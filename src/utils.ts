import config from "./config";
import { FastifyBaseLogger } from "fastify";
import path from "path";
import fs from "fs";
import { ZodObject, ZodRawShape, ZodTypeAny, ZodDefault } from "zod";
import { fetch, RequestInit, Response } from "undici";
import { getProxyDispatcher } from "./proxy-dispatcher";
import { execFile } from "child_process";
import { promisify } from "util";
import getStorageManager from "./remote-storage-manager";
import crypto from "crypto";

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

/**
 * Converts a snake_case string to UpperCamelCase
 */
export function snakeCaseToUpperCamelCase(str: string): string {
  const camel = str.replace(/(_\w)/g, (match) => match[1].toUpperCase());
  const upperCamel = camel.charAt(0).toUpperCase() + camel.slice(1);
  return upperCamel;
}

export function camelCaseToSnakeCase(str: string): string {
  return str
    .replace(/([A-Z])/g, "_$1")
    .toLowerCase()
    .replace(/^_/, "");
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
      const response = await fetch(
        url,
        options.dispatcher ? options : { ...options, dispatcher: getProxyDispatcher() }
      );
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
  if (!config.saladMetadata) {
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
      dispatcher: getProxyDispatcher(),
    });
  } catch (error) {
    console.error("Error setting deletion cost:", error);
  }
}

function isPythonVenvActive(): boolean {
  // Check for VIRTUAL_ENV environment variable (most common indicator)
  if (process.env.VIRTUAL_ENV) {
    return true;
  }

  // Check for CONDA_DEFAULT_ENV (for conda environments)
  if (process.env.CONDA_DEFAULT_ENV) {
    return true;
  }

  // Additional check: VIRTUAL_ENV_PROMPT is set when venv is active
  if (process.env.VIRTUAL_ENV_PROMPT) {
    return true;
  }

  return false;
}

export async function installCustomNode(
  nodeNameOrUrl: string,
  log: FastifyBaseLogger
): Promise<void> {
  const storageManager = getStorageManager();
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
      customNodesDir
    );
    const requirementsPath = path.join(customNodePath, "requirements.txt");
    if (!fs.existsSync(requirementsPath)) {
      log.info(`No requirements.txt found for ${nodeNameOrUrl}, skipping dependency installation`);
      return;
    }
    const activeVenv = isPythonVenvActive();
    const args = ["pip", "install", "--system", "-r", "requirements.txt"];
    if (activeVenv) {
      args.splice(2, 1); // Remove --system if venv is active
      log.info(
        `Installing custom node ${nodeNameOrUrl} in active Python virtual environment`
      );
    }

    const cmd = config.uvInstalled ? "uv" : (args.shift() as string);

    await execFilePromise(cmd, args, { cwd: customNodePath });
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

export async function pipInstallPackages(
  packages: string[],
  log: FastifyBaseLogger
): Promise<void> {
  if (packages.length === 0) {
    return;
  }
  const activeVenv = isPythonVenvActive();
  const args = ["pip", "install", "--system", ...packages];
  if (activeVenv) {
    args.splice(2, 1); // Remove --system if venv is active
    log.info(
      `Installing pip packages in active Python virtual environment: ${packages.join(
        ", "
      )}`
    );
  } else {
    log.info(`Installing pip packages: ${packages.join(", ")}`);
  }

  const cmd = config.uvInstalled ? "uv" : (args.shift() as string);

  await execFilePromise(cmd, args);
}

export function makeHumanReadableSize(sizeInBytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = sizeInBytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

export function hashUrlBase64(url: string, length = 32): string {
  return crypto
    .createHash("sha256")
    .update(url)
    .digest("base64url") // URL-safe base64
    .substring(0, length);
}

export function getContentTypeFromUrl(url: string): string {
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".bmp": "image/bmp",
    ".tiff": "image/tiff",
    ".ico": "image/x-icon",
    ".mp4": "video/mp4",
    ".mpeg": "video/mpeg",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".weba": "audio/webm",
    ".aac": "audio/aac",
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx":
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".html": "text/html",
    ".rtf": "application/rtf",
    ".zip": "application/zip",
    ".tar": "application/x-tar",
    ".gz": "application/gzip",
    ".7z": "application/x-7z-compressed",
    ".rar": "application/x-rar-compressed",
    ".json": "application/json",
    ".xml": "application/xml",
    ".js": "application/javascript",
    ".css": "text/css",
    ".bin": "application/octet-stream",
    ".pt": "application/x-pytorch",
    ".pb": "application/x-tensorflow",
  };

  return mimeTypes[ext] || "application/octet-stream";
}

export async function getDirectorySizeInBytes(
  directoryPath: string
): Promise<number> {
  const { stdout } = await execFilePromise("du", ["-sb", directoryPath]);
  const sizeInBytes = parseInt(stdout.split("\t")[0], 10);
  return sizeInBytes;
}
