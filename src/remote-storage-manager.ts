import config from "./config";
import { FastifyBaseLogger } from "fastify";
import fs, { ReadStream } from "fs";
import fsPromises from "fs/promises";
import { Readable } from "stream";
import path from "path";
import { randomUUID } from "crypto";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { execFile } from "child_process";
import { promisify } from "util";

const execFilePromise = promisify(execFile);

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

function parseS3Url(s3Url: string): { bucket: string; key: string } {
  const url = new URL(s3Url);
  const bucket = url.hostname;
  const key = url.pathname.slice(1); // Remove leading slash
  return { bucket, key };
}

class Upload {
  url: string;
  fileOrPath: string | Buffer;
  contentType: string;
  log: FastifyBaseLogger;
  private abortController = new AbortController();
  state: "in-progress" | "completed" | "failed" | "aborted" = "in-progress";

  constructor(
    url: string,
    fileOrPath: string | Buffer,
    contentType: string,
    log: FastifyBaseLogger
  ) {
    this.url = url;
    this.fileOrPath = fileOrPath;
    this.contentType = contentType;
    this.log = log;
  }

  async upload(): Promise<void> {
    if (this.url.startsWith("s3://")) {
      this.state = "in-progress";
      try {
        await this._uploadFileToS3Url(
          this.url,
          this.fileOrPath,
          this.contentType,
          this.abortController.signal,
          this.log
        );
      } catch (error: any) {
        console.error(error);
        this.state = "failed";
        this.log.error("Error uploading file to S3:", error);
      }
    } else {
      this.state = "failed";
      throw new Error(`Unsupported URL scheme for ${this.url}`);
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
    abortSignal: AbortSignal,
    log: FastifyBaseLogger
  ): Promise<void> {
    if (!s3) {
      throw new Error("S3 client is not configured");
    }
    log.info(`Uploading file to S3 at s3://${bucket}/${key}`);

    try {
      const fileStream = this.createInputStream(fileOrPath);
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: fileStream,
        ContentType: contentType,
      });
      await s3.send(command, { abortSignal: abortSignal });
      this.state = "completed";
      log.info(`File uploaded to S3 at s3://${bucket}/${key}`);
    } catch (error: any) {
      console.error(error);
      this.state = "failed";
      log.error("Error uploading file to S3:", error);
    }
  }

  private async _uploadFileToS3Url(
    s3Url: string,
    fileOrPath: string | Buffer,
    contentType: string,
    abortSignal: AbortSignal,
    log: FastifyBaseLogger
  ): Promise<void> {
    const { bucket, key } = parseS3Url(s3Url);
    return this._uploadFileToS3(
      bucket,
      key,
      fileOrPath,
      contentType,
      abortSignal,
      log
    );
  }
}

class RemoteStorageManager {
  private cache: Record<string, string> = {};
  private activeDownloads: Record<string, Promise<string>> = {};
  private activeUploads: Record<string, Upload> = {};
  cacheDir: string;

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  async downloadFile(
    url: string,
    outputDir: string,
    filenameOverride: string | null,
    log: FastifyBaseLogger
  ): Promise<string> {
    if (this.cache[url]) {
      const finalLocation = path.join(
        outputDir,
        filenameOverride || path.basename(this.cache[url])
      );
      await fsPromises.symlink(this.cache[url], finalLocation);
      log.debug(`Using cached file for ${url}`);
      return finalLocation;
    }
    if (url in this.activeDownloads) {
      log.info(`Awaiting in-progress download for ${url}`);
      const cachedPath = await this.activeDownloads[url];
      const finalLocation = path.join(
        outputDir,
        filenameOverride || path.basename(cachedPath)
      );
      await fsPromises.symlink(cachedPath, finalLocation);
      return finalLocation;
    }
    const start = Date.now();
    const tempFilename = `${randomUUID()}${path.extname(url)}`;
    const tempFilePath = path.join(this.cacheDir, tempFilename);
    if (url.startsWith("http")) {
      if (config.hfCLIVersion && url.includes("huggingface.co")) {
        log.info(`Downloading ${url} using hf CLI`);
        this.activeDownloads[url] = this._downloadWithHfCLI(
          new URL(url),
          tempFilePath,
          log
        )
          .then(() => {
            this.cache[url] = tempFilePath;
            return tempFilePath;
          })
          .finally(() => {
            delete this.activeDownloads[url];
          });
      } else {
        log.info(`Downloading ${url} using HTTP`);
        this.activeDownloads[url] = this._downloadFileHttp(
          url,
          tempFilePath,
          log
        )
          .then(() => {
            this.cache[url] = tempFilePath;

            return tempFilePath;
          })
          .finally(() => {
            delete this.activeDownloads[url];
          });
      }
    } else if (url.startsWith("s3://")) {
      this.activeDownloads[url] = this._downloadFileS3Url(
        url,
        tempFilePath,
        log
      )
        .then(() => {
          this.cache[url] = tempFilePath;

          return tempFilePath;
        })
        .finally(() => {
          delete this.activeDownloads[url];
        });
    } else {
      throw new Error(`Unsupported URL scheme for ${url}`);
    }
    await this.activeDownloads[url];
    const finalLocation = path.join(
      outputDir,
      filenameOverride || path.basename(this.cache[url])
    );
    await fsPromises.symlink(tempFilePath, finalLocation);

    const duration = (Date.now() - start) / 1000;
    const sizeInMB = (await fsPromises.stat(tempFilePath)).size / (1024 * 1024);
    const sizeInGB = sizeInMB / 1024;
    const speed = sizeInMB / duration;
    const sizeStr =
      sizeInGB >= 1 ? `${sizeInGB.toFixed(2)} GB` : `${sizeInMB.toFixed(2)} MB`;
    log.info(
      `Downloaded ${sizeStr} from ${url} in ${duration.toFixed(
        2
      )}s (${speed.toFixed(2)} MB/s)`
    );

    return finalLocation;
  }

  async downloadRepo(
    repoUrl: string,
    targetDir: string,
    log: FastifyBaseLogger
  ): Promise<string> {
    if (repoUrl in this.cache) {
      return this.cache[repoUrl];
    }
    if (repoUrl in this.activeDownloads) {
      log.info(`Awaiting in-progress clone for ${repoUrl}`);
      return this.activeDownloads[repoUrl];
    }
    try {
      this.activeDownloads[repoUrl] = this._cloneWithinDirectory(
        repoUrl,
        targetDir,
        log
      );
      const result = await this.activeDownloads[repoUrl];
      delete this.activeDownloads[repoUrl];
      this.cache[repoUrl] = result;
      return result;
    } catch (error: any) {
      log.error("Error cloning repository:", error);
      throw error;
    }
  }

  async uploadFile(
    url: string,
    fileOrPath: string | Buffer,
    contentType: string,
    log: FastifyBaseLogger
  ): Promise<void> {
    if (url in this.activeUploads) {
      await this.activeUploads[url].abort();
      delete this.activeUploads[url];
    }
    this.activeUploads[url] = new Upload(url, fileOrPath, contentType, log);
    await this.activeUploads[url].upload();
    delete this.activeUploads[url];
  }

  private async _downloadFileHttp(
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
    } catch (error: any) {
      log.error("Error downloading file:", error);
    }
  }

  private async _downloadFileS3(
    bucket: string,
    key: string,
    outputPath: string,
    log: FastifyBaseLogger
  ): Promise<void> {
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
      return;
    } catch (error: any) {
      console.error(error);
      log.error("Error downloading file from S3:", error);
    }
  }

  private async _downloadFileS3Url(
    s3Url: string,
    outputPath: string,
    log: FastifyBaseLogger
  ): Promise<void> {
    const { bucket, key } = parseS3Url(s3Url);
    return this._downloadFileS3(bucket, key, outputPath, log);
  }

  private async _downloadWithHfCLI(
    url: URL,
    outputPath: string,
    log: FastifyBaseLogger
  ): Promise<void> {
    // url like https://huggingface.co/tencent/Hunyuan3D-2.1/resolve/main/hunyuan3d-dit-v2-1/model.fp16.ckpt?download=true
    const parts = url.pathname.split("/");
    if (parts.length >= 3) {
      const repo = parts[1] + "/" + parts[2];
      const revision = parts[4];
      const filePath = parts.slice(5).join("/");
      log.info(
        `Using hf CLI to download ${filePath} from ${repo} at revision ${revision}`
      );
      const downloadResult = await execFilePromise("hf", [
        "download",
        repo,
        filePath,
        "--revision",
        revision,
      ]);

      const downloadedPath = await fsPromises.realpath(
        downloadResult.stdout.trim()
      );

      // Check if path exists
      const stats = await fsPromises.stat(downloadedPath);
      if (!stats.isFile()) {
        throw new Error(
          `Downloaded path is not a file: ${downloadedPath}, URL: ${url.toString()}`
        );
      }

      // Run mv and capture any output
      await execFilePromise("mv", [downloadedPath, outputPath]);
    } else {
      throw new Error(`Invalid HuggingFace URL: ${url.toString()}`);
    }
  }

  private async _cloneWithinDirectory(
    repoUrl: string,
    targetDir: string,
    log: FastifyBaseLogger
  ): Promise<string> {
    await fsPromises.mkdir(targetDir, { recursive: true });
    // Clone the url to the custom nodes directory
    log.info(`Cloning ${repoUrl} to ${targetDir}`);
    await execFilePromise("git", ["clone", repoUrl], { cwd: targetDir });

    const repoName = repoUrl
      .substring(repoUrl.lastIndexOf("/") + 1)
      .replace(/\.git$/, "");

    return path.join(targetDir, repoName);
  }
}

const storageManager = new RemoteStorageManager(config.cacheDir);
export default storageManager;
