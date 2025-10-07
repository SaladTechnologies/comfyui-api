import path from "path";
import fsPromises from "fs/promises";
import { StorageProvider, Upload } from "../types";
import { FastifyBaseLogger } from "fastify";
import config from "../config";
import { execFile } from "child_process";
import { promisify } from "util";
import os from "os";

const execFilePromise = promisify(execFile);

class HFUpload implements Upload {
  url: string;
  fileOrPath: string;
  contentType: string;
  log: FastifyBaseLogger;
  state: "in-progress" | "completed" | "failed" | "aborted" = "in-progress";
  private fileIsReady: Promise<void>;
  private abortController: AbortController | null = null;

  constructor(
    url: string,
    fileOrPath: string | Buffer,
    contentType: string,
    log: FastifyBaseLogger
  ) {
    this.url = url;
    // If fileOrPath is a Buffer, we need to write it to a temp file first
    if (Buffer.isBuffer(fileOrPath)) {
      const tempFilePath = path.join(
        os.tmpdir(),
        `hf-upload-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`
      );
      this.fileIsReady = fsPromises.writeFile(tempFilePath, fileOrPath);
      this.fileOrPath = tempFilePath;
    } else {
      this.fileOrPath = fileOrPath;
      this.fileIsReady = Promise.resolve();
    }
    this.contentType = contentType;
    this.log = log.child({ uploader: "HFUpload" });
    this.state = "in-progress";
  }

  async upload(): Promise<void> {
    await this.fileIsReady;
    const { repo, revision, filePath } = parseHfUrl(this.url);
    this.log.info(
      `Using hf CLI to upload ${filePath} to ${repo} at revision ${revision}`
    );
    this.abortController = new AbortController();
    try {
      await execFilePromise(
        "hf",
        [repo, this.fileOrPath, filePath, "upload", "--revision", revision],
        { env: process.env, signal: this.abortController.signal }
      );
      this.state = "completed";
      this.log.info(`Upload to ${this.url} completed`);
    } catch (error: any) {
      console.error(error);
      this.state = "failed";
      this.log.error("Error uploading file to HuggingFace:", error);
    }
  }

  async abort(): Promise<void> {
    if (this.state !== "in-progress") {
      this.log.warn(`Cannot abort upload in state ${this.state}`);
      return;
    }
    if (this.abortController) {
      this.abortController.abort();
    }
    this.state = "aborted";
    this.log.info(`Upload to ${this.url} aborted`);
  }
}

function parseHfUrl(url: string): {
  repo: string;
  revision: string;
  filePath: string;
} {
  // Example URL: https://huggingface.co/tencent/Hunyuan3D-2.1/resolve/main/hunyuan3d-dit-v2-1/model.fp16.ckpt?download=true
  const parsedUrl = new URL(url);
  const parts = parsedUrl.pathname.split("/");
  if (parts.length >= 5) {
    const repo = parts[1] + "/" + parts[2];
    const revision = parts[4];
    const filePath = parts.slice(5).join("/");
    return { repo, revision, filePath };
  } else {
    throw new Error(`Invalid HuggingFace URL: ${url.toString()}`);
  }
}

export class HFStorageProvider implements StorageProvider {
  log: FastifyBaseLogger;

  constructor(log: FastifyBaseLogger) {
    this.log = log.child({ provider: "HFStorageProvider" });
  }

  testUrl(url: string): boolean {
    return url.startsWith("https://huggingface.co/") && !!config.hfCLIVersion;
  }

  uploadFile(
    url: string,
    fileOrPath: string | Buffer,
    contentType: string
  ): Upload {
    return new HFUpload(url, fileOrPath, contentType, this.log);
  }

  async downloadFile(
    url: string,
    outputDir: string,
    filenameOverride?: string
  ): Promise<string> {
    // url like https://huggingface.co/tencent/Hunyuan3D-2.1/resolve/main/hunyuan3d-dit-v2-1/model.fp16.ckpt?download=true
    const outputPath = path.join(
      outputDir,
      filenameOverride || path.basename(new URL(url).pathname)
    );
    const { repo, revision, filePath } = parseHfUrl(url);
    this.log.info(
      `Using hf CLI to download ${filePath} from ${repo} at revision ${revision}`
    );
    const downloadResult = await execFilePromise(
      "hf",
      ["download", repo, filePath, "--revision", revision],
      { env: process.env }
    );

    const downloadedPath = await fsPromises.realpath(
      downloadResult.stdout.trim()
    );

    await execFilePromise("mv", [downloadedPath, outputPath]);

    return outputPath;
  }
}
