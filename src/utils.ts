import config from "./config";
import { FastifyBaseLogger } from "fastify";
import path from "path";
import { ZodObject, ZodRawShape, ZodTypeAny, ZodDefault } from "zod";
import { WebhookHandlers } from "./types";
import { fetch, RequestInit, Response } from "undici";
import { execFile } from "child_process";
import { promisify } from "util";
import storageManager from "./remote-storage-manager";

const execFilePromise = promisify(execFile);

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isValidUrl(str: string): boolean {
  try {
    new URL(str);
  } catch (_) {
    return false;
  }
  return (
    str.startsWith("http://") ||
    str.startsWith("https://") ||
    str.startsWith("s3://")
  );
}

export function zodToMarkdownTable(schema: ZodObject<ZodRawShape>): string {
  const shape = schema.shape;
  let markdownTable = "| Field | Type | Description | Default |\n|-|-|-|-|\n";

  for (const [key, value] of Object.entries(shape)) {
    const fieldName = key;
    const { type: fieldType, isOptional } = getZodTypeName(value);
    const fieldDescription = getZodDescription(value);
    const defaultValue = getZodDefault(value);

    markdownTable += `| ${fieldName} | ${fieldType}${
      isOptional ? "" : ""
    } | ${fieldDescription} | ${defaultValue || "**Required**"} |\n`;
  }

  return markdownTable;
}

function getZodTypeName(zodType: ZodTypeAny): {
  type: string;
  isOptional: boolean;
} {
  let currentType = zodType;
  let isOptional = false;

  while (currentType instanceof ZodDefault) {
    currentType = currentType._def.innerType;
  }

  if (currentType._def.typeName === "ZodOptional") {
    isOptional = true;
    currentType = currentType._def.innerType;
  }

  let type: string;
  switch (currentType._def.typeName) {
    case "ZodString":
      type = "string";
      break;
    case "ZodNumber":
      type = "number";
      break;
    case "ZodBoolean":
      type = "boolean";
      break;
    case "ZodArray":
      type = `${getZodTypeName(currentType._def.type).type}[]`;
      break;
    case "ZodObject":
      type = "object";
      break;
    case "ZodEnum":
      type = `enum (${(currentType._def.values as string[])
        .map((val: string) => `\`${val}\``)
        .join(", ")})`;
      break;
    case "ZodUnion":
      type = currentType._def.options
        .map((opt: any) => getZodTypeName(opt).type)
        .join(", ");
      break;
    case "ZodLiteral":
      type = `literal (${JSON.stringify(currentType._def.value)})`;
      break;
    default:
      type = currentType._def.typeName.replace("Zod", "").toLowerCase();
  }

  return { type, isOptional };
}

function getZodDescription(zodType: ZodTypeAny): string {
  let currentType: ZodTypeAny | undefined = zodType;
  while (currentType) {
    if (currentType.description) {
      return currentType.description;
    }
    currentType = currentType._def.innerType;
  }
  return "";
}

function getZodDefault(zodType: ZodTypeAny): string {
  if (zodType instanceof ZodDefault) {
    const defaultValue = zodType._def.defaultValue();
    return JSON.stringify(defaultValue);
  }
  return "-";
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
    try {
      const response = await fetch(config.systemWebhook, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ event: eventName, data, metadata }),
      });

      if (!response.ok) {
        log.error(`Failed to send system webhook: ${await response.text()}`);
      }
    } catch (error: any) {
      log.error("Error sending system webhook:", error);
    }
  }
}

/**
 * Converts a snake_case string to UpperCamelCase
 */
function snakeCaseToUpperCamelCase(str: string): string {
  const camel = str.replace(/(_\w)/g, (match) => match[1].toUpperCase());
  const upperCamel = camel.charAt(0).toUpperCase() + camel.slice(1);
  return upperCamel;
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

export async function fetchWithRetries(
  url: string,
  options: RequestInit,
  maxRetries: number,
  log: FastifyBaseLogger
): Promise<Response> {
  let retries = 0;
  while (retries < maxRetries) {
    try {
      const response = await fetch(url, options);
      if (response.ok) {
        return response;
      }
      log.error(
        `Failed to fetch ${url}: ${response.status} ${response.statusText}`
      );
    } catch (error) {
      log.error(`Error fetching ${url}: ${error}`);
    }
    retries++;
    await sleep(1000);
  }
  throw new Error(`Failed to fetch ${url} after ${maxRetries} retries`);
}

export async function setDeletionCost(cost: number): Promise<void> {
  if (!(config.saladMachineId && config.saladContainerGroupId)) {
    // If not running in Salad environment, skip setting deletion cost
    return;
  }
  try {
    await fetch(`http://169.254.169.254/v1/deletion-cost`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Metadata: "true",
      },
      body: JSON.stringify({ deletion_cost: cost }),
    });
  } catch (error) {
    console.error("Error setting deletion cost:", error);
  }
}

export async function installCustomNode(
  nodeNameOrUrl: string,
  log: FastifyBaseLogger
): Promise<void> {
  const isUrl =
    nodeNameOrUrl.startsWith("http://") || nodeNameOrUrl.startsWith("https://");
  if (!isUrl && config.comfyCLIVersion) {
    // Install from ComfyUI community nodes if comfy cli is available
    log.info(`Installing custom node ${nodeNameOrUrl} using comfy cli`);
    await execFilePromise("comfy", [
      "node",
      "install",
      nodeNameOrUrl,
      "--fast-deps",
      "--exit-on-fail",
    ]);
  } else if (!isUrl) {
    throw new Error(
      "ComfyUI CLI is not available to install custom node by name"
    );
  } else {
    const customNodesDir = path.join(config.comfyDir, "custom_nodes");
    const customNodePath = await storageManager.downloadRepo(
      nodeNameOrUrl,
      customNodesDir,
      log
    );

    await execFilePromise(
      "uv",
      ["pip", "install", "--system", "-r", "requirements.txt"],
      { cwd: customNodePath }
    );
  }
}

export async function aptInstallPackages(
  packages: string[],
  log: FastifyBaseLogger
): Promise<void> {
  if (packages.length === 0) {
    return;
  }
  await execFilePromise("apt-get", ["update"]);
  log.info(`Installing apt packages: ${packages.join(", ")}`);
  await execFilePromise("apt-get", ["install", "-y", ...packages]);
}
