import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";

vi.mock("../src/config", () => ({ default: { awsRegion: "us-east-1", hfCLIVersion: "1.11.0" } }));
import { S3StorageProvider } from "../src/storage-providers/s3";
import { AzureBlobStorageProvider } from "../src/storage-providers/azure-blob";
import { SafeS3Handler } from "../src/safe-s3-handler";
import { saveDownload } from "../src/download-path";
import { storagePolicy } from "../src/storage-policy";

const log: any = { info() {}, debug() {}, warn() {}, error() {}, child() { return this; } };
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "comfyui-storage-security-"));
  storagePolicy.trustedOrigins = [];
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe.each(["S3", "Azure"])("%s download filename policy", (kind) => {
  function fixture() {
    if (kind === "S3") {
      const provider = new S3StorageProvider(log);
      const network = vi.spyOn(provider.s3, "send").mockImplementation(async () => ({ Body: Readable.from(["marker"]) }) as any);
      return { provider, network, url: "s3://bucket/folder/model.bin" };
    }
    if (kind === "Azure") {
      const network = vi.fn(async () => ({ readableStreamBody: Readable.from(["marker"]) }));
      const provider = Object.assign(Object.create(AzureBlobStorageProvider.prototype), {
        log, client: { getContainerClient: () => ({ getBlobClient: () => ({ download: network }) }) },
      }) as AzureBlobStorageProvider;
      return { provider, network, url: "https://account.blob.core.windows.net/container/model.bin" };
    }
    throw new Error("Unexpected fixture");
  }

  it.each(["../escaped.bin", "C:\\proof.bin", "a\\b.bin", "/absolute.bin", "..", "", "bad\0name", "a".repeat(256)])("rejects %j before a provider request", async (filename) => {
    const { provider, network, url } = fixture();
    await expect(provider.downloadFile(url, root, filename)).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("writes a complete leaf file without temporary leftovers", async () => {
    const { provider, url } = fixture();
    const output = await provider.downloadFile(url, root, "model.bin");
    expect(output).toBe(path.join(root, "model.bin"));
    expect(await fs.readFile(output, "utf8")).toBe("marker");
    expect(await fs.readdir(root)).toEqual(["model.bin"]);
  });

  it("does not truncate an existing file or symlink target", async () => {
    const { provider, url } = fixture();
    const target = path.join(root, "original.bin");
    await fs.writeFile(target, "original");
    await fs.symlink(target, path.join(root, "link.bin"));
    for (const filename of ["original.bin", "link.bin"]) await expect(provider.downloadFile(url, root, filename)).rejects.toThrow();
    expect(await fs.readFile(target, "utf8")).toBe("original");
  });
});

describe("atomic publication", () => {
  it("handles a source failure while preparing the destination", async () => {
    const source = new Readable({ read() {} });
    const saving = saveDownload(root, "failed.bin", source);
    source.destroy(new Error("network failure"));
    await expect(saving).rejects.toThrow("network failure");
    expect(await fs.readdir(root)).toEqual([]);
  });
  it("cannot replace a destination created while the download is in progress", async () => {
    async function* source() {
      yield "first";
      await fs.writeFile(path.join(root, "race.bin"), "existing");
      yield "second";
    }
    await expect(saveDownload(root, "race.bin", Readable.from(source()))).rejects.toMatchObject({ code: "EEXIST" });
    expect(await fs.readFile(path.join(root, "race.bin"), "utf8")).toBe("existing");
    expect(await fs.readdir(root)).toEqual(["race.bin"]);
  });
});

describe("S3 endpoint destination policy", () => {
  it("rejects a caller-selected private endpoint before connecting, and permits an operator exception", async () => {
    let requests = 0;
    const fixture = http.createServer((_req, res) => { requests++; res.end("marker"); });
    await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const port = (fixture.address() as AddressInfo).port;
    const handler = new SafeS3Handler();
    const request = { method: "GET", protocol: "http:", hostname: "127.0.0.1", port, path: "/object", headers: {} };
    try {
      await expect(handler.handle(request)).rejects.toThrow();
      expect(requests).toBe(0);
      storagePolicy.trustedOrigins = [`http://127.0.0.1:${port}`];
      const { response } = await handler.handle(request);
      const chunks: Buffer[] = [];
      for await (const chunk of response.body) chunks.push(chunk);
      expect(Buffer.concat(chunks).toString()).toBe("marker");
      expect(requests).toBe(1);
    } finally {
      handler.destroy(); fixture.closeAllConnections();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    }
  });
});
