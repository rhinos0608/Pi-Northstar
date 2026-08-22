const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;

/**
 * Validate a URL is HTTP or HTTPS.
 *
 * Does NOT block private/reserved IP ranges. SSRF protection is provided by
 * external network containerization; do not rely on this function alone if
 * running outside a container.
 */
export function validateHttpUrl(raw: string): string {
  const url = new URL(raw.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Disallowed URL scheme: ${url.protocol}`);
  return url.href;
}

/**
 * @deprecated Use {@link validateHttpUrl} instead. Kept as alias for backward compatibility.
 */
export const validatePublicHttpUrl = validateHttpUrl;

export async function fetchJson(url: string, headersOrSignal: Record<string, string> | AbortSignal = {}, signal?: AbortSignal, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS): Promise<unknown> {
  const { headers, effectiveSignal } = requestOptions(headersOrSignal, signal);
  const response = await fetch(validatePublicHttpUrl(url), fetchInit(headers, effectiveSignal, timeoutMs));
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return safeResponseJson(response, url);
}

export async function fetchText(url: string, headersOrSignal: Record<string, string> | AbortSignal = {}, signal?: AbortSignal, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS): Promise<string> {
  const { headers, effectiveSignal } = requestOptions(headersOrSignal, signal);
  const response = await fetch(validatePublicHttpUrl(url), fetchInit(headers, effectiveSignal, timeoutMs));
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return safeResponseText(response, url);
}

/**
 * JSON fetch that rejects redirects instead of following them. Cookie-bearing
 * requests must use this so credentials are never forwarded off the initial
 * host (credential-routing control, not SSRF-policy restoration).
 */
export async function fetchJsonNoRedirect(url: string, headersOrSignal: Record<string, string> | AbortSignal = {}, signal?: AbortSignal, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS): Promise<unknown> {
  const { headers, effectiveSignal } = requestOptions(headersOrSignal, signal);
  const response = await fetch(validatePublicHttpUrl(url), fetchInit(headers, effectiveSignal, timeoutMs, 'manual'));
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`Redirect rejected for ${url}: credentials are never forwarded off the fixed host`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return safeResponseJson(response, url);
}

export async function unsafeFetchJson(url: string, headersOrSignal: Record<string, string> | AbortSignal = {}, signal?: AbortSignal, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS): Promise<unknown> {
  const { headers, effectiveSignal } = requestOptions(headersOrSignal, signal);
  const response = await fetch(url, fetchInit(headers, effectiveSignal, timeoutMs));
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return safeResponseJson(response, url);
}

export function fetchInit(headers: Record<string, string>, signal: AbortSignal | undefined, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, redirect?: RequestRedirect): RequestInit {
  return {
    headers,
    signal: composeSignal(signal, timeoutMs),
    ...(redirect ? { redirect } : {}),
  };
}

export async function safeResponseJson(response: Response, url: string, maxBytes = DEFAULT_MAX_RESPONSE_BYTES): Promise<unknown> {
  return JSON.parse(await safeResponseText(response, url, maxBytes));
}

export function requestOptions(headersOrSignal: Record<string, string> | AbortSignal, signal?: AbortSignal): { headers: Record<string, string>; effectiveSignal?: AbortSignal } {
  if (headersOrSignal instanceof AbortSignal) return { headers: {}, effectiveSignal: headersOrSignal };
  return signal ? { headers: headersOrSignal, effectiveSignal: signal } : { headers: headersOrSignal };
}

export async function safeResponseText(response: Response, url: string, maxBytes = DEFAULT_MAX_RESPONSE_BYTES): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    const length = Number.parseInt(contentLength, 10);
    if (Number.isFinite(length) && length > maxBytes) throw new Error(`Response from ${url} is too large (${length} bytes, max ${maxBytes})`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error(`Response from ${url} exceeded size limit`);
    return text;
  }

  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Response from ${url} exceeded size limit`);
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function composeSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}


