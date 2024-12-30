import config from "./config";
import { FastifyBaseLogger } from "fastify";
import { CommandExecutor } from "./commands";
import fs from "fs";
import fsPromises from "fs/promises";
import { Readable } from "stream";
import path from "path";
import { randomUUID } from "crypto";
import { ZodObject, ZodRawShape, ZodTypeAny, ZodDefault } from "zod";
import sharp from "sharp";
import { OutputConversionOptions } from "./types";

const commandExecutor = new CommandExecutor();

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function launchComfyUI() {
  const cmdAndArgs = config.comfyLaunchCmd.split(" ");
  const cmd = cmdAndArgs[0];
  const args = cmdAndArgs.slice(1);
  commandExecutor.execute(cmd, args, {
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
    await fetch(`http://localhost:${config.wrapperPort}/prompt`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt: config.warmupPrompt }),
    });
  }
}

export async function downloadImage(
  imageUrl: string,
  outputPath: string,
  log: FastifyBaseLogger
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

    log.info(`Image downloaded and saved to ${outputPath}`);
  } catch (error) {
    log.error("Error downloading image:", error);
  }
}

export async function processImage(
  imageInput: string,
  log: FastifyBaseLogger
): Promise<string> {
  const localFilePath = path.join(config.inputDir, `${randomUUID()}.png`);
  // If image is a url, download it
  if (imageInput.startsWith("http")) {
    await downloadImage(imageInput, localFilePath, log);
    return localFilePath;
  }
  // If image is already a local path, return it as an absolute path
  else if (
    imageInput.startsWith("/") ||
    imageInput.startsWith("./") ||
    imageInput.startsWith("../")
  ) {
    return path.resolve(imageInput);
  } else {
    // Assume it's a base64 encoded image
    try {
      const base64Data = Buffer.from(imageInput, "base64");
      await fsPromises.writeFile(localFilePath, base64Data);
      return localFilePath;
    } catch (e: any) {
      throw new Error(`Failed to parse base64 encoded image: ${e.message}`);
    }
  }
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

export async function convertImageBuffer(
  imageBuffer: Buffer,
  options: OutputConversionOptions
) {
  const { format, options: conversionOptions } = options;
  let image = sharp(imageBuffer);

  if (format === "webp") {
    image = image.webp(conversionOptions);
  } else {
    image = image.jpeg(conversionOptions);
  }

  return image.toBuffer();
}
