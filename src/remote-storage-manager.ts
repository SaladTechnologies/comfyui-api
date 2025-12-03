import config from "./config";
import { FastifyBaseLogger } from "fastify";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import storageProviders from "./storage-providers";
import { StorageProvider, Upload } from "./types";
import { sendSystemWebhook } from "./event-emitters";
import { TaskQueue } from "./task-queue";
import {
  makeHumanReadableSize,
  hashUrlBase64,
  getContentTypeFromUrl,
  getDirectorySizeInBytes,
  safeGetUrlPathname,
} from "./utils";

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
  private downloadQueue: TaskQueue;
  private uploadQueue: TaskQueue;
  log: FastifyBaseLogger;
  cacheDir: string;
  storageProviders: StorageProvider[] = [];

  constructor(cacheDir: string, log: FastifyBaseLogger) {
    this.cacheDir = cacheDir;
    this.log = log.child({ module: "RemoteStorageManager" });
    this.downloadQueue = new TaskQueue(config.maxConcurrentDownloads);
    this.uploadQueue = new TaskQueue(config.maxConcurrentUploads);
    fs.mkdirSync(this.cacheDir, { recursive: true });
    this.storageProviders = storageProviders
      .map((Provider) => {
        try {
          return new Provider(this.log);
        } catch (error: any) {
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

  async enforceCacheSize(): Promise<void> {
    const { totalSize, files } = await this.getCacheSizeInfo();
    this.log.info(
      `Cache populated with ${files.length
      } files, total size: ${makeHumanReadableSize(totalSize)}`
    );

    if (config.lruCacheSizeBytes > 0 && totalSize > config.lruCacheSizeBytes) {
      this.log.info(
        `Cache size ${makeHumanReadableSize(
          totalSize
        )} exceeds max size of ${makeHumanReadableSize(
          config.lruCacheSizeBytes
        )}, performing eviction`
      );
      const spaceNeeded = totalSize - config.lruCacheSizeBytes;
      const freedSpace = await this.makeSpace(spaceNeeded, files);
      this.log.info(`Freed up ${makeHumanReadableSize(freedSpace)} in cache`);
    }
  }

  /**
   * Gets the total size of the cache directory and a list of files sorted by last accessed time.
   * @returns An object containing the total size in bytes and an array of file info objects.
   */
  async getCacheSizeInfo(): Promise<{
    totalSize: number;
    files: Array<{ path: string; size: number; lastAccessed: number }>;
  }> {
    let totalSize = 0;
    const files: Array<{ path: string; size: number; lastAccessed: number }> =
      [];

    const dirFiles = await fsPromises.readdir(this.cacheDir);
    const statsPromises = dirFiles.map(async (file) => {
      const filePath = path.join(this.cacheDir, file);
      const stats = await fsPromises.stat(filePath);
      if (stats.isFile()) {
        totalSize += stats.size;
        files.push({
          path: filePath,
          size: stats.size,
          lastAccessed: stats.atimeMs,
        });
      }
    });

    await Promise.all(statsPromises);
    const sortedByLastAccessed = files.sort(
      (a, b) => a.lastAccessed - b.lastAccessed
    );

    return { totalSize, files: sortedByLastAccessed };
  }

  /**
   *
   * @param spaceNeeded A number in bytes that needs to be removed
   * @param files A list of files. Files will be removed in the order of this array.
   * @returns
   */
  private async makeSpace(
    spaceNeeded: number,
    files: Array<{ path: string; size: number }>
  ): Promise<number> {
    let freedSpace = 0;
    for (const file of files) {
      if (freedSpace >= spaceNeeded) {
        break;
      }
      try {
        const urlInCache = Object.keys(this.cache).find(
          (url) => this.cache[url] === file.path
        );
        sendSystemWebhook(
          "file_deleted",
          {
            url: urlInCache || "unknown",
            local_path: file.path,
            size: file.size,
          },
          this.log
        );
        if (urlInCache) {
          delete this.cache[urlInCache];
        }
        await fsPromises.unlink(file.path);
        freedSpace += file.size;
        this.log.info(
          `Evicted ${file.path} (${makeHumanReadableSize(
            file.size
          )}) from cache to free up space`
        );
      } catch (error) {
        this.log.error(
          { error },
          `Error evicting file ${file.path} from cache`
        );
      }
    }
    return freedSpace;
  }

  async downloadFile(
    url: string,
    outputDir: string,
    filenameOverride?: string
  ): Promise<string> {
    return this.downloadQueue.add(async () => {
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
      const ext = path.extname(safeGetUrlPathname(url));
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
      const size = (await fsPromises.stat(await fsPromises.realpath(outputPath)))
        .size;
      const sizeInMB = size / (1024 * 1024);

      const speed = sizeInMB / duration;
      const sizeStr = makeHumanReadableSize(sizeInMB * 1024 * 1024);
      this.log.info(
        `Downloaded ${sizeStr} from ${url} in ${duration.toFixed(
          2
        )}s (${speed.toFixed(2)} MB/s)`
      );
      sendSystemWebhook(
        "file_downloaded",
        { url, local_path: finalLocation, size, duration },
        this.log
      );

      this.enforceCacheSize().catch((error) => {
        this.log.error({ error }, "Error enforcing cache size after download");
      });

      return finalLocation;
    });
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
      const start = Date.now();
      this.activeDownloads[repoUrl] = this._cloneWithinDirectory(
        repoUrl,
        targetDir
      );
      const result = await this.activeDownloads[repoUrl];
      delete this.activeDownloads[repoUrl];
      this.cache[repoUrl] = result;
      const duration = (Date.now() - start) / 1000;
      const dirSize = await getDirectorySizeInBytes(result);
      this.log.info(
        `Cloned repository ${repoUrl} (${makeHumanReadableSize(
          dirSize
        )}) in ${duration.toFixed(2)}s (${makeHumanReadableSize(
          (dirSize / duration) * 1000
        )}/s)`
      );
      sendSystemWebhook(
        "file_downloaded",
        { url: repoUrl, local_path: result, size: dirSize, duration },
        this.log
      );
      return result;
    } catch (error: any) {
      this.log.error("Error cloning repository:", error);
      throw error;
    }
  }

  async uploadFile(
    url: string,
    fileOrPath: string | Buffer,
    contentType?: string
  ): Promise<void> {
    return this.uploadQueue.add(async () => {
      if (url in this.activeUploads) {
        await this.activeUploads[url].abort();
        delete this.activeUploads[url];
      }

      // Determine content type from URL if not provided
      const mimeType = contentType || getContentTypeFromUrl(url);

      for (const provider of this.storageProviders) {
        if (provider.uploadFile && provider.testUrl(url)) {
          this.log.info(
            `Uploading to ${url} using provider ${provider.constructor.name}`
          );
          this.activeUploads[url] = provider.uploadFile(
            url,
            fileOrPath,
            mimeType
          );
          break; // Use only the first matching provider
        }
      }
      if (!this.activeUploads[url]) {
        throw new Error(`No storage provider found for URL: ${url}`);
      }
      const start = Date.now();
      const size =
        fileOrPath instanceof Buffer
          ? fileOrPath.length
          : (await fsPromises.stat(fileOrPath)).size;

      await this.activeUploads[url].upload();
      delete this.activeUploads[url];
      const duration = (Date.now() - start) / 1000;
      sendSystemWebhook(
        "file_uploaded",
        { url, local_path: fileOrPath, size, duration },
        this.log
      );
    });
  }

  async getSignedUrl(url: string): Promise<string> {
    for (const provider of this.storageProviders) {
      if (provider.getSignedUrl && provider.testUrl(url)) {
        return provider.getSignedUrl(url);
      }
    }
    return url;
  }

  private async _cloneWithinDirectory(
    repoUrl: string,
    targetDir: string
  ): Promise<string> {
    await fsPromises.mkdir(targetDir, { recursive: true });
    // Check to see if the repo is already cloned
    const repoName = repoUrl
      .substring(repoUrl.lastIndexOf("/") + 1)
      .replace(/\.git$/, "");
    const existingDir = path.join(targetDir, repoName);
    if (fs.existsSync(existingDir)) {
      // Check if it's a git repo
      if (fs.existsSync(path.join(existingDir, ".git"))) {
        this.log.info(`Repository ${repoUrl} already cloned, pulling latest`);
        try {
          await execFilePromise("git", ["pull"], { cwd: existingDir });
        } catch (error) {
          this.log.error(
            { error },
            `Error pulling latest changes for ${repoUrl}, using existing copy`
          );
        }
        return existingDir;
      } else {
        throw new Error(
          `Directory ${existingDir} already exists and is not a git repository`
        );
      }
    }

    // Clone the url to the custom nodes directory
    this.log.info(`Cloning ${repoUrl} to ${targetDir}`);
    await execFilePromise("git", ["clone", repoUrl], { cwd: targetDir });

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
