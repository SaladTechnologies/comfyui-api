import config from "./config";
import { FastifyBaseLogger } from "fastify";
import fs, { ReadStream } from "fs";
import fsPromises from "fs/promises";
import { Readable } from "stream";
import path from "path";
import { randomUUID } from "crypto";
import { ZodObject, ZodRawShape, ZodTypeAny, ZodDefault } from "zod";
import sharp from "sharp";
import { OutputConversionOptions, WebhookHandlers } from "./types";
import { fetch, RequestInit, Response } from "undici";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";

export let s3: S3Client | null = null;
if (config.awsRegion) {
  s3 = new S3Client({
    region: config.awsRegion,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 10000, // 10 seconds
      requestTimeout: 0, // No timeout
    }),
    forcePathStyle: true, // Required for LocalStack or custom S3 endpoints
  });
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    await new Promise<void>((resolve, reject) => {
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

export async function downloadImageFromS3(
  bucket: string,
  key: string,
  outputPath: string,
  log: FastifyBaseLogger
): Promise<string | undefined> {
  if (!s3) {
    throw new Error("S3 client is not configured");
  }

  try {
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    const response = await s3.send(command);

    if (!response.Body) {
      throw new Error("Response body is null");
    }

    const fileStream = fs.createWriteStream(outputPath);
    await new Promise<void>((resolve, reject) => {
      (response.Body as Readable)
        .pipe(fileStream)
        .on("finish", resolve)
        .on("error", reject);
    });

    log.info(`Image downloaded from S3 and saved to ${outputPath}`);
    return outputPath;
  } catch (error) {
    console.error(error);
    log.error("Error downloading image from S3:", error);
  }
}

function createInputStream(fileOrPath: string | Buffer): ReadStream | Buffer {
  if (typeof fileOrPath === "string") {
    return fs.createReadStream(fileOrPath);
  } else {
    return fileOrPath;
  }
}

export async function uploadImageToS3(
  bucket: string,
  key: string,
  fileOrPath: string | Buffer,
  contentType: string,
  log: FastifyBaseLogger
): Promise<void> {
  if (!s3) {
    throw new Error("S3 client is not configured");
  }
  log.info(`Uploading image to S3 at s3://${bucket}/${key}`);

  try {
    const fileStream = createInputStream(fileOrPath);
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fileStream,
      ContentType: contentType,
    });
    await s3.send(command);
    log.info(`Image uploaded to S3 at s3://${bucket}/${key}`);
  } catch (error) {
    console.error(error);
    log.error("Error uploading image to S3:", error);
  }
}

export async function processImage(
  imageInput: string,
  log: FastifyBaseLogger,
  dirWithinInputDir?: string
): Promise<string> {
  let localFilePath: string;
  const ext = path.extname(imageInput).split("?")[0];
  const localFileName = `${randomUUID()}${ext}`;
  if (dirWithinInputDir) {
    localFilePath = path.join(
      config.inputDir,
      dirWithinInputDir,
      localFileName
    );
    // Create the directory if it doesn't exist
    await fsPromises.mkdir(path.dirname(localFilePath), { recursive: true });
  } else {
    localFilePath = path.join(config.inputDir, localFileName);
  }
  // If image is a url, download it
  if (imageInput.startsWith("http")) {
    await downloadImage(imageInput, localFilePath, log);
    return localFilePath;
  }

  // If image is an S3 URL, download it
  else if (imageInput.startsWith("s3://")) {
    const s3Url = new URL(imageInput);
    const bucket = s3Url.hostname;
    const key = s3Url.pathname.slice(1); // Remove leading slash
    const filepath = await downloadImageFromS3(bucket, key, localFilePath, log);
    if (!filepath) {
      throw new Error(`Failed to download image from S3: ${imageInput}`);
    }
    return filepath;
  }

  // If image is already a local path, return it as an absolute path
  else if (
    (imageInput.startsWith("/") &&
      imageInput.length < 4096 &&
      !imageInput.endsWith("==")) ||
    imageInput.startsWith("./") ||
    imageInput.startsWith("../")
  ) {
    return path.resolve(imageInput);
  }

  // Assume it's a base64 encoded image
  else {
    try {
      const base64Data = Buffer.from(imageInput, "base64");
      const image = sharp(base64Data);
      const metadata = await image.metadata();
      if (!metadata.format) {
        throw new Error("Failed to parse image metadata");
      }
      localFilePath = `${localFilePath}.${metadata.format}`;
      log.debug(`Saving decoded image to ${localFilePath}`);
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
  } else if (format === "jpg" || format === "jpeg") {
    image = image.jpeg(conversionOptions);
  }

  return image.toBuffer();
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
    } catch (error) {
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
