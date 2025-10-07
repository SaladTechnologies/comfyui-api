import path from "path";
import fsPromises from "fs/promises";
import { StorageProvider, Upload } from "../types";
import { FastifyBaseLogger } from "fastify";
import config from "../config";
import { z } from "zod";
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";
import fs, { ReadStream } from "fs";

export class AzureBlobStorageProvider implements StorageProvider {
  log: FastifyBaseLogger;
  requestBodyUploadKey = "azureBlobUpload";
  requestBodyUploadSchema = z.object({
    container: z.string().describe("Azure Blob Storage container name"),
    blobPrefix: z
      .string()
      .optional()
      .default("")
      .describe("Path in the container to upload files to"),
  });
  private urlRequestSchema = this.requestBodyUploadSchema.extend({
    filename: z.string().describe("The name of the file to upload"),
  });
  private client: BlobServiceClient | null = null;

  constructor(log: FastifyBaseLogger) {
    this.log = log.child({ provider: "AzureBlobStorageProvider" });
    const defaultAzureCredential = new DefaultAzureCredential();
    if (!config.azureStorageAccount) {
      throw new Error(
        "AZURE_STORAGE_ACCOUNT is not set in environment variables"
      );
    }
    this.client = new BlobServiceClient(
      `https://${config.azureStorageAccount}.blob.core.windows.net`,
      defaultAzureCredential
    );
  }

  createUrl(inputs: z.infer<typeof this.urlRequestSchema>): string {
    const { container, blobPrefix, filename } = inputs;
    if (!container) {
      throw new Error("Container is required to create Azure Blob URL");
    }
    const encodedBlobPrefix = blobPrefix
      ? `${blobPrefix.replace(/^\//, "").replace(/\/$/, "/")}`
      : "";
    return `https://${config.azureStorageAccount}.blob.core.windows.net/${container}/${encodedBlobPrefix}${filename}`;
  }

  testUrl(url: string): boolean {
    return (
      url.startsWith("https://") && url.includes(".blob.core.windows.net/")
    );
  }

  uploadFile(
    url: string,
    fileOrPath: string | Buffer,
    contentType: string
  ): Upload {
    if (!this.client) {
      throw new Error("Azure Blob Service Client is not initialized");
    }
    return new AzureBlobUpload(
      url,
      fileOrPath,
      contentType,
      this.client,
      this.log
    );
  }

  async downloadFile(
    url: string,
    outputDir: string,
    outputFilename: string
  ): Promise<string> {
    if (!this.client) {
      throw new Error("Azure Blob Service Client is not initialized");
    }
    // Parse the URL to extract container name and blob name
    const parsedUrl = new URL(url);
    const pathParts = parsedUrl.pathname.split("/").filter(Boolean); // Remove empty parts
    if (pathParts.length < 2) {
      throw new Error("Invalid Azure Blob URL format");
    }
    const containerName = pathParts[0];
    const blobName = pathParts.slice(1).join("/");

    const containerClient = this.client.getContainerClient(containerName);
    const blobClient = containerClient.getBlobClient(blobName);

    const downloadResponse = await blobClient.download();
    if (!downloadResponse.readableStreamBody) {
      throw new Error("Failed to get readable stream from blob download");
    }
    const downloadedFilePath = path.join(outputDir, outputFilename);
    const writableStream = fs.createWriteStream(downloadedFilePath);
    downloadResponse.readableStreamBody.pipe(writableStream);
    await new Promise((resolve, reject) => {
      writableStream.on("finish", () => resolve);
      writableStream.on("error", reject);
    });
    return downloadedFilePath;
  }
}

class AzureBlobUpload implements Upload {
  url: string;
  fileOrPath: string | Buffer;
  contentType: string;
  log: FastifyBaseLogger;
  state: "in-progress" | "completed" | "failed" | "aborted" = "in-progress";
  client: BlobServiceClient;
  private abortController = new AbortController();

  constructor(
    url: string,
    fileOrPath: string | Buffer,
    contentType: string,
    client: BlobServiceClient,
    log: FastifyBaseLogger
  ) {
    this.url = url;
    this.fileOrPath = fileOrPath;
    this.contentType = contentType;
    this.client = client;
    this.log = log.child({ uploader: "" });
  }

  private createInputStream(fileOrPath: string | Buffer): ReadStream | Buffer {
    if (typeof fileOrPath === "string") {
      return fs.createReadStream(fileOrPath);
    } else {
      return fileOrPath;
    }
  }

  async upload(): Promise<void> {
    // Parse the URL to extract container name and blob name
    const url = new URL(this.url);
    const pathParts = url.pathname.split("/").filter(Boolean); // Remove empty parts
    if (pathParts.length < 2) {
      throw new Error("Invalid Azure Blob URL format");
    }
    const containerName = pathParts[0];
    const blobName = pathParts.slice(1).join("/");
    this.state = "in-progress";

    try {
      const blockBlobClient = this.client
        .getContainerClient(containerName)
        .getBlockBlobClient(blobName);
      const inputStream = this.createInputStream(this.fileOrPath);
      const fileSize =
        typeof this.fileOrPath === "string"
          ? (await fsPromises.stat(this.fileOrPath)).size
          : this.fileOrPath.length;
      await blockBlobClient.upload(inputStream, fileSize, {
        abortSignal: this.abortController.signal,
        blobHTTPHeaders: { blobContentType: this.contentType },
      });
      this.log.info({ containerName, blobName }, "File uploaded successfully");
      this.state = "completed";
    } catch (error) {
      if (this.abortController.signal.aborted) {
        this.state = "aborted";
        this.log.warn("Upload aborted by user");
      } else {
        this.state = "failed";
        this.log.error({ error }, "Error uploading file to Azure Blob Storage");
      }
    }
  }

  async abort(): Promise<void> {
    if (this.state !== "in-progress") {
      this.log.warn(`Cannot abort upload in state ${this.state}`);
      return;
    }
    this.abortController.abort();
    this.state = "aborted";
    this.log.info(`Upload to ${this.url} aborted`);
  }
}
