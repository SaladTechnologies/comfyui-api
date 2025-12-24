import { WorkflowCredential, DownloadAuth, DownloadOptions } from "./types";

/**
 * Resolves credentials for a given URL by matching against patterns.
 * Returns the first matching credential's auth configuration.
 */
export function resolveCredentials(
  url: string,
  credentials?: WorkflowCredential[]
): DownloadOptions | undefined {
  if (!credentials || credentials.length === 0) {
    return undefined;
  }

  for (const cred of credentials) {
    if (matchesPattern(url, cred.url_pattern)) {
      return { auth: cred.auth };
    }
  }

  return undefined;
}

/**
 * Match a URL against a pattern that supports glob-style wildcards.
 * Supports:
 * - * matches any characters except /
 * - ** matches any characters including /
 * - ? matches a single character
 *
 * Examples:
 * - "https://example.com/*" matches "https://example.com/file.txt"
 * - "https://example.com/**" matches "https://example.com/path/to/file.txt"
 * - "https://*.s3.amazonaws.com/**" matches "https://mybucket.s3.amazonaws.com/models/flux.safetensors"
 */
export function matchesPattern(url: string, pattern: string): boolean {
  // Escape special regex characters except our wildcards
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    // Replace ** first (before *) to avoid double replacement
    .replace(/\*\*/g, "<<<DOUBLE_STAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<<DOUBLE_STAR>>>/g, ".*")
    .replace(/\?/g, ".");

  const regex = new RegExp(`^${escaped}$`);
  return regex.test(url);
}

/**
 * Type for functions that can receive credentials for model downloads.
 */
export type CredentialProvider = (url: string) => DownloadOptions | undefined;

/**
 * Create a credential provider function from a list of credentials.
 * This allows passing credentials to functions without exposing the full list.
 */
export function createCredentialProvider(
  credentials?: WorkflowCredential[]
): CredentialProvider {
  return (url: string) => resolveCredentials(url, credentials);
}
