import crypto from "crypto";
import config from "./config";
import { FastifyBaseLogger } from "fastify";
import { Agent } from "undici";
import { fetchWithRetries, snakeCaseToUpperCamelCase } from "./utils";
import { WebhookHandlers } from "./types";

export function signWebhookPayload(payload: string): string {
  return crypto
    .createHmac("sha256", config.webhookSecret ?? "")
    .update(payload)
    .digest("hex");
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
    Object.assign(headers, {
      "webhook-id": body.id,
      "webhook-timestamp": Math.round(Date.now() / 1000).toString(),
      "webhook-signature": signWebhookPayload(bodyString),
    });
  }
  try {
    fetchWithRetries(
      url,
      {
        method: "POST",
        headers,
        body: bodyString,
        dispatcher: new Agent({
          headersTimeout: 0,
          bodyTimeout: 0,
          connectTimeout: 0,
        }),
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
  const metadata: Record<string, string> = { ...config.systemMetaData };
  if (config.saladContainerGroupId) {
    metadata["salad_container_group_id"] = config.saladContainerGroupId;
  }
  if (config.saladMachineId) {
    metadata["salad_machine_id"] = config.saladMachineId;
  }
  if (config.systemWebhook) {
    const payload = { event: eventName, data, metadata };
    await sendWebhook(config.systemWebhook, payload, log, 2);
  }
}

export function getConfiguredWebhookHandlers(
  log: FastifyBaseLogger
): WebhookHandlers {
  const handlers: Record<string, (d: any) => void> = {};
  if (config.systemWebhook) {
    const systemWebhookEvents = config.systemWebhookEvents;
    for (const eventName of systemWebhookEvents) {
      const handlerName = `on${snakeCaseToUpperCamelCase(eventName)}`;
      handlers[handlerName] = (data: any) => {
        log.debug(`Sending system webhook for event: ${eventName}`);
        sendSystemWebhook(`comfy.${eventName}`, data, log);
      };
    }
  }

  return handlers as WebhookHandlers;
}
