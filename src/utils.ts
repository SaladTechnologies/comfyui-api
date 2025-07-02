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

export async function downloadFile(
  fileUrl: string,
  outputPath: string,
  log: FastifyBaseLogger
): Promise<void> {
  try {
    // Fetch the image
    const response = await fetch(fileUrl);

    if (!response.ok) {
      throw new Error(`Error downloading file: ${response.statusText}`);
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

    log.info(`File downloaded and saved to ${outputPath}`);
  } catch (error) {
    log.error("Error downloading file:", error);
  }
}

export async function downloadFileFromS3(
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

    log.info(`File downloaded from S3 and saved to ${outputPath}`);
    return outputPath;
  } catch (error) {
    console.error(error);
    log.error("Error downloading file from S3:", error);
  }
}

function createInputStream(fileOrPath: string | Buffer): ReadStream | Buffer {
  if (typeof fileOrPath === "string") {
    return fs.createReadStream(fileOrPath);
  } else {
    return fileOrPath;
  }
}

export async function uploadFileToS3(
  bucket: string,
  key: string,
  fileOrPath: string | Buffer,
  contentType: string,
  log: FastifyBaseLogger
): Promise<void> {
  if (!s3) {
    throw new Error("S3 client is not configured");
  }
  log.info(`Uploading file to S3 at s3://${bucket}/${key}`);

  try {
    const fileStream = createInputStream(fileOrPath);
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fileStream,
      ContentType: contentType,
    });
    await s3.send(command);
    log.info(`File uploaded to S3 at s3://${bucket}/${key}`);
  } catch (error) {
    console.error(error);
    log.error("Error uploading file to S3:", error);
  }
}

export async function processImageOrVideo(
  fileInput: string,
  log: FastifyBaseLogger,
  dirWithinInputDir?: string
): Promise<string> {
  let localFilePath: string;
  const ext = path.extname(fileInput).split("?")[0];
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
  if (fileInput.startsWith("http")) {
    await downloadFile(fileInput, localFilePath, log);
    return localFilePath;
  }

  // If image is an S3 URL, download it
  else if (fileInput.startsWith("s3://")) {
    const s3Url = new URL(fileInput);
    const bucket = s3Url.hostname;
    const key = s3Url.pathname.slice(1); // Remove leading slash
    const filepath = await downloadFileFromS3(bucket, key, localFilePath, log);
    if (!filepath) {
      throw new Error(`Failed to download image from S3: ${fileInput}`);
    }
    return filepath;
  }

  // If image is already a local path, return it as an absolute path
  else if (
    (fileInput.startsWith("/") &&
      fileInput.length < 4096 &&
      !fileInput.endsWith("==")) ||
    fileInput.startsWith("./") ||
    fileInput.startsWith("../")
  ) {
    return path.resolve(fileInput);
  }

  // Assume it's a base64 encoded image or video
  else {
    try {
      const base64Data = Buffer.from(fileInput, "base64");
      const extension = guessFileExtensionFromBase64(fileInput);
      if (!extension) {
        throw new Error("Could not determine file type from base64 data");
      }
      localFilePath = `${localFilePath}.${extension}`;
      log.debug(`Saving decoded file to ${localFilePath}`);
      await fsPromises.writeFile(localFilePath, base64Data);
      return localFilePath;
    } catch (e: any) {
      throw new Error(`Failed to parse base64 encoded file: ${e.message}`);
    }
  }
}

function guessFileExtensionFromBase64(base64Data: string): string | null {
  try {
    // Remove data URL prefix if present (e.g., "data:video/mp4;base64,")
    const cleanBase64 = base64Data.replace(/^data:[^;]+;base64,/, "");

    // Decode first 32 bytes to check file signatures
    const buffer = Buffer.from(cleanBase64.slice(0, 44), "base64"); // 44 chars = ~33 bytes
    const bytes = Array.from(buffer);

    // Helper function to check bytes at specific positions
    const checkBytes = (offset: number, expected: number[]): boolean => {
      return expected.every((byte, index) => bytes[offset + index] === byte);
    };

    // Helper function to check for string in buffer
    const hasString = (str: string): boolean => {
      return buffer.includes(Buffer.from(str));
    };

    // Images
    if (checkBytes(0, [0xff, 0xd8, 0xff])) return "jpg";
    if (checkBytes(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      return "png";
    if (
      checkBytes(0, [0x47, 0x49, 0x46, 0x38]) &&
      (bytes[4] === 0x37 || bytes[4] === 0x39)
    )
      return "gif";
    if (
      checkBytes(0, [0x52, 0x49, 0x46, 0x46]) &&
      checkBytes(8, [0x57, 0x45, 0x42, 0x50])
    )
      return "webp";
    if (checkBytes(0, [0x42, 0x4d])) return "bmp";
    if (
      checkBytes(0, [0x49, 0x49, 0x2a, 0x00]) ||
      checkBytes(0, [0x4d, 0x4d, 0x00, 0x2a])
    )
      return "tiff";
    if (checkBytes(0, [0x00, 0x00, 0x01, 0x00])) return "ico";

    // Videos
    if (hasString("ftyp")) {
      const ftypIndex = buffer.indexOf(Buffer.from("ftyp"));
      if (ftypIndex !== -1 && ftypIndex + 8 <= buffer.length) {
        const brand = buffer.subarray(ftypIndex + 4, ftypIndex + 8).toString();
        if (brand.startsWith("mp4") || brand.startsWith("isom")) return "mp4";
        if (brand.startsWith("M4V")) return "m4v";
        if (brand.startsWith("3gp")) return "3gp";
        if (brand.startsWith("qt")) return "mov";
      }
    }
    if (
      checkBytes(0, [0x52, 0x49, 0x46, 0x46]) &&
      checkBytes(8, [0x41, 0x56, 0x49, 0x20])
    )
      return "avi";
    if (checkBytes(0, [0x1a, 0x45, 0xdf, 0xa3])) {
      // Both WebM and MKV use EBML, need deeper inspection
      if (hasString("webm")) return "webm";
      return "mkv"; // Default to MKV for EBML
    }
    if (checkBytes(0, [0x46, 0x4c, 0x56])) return "flv";
    if (checkBytes(0, [0x30, 0x26, 0xb2, 0x75])) return "wmv";

    // Audio
    if (
      checkBytes(0, [0xff, 0xfb]) ||
      checkBytes(0, [0xff, 0xf3]) ||
      checkBytes(0, [0xff, 0xf2])
    )
      return "mp3";
    if (checkBytes(0, [0x49, 0x44, 0x33])) return "mp3"; // ID3 tag
    if (
      checkBytes(0, [0x52, 0x49, 0x46, 0x46]) &&
      checkBytes(8, [0x57, 0x41, 0x56, 0x45])
    )
      return "wav";
    if (checkBytes(0, [0x4f, 0x67, 0x67, 0x53])) return "ogg";
    if (checkBytes(0, [0x66, 0x4c, 0x61, 0x43])) return "flac";
    if (hasString("ftypM4A")) return "m4a";

    // Archives
    if (
      checkBytes(0, [0x50, 0x4b, 0x03, 0x04]) ||
      checkBytes(0, [0x50, 0x4b, 0x05, 0x06]) ||
      checkBytes(0, [0x50, 0x4b, 0x07, 0x08])
    )
      return "zip";
    if (checkBytes(0, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])) return "rar";
    if (checkBytes(0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return "7z";
    if (checkBytes(0, [0x1f, 0x8b])) return "gz";
    if (checkBytes(0, [0x42, 0x5a, 0x68])) return "bz2";

    // Documents
    if (checkBytes(0, [0x25, 0x50, 0x44, 0x46])) return "pdf";
    if (checkBytes(0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
      // Microsoft Office formats (legacy)
      return "doc"; // Could also be .xls, .ppt - would need deeper inspection
    }
    if (checkBytes(0, [0x50, 0x4b]) && hasString("word/")) return "docx";
    if (checkBytes(0, [0x50, 0x4b]) && hasString("xl/")) return "xlsx";
    if (checkBytes(0, [0x50, 0x4b]) && hasString("ppt/")) return "pptx";

    // Text/Code
    if (checkBytes(0, [0xef, 0xbb, 0xbf])) return "txt"; // UTF-8 BOM
    if (checkBytes(0, [0xff, 0xfe])) return "txt"; // UTF-16 LE BOM
    if (checkBytes(0, [0xfe, 0xff])) return "txt"; // UTF-16 BE BOM

    // Fonts
    if (checkBytes(0, [0x00, 0x01, 0x00, 0x00, 0x00])) return "ttf";
    if (checkBytes(0, [0x4f, 0x54, 0x54, 0x4f])) return "otf";
    if (checkBytes(0, [0x77, 0x4f, 0x46, 0x46])) return "woff";
    if (checkBytes(0, [0x77, 0x4f, 0x46, 0x32])) return "woff2";

    // Try to detect if it's likely text-based by checking for printable ASCII
    let printableCount = 0;
    for (let i = 0; i < Math.min(buffer.length, 32); i++) {
      if (
        (bytes[i] >= 32 && bytes[i] <= 126) ||
        bytes[i] === 9 ||
        bytes[i] === 10 ||
        bytes[i] === 13
      ) {
        printableCount++;
      }
    }

    // If mostly printable characters, assume it's a text file
    if (printableCount / Math.min(buffer.length, 32) > 0.7) {
      return "txt";
    }

    return null; // Unknown format
  } catch (error) {
    console.error("Error detecting file format:", error);
    return null;
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
