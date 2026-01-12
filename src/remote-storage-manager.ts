import config from "./config";
import { FastifyBaseLogger } from "fastify";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import storageProviders from "./storage-providers";
import { StorageProvider, Upload, DownloadOptions } from "./types";
import { sendSystemWebhook } from "./event-emitters";
import {
  makeHumanReadableSize,
  hashUrlBase64,
  getContentTypeFromUrl,
  getDirectorySizeInBytes,
} from "./utils";
import { parseGitUrl } from "./git-url-parser";

/**
 * Metadata for cached files, stored in sidecar .meta files.
 */
interface CacheMetadata {
  authRequired: boolean;
  url: string;
  cachedAt: string;
}

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
  // Exclude .meta files from the search
  const matchingFile = files.find((file) => file.startsWith(prefix) && !file.endsWith(".meta"));
  return matchingFile ? path.join(dir, matchingFile) : null;
}

/**
 * Get the metadata file path for a cached file.
 */
function getMetaFilePath(cachedFilePath: string): string {
  return `${cachedFilePath}.meta`;
}

/**
 * Read metadata for a cached file if it exists.
 */
async function readCacheMetadata(cachedFilePath: string): Promise<CacheMetadata | null> {
  const metaPath = getMetaFilePath(cachedFilePath);
  try {
    const content = await fsPromises.readFile(metaPath, "utf-8");
    return JSON.parse(content) as CacheMetadata;
  } catch {
    return null;
  }
}

/**
 * Write metadata for a cached file.
 */
async function writeCacheMetadata(cachedFilePath: string, metadata: CacheMetadata): Promise<void> {
  const metaPath = getMetaFilePath(cachedFilePath);
  await fsPromises.writeFile(metaPath, JSON.stringify(metadata, null, 2));
}

/**
 * Sanitize a URL by removing embedded credentials (username/password).
 * This prevents credentials from being written to disk in cache metadata.
 */
function sanitizeUrlForMetadata(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    // If URL parsing fails, return as-is (shouldn't happen for valid URLs)
    return url;
  }
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

  async enforceCacheSize(): Promise<void> {
    const { totalSize, files } = await this.getCacheSizeInfo();
    this.log.info(
      `Cache populated with ${
        files.length
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
        // Also delete the metadata file if it exists
        const metaPath = getMetaFilePath(file.path);
        await fsPromises.unlink(metaPath).catch(() => {
          // Metadata file may not exist, ignore
        });
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
    filenameOverride?: string,
    options?: DownloadOptions
  ): Promise<string> {
    const hasAuth = !!options?.auth;

    // Check in-memory cache first
    if (this.cache[url]) {
      const cachedPath = this.cache[url];
      await this.validateCacheAccess(url, cachedPath, options);
      const finalLocation = path.join(
        outputDir,
        filenameOverride || path.basename(cachedPath)
      );
      await linkIfDoesNotExist(cachedPath, finalLocation, this.log);
      this.log.debug(`Using cached file for ${url}`);
      return finalLocation;
    }

    // Check if there's an in-progress download we can wait for
    if (url in this.activeDownloads) {
      this.log.info(`Awaiting in-progress download for ${url}`);
      const cachedPath = await this.activeDownloads[url];
      await this.validateCacheAccess(url, cachedPath, options);
      const finalLocation = path.join(
        outputDir,
        filenameOverride || path.basename(cachedPath)
      );
      await linkIfDoesNotExist(cachedPath, finalLocation, this.log);
      return finalLocation;
    }

    // Check disk cache
    const hashedUrl = hashUrlBase64(url);
    const preDownloadedFile = await getFileByPrefix(this.cacheDir, hashedUrl);
    if (preDownloadedFile) {
      this.log.debug(`Found ${preDownloadedFile} for ${url} in cache dir`);
      await this.validateCacheAccess(url, preDownloadedFile, options);
      this.cache[url] = preDownloadedFile;
      const finalLocation = path.join(
        outputDir,
        filenameOverride || path.basename(preDownloadedFile)
      );
      await linkIfDoesNotExist(preDownloadedFile, finalLocation, this.log);
      return finalLocation;
    }

    // No cache hit - need to download
    const start = Date.now();
    const ext = path.extname(new URL(url).pathname);
    const tempFilename = `${hashedUrl}${ext}`;

    // Find appropriate provider and start download
    for (const provider of this.storageProviders) {
      if (provider.downloadFile && provider.testUrl(url)) {
        this.log.info(
          `Downloading ${url} using provider ${provider.constructor.name}`
        );
        this.activeDownloads[url] = provider
          .downloadFile(url, this.cacheDir, filenameOverride || tempFilename, options)
          .then(async (outputLocation: string) => {
            this.cache[url] = outputLocation;
            // Write metadata to track if auth was required
            // Sanitize URL to prevent credentials from being written to disk
            const metadata: CacheMetadata = {
              authRequired: hasAuth,
              url: sanitizeUrlForMetadata(url),
              cachedAt: new Date().toISOString(),
            };
            await writeCacheMetadata(outputLocation, metadata);
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
  }

  /**
   * Validate that the request is allowed to access a cached file.
   * For auth-required URLs, this validates credentials before serving from cache.
   *
   * SECURITY NOTE: There is a TOCTOU (time-of-check-to-time-of-use) race condition
   * between validating auth and serving the file. An attacker could theoretically:
   * 1. Time a request without credentials after auth validation succeeds
   * 2. Get the symlink created before the legitimate request completes
   *
   * This risk is accepted because:
   * - The file content is identical (same cached data)
   * - The attacker would need precise timing
   * - The worst case is serving cached data the attacker could access with valid credentials
   * - Fixing this would require exclusive locks, adding complexity and latency
   *
   * If stricter isolation is needed in the future, consider per-request temp directories
   * or exclusive file locking during the validation-to-symlink window.
   */
  private async validateCacheAccess(
    url: string,
    cachedPath: string,
    options?: DownloadOptions
  ): Promise<void> {
    const metadata = await readCacheMetadata(cachedPath);

    // If no metadata or auth not required, allow access
    if (!metadata || !metadata.authRequired) {
      return;
    }

    // Auth is required - check if credentials were provided
    if (!options?.auth) {
      throw new Error(
        `Authentication required to access cached file for URL: ${url}`
      );
    }

    // Validate the credentials with the storage provider
    const provider = this.storageProviders.find((p) => p.testUrl(url));
    if (!provider) {
      throw new Error(`No storage provider found for URL: ${url}`);
    }

    if (provider.validateAuth) {
      this.log.debug({ url }, "Validating auth for cached file access");
      await provider.validateAuth(url, options);
      this.log.debug({ url }, "Auth validated, serving from cache");
    } else {
      // Provider doesn't support auth validation, allow access if auth was provided
      this.log.warn(
        { url },
        "Provider does not support auth validation, allowing access"
      );
    }
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
  }

  private async _cloneWithinDirectory(
    repoUrl: string,
    targetDir: string
  ): Promise<string> {
    await fsPromises.mkdir(targetDir, { recursive: true });

    // Parse the URL to extract base URL and optional ref (branch/commit/tag)
    const { baseUrl, ref } = parseGitUrl(repoUrl);

    // Check to see if the repo is already cloned
    const repoName = baseUrl
      .substring(baseUrl.lastIndexOf("/") + 1)
      .replace(/\.git$/, "");
    const existingDir = path.join(targetDir, repoName);
    if (fs.existsSync(existingDir)) {
      // Check if it's a git repo
      if (fs.existsSync(path.join(existingDir, ".git"))) {
        if (ref) {
          // If a specific ref is requested, fetch and checkout that ref
          this.log.info(
            `Repository ${baseUrl} already cloned, checking out ref: ${ref}`
          );
          try {
            await execFilePromise("git", ["fetch", "--all"], {
              cwd: existingDir,
            });
            await execFilePromise("git", ["checkout", ref], {
              cwd: existingDir,
            });
          } catch (error) {
            this.log.error(
              { error },
              `Error checking out ref ${ref} for ${baseUrl}, using existing copy`
            );
          }
        } else {
          // No specific ref, just pull latest
          this.log.info(`Repository ${baseUrl} already cloned, pulling latest`);
          try {
            await execFilePromise("git", ["pull"], { cwd: existingDir });
          } catch (error) {
            this.log.error(
              { error },
              `Error pulling latest changes for ${baseUrl}, using existing copy`
            );
          }
        }
        return existingDir;
      } else {
        throw new Error(
          `Directory ${existingDir} already exists and is not a git repository`
        );
      }
    }

    // Clone the repo to the custom nodes directory
    this.log.info(`Cloning ${baseUrl} to ${targetDir}`);
    await execFilePromise("git", ["clone", baseUrl], { cwd: targetDir });

    // If a specific ref was requested, checkout that ref
    if (ref) {
      this.log.info(`Checking out ref: ${ref}`);
      await execFilePromise("git", ["checkout", ref], { cwd: existingDir });
    }

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
