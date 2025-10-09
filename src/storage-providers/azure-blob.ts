import path from "path";
import fsPromises from "fs/promises";
import { StorageProvider, Upload } from "../types";
import { FastifyBaseLogger } from "fastify";
import config from "../config";
import { z } from "zod";
import { DefaultAzureCredential } from "@azure/identity";
import {
  BlobServiceClient,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import fs, { ReadStream } from "fs";

export class AzureBlobStorageProvider implements StorageProvider {
  log: FastifyBaseLogger;
  requestBodyUploadKey = "azure_blob_upload";
  requestBodyUploadSchema = z.object({
    container: z.string().describe("Azure Blob Storage container name"),
    blob_prefix: z
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

    // Priority 1: Connection string (for Azurite or full connection strings)
    if (config.azureStorageConnectionString) {
      this.log.debug("Using Azure Storage connection string");
      this.client = BlobServiceClient.fromConnectionString(
        config.azureStorageConnectionString
      );
    }
    // Priority 2: Storage account with explicit key
    else if (config.azureStorageAccount && config.azureStorageKey) {
      this.log.debug("Using Azure Storage account with shared key");
      const sharedKeyCredential = new StorageSharedKeyCredential(
        config.azureStorageAccount,
        config.azureStorageKey
      );
      this.client = new BlobServiceClient(
        `https://${config.azureStorageAccount}.blob.core.windows.net`,
        sharedKeyCredential
      );
    }
    // Priority 3: Storage account with SAS token
    else if (config.azureStorageAccount && config.azureStorageSasToken) {
      this.log.debug("Using Azure Storage account with SAS token");
      // SAS tokens are appended to the URL, not passed as credentials
      const sasToken = config.azureStorageSasToken.startsWith("?")
        ? config.azureStorageSasToken
        : `?${config.azureStorageSasToken}`;
      this.client = new BlobServiceClient(
        `https://${config.azureStorageAccount}.blob.core.windows.net${sasToken}`
      );
    }
    // Priority 4: DefaultAzureCredential (handles many auth methods automatically)
    else if (config.azureStorageAccount) {
      this.log.debug("Using DefaultAzureCredential with storage account");
      const defaultAzureCredential = new DefaultAzureCredential();
      this.client = new BlobServiceClient(
        `https://${config.azureStorageAccount}.blob.core.windows.net`,
        defaultAzureCredential
      );
    } else {
      throw new Error(
        "Azure Storage configuration required. Set either:\n" +
          "- AZURE_STORAGE_CONNECTION_STRING (for Azurite or full connection)\n" +
          "- AZURE_STORAGE_ACCOUNT with AZURE_STORAGE_KEY (shared key auth)\n" +
          "- AZURE_STORAGE_ACCOUNT with AZURE_STORAGE_SAS_TOKEN (SAS auth)\n" +
          "- AZURE_STORAGE_ACCOUNT with DefaultAzureCredential (Azure AD/CLI/etc)"
      );
    }
  }

  createUrl(inputs: z.infer<typeof this.urlRequestSchema>): string {
    const { container, blob_prefix, filename } = inputs;
    if (!container) {
      throw new Error("Container is required to create Azure Blob URL");
    }
    const encodedBlobPrefix = blob_prefix
      ? `${blob_prefix.replace(/^\//, "").replace(/\/$/, "/")}`
      : "";

    // Get the base URL from the client
    if (this.client) {
      let baseUrl = this.client.url;
      // For local development, ensure we use the Docker service name
      if (baseUrl.includes("localhost:10000")) {
        baseUrl = baseUrl.replace("localhost", "azurite");
      }
      return `${baseUrl}/${container}/${encodedBlobPrefix}${filename}`;
    }

    // Fallback to constructing URL from storage account
    if (config.azureStorageAccount) {
      return `https://${config.azureStorageAccount}.blob.core.windows.net/${container}/${encodedBlobPrefix}${filename}`;
    }

    throw new Error("Unable to create Azure Blob URL");
  }

  testUrl(url: string): boolean {
    // Support both HTTPS (production) and HTTP (local Azurite)
    return (
      (url.startsWith("https://") && url.includes(".blob.core.windows.net/")) ||
      (url.startsWith("http://") &&
        (url.includes("devstoreaccount") || url.includes("azurite")))
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
    filenameOverride?: string
  ): Promise<string> {
    if (!this.client) {
      throw new Error("Azure Blob Service Client is not initialized");
    }
    // Parse the URL to extract container name and blob name
    const parsedUrl = new URL(url);
    let pathParts = parsedUrl.pathname.split("/").filter(Boolean); // Remove empty parts

    // For Azurite URLs, skip the account name (devstoreaccount1)
    if (pathParts[0] === "devstoreaccount1") {
      pathParts = pathParts.slice(1);
    }

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
    const downloadedFilePath = path.join(
      outputDir,
      filenameOverride || path.basename(blobName)
    );
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
    this.log = log.child({ uploader: "AzureBlobUpload" });
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
    let pathParts = url.pathname.split("/").filter(Boolean); // Remove empty parts

    // For Azurite/emulator URLs in path-style format (http://host:port/accountname/container/blob)
    // vs Azure URLs in host-style format (https://accountname.blob.core.windows.net/container/blob)
    if (!url.hostname.includes(".blob.core.windows.net")) {
      // Path-style URL - first part is account name, skip it
      if (pathParts.length > 0) {
        pathParts = pathParts.slice(1);
      }
    }

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
