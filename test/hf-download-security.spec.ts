import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const cli = vi.hoisted(() => vi.fn());
vi.mock("../src/config", () => ({ default: { hfCLIVersion: "1.11.0" } }));
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  // promisify receives the same stdout/stderr object as execFile's custom promise implementation.
  return { ...actual, execFile: cli };
});
import { HFStorageProvider } from "../src/storage-providers/hf";

const log: any = { info() {}, debug() {}, warn() {}, error() {}, child() { return this; } };
const url = "https://huggingface.co/user/repo/resolve/main/folder/model.bin";
let root: string;
let destination: string;
let blob: string;
let snapshot: string;
let provider: HFStorageProvider;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "comfyui-hf-security-"));
  destination = path.join(root, "models");
  blob = path.join(root, "hf-blob.bin");
  snapshot = path.join(root, "snapshot.bin");
  await fs.mkdir(destination);
  await fs.writeFile(blob, "model bytes");
  await fs.symlink(blob, snapshot);
  cli.mockReset();
  cli.mockImplementation((_command, _args, _options, callback) => callback(null, { stdout: snapshot + "\n", stderr: "" }));
  provider = new HFStorageProvider(log);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe("Hugging Face CLI downloads", () => {
  it.each(["plain", "colored"])("preserves CLI downloads and supports %s output", async (format) => {
    const stdout = format === "colored" ? `\x1b[32m✓ Downloaded\x1b[0m\n  path: ${snapshot}\n` : snapshot + "\n";
    cli.mockImplementationOnce((_command, _args, _options, callback) => callback(null, { stdout, stderr: "" }));
    const sourceStats = await fs.stat(blob);
    const result = await provider.downloadFile(url, destination, "model.bin");
    expect(cli).toHaveBeenCalledTimes(1);
    expect(cli.mock.calls[0][0]).toBe("hf");
    expect(cli.mock.calls[0][1]).toEqual(["download", "--repo-type", "model", "--revision=main", "--", "user/repo", "folder/model.bin"]);
    expect(await fs.readFile(result, "utf8")).toBe("model bytes");
    expect((await fs.lstat(result)).isSymbolicLink()).toBe(false);
    expect((await fs.stat(result)).ino).toBe(sourceStats.ino);
    await expect(fs.stat(blob)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(destination)).toEqual(["model.bin"]);
  });

  it("preserves dataset repositories and custom revisions", async () => {
    await provider.downloadFile("https://huggingface.co/datasets/user/data/resolve/v2/folder/file.bin", destination, "model.bin");
    expect(cli.mock.calls[0][1]).toEqual(["download", "--repo-type", "dataset", "--revision=v2", "--", "user/data", "folder/file.bin"]);
  });

  it("retains the configured CLI authentication and Xet environment", async () => {
    vi.stubEnv("HF_TOKEN", "dummy-hf-token");
    vi.stubEnv("HF_XET_HIGH_PERFORMANCE", "1");
    await provider.downloadFile(url, destination, "model.bin");
    expect(cli.mock.calls[0][2].env.HF_TOKEN).toBe("dummy-hf-token");
    expect(cli.mock.calls[0][2].env.HF_XET_HIGH_PERFORMANCE).toBe("1");
  });

  it("copies safely across separate cache mounts", async () => {
    const link = fs.link.bind(fs);
    vi.spyOn(fs, "link").mockRejectedValueOnce(Object.assign(new Error("cross-device"), { code: "EXDEV" })).mockImplementation(link);
    const result = await provider.downloadFile(url, destination, "model.bin");
    expect(await fs.readFile(result, "utf8")).toBe("model bytes");
    expect(await fs.readdir(destination)).toEqual(["model.bin"]);
    await expect(fs.stat(blob)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("Hugging Face filesystem boundaries", () => {
  it.each(["../outside.bin", "a/b.bin", "a\\b.bin", "/absolute.bin", "C:\\proof.bin", "..", "", "bad\0name", "a".repeat(256)])(
    "rejects destination %j before starting the CLI", async (filename) => {
      await expect(provider.downloadFile(url, destination, filename)).rejects.toThrow();
      expect(cli).not.toHaveBeenCalled();
      expect(await fs.readdir(destination)).toEqual([]);
    }
  );

  it.each([false, true])("does not replace an existing destination (symlink: %s)", async (symlink) => {
    const target = path.join(destination, "model.bin");
    if (symlink) await fs.symlink(blob, target);
    else await fs.writeFile(target, "original");
    await expect(provider.downloadFile(url, destination, "model.bin")).rejects.toThrow();
    expect(cli).not.toHaveBeenCalled();
    expect(await fs.readFile(target, "utf8")).toBe(symlink ? "model bytes" : "original");
  });

  it("does not replace a destination created while the CLI is running", async () => {
    cli.mockImplementationOnce((_command, _args, _options, callback) => {
      fs.symlink(blob, path.join(destination, "model.bin"))
        .then(() => callback(null, { stdout: snapshot, stderr: "" }), callback);
    });
    await expect(provider.downloadFile(url, destination, "model.bin")).rejects.toThrow();
    expect(await fs.readFile(blob, "utf8")).toBe("model bytes");
    expect((await fs.lstat(path.join(destination, "model.bin"))).isSymbolicLink()).toBe(true);
  });

  it.each(["..%2Foutside.bin", "%2Fabsolute.bin", "C%3A%5Coutside.bin", "folder%5C..%5Coutside.bin", "bad%0Aname.bin"])(
    "rejects remote path %j before it can escape the CLI cache", async (filePath) => {
      await expect(provider.downloadFile(`https://huggingface.co/user/repo/resolve/main/${filePath}`, destination, "model.bin")).rejects.toThrow();
      expect(cli).not.toHaveBeenCalled();
    }
  );

  it("keeps option-like filenames as positional arguments", async () => {
    await provider.downloadFile("https://huggingface.co/user/repo/resolve/main/--local-dir%3Doutside", destination, "model.bin");
    expect(cli.mock.calls[0][1]).toEqual(["download", "--repo-type", "model", "--revision=main", "--", "user/repo", "--local-dir=outside"]);
  });

  it("rejects an unrelated origin before starting the CLI", async () => {
    await expect(provider.downloadFile("https://other.example/user/repo/resolve/main/model.bin", destination, "model.bin")).rejects.toThrow();
    expect(cli).not.toHaveBeenCalled();
  });
});
