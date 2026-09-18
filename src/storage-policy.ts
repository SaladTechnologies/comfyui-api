export function canonicalHttpUrl(input: string): URL {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP(S) URLs are allowed");
  }
  // URL basic auth is converted to a scoped header by the HTTP provider.
  // Never pass userinfo to fetch or let it affect origin/DNS checks.
  url.username = "";
  url.password = "";
  url.hostname = url.hostname.replace(/\.+$/, "");
  return url;
}

function origins(name: string): string[] {
  return (process.env[name] || "").split(",").filter((value) => value.trim()).map((value) => {
    const supplied = new URL(value.trim());
    if (supplied.username || supplied.password || supplied.hostname.includes("*")) {
      throw new Error(`${name} must contain exact origins without credentials or wildcards`);
    }
    const url = canonicalHttpUrl(value.trim());
    if (url.pathname !== "/" || url.search || url.hash) throw new Error(`${name} must contain origins, not paths`);
    return url.origin;
  });
}

export const storagePolicy = {
  // Exceptions are set by the operator, never by the caller. Exact scheme/host/port only.
  trustedOrigins: origins("HTTP_TRUSTED_ORIGINS"),
  authOrigins: origins("HTTP_AUTH_ALLOWED_ORIGINS"),
  dnsTimeoutMs: 10_000,
  maxRedirects: 20, // Preserve fetch's existing redirect limit.
};
