import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import * as undici from "undici";
import type { LookupAddress } from "node:dns";
import { isPublicAddress, prepareHttpDestination, withHttpResponse } from "../src/safe-http";
import { canonicalHttpUrl, storagePolicy } from "../src/storage-policy";

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return { ...actual, fetch: vi.fn(actual.fetch) };
});

beforeEach(() => {
  storagePolicy.trustedOrigins = [];
  storagePolicy.authOrigins = [];
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"]) vi.stubEnv(key, "");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("public destination policy", () => {
  it.each([
    "0.0.0.0", "10.1.2.3", "127.0.0.1", "172.16.1.1", "192.168.1.1", "169.254.169.254", "100.100.100.200",
    "192.0.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.1.1.1", "255.255.255.255",
    "::", "::1", "fe80::1", "fc00::1", "fd00:ec2::254", "ff02::1", "::ffff:127.0.0.1", "::ffff:a00:1",
    "64:ff9b::a00:1", "2002:7f00:1::", "2001::1", "2001:db8::1", "3fff::1", "4000::1", "not-an-ip",
  ])("rejects non-public address %s", (address) => expect(isPublicAddress(address)).toBe(false));

  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("recognizes public address %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each(["http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/", "http://127.1/", "http://%31%32%37.0.0.1/", "http://[::ffff:127.0.0.1]/"])("rejects alternate IP notation %s", async (url) => {
    await expect(prepareHttpDestination(url)).rejects.toThrow(/not allowed/);
  });

  it.each(["file:///etc/passwd", "ftp://models.example/file"])("rejects unsupported URL %s without DNS", async (url) => {
    const resolver = vi.fn();
    await expect(prepareHttpDestination(url, resolver)).rejects.toThrow();
    expect(resolver).not.toHaveBeenCalled();
  });

  it("removes URL credentials without changing the destination policy", async () => {
    const destination = await prepareHttpDestination("https://user:password@models.example/file", async () => [{ address: "8.8.8.8", family: 4 }]);
    expect(destination.url.toString()).toBe("https://models.example/file");
    await expect(prepareHttpDestination("http://user:password@127.0.0.1/file")).rejects.toThrow(/not allowed/);
  });

  it("allows a public model server on a nonstandard port", async () => {
    const destination = await prepareHttpDestination("https://models.example:8443/model.bin", async () => [{ address: "8.8.8.8", family: 4 }]);
    expect(destination.url.port).toBe("8443");
    expect(destination.addresses).toEqual([{ address: "8.8.8.8", family: 4 }]);
  });

  it.each([
    [{ address: "10.1.1.1", family: 4 }],
    [{ address: "8.8.8.8", family: 4 }, { address: "10.1.1.1", family: 4 }],
    [{ address: "8.8.8.8", family: 4 }, { address: "::1", family: 6 }],
    [],
  ])("rejects empty or mixed private DNS answers %j", async (...addresses) => {
    await expect(prepareHttpDestination("https://models.example/file", async () => addresses as LookupAddress[])).rejects.toThrow();
  });

  it("pins all validated answers and does not resolve again at connection time", async () => {
    const resolver = vi.fn().mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }])
      .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const { lookup } = await prepareHttpDestination("https://models.example/file", resolver);
    const addresses = await new Promise((resolve, reject) => (lookup as Function)("models.example", { all: true }, (error: Error, results: unknown) => error ? reject(error) : resolve(results)));
    expect(addresses).toEqual([{ address: "8.8.8.8", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }]);
    expect(resolver).toHaveBeenCalledTimes(1);
    await expect(new Promise((resolve, reject) => lookup("other.example", {}, (error, result) => error ? reject(error) : resolve(result)))).rejects.toThrow();
  });

  it("canonicalizes origins and requires exact operator exceptions", async () => {
    expect(canonicalHttpUrl("https://EXAMPLE.COM.:443/model").origin).toBe("https://example.com");
    expect(canonicalHttpUrl("https://bücher.example/model").hostname).toBe("xn--bcher-kva.example");
    storagePolicy.trustedOrigins = ["https://models.example:8443"];
    await expect(prepareHttpDestination("https://models.example:8443/file", async () => [{ address: "10.1.1.1", family: 4 }])).resolves.toBeDefined();
    await expect(prepareHttpDestination("http://models.example:8443/file", async () => [{ address: "10.1.1.1", family: 4 }])).rejects.toThrow();
    await expect(prepareHttpDestination("https://sub.models.example:8443/file", async () => [{ address: "10.1.1.1", family: 4 }])).rejects.toThrow();
  });

  it("rejects an HTTPS downgrade without making a second request", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "8.8.8.8", family: 4 }] as any);
    const fetch = vi.spyOn(undici, "fetch").mockResolvedValue(new undici.Response(null, {
      status: 302, headers: { Location: "http://models.example/file" },
    }));
    await expect(withHttpResponse("https://models.example/file", {}, (response) => response.text())).rejects.toThrow(/downgrade/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

async function listen(server: http.Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as net.AddressInfo).port;
}

describe("real connections and HTTP proxies", () => {
  it.each([false, true])("keeps the original Host and pins proxy CONNECT to the validated IP (NO_PROXY: %s)", async (bypass) => {
    const seenHosts: string[] = [];
    const tunnels: string[] = [];
    const sockets = new Set<net.Socket>();
    const target = http.createServer((req, res) => { seenHosts.push(req.headers.host!); res.end("ok"); });
    const targetPort = await listen(target);
    const proxy = http.createServer();
    proxy.on("connect", (req, socket, head) => {
      tunnels.push(req.url!);
      // Only the local test fixture is contacted, regardless of requested IP.
      const upstream = net.connect(targetPort, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        upstream.pipe(socket); socket.pipe(upstream);
      });
      sockets.add(upstream); sockets.add(socket as net.Socket);
    });
    const proxyPort = await listen(proxy);
    const origin = `http://models.example:${targetPort}`;
    storagePolicy.trustedOrigins = [origin];
    vi.stubEnv("http_proxy", `http://127.0.0.1:${proxyPort}`);
    vi.stubEnv("no_proxy", bypass ? "models.example" : "");
    const resolver = vi.spyOn(dns, "lookup").mockResolvedValue([{ address: bypass ? "127.0.0.1" : "8.8.8.8", family: 4 }] as any);
    try {
      const body = await withHttpResponse(origin + "/model", {}, (response) => response.text());
      expect(body).toBe("ok");
      expect(seenHosts).toEqual([`models.example:${targetPort}`]);
      expect(tunnels).toEqual(bypass ? [] : [`8.8.8.8:${targetPort}`]);
      expect(resolver).toHaveBeenCalledTimes(1);
    } finally {
      for (const socket of sockets) socket.destroy();
      for (const server of [proxy, target]) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });

  it("does not contact a proxy for a disallowed destination", async () => {
    let connections = 0;
    const proxy = http.createServer();
    proxy.on("connection", () => connections++);
    const port = await listen(proxy);
    vi.stubEnv("http_proxy", `http://127.0.0.1:${port}`);
    try {
      await expect(withHttpResponse("http://169.254.169.254/", {}, (response) => response.text())).rejects.toThrow();
      expect(connections).toBe(0);
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
});
