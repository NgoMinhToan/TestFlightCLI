import { UsageError } from "./errors.js";

/**
 * Normalizes a server base URL. It may carry a deployment path prefix (for
 * example `https://example.com/testflight`) but must be a plain http(s)
 * origin plus path: no credentials, query or fragment.
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new UsageError("The server base URL is empty.");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new UsageError(
      `Invalid server base URL "${raw}".`,
      "Expected an http(s) URL such as http://127.0.0.1:8080.",
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError(
      `Invalid server base URL "${raw}": only http and https are supported.`,
    );
  }
  if (url.username || url.password) {
    throw new UsageError("The server base URL must not contain credentials.");
  }
  if (url.search || url.hash) {
    throw new UsageError("The server base URL must not contain a query string or fragment.");
  }

  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname}`;
}

/** Joins a normalized base URL (which may have a path prefix) with an API path. */
export function joinUrl(baseUrl: string, apiPath: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(apiPath.replace(/^\/+/, ""), base).toString();
}
