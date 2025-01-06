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
  convertImageBuffer,
} from "./utils";
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

const outputWatcher = new DirectoryWatcher(config.outputDir);

const server = Fastify({
  bodyLimit: 100 * 1024 * 1024, // 45MB
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
        summary: "Readiness Probe",
        description: "Check if the server is ready to serve traffic",
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
      let batchSize = 0;
      let hasSaveImage = false;
      const saveNodesWithFilenamePrefix = new Set<string>([
        "SaveImage",
        "SaveAnimatedWEBP",
        "SaveAnimatedPNG",
      ]);
      const loadImageNodes = new Set<string>(["LoadImage"]);
      const loadDirectoryOfImagesNodes = new Set<string>(["VHS_LoadImages"]);
      for (const nodeId in prompt) {
        const node = prompt[nodeId];

        if (saveNodesWithFilenamePrefix.has(node.class_type)) {
          /**
           * If the node is for saving files, we want to set the filename_prefix
           * to the id of the prompt. This is so that we can associate the output
           * files with the prompt that generated them.
           */
          node.inputs.filename_prefix = id;
          hasSaveImage = true;
        } else if (node.inputs.batch_size) {
          /**
           * A few nodes have a batch_size input that we can use to determine
           * how many images to expect from the output.
           */
          batchSize += node.inputs.batch_size;
        } else if (loadImageNodes.has(node.class_type)) {
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
        } else if (loadDirectoryOfImagesNodes.has(node.class_type)) {
          /**
           * If the node is for loading a directory of images, the user will have
           * provided the local directory as a string or an array of strings. If it's an
           * array, we need to download each image to a local file, and update the input
           * to be the local directory.
           */
          if (Array.isArray(node.inputs.directory)) {
            try {
              /**
               * We need to download each image to a local file.
               */
              await Promise.all(
                (node.inputs.directory as string[]).map((img) => {
                  processImage(img, app.log, id);
                })
              );
              node.inputs.directory = id;
            } catch (e: any) {
              return reply.code(400).send({
                error: e.message,
                location: `prompt.${nodeId}.inputs.directory`,
                message: "Failed to download images to local directory",
              });
            }
          }
        } else if (
          node.class_type === "EmptyMotionData" &&
          node.inputs.frames
        ) {
          /**
           * If the node is EmptyMotionData, we need to set the batch size to the number
           * of frames that the user has provided.
           */
          batchSize = node.inputs.frames;
        } else if (
          node.class_type === "VHS_VideoCombine" &&
          node.inputs.save_output
        ) {
          /**
           * This node only optionally saves the output, so we need to check if the user
           * has enabled saving the output, and if so, set the filename_prefix to the id
           * of the prompt.
           */
          node.inputs.filename_prefix = id;
          hasSaveImage = true;

          // Outputs the video file, and a preview image
          batchSize += 2;
        }
      }

      if (!hasSaveImage) {
        return reply.code(400).send({
          error: `Prompt must contain a a node that saves an image or video. Supported nodes are: ${[
            ...saveNodesWithFilenamePrefix,
            "VHS_VideoCombine",
          ].join(", ")}`,
          location: "prompt",
        });
      }

      if (batchSize === 0) {
        return reply.code(400).send({
          error: `Prompt must contain a node that specifies batch_size, frames, or a video output.`,
          location: "prompt",
        });
      }

      if (webhook) {
        /**
         * If the user has provided a webhook, we set up a watcher to send outputs via webhook.
         */
        outputWatcher.addPrefixAction(
          id,
          batchSize,
          async (filepath: string) => {
            let fileBuffer = await fsPromises.readFile(filepath);

            if (convert_output) {
              fileBuffer = await convertImageBuffer(fileBuffer, convert_output);
            }

            const base64File = fileBuffer.toString("base64");

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

        /**
         * Send the prompt to ComfyUI, and return a 202 response to the user.
         */
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
        /**
         * If the user has not provided a webhook, we wait for the images to be generated
         * and then send them back in the response.
         */
        const images: string[] = [];
        const filenames: string[] = [];
        function waitForImagesToGenerate(): Promise<void> {
          return new Promise((resolve) => {
            outputWatcher.addPrefixAction(
              id,
              batchSize,
              async (filepath: string) => {
                let fileBuffer = await fsPromises.readFile(filepath);
                let filename = path.basename(filepath);
                if (convert_output) {
                  fileBuffer = await convertImageBuffer(
                    fileBuffer,
                    convert_output
                  );
                  /**
                   * If the user has provided an output format, we need to update the filename
                   */
                  filename = filename.replace(
                    /\.[^/.]+$/,
                    `.${convert_output.format}`
                  );
                }

                const base64File = fileBuffer.toString("base64");
                images.push(base64File);
                filenames.push(filename);

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

        /**
         * Send the prompt to ComfyUI, and wait for the images to be generated.
         */
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
            const prompt = node.generateWorkflow(input);

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
