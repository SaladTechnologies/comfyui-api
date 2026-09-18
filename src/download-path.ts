import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Leaf names only, with the same interpretation on POSIX and Windows. */
export function isSafeDownloadFilename(name: string): boolean {
  const normalized = name.normalize("NFKC");
  return [name, normalized].every((value) =>
    value.length > 0 && value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= 255 &&
    !/[\x00-\x1f\x7f/\\:<>"|?*]/.test(value) &&
    !/[. ]$/.test(value) &&
    value !== "." && value !== ".." &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value) &&
    path.posix.basename(value) === value && path.win32.basename(value) === value
  );
}

export function validateDownloadFilename(name: string): void {
  if (!isSafeDownloadFilename(name)) {
    throw new Error("Invalid download filename: expected a single file name");
  }
}

export async function downloadDestination(root: string, name: string): Promise<string> {
  validateDownloadFilename(name);
  // The directory comes from server configuration, never from the filename.
  await fsp.mkdir(root, { recursive: true });
  return path.join(await fsp.realpath(root), name);
}

export async function requireNewDownload(root: string, name: string): Promise<string> {
  const destination = await downloadDestination(root, name);
  const existing = await fsp.lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) throw new Error("Download destination already exists");
  return destination;
}

export async function requireCachedFile(root: string, file: string): Promise<void> {
  const destination = await downloadDestination(root, path.basename(file));
  const parent = await fsp.realpath(path.dirname(file));
  if (path.join(parent, path.basename(file)) !== destination || !(await fsp.lstat(file)).isFile()) {
    throw new Error("Invalid cached download");
  }
}

/** Publish only a complete file. Exclusive creation never follows or replaces a link. */
export async function saveDownload(
  root: string,
  name: string,
  source: Readable
): Promise<string> {
  let temporary: string | undefined;
  // A network stream may fail while the destination's filesystem checks await
  // I/O. Observe that error immediately; pipeline will handle later failures.
  let sourceError: Error | undefined;
  source.once("error", (error) => { sourceError = error; });
  try {
    const destination = await requireNewDownload(root, name);
    if (sourceError) throw sourceError;
    temporary = path.join(path.dirname(destination), `.download-${randomUUID()}.partial`);
    await pipeline(source, fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    // Unlike rename, link fails if another request created the destination.
    await fsp.link(temporary, destination);
    return destination;
  } finally {
    source.destroy();
    if (temporary) await fsp.rm(temporary, { force: true });
  }
}

/** Safely stage a complete CLI download, without copying bytes on the same mount. */
export async function stageDownloadedFile(
  root: string,
  name: string,
  source: string
): Promise<string> {
  const destination = await requireNewDownload(root, name);
  const resolvedSource = await fsp.realpath(source);
  if (!(await fsp.stat(resolvedSource)).isFile()) throw new Error("Invalid downloaded file");
  try {
    await fsp.link(resolvedSource, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    const temporary = path.join(path.dirname(destination), `.download-${randomUUID()}.partial`);
    try {
      await fsp.copyFile(resolvedSource, temporary, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
      await fsp.link(temporary, destination);
    } finally {
      await fsp.rm(temporary, { force: true });
    }
  }
  return destination;
}
