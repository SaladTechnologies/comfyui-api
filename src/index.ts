import Fastify from "fastify";
import { CommandExecutor } from "./commands";
import { DirectoryWatcher } from "./watcher";
import fs from "fs/promises";
import path from "path";
import { version } from "../package.json";
import { randomUUID } from "crypto";

const {
  CMD = "./init.sh",
  HOST = "::",
  PORT = "3000",
  IP = "127.0.0.1",
  COMFYUI_PORT = "8188",
  STARTUP_CHECK_INTERVAL_S = "1",
  STARTUP_CHECK_MAX_TRIES = "10",
  OUTPUT_DIR = "/opt/ComfyUI/output",
} = process.env;

const comfyURL = `http://${IP}:${COMFYUI_PORT}`;
const port = parseInt(PORT, 10);
const startupCheckInterval = parseInt(STARTUP_CHECK_INTERVAL_S, 10) * 1000;
const startupCheckMaxTries = parseInt(STARTUP_CHECK_MAX_TRIES, 10);

const outputWatcher = new DirectoryWatcher(OUTPUT_DIR);

let start: number;

const server = Fastify({
  bodyLimit: 45 * 1024 * 1024, // 45MB
  logger: true,
});

async function pingComfyUI(): Promise<void> {
  const res = await fetch(comfyURL);
  if (!res.ok) {
    throw new Error(`Failed to ping Comfy UI: ${await res.text()}`);
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForComfyUIToStart(): Promise<void> {
  let retries = 0;
  while (retries < startupCheckMaxTries) {
    try {
      await pingComfyUI();
      console.log("Comfy UI started");
      return;
    } catch (e) {
      // Ignore
    }
    retries++;
    await sleep(startupCheckInterval);
  }

  throw new Error(
    `Comfy UI did not start after ${
      (startupCheckInterval / 1000) * startupCheckMaxTries
    } seconds`
  );
}

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
    }
  }

  if (webhook) {
    outputWatcher.addPrefixAction(id, batchSize, async (filepath: string) => {
      const base64File = await fs.readFile(filepath, { encoding: "base64" });
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
          console.error(`Failed to send image to webhook: ${await res.text()}`);
        }
      } catch (e: any) {
        console.error(`Failed to send image to webhook: ${e.message}`);
      }

      // Remove the file after sending
      fs.unlink(filepath);
    });

    const resp = await fetch(`${comfyURL}/prompt`, {
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
            const base64File = await fs.readFile(filepath, {
              encoding: "base64",
            });
            images.push(base64File);

            // Remove the file after reading
            fs.unlink(filepath);

            if (images.length === batchSize) {
              resolve();
            }
          }
        );
      });
    }

    const finished = waitForImagesToGenerate();
    const resp = await fetch(`${comfyURL}/prompt`, {
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

const commandExecutor = new CommandExecutor();

process.on("SIGINT", async () => {
  console.log("Received SIGINT, interrupting process");
  commandExecutor.interrupt();
  await outputWatcher.stopWatching();
  process.exit(0);
});

async function startServer() {
  try {
    start = Date.now();
    // Start the command
    commandExecutor.execute(CMD, [], {
      IP,
      COMFYUI_PORT,
      WEB_ENABLE_AUTH: "false",
      CF_QUICK_TUNNELS: "false",
    });
    await waitForComfyUIToStart();

    // Start the server
    await server.listen({ port, host: HOST });
    console.log(`Server listening on ${HOST}:${PORT}`);
  } catch (err: any) {
    console.error(`Failed to start server: ${err.message}`);
    process.exit(1);
  }
}

startServer();
