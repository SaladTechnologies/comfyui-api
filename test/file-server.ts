import http from "http";
import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8080;
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, "test-storage");

// Ensure storage directory exists
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  // Remove leading slash from pathname to use as filename
  const filename = url.pathname.substring(1);
  const filePath = path.join(STORAGE_DIR, filename);

  // Basic auth support
  const authHeader = req.headers.authorization;
  if (process.env.REQUIRE_AUTH === "true") {
    const expectedAuth = `Basic ${Buffer.from(
      `${process.env.AUTH_USER || "user"}:${process.env.AUTH_PASS || "pass"}`
    ).toString("base64")}`;
    
    if (authHeader !== expectedAuth) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="File Server"' });
      res.end("Unauthorized");
      return;
    }
  }

  console.log(`${req.method} ${url.pathname}`);

  if (req.method === "GET" && url.pathname === "/list") {
    // List endpoint to get files (optionally filtered by prefix)
    try {
      const prefix = url.searchParams.get("prefix") || "";
      
      // Recursively find all files in storage directory
      const getAllFiles = (dir: string, basePath: string = ""): string[] => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const files: string[] = [];
        
        for (const entry of entries) {
          const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;
          const fullPath = path.join(dir, entry.name);
          
          if (entry.isDirectory()) {
            files.push(...getAllFiles(fullPath, relativePath));
          } else {
            files.push(relativePath);
          }
        }
        
        return files;
      };
      
      const allFiles = getAllFiles(STORAGE_DIR);
      const files = allFiles.filter(f => prefix ? f.startsWith(prefix) : true);
      
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ files }));
    } catch (error) {
      console.error("Error listing files:", error);
      res.writeHead(500);
      res.end("Internal Server Error");
    }
  } else if (req.method === "DELETE" && url.pathname === "/purge") {
    // Purge endpoint to delete all files and directories
    try {
      // Recursively delete all contents of the storage directory
      const entries = fs.readdirSync(STORAGE_DIR, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(STORAGE_DIR, entry.name);
        if (entry.isDirectory()) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(fullPath);
        }
      }
      
      console.log(`Purged all files from ${STORAGE_DIR}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, message: "All files purged" }));
    } catch (error) {
      console.error("Error purging files:", error);
      res.writeHead(500);
      res.end("Internal Server Error");
    }
  } else if (req.method === "PUT") {
    try {
      // Ensure we don't write outside storage dir
      if (!filePath.startsWith(STORAGE_DIR)) {
        res.writeHead(400);
        res.end("Invalid path");
        return;
      }

      // Create parent directory if it doesn't exist
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const writeStream = fs.createWriteStream(filePath);
      await pipeline(req, writeStream);
      
      console.log(`Saved file: ${filePath}`);
      res.writeHead(200);
      res.end("OK");
    } catch (error) {
      console.error("Error saving file:", error);
      res.writeHead(500);
      res.end("Internal Server Error");
    }
  } else if (req.method === "GET") {
    try {
      // Ensure we don't read outside storage dir
      if (!filePath.startsWith(STORAGE_DIR)) {
        res.writeHead(400);
        res.end("Invalid path");
        return;
      }

      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }

      const stat = fs.statSync(filePath);
      const contentType = getContentType(filename);
      
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": stat.size,
        "Content-Disposition": `inline; filename="${filename}"`,
      });

      const readStream = fs.createReadStream(filePath);
      await pipeline(readStream, res);
      
      console.log(`Served file: ${filePath}`);
    } catch (error) {
      console.error("Error reading file:", error);
      res.writeHead(500);
      res.end("Internal Server Error");
    }
  } else {
    res.writeHead(405);
    res.end("Method Not Allowed");
  }
});

function getContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".bmp": "image/bmp",
    ".tiff": "image/tiff",
    ".ico": "image/x-icon",
    ".mp4": "video/mp4",
    ".mpeg": "video/mpeg",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".weba": "audio/webm",
    ".aac": "audio/aac",
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".html": "text/html",
    ".rtf": "application/rtf",
    ".zip": "application/zip",
    ".tar": "application/x-tar",
    ".gz": "application/gzip",
    ".7z": "application/x-7z-compressed",
    ".rar": "application/x-rar-compressed",
    ".json": "application/json",
    ".xml": "application/xml",
    ".js": "application/javascript",
    ".css": "text/css",
    ".bin": "application/octet-stream",
    ".pt": "application/x-pytorch",
    ".pb": "application/x-tensorflow",
  };
  
  return mimeTypes[ext] || "application/octet-stream";
}

server.listen(PORT, () => {
  console.log(`File server listening on http://localhost:${PORT}`);
  console.log(`Storage directory: ${STORAGE_DIR}`);
  console.log(`Auth required: ${process.env.REQUIRE_AUTH === "true"}`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, closing server");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.log("SIGINT received, closing server");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});