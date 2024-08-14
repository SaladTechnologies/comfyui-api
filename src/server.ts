import Fastify from "fastify";
import { DirectoryWatcher } from "./watcher";
import fsPromises from "fs/promises";
import path from "path";
import { version } from "../package.json";
import { randomUUID } from "crypto";
import config from "./config";
import {
  warmupComfyUI,
  waitForComfyUIToStart,
  launchComfyUI,
  shutdownComfyUI,
  processImage,
} from "./utils";

const outputWatcher = new DirectoryWatcher(config.outputDir);

const server = Fastify({
  bodyLimit: 45 * 1024 * 1024, // 45MB
  logger: true,
});

let warm = false;
server.get("/health", async (request, reply) => {
  // 200 if ready, 500 if not
  if (warm) {
    return reply.code(200).send({ version, status: "healthy" });
  }
  return reply.code(500).send({ version, status: "not healthy" });
});

server.get("/ready", async (request, reply) => {
  if (warm) {
    return reply.code(200).send({ version, status: "ready" });
  }
  return reply.code(500).send({ version, status: "not ready" });
});

type PromptRequest = {
  prompt: Record<string, ComfyNode>;
  id: string;
  webhook: string;
};

type ComfyNode = {
  inputs: any;
  class_type: string;
};

server.post("/prompt", async (request, reply) => {
  let { prompt, id, webhook } = request.body as PromptRequest;
  if (!prompt) {
    return reply.code(400).send({ error: "prompt is required" });
  }
  if (!id) {
    id = randomUUID();
  }

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
        node.inputs.image = await processImage(imageInput, server.log);
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
          server.log.error(
            `Failed to send image to webhook: ${await res.text()}`
          );
        }
      } catch (e: any) {
        server.log.error(`Failed to send image to webhook: ${e.message}`);
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
      return reply.code(resp.status).send(await resp.text());
    }
    return reply.code(202).send({ status: "ok", id, webhook });
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
      return reply.code(resp.status).send(await resp.text());
    }
    await finished;

    return reply.send({ id, prompt, images });
  }
});

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

    // Start the server
    await server.listen({ port: config.wrapperPort, host: config.wrapperHost });
    await warmupComfyUI();
    warm = true;
    const warmupTime = Date.now() - start;
    server.log.info(`Warmup took ${warmupTime / 1000}s`);
  } catch (err: any) {
    server.log.error(`Failed to start server: ${err.message}`);
    process.exit(1);
  }
}
