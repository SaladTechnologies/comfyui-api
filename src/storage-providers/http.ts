import path from "path";
import { StorageProvider, Upload, DownloadOptions, DownloadAuth } from "../types";
import { FastifyBaseLogger } from "fastify";
import fs from "fs";
import { Readable } from "stream";
import config from "../config";
import { z } from "zod";
import type { Response as UndiciResponse } from "undici";
import { requireNewDownload, saveDownload } from "../download-path";
import { canonicalHttpUrl, storagePolicy } from "../storage-policy";
import { withHttpResponse } from "../safe-http";

export class HTTPStorageProvider implements StorageProvider {
  log: FastifyBaseLogger;
  requestBodyUploadKey = "http_upload";
  requestBodyUploadSchema = z.object({
    url_prefix: z.string(),
  });
  private urlRequestSchema = this.requestBodyUploadSchema.extend({
    filename: z.string().describe("The name of the file to upload"),
  });

  constructor(log: FastifyBaseLogger) {
    this.log = log.child({ module: "HTTPStorageProvider" });
  }

  createUrl(inputs: z.infer<typeof this.urlRequestSchema>): string {
    const { url_prefix, filename } = inputs;
    if (!url_prefix) {
      throw new Error("url_prefix is required to create HTTP URL");
    }
    return `${url_prefix.replace(/\/+$/, "")}/${filename}`;
  }

  testUrl(url: string): boolean {
    return url.startsWith("http://") || url.startsWith("https://");
  }

  uploadFile(
    url: string,
    fileOrPath: string | Buffer,
    contentType: string
  ): HTTPUpload {
    return new HTTPUpload(url, fileOrPath, contentType, this.log);
  }

  /**
   * Validate authentication credentials using a HEAD request.
   * Falls back to GET with Range: bytes=0-0 if HEAD returns 405 Method Not Allowed,
   * as some servers don't support HEAD requests.
   */
  async validateAuth(url: string, options: DownloadOptions): Promise<void> {
    const requestUrl = applyQueryAuth(url, options.auth);
    const request = {
      credentialHeaders: getAuthHeaders(requestUrl, options.auth),
      credentialQueryParameter: options.auth?.type === "query" ? options.auth.query_param : undefined,
    };
    const status = await withHttpResponse(requestUrl, { ...request, method: "HEAD" }, async (response) => response.status);
    const finalStatus = status === 405
      ? await withHttpResponse(requestUrl, { ...request, headers: { Range: "bytes=0-0" } }, async (response) => response.status)
      : status;
    if (finalStatus < 200 || finalStatus >= 300) throw new Error(`Authentication validation failed (${finalStatus})`);
  }

  async downloadFile(
    url: string,
    outputDir: string,
    filenameOverride?: string,
    options?: DownloadOptions
  ): Promise<string> {
    let filename = filenameOverride ?? path.basename(new URL(url).pathname);
    // Validate before resolving DNS, connecting, or opening a file.
    await requireNewDownload(outputDir, filename);
    const requestUrl = applyQueryAuth(url, options?.auth);
    return withHttpResponse(requestUrl, {
      credentialHeaders: getAuthHeaders(requestUrl, options?.auth),
      credentialQueryParameter: options?.auth?.type === "query" ? options.auth.query_param : undefined,
    }, async (response) => {
      if (!response.ok) throw new Error(`Download failed (${response.status})`);
      if (!response.body) throw new Error("Response body is null");
      if (path.extname(filename) === "") filename += getIntendedFileExtensionFromResponse(response) || "";
      return saveDownload(outputDir, filename, Readable.fromWeb(response.body as any));
    });
  }

}

class HTTPUpload implements Upload {
  url: string;
  fileOrPath: string | Buffer;
  contentType: string;
  log: FastifyBaseLogger;
  state: "in-progress" | "completed" | "failed" | "aborted" = "in-progress";
  private abortController: AbortController | null = null;

  constructor(
    url: string,
    fileOrPath: string | Buffer,
    contentType: string,
    log: FastifyBaseLogger
  ) {
    this.url = url;
    this.fileOrPath = fileOrPath;
    this.contentType = contentType;
    this.log = log.child({ uploader: "HTTPUpload" });
    this.state = "in-progress";
  }

  async upload(): Promise<void> {
    if (this.state !== "in-progress") {
      throw new Error(`Cannot upload: state is ${this.state}`);
    }

    this.abortController = new AbortController();
    let body: Buffer | fs.ReadStream | undefined;
    try {
      this.log.info({ url: this.url }, "Starting upload");

      if (Buffer.isBuffer(this.fileOrPath)) {
        body = this.fileOrPath;
      } else {
        body = fs.createReadStream(this.fileOrPath);
      }

      await withHttpResponse(this.url, {
        method: "PUT",
        headers: { "Content-Type": this.contentType },
        credentialHeaders: getAuthHeaders(this.url),
        body: body as any,
        duplex: "half",
        signal: this.abortController.signal,
      }, async (response) => {
        if (!response.ok) throw new Error(`Upload failed (${response.status})`);
      });

      this.state = "completed";
      this.log.info({ url: this.url }, "Upload completed successfully");
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        this.state = "aborted";
        this.log.info({ url: this.url }, "Upload aborted");
      } else {
        this.state = "failed";
        this.log.error({ url: this.url, error }, "Upload failed");
        throw error;
      }
    } finally {
      if (body instanceof fs.ReadStream) body.destroy();
      this.abortController = null;
    }
  }

  async abort(): Promise<void> {
    if (this.state !== "in-progress") {
      this.log.warn(
        { state: this.state },
        "Cannot abort: upload is not in progress"
      );
      return;
    }

    if (this.abortController) {
      this.log.info({ url: this.url }, "Aborting upload");
      this.abortController.abort();
      this.state = "aborted";
    }
  }
}

function mimeToExtension(mimeType: string): string | null {
  const mimeMap: Record<string, string> = {
    // Documents
    "application/pdf": ".pdf",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      ".docx",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      ".xlsx",
    "application/vnd.ms-powerpoint": ".ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      ".pptx",
    "text/plain": ".txt",
    "text/csv": ".csv",
    "text/html": ".html",
    "application/rtf": ".rtf",

    // Images
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/bmp": ".bmp",
    "image/tiff": ".tiff",
    "image/x-icon": ".ico",

    // Video
    "video/mp4": ".mp4",
    "video/mpeg": ".mpeg",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
    "video/x-msvideo": ".avi",

    // Audio
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/ogg": ".ogg",
    "audio/webm": ".weba",
    "audio/aac": ".aac",

    // Archives
    "application/zip": ".zip",
    "application/x-tar": ".tar",
    "application/gzip": ".gz",
    "application/x-7z-compressed": ".7z",
    "application/x-rar-compressed": ".rar",

    // Code/Data
    "application/json": ".json",
    "application/xml": ".xml",
    "text/xml": ".xml",
    "application/javascript": ".js",
    "text/javascript": ".js",
    "text/css": ".css",

    // Binary/ML Model formats
    "application/octet-stream": ".bin", // Generic binary, but commonly used for model files
    "application/x-pytorch": ".pt",
    "application/x-tensorflow": ".pb",
  };

  return mimeMap[mimeType] || null;
}

function getIntendedFileExtensionFromResponse(
  response: UndiciResponse
): string | null {
  // 1. Try content-disposition header for filename
  const contentDisposition = response.headers.get("content-disposition");
  if (contentDisposition) {
    const match = contentDisposition.match(
      /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/
    );
    if (match != null && match[1]) {
      const filename = match[1].replace(/['"]/g, "");
      const ext = path.extname(filename);
      if (/^\.[a-zA-Z0-9]{1,14}$/.test(ext)) return ext;
    }
  }

  // 2. Try to get extension from the URL
  try {
    const url = new URL(response.url);
    const pathname = url.pathname;
    const ext = path.extname(pathname);
    // Only use if it looks like a real extension (not empty and reasonable length)
    if (/^\.[a-zA-Z0-9]{1,14}$/.test(ext)) return ext; // Increased to handle .safetensors
  } catch {
    // Invalid URL, continue to next method
  }

  // 3. Map content-type to common extensions
  const contentType = response.headers.get("content-type");
  if (contentType) {
    const mimeType = contentType.split(";")[0].trim().toLowerCase();
    const ext = mimeToExtension(mimeType);
    if (ext) return ext;
  }

  return null;
}

/**
 * Apply query parameter authentication to a URL (e.g., Azure SAS tokens).
 * Returns the URL with auth query param appended if applicable.
 */
function applyQueryAuth(url: string, auth?: DownloadAuth): string {
  if (!auth || auth.type !== "query") {
    return url;
  }
  const parsedUrl = new URL(url);
  parsedUrl.searchParams.set(auth.query_param, auth.query_value);
  return parsedUrl.toString();
}

/**
 * Build authentication headers for HTTP requests.
 * Per-request auth takes precedence over origin-bound environment credentials.
 *
 * When per-request auth is provided, URL-embedded credentials are NOT used,
 * even if they exist. This prevents credential mixing and ensures explicit
 * auth takes full precedence.
 */
export function getAuthHeaders(url: string, auth?: DownloadAuth): Record<string, string> {
  const headers: Record<string, string> = {};

  // If per-request auth is provided, use it exclusively (no fallback to URL credentials)
  if (auth) {
    switch (auth.type) {
      case "bearer":
        headers["Authorization"] = `Bearer ${auth.token}`;
        return headers;
      case "basic": {
        const credentials = `${auth.username}:${auth.password}`;
        headers["Authorization"] = `Basic ${Buffer.from(credentials).toString("base64")}`;
        return headers;
      }
      case "header":
        if (/^(host|connection|content-length|transfer-encoding|proxy-.*|upgrade|trailer|te)$/i.test(auth.header_name)) {
          throw new Error("Authentication header name is not allowed");
        }
        headers[auth.header_name] = auth.header_value;
        return headers;
      case "query":
        // Query auth is applied to URL, not headers - but still return empty headers
        // to avoid falling back to URL-embedded or env credentials
        return headers;
      case "s3":
        // S3 auth is handled by S3StorageProvider, not HTTP
        // Return empty headers - don't fall back to URL/env credentials
        return headers;
    }
  }

  // Preserve URL basic auth, but pass the credential through the same redirect
  // scoping as explicit request auth. The transport removes URL userinfo.
  const parsed = new URL(url);
  if (parsed.username || parsed.password) {
    const credentials = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`;
    return { Authorization: `Basic ${Buffer.from(credentials).toString("base64")}` };
  }

  // A deployer credential is bound to exact origins, never to arbitrary URLs.
  const origin = canonicalHttpUrl(url).origin;
  if (storagePolicy.authOrigins.includes(origin)) {
    Object.assign(headers, config.httpAuthHeader);
  }

  return headers;
}
