import Fastify from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUI from "@fastify/swagger-ui";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  ZodTypeProvider,
} from "fastify-type-provider-zod";
import fsPromises from "fs/promises";
import path from "path";
import { version } from "../package.json";
import config from "./config";
import {
  processImage,
  zodToMarkdownTable,
  convertImageBuffer,
  getConfiguredWebhookHandlers,
} from "./utils";
import {
  warmupComfyUI,
  waitForComfyUIToStart,
  launchComfyUI,
  shutdownComfyUI,
  runPromptAndGetOutputs,
  connectToComfyUIWebsocketStream,
} from "./comfy";
import {
  PromptRequestSchema,
  PromptErrorResponseSchema,
  PromptResponseSchema,
  PromptRequest,
  WorkflowResponseSchema,
  WorkflowTree,
  isWorkflow,
  OutputConversionOptionsSchema,
} from "./types";
import workflows from "./workflows";
import { z } from "zod";
import { randomUUID } from "crypto";
import { WebSocket } from "ws";

const server = Fastify({
  bodyLimit: config.maxBodySize,
  logger: { level: config.logLevel },
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

let warm = false;
let wasEverWarm = false;
let queueDepth = 0;

server.register(fastifySwagger, {
  openapi: {
    openapi: "3.0.0",
    info: {
      title: "ComfyUI API",
      version,
    },
    servers: [
      {
        url: `{accessDomainName}`,
        description: "Your server",
        variables: {
          accessDomainName: {
            default: `http://localhost:${config.wrapperPort}`,
            description:
              "The domain name of the server, protocol included, port optional",
          },
        },
      },
    ],
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
        summary: "Health Probe",
        description: "Check if the server is healthy",
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
      if (wasEverWarm) {
        return reply.code(200).send({ version, status: "healthy" });
      }
      return reply.code(500).send({ version, status: "not healthy" });
    }
  );

  app.get(
    "/ready",
    {
      schema: {
        summary: "Readiness Probe",
        description: "Check if the server is ready to serve traffic",
        response: {
          200: z.object({
            version: z.literal(version),
            status: z.literal("ready"),
          }),
          503: z.object({
            version: z.literal(version),
            status: z.literal("not ready"),
          }),
        },
      },
    },
    async (request, reply) => {
      if (
        warm &&
        (!config.maxQueueDepth || queueDepth < config.maxQueueDepth)
      ) {
        return reply.code(200).send({ version, status: "ready" });
      }
      return reply.code(503).send({ version, status: "not ready" });
    }
  );

  app.get(
    "/models",
    {
      schema: {
        summary: "List Models",
        description:
          "List all available models. This is from the contents of the models directory.",
        response: {
          200: ModelResponseSchema,
        },
      },
    },
    async (request, reply) => {
      return modelResponse;
    }
  );

  /**
   * This route is the primary wrapper around the ComfyUI /prompt endpoint.
   * It shares the same schema as the ComfyUI /prompt endpoint, but adds the
   * ability to convert the output image to a different format, and to send
   * the output image to a webhook, or return it in the response.
   *
   * If your application has it's own ID scheme, you can provide the ID in the
   * request body. If you don't provide an ID, one will be generated for you.
   */
  app.post<{
    Body: PromptRequest;
  }>(
    "/prompt",
    {
      schema: {
        summary: "Submit Prompt",
        description: "Submit an API-formatted ComfyUI prompt.",
        body: PromptRequestSchema,
        response: {
          200: PromptResponseSchema,
          202: PromptResponseSchema,
          400: PromptErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      let { prompt, id, webhook, convert_output } = request.body;

      /**
       * Here we go through all the nodes in the prompt to validate it,
       * and also to do some pre-processing.
       */
      let hasSaveImage = false;
      const loadImageNodes = new Set<string>(["LoadImage"]);
      const loadDirectoryOfImagesNodes = new Set<string>(["VHS_LoadImages"]);
      for (const nodeId in prompt) {
        const node = prompt[nodeId];
        if (
          node.inputs.filename_prefix &&
          typeof node.inputs.filename_prefix === "string"
        ) {
          /**
           * If the node is for saving files, we want to set the filename_prefix
           * to the id of the prompt. This ensures no collisions between prompts
           * from different users.
           */
          node.inputs.filename_prefix = id;
          if (
            typeof node.inputs.save_output !== "undefined" &&
            !node.inputs.save_output
          ) {
            continue;
          }
          hasSaveImage = true;
        } else if (
          loadImageNodes.has(node.class_type) &&
          typeof node.inputs.image === "string"
        ) {
          /**
           * If the node is for loading an image, the user will have provided
           * the image as base64 encoded data, or as a url. we need to download
           * the image if it's a url, and save it to a local file.
           */
          const imageInput = node.inputs.image;
          try {
            node.inputs.image = await processImage(imageInput, app.log);
          } catch (e: any) {
            return reply.code(400).send({
              error: e.message,
              location: `prompt.${nodeId}.inputs.image`,
            });
          }
        } else if (
          loadDirectoryOfImagesNodes.has(node.class_type) &&
          Array.isArray(node.inputs.directory) &&
          node.inputs.directory.every((x: any) => typeof x === "string")
        ) {
          /**
           * If the node is for loading a directory of images, the user will have
           * provided the local directory as a string or an array of strings. If it's an
           * array, we need to download each image to a local file, and update the input
           * to be the local directory.
           */
          try {
            /**
             * We need to download each image to a local file.
             */
            app.log.debug(
              `Downloading images to local directory for node ${nodeId}`
            );
            const processPromises: Promise<string>[] = [];
            for (const b64 of node.inputs.directory) {
              processPromises.push(processImage(b64, app.log, id));
            }
            await Promise.all(processPromises);
            node.inputs.directory = id;
            app.log.debug(`Saved images to local directory for node ${nodeId}`);
          } catch (e: any) {
            return reply.code(400).send({
              error: e.message,
              location: `prompt.${nodeId}.inputs.directory`,
              message: "Failed to download images to local directory",
            });
          }
        }
      }

      /**
       * If the prompt has no outputs, there's no point in running it.
       */
      if (!hasSaveImage) {
        return reply.code(400).send({
          error:
            'Prompt must contain a node with a "filename_prefix" input, such as "SaveImage"',
          location: "prompt",
        });
      }

      if (webhook) {
        /**
         * Send the prompt to ComfyUI, and return a 202 response to the user.
         */
        runPromptAndGetOutputs(id, prompt, app.log)
          .then(
            /**
             * This function does not block returning the 202 response to the user.
             */
            async (outputs: Record<string, Buffer>) => {
              for (const originalFilename in outputs) {
                let filename = originalFilename;
                let fileBuffer = outputs[filename];
                if (convert_output) {
                  try {
                    fileBuffer = await convertImageBuffer(
                      fileBuffer,
                      convert_output
                    );

                    /**
                     * If the user has provided an output format, we need to update the filename
                     */
                    filename = originalFilename.replace(
                      /\.[^/.]+$/,
                      `.${convert_output.format}`
                    );
                  } catch (e: any) {
                    app.log.warn(`Failed to convert image: ${e.message}`);
                  }
                }
                const base64File = fileBuffer.toString("base64");
                app.log.info(
                  `Sending image ${filename} to webhook: ${webhook}`
                );
                fetch(webhook, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    event: "output.complete",
                    image: base64File,
                    id,
                    filename,
                    prompt,
                  }),
                })
                  .catch((e: any) => {
                    app.log.error(
                      `Failed to send image to webhook: ${e.message}`
                    );
                  })
                  .then(async (resp) => {
                    if (!resp) {
                      app.log.error("No response from webhook");
                    } else if (!resp.ok) {
                      app.log.error(
                        `Failed to send image ${filename}: ${await resp.text()}`
                      );
                    } else {
                      app.log.info(`Sent image ${filename}`);
                    }
                  });

                // Remove the file after sending
                fsPromises.unlink(
                  path.join(config.outputDir, originalFilename)
                );
              }
            }
          )
          .catch(async (e: any) => {
            /**
             * Send a webhook reporting that the generation failed.
             */
            app.log.error(`Failed to generate images: ${e.message}`);
            try {
              const resp = await fetch(webhook, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  event: "prompt.failed",
                  id,
                  prompt,
                  error: e.message,
                }),
              });

              if (!resp.ok) {
                app.log.error(
                  `Failed to send failure message to webhook: ${await resp.text()}`
                );
              }
            } catch (e: any) {
              app.log.error(
                `Failed to send failure message to webhook: ${e.message}`
              );
            }
          });
        return reply.code(202).send({ status: "ok", id, webhook, prompt });
      } else {
        /**
         * If the user has not provided a webhook, we wait for the images to be generated
         * and then send them back in the response.
         */
        const images: string[] = [];
        const filenames: string[] = [];

        /**
         * Send the prompt to ComfyUI, and wait for the images to be generated.
         */
        const allOutputs = await runPromptAndGetOutputs(id, prompt, app.log);
        for (const originalFilename in allOutputs) {
          let fileBuffer = allOutputs[originalFilename];
          let filename = originalFilename;

          if (convert_output) {
            try {
              fileBuffer = await convertImageBuffer(fileBuffer, convert_output);
              /**
               * If the user has provided an output format, we need to update the filename
               */
              filename = originalFilename.replace(
                /\.[^/.]+$/,
                `.${convert_output.format}`
              );
            } catch (e: any) {
              app.log.warn(`Failed to convert image: ${e.message}`);
            }
          }

          const base64File = fileBuffer.toString("base64");
          images.push(base64File);
          filenames.push(filename);

          // Remove the file after reading
          fsPromises.unlink(path.join(config.outputDir, originalFilename));
        }

        return reply.send({ id, prompt, images, filenames });
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
          convert_output: OutputConversionOptionsSchema.optional(),
        });

        type BodyType = z.infer<typeof BodySchema>;

        let description = "";
        if (config.markdownSchemaDescriptions) {
          description = zodToMarkdownTable(node.RequestSchema);
        } else if (node.description) {
          description = node.description;
        }

        let summary = key;
        if (node.summary) {
          summary = node.summary;
        }

        /**
         * Workflow endpoints expose a simpler API to users, and then perform the transformation
         * to a ComfyUI prompt behind the scenes. These endpoints under the hood just call the /prompt
         * endpoint with the appropriate parameters.
         */
        app.post<{
          Body: BodyType;
        }>(
          `${route}/${key}`,
          {
            schema: {
              summary,
              description,
              body: BodySchema,
              response: {
                200: WorkflowResponseSchema,
                202: WorkflowResponseSchema,
              },
            },
          },
          async (request, reply) => {
            const { id, input, webhook, convert_output } = request.body;
            const prompt = await node.generateWorkflow(input);

            const resp = await fetch(
              `http://localhost:${config.wrapperPort}/prompt`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ prompt, id, webhook, convert_output }),
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
});

let comfyWebsocketClient: WebSocket | null = null;

process.on("SIGINT", async () => {
  server.log.info("Received SIGINT, interrupting process");
  shutdownComfyUI();
  if (comfyWebsocketClient) {
    comfyWebsocketClient.terminate();
  }
  process.exit(0);
});

async function launchComfyUIAndAPIServerAndWaitForWarmup() {
  warm = false;
  launchComfyUI().catch((err: any) => {
    server.log.error(err.message);
    if (config.alwaysRestartComfyUI) {
      server.log.info("Restarting ComfyUI");
      launchComfyUIAndAPIServerAndWaitForWarmup();
    } else {
      server.log.info("Exiting");
      process.exit(1);
    }
  });
  await waitForComfyUIToStart(server.log);
  if (!wasEverWarm) {
    await server.ready();
    server.swagger();
    // Start the server
    await server.listen({ port: config.wrapperPort, host: config.wrapperHost });
    server.log.info(`ComfyUI API ${version} started.`);
  }
  await warmupComfyUI();
  wasEverWarm = true;
  warm = true;
}

export async function start() {
  try {
    const start = Date.now();
    // Start ComfyUI
    await launchComfyUIAndAPIServerAndWaitForWarmup();
    const warmupTime = Date.now() - start;
    server.log.info(`Warmup took ${warmupTime / 1000}s`);
    const handlers = getConfiguredWebhookHandlers(server.log);
    if (handlers.onStatus) {
      const originalHandler = handlers.onStatus;
      handlers.onStatus = (msg) => {
        queueDepth = msg.data.status.exec_info.queue_remaining;
        originalHandler(msg);
      };
    } else {
      handlers.onStatus = (msg) => {
        queueDepth = msg.data.status.exec_info.queue_remaining;
      };
    }
    comfyWebsocketClient = await connectToComfyUIWebsocketStream(
      handlers,
      server.log,
      true
    );
  } catch (err: any) {
    server.log.error(`Failed to start server: ${err.message}`);
    process.exit(1);
  }
}
