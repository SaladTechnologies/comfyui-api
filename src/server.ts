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
import config, { setWarmupPrompt } from "./config";
import {
  zodToMarkdownTable,
  setDeletionCost,
  installCustomNode,
  aptInstallPackages,
  pipInstallPackages,
} from "./utils";
import { getConfiguredWebhookHandlers, sendWebhook } from "./event-emitters";
import { convertImageBuffer } from "./image-tools";
import getStorageManager from "./remote-storage-manager";
import { NodeProcessError, preprocessNodes } from "./comfy-node-preprocessors";
import {
  warmupComfyUI,
  waitForComfyUIToStart,
  launchComfyUI,
  shutdownComfyUI,
  runPromptAndGetOutputs,
  connectToComfyUIWebsocketStream,
  PromptOutputsWithStats,
  getModels,
  interruptPrompt,
} from "./comfy";
import {
  PromptRequestSchema as BasePromptRequestSchema,
  PromptErrorResponseSchema,
  WorkflowTree,
  isWorkflow,
  ExecutionStatsSchema,
  DownloadRequestSchema as BaseDownloadRequestSchema,
  DownloadResponseSchema,
  DownloadErrorResponseSchema,
} from "./types";
import workflows from "./workflows";
import { z } from "zod";
import { WebSocket } from "ws";
import { fetch } from "undici";
import { getProxyDispatcher } from "./proxy-dispatcher";

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

const remoteStorageManager = getStorageManager(server.log);

let PromptRequestSchema: z.ZodObject<any, any> = BasePromptRequestSchema;

for (const provider of remoteStorageManager.storageProviders) {
  if (
    !provider.uploadFile ||
    !provider.requestBodyUploadKey ||
    !provider.requestBodyUploadSchema
  )
    continue;
  PromptRequestSchema = PromptRequestSchema.extend({
    [provider.requestBodyUploadKey]: provider.requestBodyUploadSchema
      .extend({ async: z.boolean().optional().default(false) })
      .optional(),
  });
}

type PromptRequest = z.infer<typeof PromptRequestSchema>;

const WorkflowRequestSchema = PromptRequestSchema.omit({ prompt: true }).extend(
  {
    input: z.record(z.any()),
  }
);

export type WorkflowRequest = z.infer<typeof WorkflowRequestSchema>;

const PromptResponseSchema = PromptRequestSchema.extend({
  images: z.array(z.string()).optional(),
  filenames: z.array(z.string()).optional(),
  status: z.enum(["ok"]).optional(),
  stats: ExecutionStatsSchema.optional(),
});

const WorkflowResponseSchema = PromptResponseSchema.extend({
  input: z.record(z.any()),
});

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
      const modelsByType = await getModels();
      for (const modelType in modelsByType) {
        modelResponse[modelType] = modelsByType[modelType].all;
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
      let { prompt, id, webhook, webhook_v2, convert_output, credentials } = request.body;

      /**
       * Here we go through all the nodes in the prompt to validate it,
       * and also to do some pre-processing.
       */
      let hasSaveImage = false;

      const log = app.log.child({ id });

      const start = Date.now();
      try {
        const { prompt: preprocessedPrompt, hasSaveImage: saveImageFound } =
          await preprocessNodes(prompt, id, log, credentials);
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
      log.debug(`Preprocessed prompt in ${preprocessTime}ms`);

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

      type ProcessedOutput = {
        buffers: Buffer[];
        filenames: string[];
        stats: any;
      };

      const postProcessOutputs = async ({
        outputs,
        stats,
      }: PromptOutputsWithStats): Promise<ProcessedOutput> => {
        stats.preprocess_time = preprocessTime - start;
        stats.comfy_round_trip_time = Date.now() - preprocessTime;
        const filenames: string[] = [];
        const buffers: Buffer[] = [];
        const unlinks: Promise<void>[] = [];
        for (const originalFilename in outputs) {
          let filename = originalFilename;
          let fileBuffer = outputs[filename];
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
          buffers.push(fileBuffer);
          unlinks.push(
            fsPromises.unlink(path.join(config.outputDir, originalFilename))
          );
        }
        await Promise.all(unlinks);
        stats.postprocess_time =
          Date.now() - stats.comfy_round_trip_time - preprocessTime;
        return {
          buffers,
          filenames,
          stats,
        };
      };

      const runPromptPromise = runPromptAndGetOutputs(id, prompt, log)
        .catch((e: any) => {
          log.error(`Failed to run prompt: ${e.message}`);
          if (webhook_v2) {
            const webhookBody = {
              type: "prompt.failed",
              timestamp: new Date().toISOString(),
              id,
              prompt,
              error: e.message,
            };
            sendWebhook(webhook_v2, webhookBody, log, 2);
          } else if (webhook) {
            log.warn(
              `.webhook has been deprecated in favor of .webhook_v2. Support for .webhook will be removed in a future version.`
            );
            const webhookBody = {
              event: "prompt.failed",
              id,
              prompt,
              error: e.message,
            };
            sendWebhook(webhook, webhookBody, log, 1);
          }
          throw e;
        })
        .then(postProcessOutputs);

      let uploadPromise: Promise<{
        images: string[];
        filenames: string[];
        stats: any;
      }> | null = null;

      type Handler = (data: ProcessedOutput) => Promise<{
        images: string[];
        filenames: string[];
        stats: any;
      }>;

      const webhookHandler: Handler = async ({
        buffers,
        filenames,
        stats,
      }: ProcessedOutput) => {
        if (!webhook) {
          throw new Error("Webhook URL is not defined");
        }
        log.warn(
          `.webhook has been deprecated in favor of .webhook_v2. Support for .webhook will be removed in a future version.`
        );
        const webhookPromises: Promise<any>[] = [];
        const images: string[] = [];
        for (let i = 0; i < buffers.length; i++) {
          const base64File = buffers[i].toString("base64");
          images.push(base64File);
          const filename = filenames[i];
          log.info(`Sending image ${filename} to webhook: ${webhook}`);
          webhookPromises.push(
            sendWebhook(
              webhook,
              {
                event: "output.complete",
                image: base64File,
                id,
                filename,
                prompt,
                stats,
              },
              log,
              1
            )
          );
        }
        await Promise.all(webhookPromises);
        return { images, filenames, stats };
      };

      const uploadHandler: Handler = async ({
        buffers,
        filenames,
        stats,
      }): Promise<{
        images: string[];
        filenames: string[];
        stats: any;
      }> => {
        const uploadPromises: Promise<void>[] = [];
        const images: string[] = [];
        for (let i = 0; i < buffers.length; i++) {
          const fileBuffer = buffers[i];
          const filename = filenames[i];
          for (const provider of remoteStorageManager.storageProviders) {
            if (
              provider.requestBodyUploadKey &&
              request.body[provider.requestBodyUploadKey]
            ) {
              images.push(
                provider.createUrl({
                  ...request.body[provider.requestBodyUploadKey],
                  filename,
                })
              );
              break;
            }
          }
          uploadPromises.push(
            remoteStorageManager.uploadFile(images[i], fileBuffer)
          );
        }

        await Promise.all(uploadPromises);
        return { images, filenames, stats };
      };

      const storageProvider = remoteStorageManager.storageProviders.find(
        (provider) =>
          provider.requestBodyUploadKey &&
          !!request.body[provider.requestBodyUploadKey]
      );
      const asyncUpload =
        webhook ||
        webhook_v2 ||
        (storageProvider &&
          storageProvider.requestBodyUploadKey &&
          request.body[storageProvider.requestBodyUploadKey]?.async);

      if (webhook) {
        uploadPromise = runPromptPromise.then(webhookHandler);
      } else if (!!storageProvider) {
        uploadPromise = runPromptPromise.then(uploadHandler);
      } else {
        uploadPromise = runPromptPromise.then(
          async ({ buffers, filenames, stats }) => {
            const images: string[] = buffers.map((b) => b.toString("base64"));
            return { images, filenames, stats };
          }
        );
      }

      const finalStatsPromise = uploadPromise.then(
        ({ images, stats, filenames }) => {
          stats.upload_time =
            Date.now() -
            start -
            stats.preprocess_time -
            stats.comfy_round_trip_time -
            stats.postprocess_time;
          stats.total_time = Date.now() - start;
          log.debug(stats);
          return { images, stats, filenames };
        }
      );

      if (asyncUpload) {
        reply.code(202).send({ ...request.body, status: "ok", id, prompt });
      }

      const { images, stats, filenames } = await finalStatsPromise;

      const outputPayload = {
        ...request.body,
        id,
        prompt,
        images,
        filenames,
        stats,
      };

      if (webhook_v2) {
        log.debug(`Sending final response to webhook_v2: ${webhook_v2}`);
        const webhookBody = {
          type: "prompt.complete",
          timestamp: new Date().toISOString(),
          ...outputPayload,
        };
        sendWebhook(webhook_v2, webhookBody, log, 2);
      }

      if (!asyncUpload) {
        return reply.send(outputPayload);
      }
    }
  );

  app.post(
    "/interrupt",
    {
      schema: {
        summary: "Interrupt Prompt",
        description: "Interrupt a running prompt by ID.",
        body: z.object({
          id: z.string(),
        }),
        response: {
          200: z.object({
            id: z.string(),
            interrupted: z.literal("success"),
          }),
          404: z.object({
            id: z.string(),
            interrupted: z.literal("failed"),
          }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.body as { id: string };

      const log = app.log.child({ id });

      try {
        await interruptPrompt(id);
        log.info(`Successfully interrupted prompt: ${id}`);
        return reply.code(200).send({
          id,
          interrupted: "success",
        });
      } catch (e: any) {
        log.error(`Failed to interrupt prompt: ${e.message}`);
        return reply.code(404).send({
          id,
          interrupted: "failed",
        });
      }
    }
  );

  const modelTypes = Object.keys(config.models);
  const ModelTypeSchema =
    modelTypes.length > 0
      ? z.enum(modelTypes as [string, ...string[]])
      : z.string();

  const DownloadRequestSchema = BaseDownloadRequestSchema.extend({
    model_type: ModelTypeSchema,
  });

  app.post(
    "/download",
    {
      schema: {
        summary: "Download Model",
        description:
          "Download a model from a URL to the appropriate model directory. By default, the download runs asynchronously and returns immediately with a 202 status. Set `wait: true` to hold the request open until the download completes.",
        body: DownloadRequestSchema,
        response: {
          200: DownloadResponseSchema,
          202: DownloadResponseSchema,
          400: DownloadErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { url, model_type, filename: filenameOverride, wait, auth } =
        request.body as z.infer<typeof DownloadRequestSchema>;

      // Log without auth details to prevent credential exposure
      const log = app.log.child({
        url,
        model_type,
        hasAuth: !!auth,
        authType: auth?.type,
      });

      const modelConfig = config.models[model_type];
      if (!modelConfig) {
        return reply.code(400).send({
          error: `Unknown model type: ${model_type}. Available types: ${Object.keys(config.models).join(", ")}`,
        });
      }

      const outputDir = modelConfig.dir;
      let filename: string;
      try {
        filename = filenameOverride || path.basename(new URL(url).pathname);
      } catch (err: any) {
        log.error(`Invalid URL: ${err.message}`);
        return reply.code(400).send({
          error: `Invalid URL: ${err.message}`,
        });
      }

      // Build download options with auth if provided
      const downloadOptions = auth ? { auth } : undefined;

      if (!wait) {
        log.info(`Starting async download of ${url} to ${outputDir}`);
        remoteStorageManager
          .downloadFile(url, outputDir, filename, downloadOptions)
          .then((finalPath) => {
            log.info(`Download completed: ${finalPath}`);
          })
          .catch((err) => {
            log.error(`Download failed: ${err.message}`);
          });

        return reply.code(202).send({
          url,
          model_type,
          filename,
          status: "started",
        });
      }

      log.info(`Starting sync download of ${url} to ${outputDir}`);
      const start = Date.now();

      try {
        const finalPath = await remoteStorageManager.downloadFile(
          url,
          outputDir,
          filename,
          downloadOptions
        );
        const duration = (Date.now() - start) / 1000;
        const stats = await fsPromises.stat(
          await fsPromises.realpath(finalPath)
        );

        log.info(
          `Download completed: ${finalPath} (${stats.size} bytes in ${duration}s)`
        );

        return reply.code(200).send({
          url,
          model_type,
          filename: path.basename(finalPath),
          status: "completed",
          size: stats.size,
          duration,
        });
      } catch (err: any) {
        log.error(`Download failed: ${err.message}`);
        return reply.code(400).send({
          error: err.message,
        });
      }
    }
  );

  // Recursively build the route tree from workflows
  const walk = (tree: WorkflowTree, route = "/workflow") => {
    for (const key in tree) {
      const node = tree[key];
      if (isWorkflow(node)) {
        const BodySchema = WorkflowRequestSchema.extend({
          input: node.RequestSchema,
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
            const log = app.log.child({ workflow: `${route}/${key}` });

            log.debug({ input: request.body.input }, "Workflow input received");

            let prompt;
            try {
              prompt = await node.generateWorkflow(request.body.input);
              log.debug({ prompt }, "Generated ComfyUI prompt from workflow");
            } catch (e: any) {
              log.error(
                { error: e.message, stack: e.stack },
                "Failed to generate workflow prompt"
              );
              return reply.code(400).send({
                error: `Failed to generate workflow prompt: ${e.message}`,
                location: "input",
              });
            }

            const promptRequestBody = {
              ...request.body,
              prompt,
              input: undefined,
            };

            log.debug(
              { promptRequestBody },
              "Sending request to /prompt endpoint"
            );

            const resp = await fetch(
              `http://localhost:${config.wrapperPort}/prompt`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(promptRequestBody),
                dispatcher: getProxyDispatcher(),
              }
            );
            const body = (await resp.json()) as any;
            if (!resp.ok) {
              log.error(
                {
                  status: resp.status,
                  error: body.error,
                  location: body.location,
                  promptRequestBody,
                },
                "Workflow request to /prompt endpoint failed"
              );
              return reply.code(resp.status).send(body);
            }

            log.debug({ status: resp.status }, "Workflow completed successfully");

            body.input = request.body.input;

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
    await remoteStorageManager.downloadFile(url, dir, filename);
  }
}

async function downloadWarmupPrompt() {
  // Skip if warmup prompt is already set (from WARMUP_PROMPT_FILE)
  if (config.warmupPrompt) {
    return;
  }

  // Download warmup prompt from URL if specified
  if (config.warmupPromptUrl) {
    server.log.info(
      `Downloading warmup prompt from ${config.warmupPromptUrl}`
    );
    const start = Date.now();
    const resp = await fetch(config.warmupPromptUrl, {
      headers: config.httpAuthHeader,
      dispatcher: getProxyDispatcher(),
    });
    if (!resp.ok) {
      throw new Error(
        `Failed to download warmup prompt from ${config.warmupPromptUrl}: ${resp.status} ${resp.statusText}`
      );
    }
    const content = await resp.text();
    setWarmupPrompt(content);
    const duration = (Date.now() - start) / 1000;
    server.log.info(
      `Downloaded and parsed warmup prompt in ${duration.toFixed(2)}s`
    );
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
    await remoteStorageManager.enforceCacheSize();
    await downloadWarmupPrompt();
    await processManifest();
    if (config.manifest) {
      server.log.info(
        `Processed manifest file in ${(Date.now() - start) / 1000}s`
      );
    }

    // Start ComfyUI
    await launchComfyUIAndAPIServerAndWaitForWarmup();
    await getModels();
    const warmupTime = Date.now() - start;
    server.log.info(`ComfyUI fully ready in ${warmupTime / 1000}s`);
  } catch (err: any) {
    server.log.error(`Failed to start server: ${err.message}`);
    process.exit(1);
  }
}
