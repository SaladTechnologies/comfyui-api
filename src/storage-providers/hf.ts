import path from "path";
import fsPromises from "fs/promises";
import { StorageProvider, Upload } from "../types";
import { FastifyBaseLogger } from "fastify";
import config from "../config";
import { execFile } from "child_process";
import { promisify } from "util";

const execFilePromise = promisify(execFile);

export class HFStorageProvider implements StorageProvider {
  log: FastifyBaseLogger;

  constructor(log: FastifyBaseLogger) {
    this.log = log.child({ provider: "HFStorageProvider" });
  }

  testUrl(url: string): boolean {
    return url.startsWith("https://huggingface.co/") && !!config.hfCLIVersion;
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
