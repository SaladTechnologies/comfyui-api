import Fastify from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUI from "@fastify/swagger-ui";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  ZodTypeProvider,
} from "fastify-type-provider-zod";
import { DirectoryWatcher } from "./watcher";
import fsPromises from "fs/promises";
import path from "path";
import { version } from "../package.json";
import config from "./config";
import {
  warmupComfyUI,
  waitForComfyUIToStart,
  launchComfyUI,
  shutdownComfyUI,
  processImage,
  zodToMarkdownTable,
} from "./utils";
import {
  PromptRequestSchema,
  PromptErrorResponseSchema,
  PromptResponseSchema,
  PromptRequest,
  WorkflowResponseSchema,
  WorkflowTree,
  isWorkflow,
} from "./types";
import workflows from "./workflows";
import { z } from "zod";
import { randomUUID } from "crypto";

const outputWatcher = new DirectoryWatcher(config.outputDir);

const server = Fastify({
  bodyLimit: 45 * 1024 * 1024, // 45MB
  logger: true,
});
server.setValidatorCompiler(validatorCompiler);
server.setSerializerCompiler(serializerCompiler);

const modelSchema: any = {};
for (const modelType in config.models) {
  modelSchema[modelType] = z.string().array();
}

const ModelResponseSchema = z.object(modelSchema);
type ModelResponse = z.infer<typeof ModelResponseSchema>;

const modelResponse: ModelResponse = {};
for (const modelType in config.models) {
  modelResponse[modelType] = config.models[modelType].all;
}

server.register(fastifySwagger, {
  openapi: {
    openapi: "3.0.0",
    info: {
      title: "Comfy Wrapper API",
      version,
    },
  },
  transform: jsonSchemaTransform,
});
server.register(fastifySwaggerUI, {
  routePrefix: "/docs",
  uiConfig: {
    deepLinking: true,
  },
});

server.after(() => {
  const app = server.withTypeProvider<ZodTypeProvider>();
  app.get(
    "/health",
    {
      schema: {
        response: {
          200: z.object({
            version: z.literal(version),
            status: z.literal("healthy"),
          }),
          500: z.object({
            version: z.literal(version),
            status: z.literal("not healthy"),
          }),
        },
      },
    },
    async (request, reply) => {
      // 200 if ready, 500 if not
      if (warm) {
        return reply.code(200).send({ version, status: "healthy" });
      }
      return reply.code(500).send({ version, status: "not healthy" });
    }
  );

  app.get(
    "/ready",
    {
      schema: {
        response: {
          200: z.object({
            version: z.literal(version),
            status: z.literal("ready"),
          }),
          500: z.object({
            version: z.literal(version),
            status: z.literal("not ready"),
          }),
        },
      },
    },
    async (request, reply) => {
      if (warm) {
        return reply.code(200).send({ version, status: "ready" });
      }
      return reply.code(500).send({ version, status: "not ready" });
    }
  );

  app.get(
    "/models",
    {
      schema: {
        response: {
          200: ModelResponseSchema,
        },
      },
    },
    async (request, reply) => {
      return modelResponse;
    }
  );

  app.post<{
    Body: PromptRequest;
  }>(
    "/prompt",
    {
      schema: {
        body: PromptRequestSchema,
        response: {
          200: PromptResponseSchema,
          202: PromptResponseSchema,
          400: PromptErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      let { prompt, id, webhook } = request.body;
      let batchSize = 1;

      for (const nodeId in prompt) {
        const node = prompt[nodeId];
        if (node.class_type === "SaveImage") {
          node.inputs.filename_prefix = id;
        } else if (node.inputs.batch_size) {
          batchSize = node.inputs.batch_size;
        } else if (node.class_type === "LoadImage") {
          const imageInput = node.inputs.image;
          try {
            node.inputs.image = await processImage(imageInput, app.log);
          } catch (e: any) {
            return reply.code(400).send({
              error: e.message,
              location: `prompt.${nodeId}.inputs.image`,
            });
          }
        }
      }

      if (webhook) {
        outputWatcher.addPrefixAction(
          id,
          batchSize,
          async (filepath: string) => {
            const base64File = await fsPromises.readFile(filepath, {
              encoding: "base64",
            });
            try {
              const res = await fetch(webhook, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  image: base64File,
                  id,
                  filename: path.basename(filepath),
                  prompt,
                }),
              });
              if (!res.ok) {
                app.log.error(
                  `Failed to send image to webhook: ${await res.text()}`
                );
              }
            } catch (e: any) {
              app.log.error(`Failed to send image to webhook: ${e.message}`);
            }

            // Remove the file after sending
            fsPromises.unlink(filepath);
          }
        );

        const resp = await fetch(`${config.comfyURL}/prompt`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ prompt }),
        });

        if (!resp.ok) {
          outputWatcher.removePrefixAction(id);
          return reply.code(resp.status).send({ error: await resp.text() });
        }
        return reply.code(202).send({ status: "ok", id, webhook, prompt });
      } else {
        // Wait for the file and return it
        const images: string[] = [];
        function waitForImagesToGenerate(): Promise<void> {
          return new Promise((resolve) => {
            outputWatcher.addPrefixAction(
              id,
              batchSize,
              async (filepath: string) => {
                const base64File = await fsPromises.readFile(filepath, {
                  encoding: "base64",
                });
                images.push(base64File);

                // Remove the file after reading
                fsPromises.unlink(filepath);

                if (images.length === batchSize) {
                  outputWatcher.removePrefixAction(id);
                  resolve();
                }
              }
            );
          });
        }

        const finished = waitForImagesToGenerate();
        const resp = await fetch(`${config.comfyURL}/prompt`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ prompt }),
        });
        if (!resp.ok) {
          outputWatcher.removePrefixAction(id);
          return reply.code(resp.status).send({ error: await resp.text() });
        }
        await finished;

        return reply.send({ id, prompt, images });
      }
    }
  );

  // Recursively build the route tree from workflows
  const walk = (tree: WorkflowTree, route = "/workflow") => {
    for (const key in tree) {
      const node = tree[key];
      if (isWorkflow(node)) {
        const BodySchema = z.object({
          id: z
            .string()
            .optional()
            .default(() => randomUUID()),
          input: node.RequestSchema,
          webhook: z.string().optional(),
        });

        type BodyType = z.infer<typeof BodySchema>;

        const description = zodToMarkdownTable(node.RequestSchema);

        app.post<{
          Body: BodyType;
        }>(
          `${route}/${key}`,
          {
            schema: {
              description,
              body: BodySchema,
              response: {
                200: WorkflowResponseSchema,
                202: WorkflowResponseSchema,
              },
            },
          },
          async (request, reply) => {
            const { id, input, webhook } = request.body;
            const prompt = node.generateWorkflow(input);

            const resp = await fetch(
              `http://localhost:${config.wrapperPort}/prompt`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ prompt, id, webhook }),
              }
            );
            const body = await resp.json();
            if (!resp.ok) {
              return reply.code(resp.status).send(body);
            }

            body.input = input;
            body.prompt = prompt;

            return reply.code(resp.status).send(body);
          }
        );

        server.log.info(`Registered workflow ${route}/${key}`);
      } else {
        walk(node as WorkflowTree, `${route}/${key}`);
      }
    }
  };
  walk(workflows);

  // for (const baseModel in workflows) {
  //   for (const workflowId in workflows[baseModel]) {
  //     const workflow = workflows[baseModel][workflowId] as Workflow;
  //     server.log.info(`Registering workflow ${baseModel}/${workflowId}`);
  //     const BodySchema = z.object({
  //       id: z
  //         .string()
  //         .optional()
  //         .default(() => randomUUID()),
  //       input: workflow.RequestSchema,
  //       webhook: z.string().optional(),
  //     });

  //     type BodyType = z.infer<typeof BodySchema>;

  //     app.post<{
  //       Body: BodyType;
  //     }>(
  //       `/workflow/${baseModel}/${workflowId}`,
  //       {
  //         schema: {
  //           body: BodySchema,
  //           response: {
  //             200: WorkflowResponseSchema,
  //             202: WorkflowResponseSchema,
  //           },
  //         },
  //       },
  //       async (request, reply) => {
  //         const { id, input, webhook } = request.body;
  //         const prompt = workflow.generateWorkflow(input);

  //         const resp = await fetch(
  //           `http://localhost:${config.wrapperPort}/prompt`,
  //           {
  //             method: "POST",
  //             headers: {
  //               "Content-Type": "application/json",
  //             },
  //             body: JSON.stringify({ prompt, id, webhook }),
  //           }
  //         );
  //         const body = await resp.json();
  //         if (!resp.ok) {
  //           return reply.code(resp.status).send(body);
  //         }

  //         body.input = input;
  //         body.prompt = prompt;

  //         return reply.code(resp.status).send(body);
  //       }
  //     );
  //   }
  // }
});

let warm = false;

process.on("SIGINT", async () => {
  server.log.info("Received SIGINT, interrupting process");
  shutdownComfyUI();
  await outputWatcher.stopWatching();
  process.exit(0);
});

export async function start() {
  try {
    const start = Date.now();
    // Start the command
    launchComfyUI();
    await waitForComfyUIToStart(server.log);

    await server.ready();
    server.swagger();

    // Start the server
    await server.listen({ port: config.wrapperPort, host: config.wrapperHost });
    server.log.info(`ComfyUI API ${version} started.`);
    await warmupComfyUI();
    warm = true;
    const warmupTime = Date.now() - start;
    server.log.info(`Warmup took ${warmupTime / 1000}s`);
  } catch (err: any) {
    server.log.error(`Failed to start server: ${err.message}`);
    process.exit(1);
  }
}
