import { sleep } from "./utils";
import config from "./config";
import { CommandExecutor } from "./commands";
import { FastifyBaseLogger } from "fastify";
import { ComfyPrompt } from "./types";
import path from "path";
import fsPromises from "fs/promises";
import { Message, client as WebSocketClient } from "websocket";

const commandExecutor = new CommandExecutor();

export function launchComfyUI() {
  const cmdAndArgs = config.comfyLaunchCmd.split(" ");
  const cmd = cmdAndArgs[0];
  const args = cmdAndArgs.slice(1);
  return commandExecutor.execute(cmd, args, {
    DIRECT_ADDRESS: config.comfyHost,
    COMFYUI_PORT_HOST: config.comfyPort,
    WEB_ENABLE_AUTH: "false",
    CF_QUICK_TUNNELS: "false",
  });
}

export function shutdownComfyUI() {
  commandExecutor.interrupt();
}

export async function pingComfyUI(): Promise<void> {
  const res = await fetch(config.comfyURL);
  if (!res.ok) {
    throw new Error(`Failed to ping Comfy UI: ${await res.text()}`);
  }
}

export async function waitForComfyUIToStart(
  log: FastifyBaseLogger
): Promise<void> {
  let retries = 0;
  while (retries < config.startupCheckMaxTries) {
    try {
      await pingComfyUI();
      log.info("Comfy UI started");
      return;
    } catch (e) {
      // Ignore
    }
    retries++;
    await sleep(config.startupCheckInterval);
  }

  throw new Error(
    `Comfy UI did not start after ${
      (config.startupCheckInterval / 1000) * config.startupCheckMaxTries
    } seconds`
  );
}

export async function warmupComfyUI(): Promise<void> {
  if (config.warmupPrompt) {
    const resp = await fetch(`http://localhost:${config.wrapperPort}/prompt`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt: config.warmupPrompt }),
    });
    if (!resp.ok) {
      throw new Error(`Failed to warmup Comfy UI: ${await resp.text()}`);
    }
  }
}

export async function queuePrompt(prompt: ComfyPrompt): Promise<string> {
  const resp = await fetch(`${config.comfyURL}/prompt`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt }),
  });
  if (!resp.ok) {
    throw new Error(`Failed to queue prompt: ${await resp.text()}`);
  }
  const { prompt_id } = await resp.json();
  return prompt_id;
}

export async function getPromptOutputs(
  promptId: string,
  log: FastifyBaseLogger
): Promise<Record<string, Buffer> | null> {
  const resp = await fetch(`${config.comfyURL}/history/${promptId}`);
  if (!resp.ok) {
    throw new Error(`Failed to get prompt outputs: ${await resp.text()}`);
  }
  const body = await resp.json();
  const allOutputs: Record<string, Buffer> = {};
  const fileLoadPromises: Promise<void>[] = [];
  if (!body[promptId]) {
    return null;
  }
  const { status, outputs } = body[promptId];
  if (status.completed) {
    for (const nodeId in outputs) {
      const node = outputs[nodeId];
      for (const outputType in node) {
        for (let outputFile of node[outputType]) {
          const filename = outputFile.filename;
          if (!filename) {
            /**
             * Some nodes have fields in the outputs that are not actual files.
             * For example, the SaveAnimatedWebP node has a field called "animated"
             * that only container boolean values mapping to the files present in
             * .images. We can safely ignore these.
             */
            continue;
          }
          const filepath = path.join(config.outputDir, filename);
          fileLoadPromises.push(
            fsPromises
              .readFile(filepath)
              .then((data) => {
                allOutputs[filename] = data;
              })
              .catch((e: any) => {
                /**
                 * The most likely reason for this is a node that has an optonal
                 * output. If the node doesn't produce that output, the file won't
                 * exist.
                 */
                log.warn(`Failed to read file ${filepath}: ${e.message}`);
              })
          );
        }
      }
    }
  } else if (status.status_str === "error") {
    throw new Error("Prompt execution failed");
  } else {
    console.log(JSON.stringify(status, null, 2));
    throw new Error("Prompt is not completed");
  }
  await Promise.all(fileLoadPromises);
  return allOutputs;
}

export async function runPromptAndGetOutputs(
  prompt: ComfyPrompt,
  log: FastifyBaseLogger
): Promise<Record<string, Buffer>> {
  const promptId = await queuePrompt(prompt);
  log.info(`Prompt queued with ID: ${promptId}`);
  while (true) {
    const outputs = await getPromptOutputs(promptId, log);
    if (outputs) {
      return outputs;
    }
    await sleep(50);
  }
}

export function getComfyUIWebsocketStream(
  onMessage: (msg: Message) => Promise<void>,
  log: FastifyBaseLogger
): Promise<void> {
  const client = new WebSocketClient();
  client.connect(config.comfyWSURL);
  return new Promise((resolve, reject) => {
    client.on("connect", (connection) => {
      log.info("Connected to Comfy UI websocket");
      connection.on("message", onMessage);
      resolve();
    });
    client.on("connectFailed", (error) => {
      log.error(`Failed to connect to Comfy UI websocket: ${error}`);
      reject(error);
    });
  });
}
