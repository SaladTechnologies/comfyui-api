import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const config = vi.hoisted(() => ({ inputDir: "" }));
vi.mock("../src/config", () => ({ default: config }));

import { linkIfDoesNotExist } from "../src/remote-storage-manager";

const log: any = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let root: string;
let cacheDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "comfyui-input-staging-"));
  config.inputDir = path.join(root, "input");
  cacheDir = path.join(root, "cache");
  fs.mkdirSync(config.inputDir);
  fs.mkdirSync(cacheDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function cachedFile(name = "photo.png"): string {
  const source = path.join(cacheDir, name);
  fs.writeFileSync(source, "downloaded media");
  return source;
}

// ComfyUI >= 0.28 checks real paths, rejecting input symlinks into the cache.
function expectContainedInput(dest: string) {
  const relative = path.relative(fs.realpathSync(config.inputDir), fs.realpathSync(dest));
  expect(relative).not.toBe("..");
  expect(relative.startsWith(`..${path.sep}`)).toBe(false);
  expect(path.isAbsolute(relative)).toBe(false);
  expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false);
  expect(fs.readFileSync(dest, "utf8")).toBe("downloaded media");
}

describe("ComfyUI input staging", () => {
  it("keeps a downloaded input inside ComfyUI's input directory without duplicating bytes", async () => {
    const source = cachedFile();
    const dest = path.join(config.inputDir, "photo.png");
    await linkIfDoesNotExist(source, dest, log);
    expectContainedInput(dest);
    expect(fs.statSync(dest).ino).toBe(fs.statSync(source).ino);
  });

  it("keeps the staged input readable after cache eviction", async () => {
    const source = cachedFile();
    const dest = path.join(config.inputDir, "photo.png");
    await linkIfDoesNotExist(source, dest, log);
    fs.unlinkSync(source);
    expectContainedInput(dest);
  });

  it.each([false, true])("repairs a legacy input symlink (dangling: %s)", async (dangling) => {
    const source = cachedFile();
    const dest = path.join(config.inputDir, "photo.png");
    fs.symlinkSync(dangling ? path.join(cacheDir, "evicted.png") : source, dest);
    await linkIfDoesNotExist(source, dest, log);
    expectContainedInput(dest);
  });

  it("preserves an existing regular input file", async () => {
    const dest = path.join(config.inputDir, "photo.png");
    fs.writeFileSync(dest, "already staged");
    await linkIfDoesNotExist(cachedFile(), dest, log);
    expect(fs.readFileSync(dest, "utf8")).toBe("already staged");
  });

  it("stages nested inputs with a trailing slash in INPUT_DIR", async () => {
    config.inputDir += path.sep;
    const dest = path.join(config.inputDir, "job", "photo.png");
    await linkIfDoesNotExist(cachedFile(), dest, log);
    expectContainedInput(dest);
  });

  it("stages inputs when INPUT_DIR is configured as a relative path", async () => {
    const dest = path.join(config.inputDir, "photo.png");
    config.inputDir = path.relative(process.cwd(), config.inputDir);
    await linkIfDoesNotExist(cachedFile(), dest, log);
    expectContainedInput(dest);
  });

  it.each(["models/checkpoints/model.safetensors", "input-other/photo.png", "input/../models/photo.png"])(
    "retains symlinks for files outside the input directory: %s",
    async (relative) => {
      const source = cachedFile();
      const dest = path.join(root, relative);
      await linkIfDoesNotExist(source, dest, log);
      expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(dest)).toBe(source);
    }
  );

  it("copies an input when the cache is on a different filesystem", async () => {
    const source = cachedFile();
    const dest = path.join(config.inputDir, "photo.png");
    vi.spyOn(fsPromises, "link").mockRejectedValue(Object.assign(new Error("cross-device link"), { code: "EXDEV" }));
    await linkIfDoesNotExist(source, dest, log);
    fs.unlinkSync(source);
    expectContainedInput(dest);
    expect(fs.readdirSync(config.inputDir)).toEqual(["photo.png"]);
  });

  it("handles concurrent requests downloading the same input", async () => {
    const source = cachedFile();
    const dest = path.join(config.inputDir, "photo.png");
    await Promise.all(Array.from({ length: 10 }, () => linkIfDoesNotExist(source, dest, log)));
    expectContainedInput(dest);
  });

  it("does not hide filesystem failures", async () => {
    const source = cachedFile();
    const dest = path.join(config.inputDir, "photo.png");
    vi.spyOn(fsPromises, "link").mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }));
    await expect(linkIfDoesNotExist(source, dest, log)).rejects.toMatchObject({ code: "EACCES" });
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("does not expose a partial input if a cross-filesystem copy fails", async () => {
    const source = cachedFile();
    const dest = path.join(config.inputDir, "photo.png");
    vi.spyOn(fsPromises, "link").mockRejectedValue(Object.assign(new Error("cross-device link"), { code: "EXDEV" }));
    vi.spyOn(fsPromises, "copyFile").mockImplementation(async (_src, target) => {
      fs.writeFileSync(target, "partial");
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    });
    await expect(linkIfDoesNotExist(source, dest, log)).rejects.toMatchObject({ code: "ENOSPC" });
    expect(fs.readdirSync(config.inputDir)).toEqual([]);
  });
});
