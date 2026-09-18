import dns from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { EnvHttpProxyAgent, Pool, fetch } from "undici";
import type { Dispatcher, RequestInit, Response } from "undici";
import { canonicalHttpUrl, storagePolicy } from "./storage-policy";

export function isPublicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.process(address);
    if (parsed.range() !== "unicast") return false;
    // Fail closed for unallocated IPv6 space and transition mechanisms.
    if (parsed.kind() === "ipv4") return true;
    const v6 = parsed as ipaddr.IPv6;
    // IANA's 3fff::/20 documentation range postdates ipaddr.js's range table.
    // https://www.iana.org/assignments/iana-ipv6-special-registry/
    return v6.match(ipaddr.IPv6.parse("2000::"), 3) && !v6.match(ipaddr.IPv6.parse("3fff::"), 20);
  } catch {
    return false;
  }
}

export type AddressResolver = (hostname: string) => Promise<LookupAddress[]>;
const resolveAddresses: AddressResolver = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

/** Validate all DNS answers, then reuse exactly those answers for the connection. */
export async function prepareHttpDestination(input: string, resolver: AddressResolver = resolveAddresses) {
  const url = canonicalHttpUrl(input);
  const trusted = storagePolicy.trustedOrigins.includes(url.origin);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let timer: NodeJS.Timeout | undefined;
  let addresses: LookupAddress[];
  try {
    addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await Promise.race([
      resolver(hostname),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("HTTP destination lookup timed out")), storagePolicy.dnsTimeoutMs);
      }),
    ]);
  } catch {
    throw new Error("Unable to resolve an allowed HTTP destination");
  } finally {
    clearTimeout(timer);
  }
  if (!addresses.length || addresses.some((address) =>
    !isIP(address.address) || (!trusted && !isPublicAddress(address.address)))) {
    throw new Error("HTTP destination is not allowed");
  }

  const lookup: LookupFunction = (requestedHostname, options, callback) => {
    if (requestedHostname.replace(/\.+$/, "") !== hostname) {
      callback(new Error("Unexpected HTTP destination"), "", 0);
      return;
    }
    const family = typeof options === "number" ? options : options.family;
    const candidates = addresses.filter((address) => !family || address.family === family);
    if (!candidates.length) {
      callback(new Error("No allowed address for the requested family"), "", 0);
    } else if (typeof options === "object" && options.all) {
      (callback as Function)(null, candidates);
    } else {
      callback(null, candidates[0].address, candidates[0].family);
    }
  };
  return { url, addresses, lookup };
}

export function createStorageDispatcher(destination: Awaited<ReturnType<typeof prepareHttpDestination>>) {
  // EnvHttpProxyAgent honors NO_PROXY; for proxy traffic, CONNECT must also use
  // a validated IP. Allowing the proxy to resolve the hostname would reintroduce rebinding.
  for (const name of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"]) {
    const proxy = process.env[name];
    if (proxy && !["http:", "https:"].includes(new URL(proxy).protocol)) {
      throw new Error("Storage requests require an HTTP(S) CONNECT proxy");
    }
  }
  return new EnvHttpProxyAgent({
    connect: { lookup: destination.lookup, timeout: 0 },
    headersTimeout: 0,
    bodyTimeout: 0,
    proxyTunnel: true,
    clientFactory(origin, options) {
      const pool = new Pool(origin, options);
      const connect = pool.connect.bind(pool);
      const ip = destination.addresses[0];
      const authority = `${ip.family === 6 ? `[${ip.address}]` : ip.address}:${destination.url.port || (destination.url.protocol === "https:" ? "443" : "80")}`;
      // ProxyAgent uses the promise overload and preserves the original hostname
      // for the HTTP Host header, TLS SNI and certificate verification.
      pool.connect = ((params: Dispatcher.ConnectOptions, callback?: Function) => {
        const pinned = { ...params, path: authority, headers: { ...params.headers, host: authority } };
        return callback ? connect(pinned, callback as any) : connect(pinned);
      }) as typeof pool.connect;
      return pool;
    },
  });
}

type StorageRequest = Omit<RequestInit, "dispatcher" | "redirect" | "headers"> & {
  headers?: Record<string, string>;
  credentialHeaders?: Record<string, string>;
  credentialQueryParameter?: string;
};

/** The callback consumes the response before its dispatcher is released. */
export async function withHttpResponse<T>(
  input: string,
  options: StorageRequest,
  consume: (response: Response) => Promise<T>
): Promise<T> {
  let current = canonicalHttpUrl(input);
  let credentials = options.credentialHeaders || {};
  const { credentialHeaders, credentialQueryParameter, ...requestOptions } = options;
  for (let redirects = 0; ; redirects++) {
    options.signal?.throwIfAborted();
    const destination = await prepareHttpDestination(current.toString());
    const dispatcher = createStorageDispatcher(destination);
    let response: Response | undefined;
    try {
      response = await fetch(destination.url, {
        ...requestOptions,
        headers: { ...options.headers, ...credentials },
        redirect: "manual",
        dispatcher,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirects >= storagePolicy.maxRedirects || !["GET", "HEAD"].includes(options.method || "GET")) {
          throw new Error("HTTP redirect is not allowed");
        }
        const location = response.headers.get("location");
        if (!location) throw new Error("Invalid HTTP redirect");
        const next = canonicalHttpUrl(new URL(location, current).toString());
        if (current.protocol === "https:" && next.protocol !== "https:") throw new Error("HTTPS downgrade is not allowed");
        if (next.origin !== current.origin) {
          credentials = {};
          if (credentialQueryParameter) next.searchParams.delete(credentialQueryParameter);
        }
        current = next;
        continue;
      }
      return await consume(response);
    } finally {
      await response?.body?.cancel().catch(() => {});
      await dispatcher.destroy();
    }
  }
}
