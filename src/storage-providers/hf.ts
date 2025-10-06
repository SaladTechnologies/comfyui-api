import path from "path";
import fsPromises from "fs/promises";
import { StorageProvider, Upload } from "../types";
import { FastifyBaseLogger } from "fastify";
import config from "../config";
import { execFile } from "child_process";
import { promisify } from "util";

const execFilePromise = promisify(execFile);

export class HFUpload implements Upload {
  url: string;
  fileOrPath: string | Buffer;
  contentType: string;
  log: FastifyBaseLogger;
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
    this.log = log.child({ module: "HFUpload" });
    this.state = "in-progress";
    throw new Error("HF upload not implemented yet");
  }

  async upload(): Promise<void> {}

  async abort(): Promise<void> {
    if (this.state !== "in-progress") {
      this.log.warn(`Cannot abort upload in state ${this.state}`);
      return;
    }
    this.state = "aborted";
    this.log.info(`Upload to ${this.url} aborted`);
  }
}

export class HFStorageProvider implements StorageProvider {
  log: FastifyBaseLogger;

  constructor(log: FastifyBaseLogger) {
    this.log = log.child({ module: "HFStorageProvider" });
  }

  testUrl(url: string): boolean {
    return url.startsWith("https://huggingface.co/") && !!config.hfCLIVersion;
  }

  uploadFile(
    url: string,
    fileOrPath: string | Buffer,
    contentType: string
  ): HFUpload {
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
    const parsedUrl = new URL(url);
    const parts = parsedUrl.pathname.split("/");
    if (parts.length >= 3) {
      const repo = parts[1] + "/" + parts[2];
      const revision = parts[4];
      const filePath = parts.slice(5).join("/");
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
    } else {
      throw new Error(`Invalid HuggingFace URL: ${url.toString()}`);
    }
  }
}
