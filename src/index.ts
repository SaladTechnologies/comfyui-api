import Fastify from "fastify";
import { CommandExecutor } from "./commands";
import { DirectoryWatcher } from "./watcher";
import fsPromises from "fs/promises";
import fs from "fs";
import path from "path";
import { version } from "../package.json";
import { randomUUID } from "crypto";
import { Readable } from "stream";

const {
  CMD = "init.sh",
  HOST = "::",
  PORT = "3000",
  DIRECT_ADDRESS = "127.0.0.1",
  COMFYUI_PORT_HOST = "8188",
  STARTUP_CHECK_INTERVAL_S = "1",
  STARTUP_CHECK_MAX_TRIES = "10",
  OUTPUT_DIR = "/opt/ComfyUI/output",
  INPUT_DIR = "/opt/ComfyUI/input",
} = process.env;

const comfyURL = `http://${DIRECT_ADDRESS}:${COMFYUI_PORT_HOST}`;
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
      server.log.info("Comfy UI started");
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

async function downloadImage(
  imageUrl: string,
  outputPath: string
): Promise<void> {
  try {
    // Fetch the image
    const response = await fetch(imageUrl);

    if (!response.ok) {
      throw new Error(`Error downloading image: ${response.statusText}`);
    }

    // Get the response as a readable stream
    const body = response.body;
    if (!body) {
      throw new Error("Response body is null");
    }

    // Create a writable stream to save the file
    const fileStream = fs.createWriteStream(outputPath);

    // Pipe the response to the file
    await new Promise((resolve, reject) => {
      Readable.fromWeb(body as any)
        .pipe(fileStream)
        .on("finish", resolve)
        .on("error", reject);
    });

    server.log.info(`Image downloaded and saved to ${outputPath}`);
  } catch (error) {
    server.log.error("Error downloading image:", error);
  }
}

server.post("/prompt", async (request, reply) => {
  let { prompt, id, webhook } = request.body as PromptRequest;
  if (!prompt) {
    return reply.code(400).send({ error: "prompt is required" });
  }
  if (!id) {
    id = randomUUID();
  }

  let batchSize = 1;

  let imagesRequested = 0;

  for (const nodeId in prompt) {
    const node = prompt[nodeId];
    if (node.class_type === "SaveImage") {
      node.inputs.filename_prefix = id;
    } else if (node.inputs.batch_size) {
      batchSize = node.inputs.batch_size;
    } else if (node.class_type === "LoadImage") {
      const imageInput = node.inputs.image;
      imagesRequested += 1;

      // If image is a url, download it
      if (imageInput.startsWith("http")) {
        const downloadPath = path.join(INPUT_DIR, `${id}-${imagesRequested}`);
        await downloadImage(imageInput, downloadPath);
        node.inputs.image = downloadPath;
      } else {
        // Assume it's a base64 encoded image
        try {
          const base64Data = Buffer.from(imageInput, "base64");
          const downloadPath = path.join(
            INPUT_DIR,
            `${id}-${imagesRequested}.png`
          );
          await fsPromises.writeFile(downloadPath, base64Data);
          node.inputs.image = downloadPath;
        } catch (e) {
          return reply.code(400).send({
            error: `Failed to parse base64 encoded image: prompt.${nodeId}.inputs.image`,
          });
        }
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
            const base64File = await fsPromises.readFile(filepath, {
              encoding: "base64",
            });
            images.push(base64File);

            // Remove the file after reading
            fsPromises.unlink(filepath);

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
  server.log.info("Received SIGINT, interrupting process");
  commandExecutor.interrupt();
  await outputWatcher.stopWatching();
  process.exit(0);
});

async function startServer() {
  try {
    start = Date.now();
    // Start the command
    commandExecutor.execute(CMD, [], {
      DIRECT_ADDRESS,
      COMFYUI_PORT_HOST,
      WEB_ENABLE_AUTH: "false",
      CF_QUICK_TUNNELS: "false",
    });
    await waitForComfyUIToStart();
    warm = true;

    // Start the server
    await server.listen({ port, host: HOST });
    server.log.info(`Server listening on ${HOST}:${PORT}`);
  } catch (err: any) {
    server.log.error(`Failed to start server: ${err.message}`);
    process.exit(1);
  }
}

startServer();
