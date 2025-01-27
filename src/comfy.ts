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
  ComfyPromptResponse,
  ComfyHistoryResponse,
} from "./types";
import path from "path";
import fsPromises from "fs/promises";
import WebSocket, { MessageEvent } from "ws";
import { fetch, Agent } from "undici";

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
      dispatcher: new Agent({
        headersTimeout: 0,
        bodyTimeout: 0,
        connectTimeout: 0,
      }),
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
  const { prompt_id } = (await resp.json()) as ComfyPromptResponse;
  return prompt_id;
}

export async function getPromptOutputs(
  promptId: string,
  log: FastifyBaseLogger
): Promise<Record<string, Buffer> | null> {
  const resp = await fetch(`${config.comfyURL}/history/${promptId}`);
  if (!resp.ok) {
    const txt = await resp.text();
    log.error(`Failed to get prompt outputs: ${txt}`);
    throw new Error(`Failed to get prompt outputs: ${txt}`);
  }
  const body = (await resp.json()) as ComfyHistoryResponse;
  const allOutputs: Record<string, Buffer> = {};
  const fileLoadPromises: Promise<void>[] = [];
  if (!body[promptId]) {
    log.debug(`Prompt ${promptId} not found in history endpoint response`);
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
    log.error(JSON.stringify(status));
    throw new Error("Prompt execution failed");
  } else {
    log.debug(JSON.stringify(status));
    throw new Error("Prompt is not completed");
  }
  await Promise.all(fileLoadPromises);
  return allOutputs;
}

export async function waitForPromptToComplete(
  promptId: string
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const handleMessage = (event: MessageEvent) => {
      const { data } = event;
      if (typeof data === "string") {
        const message = JSON.parse(data) as ComfyWSMessage;
        if (
          isExecutionSuccessMessage(message) &&
          message.data.prompt_id === promptId
        ) {
          wsClient?.removeEventListener("close", onClose);
          wsClient?.removeEventListener("message", handleMessage);
          return resolve(true);
        } else if (
          isExecutionErrorMessage(message) &&
          message.data.prompt_id === promptId
        ) {
          return reject(new Error("Prompt execution failed"));
        } else if (
          isExecutionInterruptedMessage(message) &&
          message.data.prompt_id === promptId
        ) {
          return reject(new Error("Prompt execution interrupted"));
        }
      }
    };
    wsClient?.addEventListener("message", handleMessage);

    const onClose = () => {
      wsClient?.removeEventListener("message", handleMessage);
      wsClient?.removeEventListener("close", onClose);
      return reject(new Error("Websocket closed"));
    };
    wsClient?.addEventListener("close", onClose);
  });
}

export const comfyIDToApiID: Record<string, string> = {};

class HistoryEndpointPoller {
  private promptId: string;
  private log: FastifyBaseLogger;
  private maxTries: number;
  private interval: number;
  private currentTries: number = 0;
  private sleepTimer: NodeJS.Timeout | null = null;
  private resolveCurrentSleep: (() => void) | null = null;
  constructor(options: {
    promptId: string;
    log: FastifyBaseLogger;
    maxTries: number;
    interval: number;
  }) {
    this.promptId = options.promptId;
    this.log = options.log;
    this.maxTries = options.maxTries;
    this.interval = options.interval;
  }
  async poll(): Promise<Record<string, Buffer> | null> {
    while (this.currentTries < this.getMaxTries() || this.maxTries === 0) {
      this.log.debug(
        `Polling history endpoint for prompt ${this.promptId}, try ${
          this.currentTries
        } of ${this.getMaxTries()}`
      );
      const outputs = await getPromptOutputs(this.promptId, this.log);
      if (outputs) {
        return outputs;
      }
      this.currentTries++;
      this.log.debug(
        `Polling history endpoint for prompt ${
          this.promptId
        }, sleep for ${this.getInterval()}ms`
      );
      await new Promise<void>((resolve) => {
        this.resolveCurrentSleep = resolve;
        this.sleepTimer = setTimeout(resolve, this.getInterval());
      });
    }
    return null;
  }

  getInterval(): number {
    return this.interval;
  }

  getMaxTries(): number {
    return this.maxTries;
  }

  setInterval(interval: number, skipCurrentTimeout: boolean = true): void {
    this.interval = interval;
    if (skipCurrentTimeout && this.sleepTimer) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
    }
    if (skipCurrentTimeout && this.resolveCurrentSleep) {
      this.resolveCurrentSleep();
      this.resolveCurrentSleep = null;
    }
  }

  setMaxTries(maxTries: number, reset: boolean = true): void {
    this.maxTries = maxTries;
    if (reset) {
      this.currentTries = 0;
    }
  }

  stop(): void {
    this.setMaxTries(this.currentTries);
    this.setInterval(0);
  }
}

export async function runPromptAndGetOutputs(
  id: string,
  prompt: ComfyPrompt,
  log: FastifyBaseLogger
): Promise<Record<string, Buffer>> {
  const promptId = await queuePrompt(prompt);
  comfyIDToApiID[promptId] = id;
  log.debug(`Prompt ${id} queued as comfy prompt id: ${promptId}`);
  /**
   * We start with a slow poll to the history endpoint, both as a safety measure around websocket
   * failures, and to avoid hammering the history endpoint with requests in the case of many queued
   * prompts.
   */
  const poller = new HistoryEndpointPoller({
    promptId,
    log,
    maxTries: 0,
    interval: 1000,
  });
  const historyPoll = poller.poll();

  /**
   * We also listen to the websocket stream for the prompt to complete.
   */
  const wsSuccessEvent = waitForPromptToComplete(promptId);

  /**
   * We wait for either the history endpoint to return the outputs, or the websocket
   * to signal that the prompt has completed.
   */
  let firstToComplete: Record<string, Buffer> | boolean | null;
  try {
    firstToComplete = await Promise.race([historyPoll, wsSuccessEvent]);
  } catch (e) {
    /**
     * If an error is thrown by either of those processes, we stop the polling and
     * throw an error.
     */
    log.error(`Error waiting for prompt to complete: ${e}`);
    firstToComplete = false;
  }

  if (firstToComplete === true) {
    /**
     * If the websocket signals that the prompt has completed (this is typical), we can speed
     * up the history endpoint polling, as it should only need 1-2 tries to get the outputs.
     */
    log.info(`Prompt ${id} completed`);
    poller.setMaxTries(100);
    poller.setInterval(50);
    const outputs = await historyPoll;
    /**
     * We delete the comfyIDToApiID mapping after a short delay to prevent
     * this object from growing indefinitely.
     */
    setTimeout(() => {
      delete comfyIDToApiID[promptId];
    }, 1000);
    if (outputs) {
      return outputs;
    }
    throw new Error("Failed to get prompt outputs");
  } else if (firstToComplete === null) {
    throw new Error("Failed to get prompt outputs");
  } else if (firstToComplete === false) {
    poller.stop();
    throw new Error("Prompt execution failed");
  }
  /**
   * If we reach this point, it means that the history endpoint returned the outputs
   * before the websocket signaled that the prompt had completed. This is unexpected,
   * but fine. We return the outputs and delete the comfyIDToApiID mapping.
   */
  setTimeout(() => {
    /**
     * We delete the comfyIDToApiID mapping after a short delay to prevent
     * this object from growing indefinitely.
     */
    delete comfyIDToApiID[promptId];
  }, 1000);
  return firstToComplete;
}

let wsClient: WebSocket | null = null;

export function connectToComfyUIWebsocketStream(
  hooks: WebhookHandlers,
  log: FastifyBaseLogger,
  useApiIDs: boolean = true
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    wsClient = new WebSocket(config.comfyWSURL);
    wsClient.on("message", (data, isBinary) => {
      if (hooks.onMessage) {
        hooks.onMessage(data);
      }
      if (!isBinary) {
        const message = JSON.parse(data.toString("utf8")) as ComfyWSMessage;
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
        } else if (isExecutionStartMessage(message) && hooks.onExecutionStart) {
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
        } else if (isExecutionErrorMessage(message) && hooks.onExecutionError) {
          hooks.onExecutionError(message);
        }
      } else {
        log.info(`Received binary message`);
      }
    });

    wsClient.on("open", () => {
      log.info("Connected to Comfy UI websocket");

      return resolve(wsClient as WebSocket);
    });
    wsClient.on("error", (error) => {
      log.error(`Failed to connect to Comfy UI websocket: ${error}`);
      return reject(error);
    });

    wsClient.on("close", () => {
      log.info("Disconnected from Comfy UI websocket");
    });
  });
}
