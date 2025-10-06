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
import config from "./config";
import {
  zodToMarkdownTable,
  getConfiguredWebhookHandlers,
  fetchWithRetries,
  setDeletionCost,
  installCustomNode,
  aptInstallPackages,
  pipInstallPackages,
} from "./utils";
import { convertImageBuffer } from "./image-tools";
import remoteStorageManager from "./remote-storage-manager";
import { NodeProcessError, preprocessNodes } from "./comfy-node-preprocessors";
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
import { fetch, Agent } from "undici";

const { apiVersion: version } = config;

const server = Fastify({
  bodyLimit: config.maxBodySize,
  logger: { level: config.logLevel },
  connectionTimeout: 0,
  keepAliveTimeout: 0,
  requestTimeout: 0,
});
server.setValidatorCompiler(validatorCompiler);
server.setSerializerCompiler(serializerCompiler);

const modelSchema: any = {};
for (const modelType in config.models) {
  modelSchema[modelType] = z.string().array();
}

const ModelResponseSchema = z.object(modelSchema);
type ModelResponse = z.infer<typeof ModelResponseSchema>;

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
      const modelResponse: ModelResponse = {};
      for (const modelType in config.models) {
        modelResponse[modelType] = config.models[modelType].all;
      }
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
      let { prompt, id, webhook, convert_output, s3 } = request.body;
      let contentType = "image/png";
      if (convert_output) {
        contentType = `image/${convert_output.format}`;
      }

      /**
       * Here we go through all the nodes in the prompt to validate it,
       * and also to do some pre-processing.
       */
      let hasSaveImage = false;

      const log = app.log.child({ id });

      const start = Date.now();
      try {
        const { prompt: preprocessedPrompt, hasSaveImage: saveImageFound } =
          await preprocessNodes(prompt, id, log);
        prompt = preprocessedPrompt;
        hasSaveImage = saveImageFound;
      } catch (e: NodeProcessError | any) {
        log.error(`Failed to preprocess nodes: ${e.message}`);
        const code = e.code && [400, 422].includes(e.code) ? e.code : 400;
        return reply.code(code).send({
          error: e.message || "Failed to preprocess nodes",
          location: e.location || "prompt",
        });
      }

      const preprocessTime = Date.now();

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
        runPromptAndGetOutputs(id, prompt, log)
          .then(
            /**
             * This function does not block returning the 202 response to the user.
             */
            async ({ outputs, stats }) => {
              stats.preprocess_time = preprocessTime - start;
              stats.total_time = Date.now() - start;
              log.debug({ id, ...stats });
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
                    log.warn(`Failed to convert image: ${e.message}`);
                  }
                }
                const base64File = fileBuffer.toString("base64");

                log.info(`Sending image ${filename} to webhook: ${webhook}`);
                fetchWithRetries(
                  webhook,
                  {
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
                      stats,
                    }),
                    dispatcher: new Agent({
                      headersTimeout: 0,
                      bodyTimeout: 0,
                      connectTimeout: 0,
                    }),
                  },
                  config.promptWebhookRetries,
                  log
                )
                  .catch((e: any) => {
                    log.error(`Failed to send image to webhook: ${e.message}`);
                  })
                  .then(async (resp) => {
                    if (!resp) {
                      log.error("No response from webhook");
                    } else if (!resp.ok) {
                      log.error(
                        `Failed to send image ${filename}: ${await resp.text()}`
                      );
                    } else {
                      log.info(`Sent image ${filename}`);
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
            log.error(`Failed to generate images: ${e.message}`);
            try {
              const resp = await fetchWithRetries(
                webhook,
                {
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
                  dispatcher: new Agent({
                    headersTimeout: 0,
                    bodyTimeout: 0,
                    connectTimeout: 0,
                  }),
                },
                config.promptWebhookRetries,
                log
              );

              if (!resp.ok) {
                log.error(
                  `Failed to send failure message to webhook: ${await resp.text()}`
                );
              }
            } catch (e: any) {
              log.error(
                `Failed to send failure message to webhook: ${e.message}`
              );
            }
          });
        return reply.code(202).send({ status: "ok", id, webhook, prompt });
      } else if (s3 && s3.async) {
        runPromptAndGetOutputs(id, prompt, log)
          .then(async ({ outputs, stats }) => {
            /**
             * If the user has provided an S3 configuration, we upload the images to S3.
             */
            stats.preprocess_time = preprocessTime - start;
            const comfyTime = Date.now();
            const uploadPromises: Promise<void>[] = [];
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
                  log.warn(`Failed to convert image: ${e.message}`);
                }
              }

              const key = `${s3.prefix}${filename}`;
              const s3Url = `s3://${s3.bucket}/${key}`;
              uploadPromises.push(
                remoteStorageManager.uploadFile(
                  s3Url,
                  fileBuffer,
                  contentType,
                  log
                )
              );
              log.info(
                `Uploading image ${filename} to s3://${s3.bucket}/${key}`
              );

              // Remove the file after uploading
              fsPromises.unlink(path.join(config.outputDir, originalFilename));
            }

            await Promise.all(uploadPromises);
            stats.upload_time = Date.now() - comfyTime;
            stats.total_time = Date.now() - start;
            log.debug({ id, ...stats });
          })
          .catch(async (e: any) => {
            log.error(`Failed to generate images: ${e.message}`);
          });
        return reply.code(202).send({ status: "ok", id, prompt, s3 });
      } else {
        /**
         * If the user has not provided a webhook or s3.async is false, we wait for the images to
         * be generated and then send them back in the response.
         */
        const images: string[] = [];
        const filenames: string[] = [];
        const uploadPromises: Promise<void>[] = [];

        /**
         * Send the prompt to ComfyUI, and wait for the images to be generated.
         */
        const { outputs: allOutputs, stats } = await runPromptAndGetOutputs(
          id,
          prompt,
          log
        );
        const comfyTime = Date.now();
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
              log.warn(`Failed to convert image: ${e.message}`);
            }
          }

          filenames.push(filename);
          if (!s3) {
            const base64File = fileBuffer.toString("base64");
            images.push(base64File);
          } else if (s3 && !s3.async) {
            const key = `${s3.prefix}${filename}`;
            const s3Url = `s3://${s3.bucket}/${key}`;
            uploadPromises.push(
              remoteStorageManager.uploadFile(
                s3Url,
                fileBuffer,
                contentType,
                log
              )
            );
            log.info(`Uploading image ${filename} to ${s3Url}`);
            images.push(`s3://${s3.bucket}/${key}`);
          }

          // Remove the file after reading
          fsPromises.unlink(path.join(config.outputDir, originalFilename));
        }
        await Promise.all(uploadPromises);
        stats.preprocess_time = preprocessTime - start;
        stats.upload_time = Date.now() - comfyTime;
        stats.total_time = Date.now() - start;

        log.debug({ id, ...stats });

        return reply.send({ id, prompt, images, filenames, stats });
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
          s3: PromptRequestSchema.shape.s3.optional(),
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
            const { id, input, webhook, convert_output, s3 } = request.body;
            const prompt = await node.generateWorkflow(input);

            const resp = await fetch(
              `http://localhost:${config.wrapperPort}/prompt`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  prompt,
                  id,
                  webhook,
                  convert_output,
                  s3,
                }),
                dispatcher: new Agent({
                  headersTimeout: 0,
                  bodyTimeout: 0,
                  connectTimeout: 0,
                }),
              }
            );
            const body = (await resp.json()) as any;
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
  server.log.info(
    `Starting ComfyUI API ${config.apiVersion} with ComfyUI ${config.comfyVersion}`
  );
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
  server.log.info(`ComfyUI ${config.comfyVersion} started.`);
  if (!wasEverWarm) {
    await server.ready();
    server.swagger();
    // Start the server
    await server.listen({ port: config.wrapperPort, host: config.wrapperHost });
    server.log.info(`ComfyUI API ${config.apiVersion} started.`);
  }
  const handlers = getConfiguredWebhookHandlers(server.log);
  if (handlers.onStatus) {
    const originalHandler = handlers.onStatus;
    handlers.onStatus = (msg) => {
      queueDepth = msg.data.status.exec_info.queue_remaining;
      server.log.debug(`Queue depth: ${queueDepth}`);
      setDeletionCost(queueDepth);
      originalHandler(msg);
    };
  } else {
    handlers.onStatus = (msg) => {
      queueDepth = msg.data.status.exec_info.queue_remaining;
      server.log.debug(`Queue depth: ${queueDepth}`);
      setDeletionCost(queueDepth);
    };
  }
  comfyWebsocketClient = await connectToComfyUIWebsocketStream(
    handlers,
    server.log,
    true
  );
  await warmupComfyUI();
  wasEverWarm = true;
  warm = true;
}

async function downloadAllModels(
  models: { url: string; local_path: string }[]
) {
  for (const { url, local_path } of models) {
    const dir = path.dirname(local_path);
    const filename = path.basename(local_path);
    await remoteStorageManager.downloadFile(url, dir, filename, server.log);
  }
}

async function processManifest() {
  if (config.manifest) {
    if (config.manifest.apt) {
      server.log.info(
        `Installing ${config.manifest.apt.length} apt packages specified in manifest`
      );
      await aptInstallPackages(config.manifest.apt, server.log);
    }
    if (config.manifest.pip) {
      server.log.info(
        `Installing ${config.manifest.pip.length} pip packages specified in manifest`
      );
      await pipInstallPackages(config.manifest.pip, server.log);
    }
    if (config.manifest.custom_nodes) {
      server.log.info(
        `Installing ${config.manifest.custom_nodes.length} custom nodes specified in manifest`
      );
      for (const node of config.manifest.custom_nodes) {
        await installCustomNode(node, server.log);
      }
    }
    if (config.manifest.models.before_start) {
      server.log.info(
        `Downloading ${config.manifest.models.before_start.length} models specified in manifest before startup`
      );
      await downloadAllModels(config.manifest.models.before_start);
    }
    if (config.manifest.models.after_start) {
      server.log.info(
        `Downloading ${config.manifest.models.after_start.length} models specified in manifest after startup`
      );

      // Don't await, do it in the background
      downloadAllModels(config.manifest.models.after_start);
    }
  }
}

export async function start() {
  try {
    const start = Date.now();
    await processManifest();
    if (config.manifest) {
      server.log.info(
        `Processed manifest file in ${(Date.now() - start) / 1000}s`
      );
    }

    // Start ComfyUI
    await launchComfyUIAndAPIServerAndWaitForWarmup();
    const warmupTime = Date.now() - start;
    server.log.info(`ComfyUI fully ready in ${warmupTime / 1000}s`);
  } catch (err: any) {
    server.log.error(`Failed to start server: ${err.message}`);
    process.exit(1);
  }
}
