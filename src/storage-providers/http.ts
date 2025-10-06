import path from "path";
import { StorageProvider, Upload } from "../types";
import { FastifyBaseLogger } from "fastify";
import fs from "fs";
import { Readable } from "stream";

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

    try {
      this.log.info({ url: this.url }, "Starting upload");

      let body: Buffer | fs.ReadStream;

      if (Buffer.isBuffer(this.fileOrPath)) {
        body = this.fileOrPath;
      } else {
        body = fs.createReadStream(this.fileOrPath);
      }

      // Parse URL to extract credentials if present
      const parsedUrl = new URL(this.url);
      const headers: HeadersInit = {
        "Content-Type": this.contentType,
      };

      // Add basic auth header if credentials are in the URL
      if (parsedUrl.username || parsedUrl.password) {
        const credentials = `${parsedUrl.username}:${parsedUrl.password}`;
        headers["Authorization"] = `Basic ${Buffer.from(credentials).toString(
          "base64"
        )}`;

        // Remove credentials from URL for the actual request
        parsedUrl.username = "";
        parsedUrl.password = "";
      }

      const response = await fetch(parsedUrl.toString(), {
        method: "PUT",
        headers,
        body: body as any,
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw new Error(
          `Upload failed with status ${response.status}: ${response.statusText}`
        );
      }

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
  response: Response
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
      if (ext) return ext;
    }
  }

  // 2. Try to get extension from the URL
  try {
    const url = new URL(response.url);
    const pathname = url.pathname;
    const ext = path.extname(pathname);
    // Only use if it looks like a real extension (not empty and reasonable length)
    if (ext && ext.length <= 15) return ext; // Increased to handle .safetensors
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

export class HTTPStorageProvider implements StorageProvider {
  log: FastifyBaseLogger;

  constructor(log: FastifyBaseLogger) {
    this.log = log.child({ module: "HTTPStorageProvider" });
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

  async downloadFile(
    url: string,
    outputDir: string,
    filenameOverride?: string
  ): Promise<string> {
    try {
      // Fetch the image
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Error downloading file: ${response.statusText}`);
      }

      let outputPath = path.join(
        outputDir,
        filenameOverride || path.basename(new URL(url).pathname)
      );

      if (path.extname(outputPath) === "") {
        const ext = getIntendedFileExtensionFromResponse(response) || "";
        if (ext) {
          outputPath = outputPath + ext;
        }
      }

      // Get the response as a readable stream
      const body = response.body;
      if (!body) {
        throw new Error("Response body is null");
      }

      this.log.info(`Downloading file to ${outputPath}`);

      // Create a writable stream to save the file
      const fileStream = fs.createWriteStream(outputPath);

      // Pipe the response to the file
      await new Promise<void>((resolve, reject) => {
        Readable.fromWeb(body as any)
          .pipe(fileStream)
          .on("finish", () => resolve())
          .on("error", reject);
      });

      this.log.info(`File downloaded and saved to ${outputPath}`);
      return outputPath;
    } catch (error: any) {
      this.log.error("Error downloading file:", error);
      throw error;
    }
  }
}
