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
  setDeletionCost,
  installCustomNode,
  aptInstallPackages,
  pipInstallPackages,
} from "./utils";
import { getConfiguredWebhookHandlers, sendWebhook } from "./event-emitters";
import { convertImageBuffer } from "./image-tools";
import { convertMediaBuffer } from "./media-tools";
import getStorageManager from "./remote-storage-manager";
import { NodeProcessError, preprocessNodes, updateModelsInConfig } from "./comfy-node-preprocessors";
import {
  warmupComfyUI,
  waitForComfyUIToStart,
  launchComfyUI,
  shutdownComfyUI,
  runPromptAndGetOutputs,
  connectToComfyUIWebsocketStream,
  PromptOutputsWithStats,
  getModels,
} from "./comfy";
import { telemetry } from "./telemetry";
import {
  PromptRequestSchema as BasePromptRequestSchema,
  PromptErrorResponseSchema,
  WorkflowTree,
  isWorkflow,
  ExecutionStatsSchema,
} from "./types";
import workflows from "./workflows";
import { z } from "zod";
import { WebSocket } from "ws";
import { fetch } from "undici";
import { getProxyDispatcher } from "./proxy-dispatcher";
import archiver from "archiver";
import { processPrompt, PromptRequest } from "./prompt-handler";
import { AmqpClient } from "./amqp-client";
import { ServiceRegistry } from "./service-registry";

const { apiVersion: version } = config;

export const server = Fastify({
  bodyLimit: config.maxBodySize,
  logger: { level: config.logLevel, timestamp: () => {
    const d = new Date();
    const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
    const year = d.getFullYear();
    const month = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const hour = pad(d.getHours());
    const minute = pad(d.getMinutes());
    const second = pad(d.getSeconds());
    const ms = d.getMilliseconds().toString().padStart(3, '0');
    const tzOffsetMin = -d.getTimezoneOffset();
    const sign = tzOffsetMin >= 0 ? '+' : '-';
    const tzH = pad(Math.floor(Math.abs(tzOffsetMin) / 60));
    const tzM = pad(Math.abs(tzOffsetMin) % 60);
    const local = `${year}-${month}-${day} ${hour}:${minute}:${second}.${ms}${sign}${tzH}:${tzM}`;
    return `,"time":"${local}"`;
  } },
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

server.log.info(
  `Loaded storage providers: ${remoteStorageManager.storageProviders
    .map((p) => p.constructor.name)
    .join(", ")}`
);

// type PromptRequest = z.infer<typeof PromptRequestSchema>;

const WorkflowRequestSchema = PromptRequestSchema.omit({ prompt: true }).extend(
  {
    input: z.record(z.any()),
  }
);

export type WorkflowRequest = z.infer<typeof WorkflowRequestSchema>;

const PromptResponseSchema = PromptRequestSchema.partial().extend({
  images: z.array(z.string()).optional(),
  filenames: z.array(z.string()).optional(),
  status: z.enum(["ok", "processing"]).optional(),
  stats: ExecutionStatsSchema.optional(),
  message: z.string().optional(),
});

const WorkflowResponseSchema = PromptResponseSchema.extend({
  input: z.record(z.any()),
});

const ModelResponseSchema = z.record(z.string(), z.array(z.string()));
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
        if (modelType === "custom_nodes") {
          // For custom_nodes, only return unique directory names (plugin names)
          // and single .py files that are plugins. Filter out garbage.
          const pluginNames = new Set<string>();
          for (const filePath of modelsByType[modelType].all) {
            const parts = filePath.split("/");
            if (parts.length > 1) {
              // It's a directory
              const dirName = parts[0];
              if (
                !dirName.startsWith(".") &&
                dirName !== "__pycache__"
              ) {
                pluginNames.add(dirName);
              }
            } else if (parts.length === 1) {
              // It's a file in the root
              const fileName = parts[0];
              if (
                fileName.endsWith(".py") &&
                fileName !== "__init__.py" &&
                !fileName.startsWith(".")
              ) {
                pluginNames.add(fileName);
              }
            }
          }
          modelResponse[modelType] = Array.from(pluginNames).sort();
        } else {
          modelResponse[modelType] = modelsByType[modelType].all;
        }
      }
      return modelResponse;
    }
  );

  app.post<{
    Body: {
      url: string;
      type: string;
      filename?: string;
    };
  }>(
    "/models",
    {
      schema: {
        summary: "Download Model",
        description: "Download a model from a URL.",
        body: z.object({
          url: z.string().url(),
          type: z.enum(Object.keys(config.models) as [string, ...string[]]),
          filename: z.string().optional(),
        }),
        response: {
          200: z.object({
            status: z.literal("ok"),
            path: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { url, type, filename } = request.body;
      const modelConfig = config.models[type];
      if (!modelConfig) {
        return reply.code(400).send({
          error: `Invalid model type: ${type}`,
          location: "body.type",
        } as any);
      }

      try {
        const downloadedPath = await remoteStorageManager.downloadFile(
          url,
          modelConfig.dir,
          filename
        );
        const finalFilename = path.basename(downloadedPath);

        // Update config with new model
        updateModelsInConfig(type, finalFilename);

        return { status: "ok", path: downloadedPath };
      } catch (e: any) {
        return reply.code(500).send({
          error: `Failed to download model: ${e.message}`,
          location: "body.url",
        } as any);
      }
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
      const accept = request.headers.accept;
      if (accept && accept.includes("text/event-stream")) {
        reply.hijack();
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });

        const sendEvent = (event: string, data: any) => {
          reply.raw.write(`event: ${event}\n`);
          reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        try {
          if (serviceRegistry) serviceRegistry.setCurrentTask((request.body as PromptRequest).id);
          const result = await processPrompt(
            request.body as PromptRequest,
            app.log,
            (message) => {
              sendEvent("message", message);
            }
          );
          sendEvent("complete", {
            ...request.body,
            ...result,
          });
        } catch (e: any) {
          const code = e.code && [400, 422].includes(e.code) ? e.code : 400;
          sendEvent("error", {
            error: e.message || "Failed to process prompt",
            location: e.location || "prompt",
            code,
          });
        } finally {
          reply.raw.end();
          if (serviceRegistry) serviceRegistry.setCurrentTask(null);
        }
        return;
      }

      // Check if any storage provider has async: true
      let isAsync = false;
      for (const provider of remoteStorageManager.storageProviders) {
        if (provider.requestBodyUploadKey) {
          const providerParams = (request.body as any)[provider.requestBodyUploadKey];
          if (providerParams?.async === true) {
            isAsync = true;
            break;
          }
        }
      }

      // If async mode, start processing in background and return immediately
      if (isAsync) {
        // Start processing in background (don't await)
        if (serviceRegistry) serviceRegistry.setCurrentTask((request.body as PromptRequest).id);
        processPrompt(request.body as PromptRequest, app.log)
          .catch((e: any) => {
            app.log.error({ error: e, id: request.body.id }, "Background prompt processing failed");
          })
          .finally(() => {
            if (serviceRegistry) serviceRegistry.setCurrentTask(null);
          });

        return reply
          .code(202)
          .send({
            status: "processing",
            id: request.body.id,
            message: "Prompt submitted for async processing"
          });
      }

      // Synchronous mode - wait for completion
      try {
        if (serviceRegistry) serviceRegistry.setCurrentTask((request.body as PromptRequest).id);
        const result = await processPrompt(request.body as PromptRequest, app.log);
        if (
          request.body.webhook ||
          request.body.webhook_v2 ||
          (request.body.signed_url && !result.images)
        ) {
          return reply
            .code(202)
            .send({ ...request.body, status: "ok", id: request.body.id });
        }
        return reply.send({
          ...request.body,
          ...result,
        });
      } catch (e: any) {
        const code = e.code && [400, 422].includes(e.code) ? e.code : 400;
        return reply.code(code).send({
          error: e.message || "Failed to process prompt",
          location: e.location || "prompt",
        });
      } finally {
        if (serviceRegistry) serviceRegistry.setCurrentTask(null);
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
            const prompt = await node.generateWorkflow(request.body.input);

            const resp = await fetch(
              `http://localhost:${config.wrapperPort}/prompt`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  ...request.body,
                  prompt,
                  input: undefined,
                }),
                dispatcher: getProxyDispatcher(),
              }
            );
            const body = (await resp.json()) as any;
            if (!resp.ok) {
              return reply.code(resp.status).send(body);
            }

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

let amqpClient: AmqpClient | undefined;
let serviceRegistry: ServiceRegistry | undefined;

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
    // Initialize AMQP Client
    amqpClient = new AmqpClient(server.log);
    await amqpClient.connect();

    // Service Registry
    serviceRegistry = new ServiceRegistry(amqpClient, server.log);
    await serviceRegistry.register();
    serviceRegistry.startHeartbeat();
    if (amqpClient && serviceRegistry) {
      amqpClient.setServiceRegistry(serviceRegistry);
    }

    const start = async () => {
      try {
        await server.listen({ port: config.wrapperPort, host: config.wrapperHost });
      } catch (err) {
        server.log.error(err);
        process.exit(1);
      }
    };
    start();
    server.log.info(`ComfyUI API ${config.apiVersion} started.`);
  }
  const handlers = getConfiguredWebhookHandlers(server.log, amqpClient);
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

process.on('SIGTERM', async () => {
  server.log.info('SIGTERM received, shutting down');
  try {
    if (serviceRegistry) await serviceRegistry.unregister('SIGTERM');
  } catch {}
  try {
    if (amqpClient) await amqpClient.close();
  } catch {}
  try {
    shutdownComfyUI();
  } catch {}
  process.exit(0);
});

process.on('SIGINT', async () => {
  server.log.info('SIGINT received, shutting down');
  try {
    if (serviceRegistry) await serviceRegistry.unregister('SIGINT');
  } catch {}
  try {
    if (amqpClient) await amqpClient.close();
  } catch {}
  try {
    shutdownComfyUI();
  } catch {}
  process.exit(0);
});
