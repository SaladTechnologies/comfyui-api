import { expect, describe, it, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";

/**
 * ComfyUI >= v0.28.0 rejects an input file that does not resolve to a path
 * inside the input directory (PR #14734, GHSA-779p-m5rp-r4h4). These tests
 * mirror ComfyUI's own containment check so a regression fails here rather than
 * in a render.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "comfyui-api-staging-"));
const inputDir = path.join(tmpRoot, "input");
const cacheDir = path.join(tmpRoot, "cache");
const modelDir = path.join(tmpRoot, "models");

vi.mock("../src/config", () => ({
  default: { inputDir, cacheDir, modelDir, lruCacheSizeBytes: 0 },
}));

const { linkIfDoesNotExist } = await import("../src/remote-storage-manager");

const log: any = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

beforeEach(() => {
  for (const dir of [inputDir, cacheDir, modelDir]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function cached(name: string, contents = "cached-bytes"): string {
  const p = path.join(cacheDir, name);
  fs.writeFileSync(p, contents);
  return p;
}

/**
 * ComfyUI's folder_paths.is_within_directory(), which realpath()s both operands:
 *
 *     directory = os.path.realpath(directory)
 *     target = os.path.realpath(target)
 *     return os.path.commonpath((directory, target)) == directory
 */
function comfyAcceptsInput(dest: string): boolean {
  if (!fs.existsSync(dest)) {
    return false;
  }
  const realDir = fs.realpathSync(inputDir);
  const realTarget = fs.realpathSync(dest);
  return realTarget === realDir || realTarget.startsWith(realDir + path.sep);
}

describe("staging input files for ComfyUI >= v0.28.0", () => {
  it("stages an input ComfyUI accepts", async () => {
    const dest = path.join(inputDir, "photo.png");

    await linkIfDoesNotExist(cached("photo.png"), dest, log);

    expect(comfyAcceptsInput(dest)).toEqual(true);
    expect(fs.lstatSync(dest).isSymbolicLink()).toEqual(false);
  });

  it("does not duplicate the file's bytes", async () => {
    const src = cached("photo.png");
    const dest = path.join(inputDir, "photo.png");

    await linkIfDoesNotExist(src, dest, log);

    expect(fs.statSync(dest).ino).toEqual(fs.statSync(src).ino);
  });

  it("keeps the input readable after the cache entry is evicted", async () => {
    const src = cached("photo.png");
    const dest = path.join(inputDir, "photo.png");
    await linkIfDoesNotExist(src, dest, log);

    fs.unlinkSync(src);

    expect(comfyAcceptsInput(dest)).toEqual(true);
    expect(fs.readFileSync(dest, "utf-8")).toEqual("cached-bytes");
  });

  it("replaces a symlink left by an older version", async () => {
    const src = cached("photo.png");
    const dest = path.join(inputDir, "photo.png");
    fs.symlinkSync(src, dest);
    expect(comfyAcceptsInput(dest)).toEqual(false);

    await linkIfDoesNotExist(src, dest, log);

    expect(comfyAcceptsInput(dest)).toEqual(true);
  });

  it("replaces a symlink whose cache target was evicted", async () => {
    // lstat() succeeds on a dangling symlink, so the old "already exists" check
    // left these broken forever.
    const dest = path.join(inputDir, "photo.png");
    fs.symlinkSync(path.join(cacheDir, "evicted.png"), dest);

    await linkIfDoesNotExist(cached("photo.png"), dest, log);

    expect(comfyAcceptsInput(dest)).toEqual(true);
  });

  it("reuses an input that is already staged", async () => {
    const dest = path.join(inputDir, "photo.png");
    fs.writeFileSync(dest, "already-there");

    await linkIfDoesNotExist(cached("photo.png"), dest, log);

    expect(fs.readFileSync(dest, "utf-8")).toEqual("already-there");
  });

  it("creates missing parent directories", async () => {
    const dest = path.join(inputDir, "job-123", "photo.png");

    await linkIfDoesNotExist(cached("photo.png"), dest, log);

    expect(comfyAcceptsInput(dest)).toEqual(true);
  });

  it("still symlinks model files, which are not containment checked", async () => {
    // Models are routinely many gigabytes, and the cache is often on a
    // different filesystem, where a copy would be the fallback.
    const dest = path.join(modelDir, "checkpoints", "model.safetensors");

    await linkIfDoesNotExist(cached("model.safetensors"), dest, log);

    expect(fs.lstatSync(dest).isSymbolicLink()).toEqual(true);
  });
});
