// Bounded provider HTTP helper for compat adapters. No retries, no cookies,
// no proxy, no config-file credentials. Redirects reject (manual) so vendor
// endpoints cannot bounce the request elsewhere; SSRF allow-ranges and
// caller-controlled proxies are deliberately absent (Phase 1 decision).

import {
  redactWebAccessSecrets,
  WebAccessProviderError,
  classifyWebAccessError,
} from './web-access-provider-errors.js';
import type {
  WebAccessProviderFailure,
  WebAccessProviderId,
} from './web-access-contract.js';

/** Cap on error-body text carried into failure messages. */
export const WEB_ACCESS_HTTP_ERROR_TEXT_MAX = 300;
/** Cap on JSON payload bytes accepted from a provider. */
export const WEB_ACCESS_HTTP_JSON_MAX_BYTES = 1_000_000;

export interface WebAccessHttpOptions {
  provider: WebAccessProviderId;
  label: string;
  apiKey: string | undefined;
  signal: AbortSignal | undefined;
}

function secretOf(apiKey: string | undefined): string[] {
  return apiKey !== undefined ? [apiKey] : [];
}

function abortError(provider: WebAccessProviderId, label: string): WebAccessProviderError {
  const failure: WebAccessProviderFailure = {
    provider,
    kind: 'aborted',
    message: `${label} request aborted`,
    retryable: false,
  };
  return new WebAccessProviderError(failure);
}

function fail(
  provider: WebAccessProviderId,
  error: unknown,
  apiKey: string | undefined,
): WebAccessProviderError {
  if (error instanceof WebAccessProviderError) return error;
  const classified = classifyWebAccessError(provider, error);
  const raw = error instanceof Error ? error.message : String(error);
  const failure: WebAccessProviderFailure = {
    provider,
    kind: classified.kind,
    message: redactWebAccessSecrets(raw, secretOf(apiKey)).slice(0, 500),
    retryable: classified.retryable,
  };
  if (classified.status !== undefined) failure.status = classified.status;
  return new WebAccessProviderError(failure);
}

/** Throw when the caller signal is already aborted. */
export function throwIfAborted(options: WebAccessHttpOptions): void {
  if (options.signal?.aborted) throw abortError(options.provider, options.label);
}

/** Reject redirect responses; compat adapters never follow them. */
export function assertNotRedirect(response: Response, options: WebAccessHttpOptions): void {
  if (response.status >= 300 && response.status < 400) {
    throw fail(
      options.provider,
      new Error(`${options.label} HTTP ${response.status}: redirect rejected`),
      options.apiKey,
    );
  }
}

/** Read an error body with byte cap and secret redaction. */
export async function readErrorText(response: Response, options: WebAccessHttpOptions): Promise<string> {
  const raw = await response.text().catch(() => '');
  return redactWebAccessSecrets(raw, secretOf(options.apiKey)).slice(0, WEB_ACCESS_HTTP_ERROR_TEXT_MAX);
}

/** Parse a bounded JSON payload; invalid JSON becomes invalid_response. */
export async function readJsonPayload(response: Response, options: WebAccessHttpOptions): Promise<unknown> {
  const raw = await response.text().catch(() => '');
  if (Buffer.byteLength(raw, 'utf8') > WEB_ACCESS_HTTP_JSON_MAX_BYTES) {
    throw fail(
      options.provider,
      new Error(`${options.label} returned invalid response: payload exceeds size bound`),
      options.apiKey,
    );
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw fail(
      options.provider,
      new Error(
        `${options.label} returned invalid JSON: ${redactWebAccessSecrets(raw.slice(0, 200), secretOf(options.apiKey))}`,
      ),
      options.apiKey,
    );
  }
}

/**
 * Single-attempt fetch. Exactly one network call; never retries (no automatic
 * paid retry in Phase 1). Network/transport failures classify via the shared
 * taxonomy with secrets redacted.
 */
export async function fetchOnce(url: string, init: RequestInit, options: WebAccessHttpOptions): Promise<Response> {
  throwIfAborted(options);
  try {
    return await fetch(url, { ...init, redirect: 'manual' });
  } catch (error) {
    if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw abortError(options.provider, options.label);
    }
    throw fail(options.provider, error, options.apiKey);
  }
}

/** Wrap an unexpected adapter error into the contract failure shape. */
export function wrapAdapterError(
  provider: WebAccessProviderId,
  label: string,
  error: unknown,
  apiKey: string | undefined,
): WebAccessProviderError {
  // `label` stays in the public signature for adapter call-site stability;
  // failure detail comes from the classified error, never the label.
  void label;
  return fail(provider, error, apiKey);
}
