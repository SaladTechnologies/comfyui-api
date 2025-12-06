import crypto from "crypto";
import config from "./config";
import { FastifyBaseLogger } from "fastify";
import { getProxyDispatcher } from "./proxy-dispatcher";
import {
  fetchWithRetries,
  snakeCaseToUpperCamelCase,
  camelCaseToSnakeCase,
} from "./utils";
import { WebhookHandlers } from "./types";

export function signWebhookPayload(payload: string): string {
  return crypto
    .createHmac("sha256", Buffer.from(config.webhookSecret ?? "", "base64"))
    .update(payload)
    .digest("base64");
}

export async function sendWebhook(
  url: string,
  body: any,
  log: FastifyBaseLogger,
  version: number = 1
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const bodyString = JSON.stringify(body);
  if (version === 2) {
    const webhookId = body.id || crypto.randomUUID();
    const timestamp = Math.round(Date.now() / 1000).toString();
    const signedContent = `${webhookId}.${timestamp}.${bodyString}`;
    const signature = signWebhookPayload(signedContent);
    Object.assign(headers, {
      "webhook-id": webhookId,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`,
    });
  }
  try {
    await fetchWithRetries(
      url,
      {
        method: "POST",
        headers,
        body: bodyString,
        dispatcher: getProxyDispatcher(),
      },
      config.promptWebhookRetries,
      log
    );
  } catch (e: any) {
    log.error(`Failed to send webhook to ${url}: ${e.message}`);
  }
}

export async function sendSystemWebhook(
  eventName: string,
  data: any,
  log: FastifyBaseLogger
): Promise<void> {
  if (
    !config.systemWebhookEvents.includes(eventName) ||
    !config.systemWebhook
  ) {
    log.debug(
      `System webhook for event ${eventName} is not configured to be sent.`
    );
    return;
  }

  const eventLabel = [
    "file_downloaded",
    "file_uploaded",
    "file_deleted",
  ].includes(eventName)
    ? "storage"
    : "comfy";

  const metadata: Record<string, string> = { ...config.systemMetaData };
  if (config.saladMetadata) {
    for (const [key, value] of Object.entries(config.saladMetadata)) {
      if (value) {
        metadata[`salad_${camelCaseToSnakeCase(key)}`] = value;
      }
    }
  }
  const payload = { event: `${eventLabel}.${eventName}`, data, metadata };
  await sendWebhook(config.systemWebhook, payload, log, 2);
}

import { AmqpClient } from "./amqp-client";

export function getConfiguredWebhookHandlers(
  log: FastifyBaseLogger,
  amqpClient?: AmqpClient
): WebhookHandlers {
  const handlers: Record<string, (d: any) => void> = {};

  // Determine which event delivery method to use
  // Priority: AMQP > Webhook
  const useAMQP = amqpClient !== null;
  const useWebhook = config.systemWebhook && !useAMQP;

  if (!useAMQP && !useWebhook) {
    log.info("No system event handlers configured (neither AMQP nor Webhook)");
    return handlers;
  }

  log.info(`System events will be sent via: ${useAMQP ? 'AMQP' : 'Webhook'}`);

  // We register handlers if either systemWebhook is configured OR amqpClient is provided
  if (useWebhook || useAMQP) {
    const systemWebhookEvents = config.systemWebhookEvents;
    for (const eventName of systemWebhookEvents) {
      const handlerName = `on${snakeCaseToUpperCamelCase(eventName)}`;
      handlers[handlerName] = (data: any) => {
        log.debug(`Processing system event: ${eventName}`);

        // Special handling: Filter WebSocket execution_success events
        // We only want the execution_success from processPrompt completion (with full results)
        if (eventName === 'execution_success') {
          // Check if this is a WebSocket event (only has prompt_id and timestamp, no images)
          const isWebSocketEvent = data?.data?.prompt_id &&
            data?.data?.timestamp &&
            !data?.images;

          if (isWebSocketEvent) {
            log.debug(`Skipping WebSocket execution_success, waiting for processPrompt result`);
            return;
          }
        }

        // 1. Send via Webhook if configured
        if (useWebhook) {
          sendSystemWebhook(eventName, data, log);
        }

        // 2. Send via AMQP if configured
        if (useAMQP && amqpClient) {
          // Since we now pass task ID directly to ComfyUI as prompt_id,
          // the prompt_id in the event data IS the task ID
          const promptId = data?.data?.prompt_id || data?.prompt_id;
          const taskId = promptId || data?.id || "system";

          // Construct metadata (same as webhook)
          const metadata: Record<string, string> = { ...config.systemMetaData };
          if (config.saladMetadata) {
            for (const [key, value] of Object.entries(config.saladMetadata)) {
              if (value) {
                metadata[`salad_${camelCaseToSnakeCase(key)}`] = value;
              }
            }
          }

          amqpClient.publishEvent(taskId, eventName, data, metadata);
        }
      };
    }
  }

  log.debug(
    `Configured webhook handlers for events: ${Object.keys(handlers).join(
      ", "
    )}`
  );

  return handlers as WebhookHandlers;
}
