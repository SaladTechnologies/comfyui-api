import path from "path";
import fsPromises from "fs/promises";
import { StorageProvider, Upload } from "../types";
import { FastifyBaseLogger } from "fastify";
import config from "../config";
import { execFile } from "child_process";
import { promisify } from "util";
import os from "os";
import { z } from "zod";

const execFilePromise = promisify(execFile);

export class HFStorageProvider implements StorageProvider {
  log: FastifyBaseLogger;
  requestBodyUploadKey = "hf_upload";
  requestBodyUploadSchema = z.object({
    repo: z.string().describe("HuggingFace repo name, e.g. user/repo"),
    repo_type: z
      .enum(["model", "dataset"])
      .optional()
      .default("model")
      .describe("Type of HuggingFace repository"),
    revision: z
      .string()
      .optional()
      .default("main")
      .describe("HuggingFace repo revision, e.g. main or a branch name"),
    directory: z
      .string()
      .optional()
      .default("/")
      .describe("Directory in the repo to upload files to"),
  });

  private urlRequestSchema = this.requestBodyUploadSchema.extend({
    filename: z.string().describe("The name of the file to upload"),
  });

  constructor(log: FastifyBaseLogger) {
    this.log = log.child({ provider: "HFStorageProvider" });
  }

  createUrl(inputs: z.infer<typeof this.urlRequestSchema>): string {
    const { repo, repo_type, revision, directory, filename } = inputs;
    if (!repo) {
      throw new Error("Repo is required to create HuggingFace URL");
    }
    // Add repo type prefix for datasets
    const repoPrefix = repo_type === "dataset" ? "datasets/" : "";
    // URL-encode directory and filename to handle spaces and special characters
    const encodedDirectory = directory
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
    const encodedFilename = encodeURIComponent(filename);
    return `https://huggingface.co/${repoPrefix}${repo}/resolve/${revision}/${encodedDirectory}/${encodedFilename}`;
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
    const outputPath = path.join(
      outputDir,
      filenameOverride || path.basename(new URL(url).pathname)
    );
    const { repo, repoType, revision, filePath } = parseHfUrl(url);
    this.log.info(
      `Using hf CLI to download ${filePath} from ${repo} (${repoType}) at revision ${revision}`
    );

    // For datasets, we need to use --repo-type dataset flag
    const args =
      repoType === "dataset"
        ? [
            "download",
            repo,
            filePath,
            "--repo-type",
            "dataset",
            "--revision",
            revision,
          ]
        : ["download", repo, filePath, "--revision", revision];

    const downloadResult = await execFilePromise("hf", args, {
      env: process.env,
    });

    const downloadedPath = await fsPromises.realpath(
      downloadResult.stdout.trim()
    );

    await execFilePromise("mv", [downloadedPath, outputPath]);

    return outputPath;
  }
}

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
    const { repo, repoType, revision, filePath } = parseHfUrl(this.url);
    this.log.info(
      `Using hf CLI to upload ${filePath} to ${repo} (${repoType}) at revision ${revision}`
    );
    this.abortController = new AbortController();
    try {
      // For datasets, we need to use --repo-type dataset flag
      const args = [
        "upload",
        repo,
        this.fileOrPath,
        filePath,
        "--revision",
        revision,
      ];
      if (repoType === "dataset") {
        args.push("--repo-type", "dataset");
      }

      await execFilePromise("hf", args, {
        env: process.env,
        signal: this.abortController.signal,
      });
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
  repoType: "model" | "dataset";
  revision: string;
  filePath: string;
} {
  // Example URLs:
  // Model: https://huggingface.co/tencent/Hunyuan3D-2.1/resolve/main/hunyuan3d-dit-v2-1/model.fp16.ckpt
  // Dataset: https://huggingface.co/datasets/user/repo/resolve/main/path/file.ext
  const parsedUrl = new URL(url);
  const parts = parsedUrl.pathname.split("/");

  let repoType: "model" | "dataset" = "model";
  let startIdx = 1;

  // Check if it's a dataset URL
  if (parts[1] === "datasets") {
    repoType = "dataset";
    startIdx = 2;
  }

  if (parts.length >= startIdx + 4) {
    const repo = parts[startIdx] + "/" + parts[startIdx + 1];
    const revision = parts[startIdx + 3];
    const filePath = decodeURIComponent(parts.slice(startIdx + 4).join("/"));
    return { repo, repoType, revision, filePath };
  } else {
    throw new Error(`Invalid HuggingFace URL: ${url.toString()}`);
  }
}
