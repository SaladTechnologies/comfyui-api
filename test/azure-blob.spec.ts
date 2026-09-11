import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

const download = vi.hoisted(() => vi.fn());
vi.mock("../src/config", () => ({
  default: { azureStorageConnectionString: "test-connection-string" },
}));
vi.mock("@azure/storage-blob", () => ({
  BlobServiceClient: {
    fromConnectionString: () => ({
      getContainerClient: () => ({ getBlobClient: () => ({ download }) }),
    }),
  },
}));

import { AzureBlobStorageProvider } from "../src/storage-providers/azure-blob";

const log: any = { debug: vi.fn(), child: () => log };
const url = "http://azurite:10000/devstoreaccount1/inputs/photo.png";
let directory: string;
let provider: AzureBlobStorageProvider;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "comfyui-azure-download-"));
  provider = new AzureBlobStorageProvider(log);
  download.mockReset();
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe("Azure Blob downloads", () => {
  it.each([undefined, "cached-input.png"])("resolves after saving the complete input (filename: %s)", async (filename) => {
    download.mockResolvedValue({ readableStreamBody: Readable.from(["first", "second"]) });
    const result = await provider.downloadFile(url, directory, filename);
    expect(result).toBe(path.join(directory, filename ?? "photo.png"));
    expect(await fs.readFile(result, "utf8")).toBe("firstsecond");
  }, 1000);

  it("rejects when the response stream fails", async () => {
    download.mockResolvedValue({
      readableStreamBody: Readable.from((async function* () {
        yield "partial";
        throw new Error("download interrupted");
      })()),
    });
    await expect(provider.downloadFile(url, directory)).rejects.toThrow("download interrupted");
  });

  it("rejects when the destination cannot be written", async () => {
    download.mockResolvedValue({ readableStreamBody: Readable.from(["input"]) });
    await expect(provider.downloadFile(url, path.join(directory, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
