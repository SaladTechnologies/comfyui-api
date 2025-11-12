import { EnvHttpProxyAgent, type Dispatcher } from "undici";

// Create a singleton proxy-aware dispatcher that:
// - Reads HTTP_PROXY/HTTPS_PROXY/NO_PROXY from environment
// - Honors NO_PROXY for localhost/cluster/internal hosts
// - Uses unlimited timeouts to match existing Agent usage
let cachedDispatcher: Dispatcher | null = null;

export function getProxyDispatcher(): Dispatcher {
  if (!cachedDispatcher) {
    cachedDispatcher = new EnvHttpProxyAgent({
      headersTimeout: 0,
      bodyTimeout: 0,
      connectTimeout: 0,
    });
  }
  return cachedDispatcher;
}

