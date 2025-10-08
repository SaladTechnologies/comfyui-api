import config from "./config";
import { FastifyBaseLogger } from "fastify";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import storageProviders from "./storage-providers";
import { StorageProvider, Upload } from "./types";

const execFilePromise = promisify(execFile);

async function linkIfDoesNotExist(
  src: string,
  dest: string,
  log: FastifyBaseLogger
): Promise<void> {
  return fsPromises
    .lstat(dest)
    .then(() => {
      log.debug(`Link target ${dest} already exists, skipping link`);
    })
    .catch(async (err: any) => {
      if (err.code === "ENOENT") {
        log.debug(`Linking ${src} to ${dest}`);
        await fsPromises.symlink(src, dest);
        log.debug(`Linked ${src} to ${dest}`);
      } else {
        log.error(
          `Error linking ${src} to ${dest}: (${err.code}) ${err.message}`
        );
        throw err;
      }
    });
}

function hashUrlBase64(url: string, length = 32): string {
  return crypto
    .createHash("sha256")
    .update(url)
    .digest("base64url") // URL-safe base64
    .substring(0, length);
}

async function getFileByPrefix(
  dir: string,
  prefix: string
): Promise<string | null> {
  const files = await fsPromises.readdir(dir);
  const matchingFile = files.find((file) => file.startsWith(prefix));
  return matchingFile ? path.join(dir, matchingFile) : null;
}

class RemoteStorageManager {
  private cache: Record<string, string> = {};
  private activeDownloads: Record<string, Promise<string>> = {};
  private activeUploads: Record<string, Upload> = {};
  log: FastifyBaseLogger;
  cacheDir: string;
  storageProviders: StorageProvider[] = [];

  constructor(cacheDir: string, log: FastifyBaseLogger) {
    this.cacheDir = cacheDir;
    this.log = log.child({ module: "RemoteStorageManager" });
    fs.mkdirSync(this.cacheDir, { recursive: true });
    this.storageProviders = storageProviders
      .map((Provider) => {
        try {
          return new Provider(this.log);
        } catch (error) {
          this.log.warn(
            { error },
            `Error initializing storage provider ${Provider.name}`
          );
        }
      })
      .filter(Boolean) as StorageProvider[];
    this.log.info(
      `Initialized with ${this.storageProviders.length} storage providers`
    );
  }

  async downloadFile(
    url: string,
    outputDir: string,
    filenameOverride?: string
  ): Promise<string> {
    if (this.cache[url]) {
      const finalLocation = path.join(
        outputDir,
        filenameOverride || path.basename(this.cache[url])
      );
      await linkIfDoesNotExist(this.cache[url], finalLocation, this.log);
      this.log.debug(`Using cached file for ${url}`);
      return finalLocation;
    }
    if (url in this.activeDownloads) {
      this.log.info(`Awaiting in-progress download for ${url}`);
      const cachedPath = await this.activeDownloads[url];
      const finalLocation = path.join(
        outputDir,
        filenameOverride || path.basename(cachedPath)
      );
      await linkIfDoesNotExist(cachedPath, finalLocation, this.log);
      return finalLocation;
    }

    const hashedUrl = hashUrlBase64(url);
    const preDownloadedFile = await getFileByPrefix(this.cacheDir, hashedUrl);
    if (preDownloadedFile) {
      this.log.debug(`Found ${preDownloadedFile} for ${url} in cache dir`);
      this.cache[url] = preDownloadedFile;
      const finalLocation = path.join(
        outputDir,
        filenameOverride || path.basename(this.cache[url])
      );
      await linkIfDoesNotExist(this.cache[url], finalLocation, this.log);
      return finalLocation;
    }

    const start = Date.now();
    const ext = path.extname(new URL(url).pathname);
    const tempFilename = `${hashedUrl}${ext}`;

    for (const provider of this.storageProviders) {
      if (provider.downloadFile && provider.testUrl(url)) {
        this.log.info(
          `Downloading ${url} using provider ${provider.constructor.name}`
        );
        this.activeDownloads[url] = provider
          .downloadFile(url, this.cacheDir, filenameOverride || tempFilename)
          .then((outputLocation: string) => {
            this.cache[url] = outputLocation;
            return outputLocation;
          })
          .finally(() => {
            delete this.activeDownloads[url];
          });
        break;
      }
    }
    if (!this.activeDownloads[url]) {
      throw new Error(`No storage provider found for URL: ${url}`);
    }
    const outputPath = await this.activeDownloads[url];
    const finalLocation = path.join(
      outputDir,
      filenameOverride || path.basename(this.cache[url])
    );
    await linkIfDoesNotExist(outputPath, finalLocation, this.log);

    const duration = (Date.now() - start) / 1000;
    const sizeInMB =
      (await fsPromises.stat(await fsPromises.realpath(outputPath))).size /
      (1024 * 1024);
    const sizeInGB = sizeInMB / 1024;
    const speed = sizeInMB / duration;
    const sizeStr =
      sizeInGB >= 1 ? `${sizeInGB.toFixed(2)} GB` : `${sizeInMB.toFixed(2)} MB`;
    this.log.info(
      `Downloaded ${sizeStr} from ${url} in ${duration.toFixed(
        2
      )}s (${speed.toFixed(2)} MB/s)`
    );

    return finalLocation;
  }

  async downloadRepo(repoUrl: string, targetDir: string): Promise<string> {
    if (repoUrl in this.cache) {
      return this.cache[repoUrl];
    }
    if (repoUrl in this.activeDownloads) {
      this.log.info(`Awaiting in-progress clone for ${repoUrl}`);
      return this.activeDownloads[repoUrl];
    }
    try {
      this.activeDownloads[repoUrl] = this._cloneWithinDirectory(
        repoUrl,
        targetDir
      );
      const result = await this.activeDownloads[repoUrl];
      delete this.activeDownloads[repoUrl];
      this.cache[repoUrl] = result;
      return result;
    } catch (error: any) {
      this.log.error("Error cloning repository:", error);
      throw error;
    }
  }

  async uploadFile(
    url: string,
    fileOrPath: string | Buffer,
    contentType: string
  ): Promise<void> {
    if (url in this.activeUploads) {
      await this.activeUploads[url].abort();
      delete this.activeUploads[url];
    }
    for (const provider of this.storageProviders) {
      if (provider.uploadFile && provider.testUrl(url)) {
        this.log.info(
          `Uploading to ${url} using provider ${provider.constructor.name}`
        );
        this.activeUploads[url] = provider.uploadFile(
          url,
          fileOrPath,
          contentType
        );
        break; // Use only the first matching provider
      }
    }
    await this.activeUploads[url].upload();
    delete this.activeUploads[url];
  }

  private async _cloneWithinDirectory(
    repoUrl: string,
    targetDir: string
  ): Promise<string> {
    await fsPromises.mkdir(targetDir, { recursive: true });
    // Clone the url to the custom nodes directory
    this.log.info(`Cloning ${repoUrl} to ${targetDir}`);
    await execFilePromise("git", ["clone", repoUrl], { cwd: targetDir });

    const repoName = repoUrl
      .substring(repoUrl.lastIndexOf("/") + 1)
      .replace(/\.git$/, "");

    return path.join(targetDir, repoName);
  }
}

let storageManager: RemoteStorageManager | undefined;
export default function getStorageManager(log?: FastifyBaseLogger) {
  if (!storageManager && log) {
    storageManager = new RemoteStorageManager(config.cacheDir, log);
  } else if (!storageManager && !log) {
    throw new Error(
      "RemoteStorageManager not initialized yet, log parameter required"
    );
  }
  if (!storageManager) {
    throw new Error("RemoteStorageManager not initialized yet");
  }
  return storageManager;
}
