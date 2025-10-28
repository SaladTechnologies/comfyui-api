import config from "./config";
import { FastifyBaseLogger } from "fastify";
import fsPromises from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import getStorageManager from "./remote-storage-manager";
import sharp from "sharp";
import { OutputConversionOptions } from "./types";
import { isValidUrl } from "./utils";

export async function processInputMedia(
  fileInput: string,
  log: FastifyBaseLogger,
  dirWithinInputDir?: string
): Promise<string> {
  const storageManager = getStorageManager();
  let localFilePath: string;
  const ext = path.extname(fileInput).split("?")[0];
  const localFileName = `${randomUUID()}${ext}`;
  if (dirWithinInputDir) {
    localFilePath = path.join(
      config.inputDir,
      dirWithinInputDir,
      localFileName
    );
    // Create the directory if it doesn't exist
    await fsPromises.mkdir(path.dirname(localFilePath), { recursive: true });
  } else {
    localFilePath = path.join(config.inputDir, localFileName);
  }
  if (
    (fileInput.startsWith("/") &&
      fileInput.length < 4096 &&
      !fileInput.endsWith("==")) ||
    fileInput.startsWith("./") ||
    fileInput.startsWith("../")
  ) {
    return path.resolve(fileInput);
  } else if (isValidUrl(fileInput)) {
    const dir = path.dirname(localFilePath);
    return storageManager.downloadFile(fileInput, dir);
  } else {
    // Assume it's base64 encoded data
    try {
      const base64Data = Buffer.from(fileInput, "base64");
      const extension = guessFileExtensionFromBase64(fileInput);
      if (!extension) {
        throw new Error("Could not determine file type from base64 data");
      }
      localFilePath = `${localFilePath}.${extension}`;
      log.debug(`Saving decoded file to ${localFilePath}`);
      await fsPromises.writeFile(localFilePath, base64Data);
      return localFilePath;
    } catch (e: any) {
      throw new Error(`Failed to parse base64 encoded file: ${e.message}`);
    }
  }
}

function guessFileExtensionFromBase64(base64Data: string): string | null {
  try {
    // Remove data URL prefix if present (e.g., "data:video/mp4;base64,")
    const cleanBase64 = base64Data.replace(/^data:[^;]+;base64,/, "");

    // Decode first 32 bytes to check file signatures
    const buffer = Buffer.from(cleanBase64.slice(0, 44), "base64"); // 44 chars = ~33 bytes
    const bytes = Array.from(buffer);

    // Helper function to check bytes at specific positions
    const checkBytes = (offset: number, expected: number[]): boolean => {
      return expected.every((byte, index) => bytes[offset + index] === byte);
    };

    // Helper function to check for string in buffer
    const hasString = (str: string): boolean => {
      return buffer.includes(Buffer.from(str));
    };

    // Images
    if (checkBytes(0, [0xff, 0xd8, 0xff])) return "jpg";
    if (checkBytes(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      return "png";
    if (
      checkBytes(0, [0x47, 0x49, 0x46, 0x38]) &&
      (bytes[4] === 0x37 || bytes[4] === 0x39)
    )
      return "gif";
    if (
      checkBytes(0, [0x52, 0x49, 0x46, 0x46]) &&
      checkBytes(8, [0x57, 0x45, 0x42, 0x50])
    )
      return "webp";
    if (checkBytes(0, [0x42, 0x4d])) return "bmp";
    if (
      checkBytes(0, [0x49, 0x49, 0x2a, 0x00]) ||
      checkBytes(0, [0x4d, 0x4d, 0x00, 0x2a])
    )
      return "tiff";
    if (checkBytes(0, [0x00, 0x00, 0x01, 0x00])) return "ico";

    // Videos
    if (hasString("ftyp")) {
      const ftypIndex = buffer.indexOf(Buffer.from("ftyp"));
      if (ftypIndex !== -1 && ftypIndex + 8 <= buffer.length) {
        const brand = buffer.subarray(ftypIndex + 4, ftypIndex + 8).toString();
        if (brand.startsWith("mp4") || brand.startsWith("isom")) return "mp4";
        if (brand.startsWith("M4V")) return "m4v";
        if (brand.startsWith("3gp")) return "3gp";
        if (brand.startsWith("qt")) return "mov";
      }
    }
    if (
      checkBytes(0, [0x52, 0x49, 0x46, 0x46]) &&
      checkBytes(8, [0x41, 0x56, 0x49, 0x20])
    )
      return "avi";
    if (checkBytes(0, [0x1a, 0x45, 0xdf, 0xa3])) {
      // Both WebM and MKV use EBML, need deeper inspection
      if (hasString("webm")) return "webm";
      return "mkv"; // Default to MKV for EBML
    }
    if (checkBytes(0, [0x46, 0x4c, 0x56])) return "flv";
    if (checkBytes(0, [0x30, 0x26, 0xb2, 0x75])) return "wmv";

    // Audio
    if (
      checkBytes(0, [0xff, 0xfb]) ||
      checkBytes(0, [0xff, 0xf3]) ||
      checkBytes(0, [0xff, 0xf2])
    )
      return "mp3";
    if (checkBytes(0, [0x49, 0x44, 0x33])) return "mp3"; // ID3 tag
    if (
      checkBytes(0, [0x52, 0x49, 0x46, 0x46]) &&
      checkBytes(8, [0x57, 0x41, 0x56, 0x45])
    )
      return "wav";
    if (checkBytes(0, [0x4f, 0x67, 0x67, 0x53])) return "ogg";
    if (checkBytes(0, [0x66, 0x4c, 0x61, 0x43])) return "flac";
    if (hasString("ftypM4A")) return "m4a";

    // Archives
    if (
      checkBytes(0, [0x50, 0x4b, 0x03, 0x04]) ||
      checkBytes(0, [0x50, 0x4b, 0x05, 0x06]) ||
      checkBytes(0, [0x50, 0x4b, 0x07, 0x08])
    )
      return "zip";
    if (checkBytes(0, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])) return "rar";
    if (checkBytes(0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return "7z";
    if (checkBytes(0, [0x1f, 0x8b])) return "gz";
    if (checkBytes(0, [0x42, 0x5a, 0x68])) return "bz2";

    // Documents
    if (checkBytes(0, [0x25, 0x50, 0x44, 0x46])) return "pdf";
    if (checkBytes(0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
      // Microsoft Office formats (legacy)
      return "doc"; // Could also be .xls, .ppt - would need deeper inspection
    }
    if (checkBytes(0, [0x50, 0x4b]) && hasString("word/")) return "docx";
    if (checkBytes(0, [0x50, 0x4b]) && hasString("xl/")) return "xlsx";
    if (checkBytes(0, [0x50, 0x4b]) && hasString("ppt/")) return "pptx";

    // Text/Code
    if (checkBytes(0, [0xef, 0xbb, 0xbf])) return "txt"; // UTF-8 BOM
    if (checkBytes(0, [0xff, 0xfe])) return "txt"; // UTF-16 LE BOM
    if (checkBytes(0, [0xfe, 0xff])) return "txt"; // UTF-16 BE BOM

    // Fonts
    if (checkBytes(0, [0x00, 0x01, 0x00, 0x00, 0x00])) return "ttf";
    if (checkBytes(0, [0x4f, 0x54, 0x54, 0x4f])) return "otf";
    if (checkBytes(0, [0x77, 0x4f, 0x46, 0x46])) return "woff";
    if (checkBytes(0, [0x77, 0x4f, 0x46, 0x32])) return "woff2";

    // Try to detect if it's likely text-based by checking for printable ASCII
    let printableCount = 0;
    for (let i = 0; i < Math.min(buffer.length, 32); i++) {
      if (
        (bytes[i] >= 32 && bytes[i] <= 126) ||
        bytes[i] === 9 ||
        bytes[i] === 10 ||
        bytes[i] === 13
      ) {
        printableCount++;
      }
    }

    // If mostly printable characters, assume it's a text file
    if (printableCount / Math.min(buffer.length, 32) > 0.7) {
      return "txt";
    }

    return null; // Unknown format
  } catch (error) {
    console.error("Error detecting file format:", error);
    return null;
  }
}

export async function convertImageBuffer(
  imageBuffer: Buffer,
  options: OutputConversionOptions
) {
  const { format, options: conversionOptions } = options;
  let image = sharp(imageBuffer);

  if (format === "webp") {
    image = image.webp(conversionOptions);
  } else if (format === "jpg" || format === "jpeg") {
    image = image.jpeg(conversionOptions);
  }

  return image.toBuffer();
}
