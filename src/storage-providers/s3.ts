import path from "path";
import fs, { ReadStream } from "fs";
import { Readable } from "stream";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import config from "../config";
import { FastifyBaseLogger } from "fastify";
import { StorageProvider, Upload } from "../types";
import { z } from "zod";

export class S3StorageProvider implements StorageProvider {
  log: FastifyBaseLogger;
  s3: S3Client;
  requestBodyUploadKey = "s3";
  requestBodyUploadSchema = z.object({
    bucket: z.string(),
    prefix: z.string(),
  });
  private urlRequestSchema = this.requestBodyUploadSchema.extend({
    filename: z.string().describe("The name of the file to upload"),
  });

  constructor(log: FastifyBaseLogger) {
    this.log = log.child({ provider: "S3StorageProvider" });
    if (!config.awsRegion) {
      throw new Error("AWS_REGION is not configured");
    }
    this.s3 = new S3Client({
      region: config.awsRegion,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 10000, // 10 seconds
        requestTimeout: 0, // No timeout
      }),
      forcePathStyle: true, // Required for LocalStack or custom S3 endpoints
    });
  }

  createUrl(inputs: z.infer<typeof this.urlRequestSchema>): string {
    const { bucket, prefix, filename } = inputs;
    if (!bucket) {
      throw new Error("Bucket is required to create S3 URL");
    }
    return `s3://${bucket}/${prefix || ""}${filename}`;
  }

  testUrl(url: string): boolean {
    return url.startsWith("s3://");
  }

  uploadFile(
    url: string,
    fileOrPath: string | Buffer,
    contentType: string
  ): S3Upload {
    return new S3Upload(url, fileOrPath, contentType, this.s3, this.log);
  }

  async downloadFile(
    s3Url: string,
    outputDir: string,
    filenameOverride?: string
  ): Promise<string> {
    try {
      const { bucket, key } = parseS3Url(s3Url);
      const outputPath = path.join(
        outputDir,
        filenameOverride || path.basename(key)
      );
      const command = new GetObjectCommand({ Bucket: bucket, Key: key });
      const response = await this.s3.send(command);

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

      this.log.info(`File downloaded from S3 and saved to ${outputPath}`);
      return outputPath;
    } catch (error: any) {
      console.error(error);
      this.log.error("Error downloading file from S3:", error);
      this.log.error("Error downloading file from S3:", error);
      throw error;
    }
  }

  async getSignedUrl(s3Url: string): Promise<string> {
    const { bucket, key } = parseS3Url(s3Url);
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    return getSignedUrl(this.s3, command, { expiresIn: 3600 });
  }
}

function parseS3Url(s3Url: string): { bucket: string; key: string } {
  const url = new URL(s3Url);
  const bucket = url.hostname;
  const key = url.pathname.slice(1); // Remove leading slash
  return { bucket, key };
}

export class S3Upload implements Upload {
  url: string;
  fileOrPath: string | Buffer;
  contentType: string;
  log: FastifyBaseLogger;
  state: "in-progress" | "completed" | "failed" | "aborted" = "in-progress";
  s3: S3Client;

  private abortController = new AbortController();

  constructor(
    url: string,
    fileOrPath: string | Buffer,
    contentType: string,
    s3: S3Client,
    log: FastifyBaseLogger
  ) {
    this.url = url;
    this.fileOrPath = fileOrPath;
    this.contentType = contentType;
    this.s3 = s3;
    this.log = log.child({ uploader: "S3Upload" });
    this.state = "in-progress";
  }

  async upload(): Promise<void> {
    try {
      await this._uploadFileToS3Url(
        this.url,
        this.fileOrPath,
        this.contentType,
        this.abortController.signal
      );
    } catch (error: any) {
      console.error(error);
      this.state = "failed";
      this.log.error("Error uploading file to S3:", error);
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

  private createInputStream(fileOrPath: string | Buffer): ReadStream | Buffer {
    if (typeof fileOrPath === "string") {
      return fs.createReadStream(fileOrPath);
    } else {
      return fileOrPath;
    }
  }

  private async _uploadFileToS3(
    bucket: string,
    key: string,
    fileOrPath: string | Buffer,
    contentType: string,
    abortSignal: AbortSignal
  ): Promise<void> {
    if (!this.s3) {
      throw new Error("S3 client is not configured");
    }
    this.log.info(`Uploading file to S3 at s3://${bucket}/${key}`);

    try {
      const fileStream = this.createInputStream(fileOrPath);
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: fileStream,
        ContentType: contentType,
      });
      await this.s3.send(command, { abortSignal: abortSignal });
      this.state = "completed";
      this.log.info(`File uploaded to S3 at s3://${bucket}/${key}`);
    } catch (error: any) {
      console.error(error);
      this.state = "failed";
      this.log.error("Error uploading file to S3:", error);
    }
  }

  private async _uploadFileToS3Url(
    s3Url: string,
    fileOrPath: string | Buffer,
    contentType: string,
    abortSignal: AbortSignal
  ): Promise<void> {
    const { bucket, key } = parseS3Url(s3Url);
    return this._uploadFileToS3(
      bucket,
      key,
      fileOrPath,
      contentType,
      abortSignal
    );
  }
}
