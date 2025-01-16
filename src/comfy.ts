import { sleep } from "./utils";
import config from "./config";
import { CommandExecutor } from "./commands";
import { FastifyBaseLogger } from "fastify";
import {
  ComfyPrompt,
  ComfyWSMessage,
  isStatusMessage,
  isProgressMessage,
  isExecutionStartMessage,
  isExecutionCachedMessage,
  isExecutedMessage,
  isExecutionSuccessMessage,
  isExecutingMessage,
  isExecutionInterruptedMessage,
  isExecutionErrorMessage,
  WebhookHandlers,
} from "./types";
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
    body: JSON.stringify({ prompt, client_id: config.wsClientId }),
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

export const comfyIDToApiID: Record<string, string> = {};

export async function runPromptAndGetOutputs(
  id: string,
  prompt: ComfyPrompt,
  log: FastifyBaseLogger
): Promise<Record<string, Buffer>> {
  const promptId = await queuePrompt(prompt);
  comfyIDToApiID[promptId] = id;
  log.info(`Prompt ${id} queued as comfy prompt id: ${promptId}`);
  while (true) {
    const outputs = await getPromptOutputs(promptId, log);
    if (outputs) {
      return outputs;
    }
    await sleep(50);
  }
}

export function connectToComfyUIWebsocketStream(
  hooks: WebhookHandlers,
  log: FastifyBaseLogger,
  useApiIDs: boolean = true
): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = new WebSocketClient();
    client.connect(config.comfyWSURL);
    client.on("connect", (connection) => {
      log.info("Connected to Comfy UI websocket");
      connection.on("message", (data) => {
        if (hooks.onMessage) {
          hooks.onMessage(data);
        }
        if (data.type === "utf8") {
          const message = JSON.parse(data.utf8Data) as ComfyWSMessage;
          if (
            useApiIDs &&
            message.data.prompt_id &&
            comfyIDToApiID[message.data.prompt_id]
          ) {
            message.data.prompt_id = comfyIDToApiID[message.data.prompt_id];
          }
          if (isStatusMessage(message) && hooks.onStatus) {
            hooks.onStatus(message);
          } else if (isProgressMessage(message) && hooks.onProgress) {
            hooks.onProgress(message);
          } else if (
            isExecutionStartMessage(message) &&
            hooks.onExecutionStart
          ) {
            hooks.onExecutionStart(message);
          } else if (
            isExecutionCachedMessage(message) &&
            hooks.onExecutionCached
          ) {
            hooks.onExecutionCached(message);
          } else if (isExecutingMessage(message) && hooks.onExecuting) {
            hooks.onExecuting(message);
          } else if (isExecutedMessage(message) && hooks.onExecuted) {
            hooks.onExecuted(message);
          } else if (
            isExecutionSuccessMessage(message) &&
            hooks.onExecutionSuccess
          ) {
            hooks.onExecutionSuccess(message);
          } else if (
            isExecutionInterruptedMessage(message) &&
            hooks.onExecutionInterrupted
          ) {
            hooks.onExecutionInterrupted(message);
          } else if (
            isExecutionErrorMessage(message) &&
            hooks.onExecutionError
          ) {
            hooks.onExecutionError(message);
          }
        } else {
          log.info(`Received ${data.type} message`);
        }
      });
      resolve();
    });
    client.on("connectFailed", (error) => {
      log.error(`Failed to connect to Comfy UI websocket: ${error}`);
      reject(error);
    });
  });
}
