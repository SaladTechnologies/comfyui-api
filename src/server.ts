import Fastify from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUI from "@fastify/swagger-ui";
import {
  jsonSchemaTransform,
  createJsonSchemaTransform,
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
} from "./utils";
import {
  PromptRequestSchema,
  PromptErrorResponseSchema,
  PromptResponseSchema,
  PromptRequest,
  Workflow,
  WorkflowRequestSchema,
  WorkflowRequest,
} from "./types";
import { workflows } from "./workflows";
import { z } from "zod";

const outputWatcher = new DirectoryWatcher(config.outputDir);

const server = Fastify({
  bodyLimit: 45 * 1024 * 1024, // 45MB
  logger: true,
});
server.setValidatorCompiler(validatorCompiler);
server.setSerializerCompiler(serializerCompiler);
server.register(fastifySwagger, {
  openapi: {
    info: {
      title: "Comfy Wrapper API",
      version,
    },
  },
  transform: jsonSchemaTransform,
});
server.register(fastifySwaggerUI, {
  routePrefix: "/docs",
});

const app = server.withTypeProvider<ZodTypeProvider>();

let warm = false;
app.get("/health", async (request, reply) => {
  // 200 if ready, 500 if not
  if (warm) {
    return reply.code(200).send({ version, status: "healthy" });
  }
  return reply.code(500).send({ version, status: "not healthy" });
});

app.get("/ready", async (request, reply) => {
  if (warm) {
    return reply.code(200).send({ version, status: "ready" });
  }
  return reply.code(500).send({ version, status: "not ready" });
});

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
      outputWatcher.addPrefixAction(id, batchSize, async (filepath: string) => {
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
      });

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

server.post<{
  Params: { base_model: string; workflow_id: string };
  Body: WorkflowRequest;
}>(
  "/workflow/:base_model/:workflow_id",
  {
    schema: {
      body: WorkflowRequestSchema,
      params: z.object({
        base_model: z.string(),
        workflow_id: z.string(),
      }),
    },
  },
  async (request, reply) => {
    const { base_model, workflow_id } = request.params;
    if (!(workflows as any)[base_model]) {
      return reply.code(404).send({ error: "Base model not found" });
    }

    if (!(workflows as any)[base_model][workflow_id]) {
      return reply.code(404).send({ error: "Workflow not found" });
    }

    const workflow = (workflows as any)[base_model][workflow_id] as Workflow;

    const { id, workflow: input, webhook } = request.body;

    const { success, data, error } = workflow.RequestSchema.safeParse(input);
    if (!success) {
      return reply.code(400).send({ error: error.errors });
    }

    const prompt = workflow.generateWorkflow(data);

    const resp = await fetch(`http://localhost:${config.wrapperPort}/prompt`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt, id, webhook }),
    });
    return reply.code(resp.status).send(await resp.json());
  }
);

process.on("SIGINT", async () => {
  app.log.info("Received SIGINT, interrupting process");
  shutdownComfyUI();
  await outputWatcher.stopWatching();
  process.exit(0);
});

export async function start() {
  try {
    const start = Date.now();
    // Start the command
    launchComfyUI();
    await waitForComfyUIToStart(app.log);

    // Start the server
    await server.listen({ port: config.wrapperPort, host: config.wrapperHost });
    await warmupComfyUI();
    warm = true;
    const warmupTime = Date.now() - start;
    app.log.info(`Warmup took ${warmupTime / 1000}s`);
  } catch (err: any) {
    app.log.error(`Failed to start server: ${err.message}`);
    process.exit(1);
  }
}
