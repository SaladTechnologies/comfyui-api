// Real providers and route; only disposable files, loopback fixtures and dummy credentials.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";

const config = vi.hoisted(() => ({
  apiVersion: "1.19.1", logLevel: "silent", maxBodySize: 1024 * 1024,
  wrapperPort: 3000, comfyDir: "", inputDir: "", cacheDir: "",
  lruCacheSizeBytes: 0, systemWebhookEvents: [], systemWebhook: "",
  httpAuthHeader: {} as Record<string, string>,
  models: { checkpoints: { dir: "", all: [] } },
}));
vi.mock("../src/config", () => ({ default: config }));
vi.mock("../src/proxy-dispatcher", () => ({ getProxyDispatcher: () => undefined }));
vi.mock("../src/storage-providers", async () => {
  const { HTTPStorageProvider } = await import("../src/storage-providers/http");
  return { default: [HTTPStorageProvider] };
});
vi.mock("../src/workflows", () => ({ default: {} }));
vi.mock("../src/comfy", () => ({ getModels: vi.fn() }));

import { storagePolicy } from "../src/storage-policy";
import { hashUrlBase64 } from "../src/utils";
import { HTTPStorageProvider } from "../src/storage-providers/http";
import { DownloadRequestSchema } from "../src/types";
import getStorageManager from "../src/remote-storage-manager";

const marker = "SAFE-REVIEW-MARKER";
const dummySecret = "dummy-not-a-secret";
const log: any = { info() {}, debug() {}, warn() {}, error() {}, child() { return this; } };
let root: string;
let primary: http.Server;
let receiver: http.Server;
let primaryUrl: string;
let receiverUrl: string;
let app: FastifyInstance;
let requests: { url: string; headers: http.IncomingHttpHeaders }[] = [];
let received: http.IncomingHttpHeaders[] = [];

async function listen(server: http.Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "comfyui-safe-security-review-"));
  config.comfyDir = path.join(root, "comfyui");
  config.inputDir = path.join(root, "input");
  config.cacheDir = path.join(root, "cache");
  config.models.checkpoints.dir = path.join(root, "models", "checkpoints");
  for (const dir of [config.cacheDir, config.inputDir, config.models.checkpoints.dir, path.join(root, "escaped")]) {
    await fs.mkdir(dir, { recursive: true });
  }
  receiver = http.createServer((req, res) => {
    received.push(req.headers);
    res.end(marker);
  });
  receiverUrl = await listen(receiver);
  primary = http.createServer((req, res) => {
    requests.push({ url: req.url!, headers: req.headers });
    if (req.url === "/chunked.bin") {
      res.write("12345678");
      res.end("12345678");
    } else if (req.url === "/loop.bin") {
      res.writeHead(302, { Location: "/loop.bin" });
      res.end();
    } else if (req.url === "/same-origin.bin") {
      res.writeHead(302, { Location: "/same-origin-final.bin" });
      res.end();
    } else if (req.url === "/broken.bin") {
      res.writeHead(200, { "Content-Length": "999" });
      res.write("part");
      setImmediate(() => res.destroy());
    } else if (req.url?.startsWith("/redirect")) {
      res.writeHead(302, { Location: receiverUrl + "/receiver.bin" });
      res.end();
    } else {
      res.setHeader("Content-Type", "application/octet-stream");
      res.end(marker);
    }
  });
  primaryUrl = await listen(primary);
  app = (await import("../src/server")).server;
  await app.ready();
});

beforeEach(() => {
  requests = [];
  received = [];
  config.httpAuthHeader = {};
  storagePolicy.trustedOrigins = [primaryUrl, receiverUrl];
  storagePolicy.authOrigins = [];
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"]) vi.stubEnv(key, "");
});

afterAll(async () => {
  if (app) await app.close();
  for (const server of [primary, receiver]) {
    if (!server) continue;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (root) await fs.rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const unsafeNames = ["../proof.bin", "../../proof.bin", "a/b.bin", "a\\b.bin", "/absolute/proof.bin", "C:\\proof.bin", "C:proof.bin", "\\\\host\\share\\proof.bin", ".", "..", "", "   ", "bad\0name.bin", "a".repeat(256), "é".repeat(128), "name.", "NUL.txt", "．．／proof.bin"];

describe("download filesystem boundaries", () => {
  it.each([false, true])("accepts a valid model download through the real route (wait: %s)", async (wait) => {
    const filename = `valid-route-${wait}.bin`;
    const response = await app.inject({ method: "POST", url: "/download", payload: {
      url: primaryUrl + "/" + filename, model_type: "checkpoints", filename, wait,
    } });
    expect(response.statusCode, response.body).toBe(wait ? 200 : 202);
    await vi.waitFor(async () => expect(await fs.readFile(path.join(config.models.checkpoints.dir, filename), "utf8")).toBe(marker));
    expect(requests).toHaveLength(1);
  });
  it.each(unsafeNames)("rejects filename %j before fetching", async (filename) => {
    expect(DownloadRequestSchema.safeParse({ url: primaryUrl + "/schema.bin", model_type: "checkpoints", filename }).success).toBe(false);
    await expect(new HTTPStorageProvider(log).downloadFile(primaryUrl + "/filename.bin", config.cacheDir, filename)).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it.each([false, true])("rejects traversal in the real route (wait: %s)", async (wait) => {
    const target = path.join(root, "escaped", "route.bin");
    await fs.writeFile(target, "original");
    const response = await app.inject({ method: "POST", url: "/download", payload: {
      url: primaryUrl + "/route.bin", model_type: "checkpoints", filename: "../escaped/route.bin", wait,
    } });
    expect(response.statusCode, response.body).toBe(400);
    expect(await fs.readFile(target, "utf8")).toBe("original");
    expect(requests).toHaveLength(0);
    expect(response.body).not.toContain(root);
  });

  it.each([false, true])("does not replace an existing provider destination (symlink: %s)", async (symlink) => {
    const target = path.join(root, "escaped", `existing-${symlink}.bin`);
    const destination = path.join(config.cacheDir, `existing-${symlink}.bin`);
    await fs.writeFile(target, "original");
    if (symlink) await fs.symlink(target, destination);
    else await fs.writeFile(destination, "original");
    await expect(new HTTPStorageProvider(log).downloadFile(primaryUrl + "/existing.bin", config.cacheDir, path.basename(destination))).rejects.toThrow();
    expect(await fs.readFile(target, "utf8")).toBe("original");
    expect(await fs.readFile(destination, "utf8")).toBe("original");
    expect(requests).toHaveLength(0);
  });

  it("accepts leaf names and URL-derived names, with Unicode kept inert", async () => {
    for (const filename of ["model.bin", "mödél∕weights.bin", undefined]) {
      const output = await new HTTPStorageProvider(log).downloadFile(primaryUrl + "/derived.bin", config.cacheDir, filename);
      expect(path.dirname(output)).toBe(config.cacheDir);
      expect(await fs.readFile(output, "utf8")).toBe(marker);
    }
  });

  it("uses generated cache names and validates memory and disk cache hits", async () => {
    const manager = getStorageManager();
    const url = primaryUrl + "/cache-hit.bin";
    const output = await manager.downloadFile(url, config.models.checkpoints.dir, "friendly-name.bin");
    const cached = await fs.realpath(output);
    expect(path.basename(cached)).toBe(hashUrlBase64(url) + ".bin");
    for (const disk of [false, true]) {
      if (disk) (manager as any).cache = {};
      await expect(manager.downloadFile(url, config.models.checkpoints.dir, "../escaped/proof.bin")).rejects.toThrow();
      await manager.downloadFile(url, config.models.checkpoints.dir, `copy-${disk}.bin`);
    }
    expect(requests).toHaveLength(1);
  });

  it("deduplicates active downloads and rejects traversal while one is active", async () => {
    const manager = getStorageManager();
    const url = primaryUrl + "/concurrent.bin";
    const first = manager.downloadFile(url, config.models.checkpoints.dir, "concurrent-1.bin");
    await expect(manager.downloadFile(url, config.models.checkpoints.dir, "../escaped/concurrent.bin")).rejects.toThrow();
    const second = manager.downloadFile(url, config.models.checkpoints.dir, "concurrent-2.bin");
    const outputs = await Promise.all([first, second]);
    expect(await fs.realpath(outputs[0])).toBe(await fs.realpath(outputs[1]));
    expect(requests).toHaveLength(1);
  });

  it("rejects a symlink in the disk cache", async () => {
    const url = primaryUrl + "/poisoned-cache.bin";
    const target = path.join(root, "escaped", "poisoned.bin");
    await fs.writeFile(target, "original");
    await fs.symlink(target, path.join(config.cacheDir, hashUrlBase64(url) + ".bin"));
    await expect(getStorageManager().downloadFile(url, config.models.checkpoints.dir, "poisoned.bin")).rejects.toThrow();
    expect(requests).toHaveLength(0);
    expect(await fs.readFile(target, "utf8")).toBe("original");
  });

  it("rejects a final model symlink outside the cache before fetching", async () => {
    const target = path.join(root, "escaped", "model-target.bin");
    await fs.writeFile(target, "original");
    await fs.symlink(target, path.join(config.models.checkpoints.dir, "model-target.bin"));
    await expect(getStorageManager().downloadFile(primaryUrl + "/model-target.bin", config.models.checkpoints.dir, "model-target.bin")).rejects.toThrow();
    expect(requests).toHaveLength(0);
    expect(await fs.readFile(target, "utf8")).toBe("original");
  });

  it("supports a configured directory symlink without accepting a filename path", async () => {
    const alias = path.join(root, "cache-alias");
    await fs.symlink(config.cacheDir, alias);
    const output = await new HTTPStorageProvider(log).downloadFile(primaryUrl + "/alias.bin", alias, "alias.bin");
    expect(output).toBe(path.join(config.cacheDir, "alias.bin"));
    expect(await fs.readFile(output, "utf8")).toBe(marker);
  });

  it("stages regular inputs when INPUT_DIR is a configured directory symlink", async () => {
    const originalInput = config.inputDir;
    const alias = path.join(root, "input-alias");
    await fs.symlink(originalInput, alias);
    config.inputDir = alias;
    try {
      const output = await getStorageManager().downloadFile(primaryUrl + "/aliased-input.bin", alias, "aliased-input.bin");
      expect(path.dirname(output)).toBe(originalInput);
      expect((await fs.lstat(output)).isSymbolicLink()).toBe(false);
      expect(await fs.readFile(output, "utf8")).toBe(marker);
    } finally { config.inputDir = originalInput; }
  });

  it("does not evict auth metadata, temporary downloads, or symlink targets as cache files", async () => {
    const temporary = path.join(config.cacheDir, ".download-pending.partial");
    await fs.writeFile(temporary, "partial");
    const info = await getStorageManager().getCacheSizeInfo();
    expect(info.files.every((file) => !file.path.endsWith(".meta") && !path.basename(file.path).startsWith("."))).toBe(true);
    expect(info.files.some((file) => file.path.includes("existing-true"))).toBe(false);
    expect(await fs.readFile(temporary, "utf8")).toBe("partial");
  });
});

describe("HTTP destination and credential boundaries", () => {
  it("preserves URL basic auth and strips it on cross-origin redirects", async () => {
    const url = new URL(primaryUrl + "/redirect-basic.bin");
    url.username = "caller";
    url.password = "dummy:password";
    config.httpAuthHeader = { "X-Review-Token": dummySecret };
    storagePolicy.authOrigins = [primaryUrl];
    await new HTTPStorageProvider(log).downloadFile(url.toString(), config.cacheDir, "basic-url.bin");
    expect(requests[0].headers.authorization).toBe(`Basic ${Buffer.from("caller:dummy:password").toString("base64")}`);
    expect(requests[0].headers["x-review-token"]).toBeUndefined();
    expect(received[0].authorization).toBeUndefined();
    expect(received[0]["x-review-token"]).toBeUndefined();
  });

  it("prefers per-request auth to URL basic auth", async () => {
    const url = new URL(primaryUrl + "/basic-override.bin");
    url.username = "caller";
    url.password = "dummy";
    await new HTTPStorageProvider(log).downloadFile(url.toString(), config.cacheDir, "basic-override.bin", {
      auth: { type: "bearer", token: "request-token" },
    });
    expect(requests[0].headers.authorization).toBe("Bearer request-token");
  });

  it.each([false, true])("rejects private destinations in the real route before accepting work (wait: %s)", async (wait) => {
    storagePolicy.trustedOrigins = [];
    const response = await app.inject({ method: "POST", url: "/download", payload: {
      url: primaryUrl + "/internal.bin", model_type: "checkpoints", filename: "internal.bin", wait,
    } });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(root);
    expect(requests).toHaveLength(0);
  });

  it.each(["X-Review-Token", "Authorization"])("does not send unbound global %s", async (name) => {
    config.httpAuthHeader = { [name]: dummySecret };
    await new HTTPStorageProvider(log).downloadFile(primaryUrl + "/unbound.bin", config.cacheDir, `unbound-${name}.bin`);
    expect(requests[0].headers[name.toLowerCase()]).toBeUndefined();
  });

  it.each(["X-Review-Token", "Authorization"])("sends bound %s only to its origin, including redirects", async (name) => {
    config.httpAuthHeader = { [name]: dummySecret };
    storagePolicy.authOrigins = [primaryUrl];
    await new HTTPStorageProvider(log).downloadFile(primaryUrl + "/redirect-bound.bin", config.cacheDir, `bound-${name}.bin`);
    expect(requests[0].headers[name.toLowerCase()]).toBe(dummySecret);
    expect(received[0][name.toLowerCase()]).toBeUndefined();
  });

  it("retains authentication for a same-origin redirect", async () => {
    config.httpAuthHeader = { "X-Review-Token": dummySecret };
    storagePolicy.authOrigins = [primaryUrl];
    await new HTTPStorageProvider(log).downloadFile(primaryUrl + "/same-origin.bin", config.cacheDir, "same-origin.bin");
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.headers["x-review-token"] === dummySecret)).toBe(true);
  });

  it("strips a caller's custom credential on a cross-origin redirect", async () => {
    config.httpAuthHeader = { "X-Global": dummySecret };
    storagePolicy.authOrigins = [primaryUrl];
    await new HTTPStorageProvider(log).downloadFile(primaryUrl + "/redirect-request.bin", config.cacheDir, "request-auth.bin", {
      auth: { type: "header", header_name: "X-Request-Token", header_value: "dummy-caller" },
    });
    expect(requests[0].headers["x-global"]).toBeUndefined();
    expect(requests[0].headers["x-request-token"]).toBe("dummy-caller");
    expect(received[0]["x-request-token"]).toBeUndefined();
  });

  it("rejects a redirect into a private origin and sends it no credentials", async () => {
    storagePolicy.trustedOrigins = [primaryUrl];
    storagePolicy.authOrigins = [primaryUrl];
    config.httpAuthHeader = { "X-Review-Token": dummySecret };
    await expect(new HTTPStorageProvider(log).downloadFile(primaryUrl + "/redirect-denied.bin", config.cacheDir, "denied-redirect.bin")).rejects.toThrow();
    expect(requests).toHaveLength(1);
    expect(received).toHaveLength(0);
  });

  it("does not attach bound credentials when redirecting from an unbound origin", async () => {
    storagePolicy.authOrigins = [receiverUrl];
    config.httpAuthHeader = { "X-Review-Token": dummySecret };
    await new HTTPStorageProvider(log).downloadFile(primaryUrl + "/redirect-unbound.bin", config.cacheDir, "redirect-unbound.bin");
    expect(requests[0].headers["x-review-token"]).toBeUndefined();
    expect(received[0]["x-review-token"]).toBeUndefined();
  });

  it("limits redirects", async () => {
    await expect(new HTTPStorageProvider(log).downloadFile(primaryUrl + "/loop.bin", config.cacheDir, "loop.bin")).rejects.toThrow(/redirect/);
    expect(requests).toHaveLength(storagePolicy.maxRedirects + 1);
  });

  it("applies destination policy and credential scoping to uploads", async () => {
    storagePolicy.trustedOrigins = [];
    const upload = new HTTPStorageProvider(log).uploadFile(primaryUrl + "/upload.bin", Buffer.from(marker), "application/octet-stream");
    await expect(upload.upload()).rejects.toThrow();
    expect(requests).toHaveLength(0);
    storagePolicy.trustedOrigins = [primaryUrl];
    config.httpAuthHeader = { "X-Review-Token": dummySecret };
    await new HTTPStorageProvider(log).uploadFile(primaryUrl + "/upload.bin", Buffer.from(marker), "application/octet-stream").upload();
    expect(requests[0].headers["x-review-token"]).toBeUndefined();
  });

  it("applies destination policy to cached-credential validation", async () => {
    storagePolicy.trustedOrigins = [];
    await expect(new HTTPStorageProvider(log).validateAuth(primaryUrl + "/cached.bin", { auth: { type: "bearer", token: "dummy" } })).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
});

describe("complete download publication", () => {
  it("streams a response without Content-Length", async () => {
    const destination = path.join(root, "chunked");
    const output = await new HTTPStorageProvider(log).downloadFile(`${primaryUrl}/chunked.bin`, destination, "model.bin");
    expect(await fs.readFile(output, "utf8")).toBe("1234567812345678");
    expect(await fs.readdir(destination)).toEqual(["model.bin"]);
  });

  it("removes partial files after a broken connection", async () => {
    const destination = path.join(root, "broken");
    await fs.mkdir(destination);
    await expect(new HTTPStorageProvider(log).downloadFile(`${primaryUrl}/broken.bin`, destination, "model.bin")).rejects.toThrow();
    expect(await fs.readdir(destination)).toEqual([]);
  });
});
