// Operator-owned SPARQL HTTP transport v1: env endpoint only (never model
// input), POST with urlencoded `query` body, optional bearer token via
// Authorization header only, manual redirects (3xx rejects), per-request
// timeout + AbortSignal, bounded body, secret redaction in errors. No SPARQL
// query parsing here: form gating (SELECT/ASK only) belongs to the adapter.
// Loopback endpoints allowed: endpoint is operator config, not public input.

import { safeResponseText } from '../core/http.js';

export type SparqlTransportErrorCode =
  | 'transport_invalid_response'
  | 'contract_invalid_response'
  | 'response_too_large'
  | 'unsupported_option'
  | 'upstream_error';

export class SparqlTransportError extends Error {
  readonly code: SparqlTransportErrorCode;
  readonly retryable: boolean;
  readonly status?: number | undefined;

  constructor(
    code: SparqlTransportErrorCode,
    message: string,
    options?: { retryable?: boolean; status?: number | undefined; cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SparqlTransportError';
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.status = options?.status;
  }
}

const ERROR_SLICE_MAX = 500;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 1_000_000;

export type SparqlFetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface SparqlTransportOptions {
  /** Operator-configured endpoint URL (env only). http/https, no credentials. */
  endpoint: string;
  /** Opaque SPARQL string; never parsed here. */
  query: string;
  /** Optional bearer token; sent via Authorization header only. */
  token?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  /** Injected fetch for deterministic tests; defaults to global fetch. */
  fetchFn?: SparqlFetchFn;
}

/** Strip token from an error string; strip URL query strings as defense-in-depth; slice to 500 chars. */
export function redactSparqlError(message: string, token?: string): string {
  let out = token ? message.split(token).join('[REDACTED]') : message;
  out = out.replace(/(https?:\/\/[^\s"'?#]+)\?[^\s"']*/g, '$1');
  return out.slice(0, ERROR_SLICE_MAX);
}

/** Error label identifying only origin+path; never search/hash/credentials. */
export function safeEndpointLabel(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

/** Sanitize a raw endpoint string for error echo: origin+path when parseable, else cut at ?/#. */
export function safeRawEndpointLabel(raw: string): string {
  try {
    return safeEndpointLabel(new URL(raw.trim()));
  } catch {
    return raw.split(/[?#]/)[0]!;
  }
}

function fail(
  code: SparqlTransportErrorCode,
  message: string,
  token: string | undefined,
  extra?: { retryable?: boolean; status?: number | undefined; cause?: unknown },
): never {
  throw new SparqlTransportError(code, redactSparqlError(message, token), { ...extra });
}

/**
 * Bounded operator-owned SPARQL POST transport. No retry, no logging, no cache.
 */
export async function sparqlPost<T = unknown>(options: SparqlTransportOptions): Promise<T> {
  const {
    endpoint,
    query,
    token,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    fetchFn = globalThis.fetch as SparqlFetchFn,
  } = options;

  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    fail('unsupported_option', `Invalid SPARQL endpoint URL: ${safeRawEndpointLabel(endpoint)}`, token);
  }
  if (url!.protocol !== 'http:' && url!.protocol !== 'https:') {
    fail('unsupported_option', `Disallowed SPARQL endpoint scheme: ${url!.protocol}`, token);
  }
  if (url!.username || url!.password) {
    fail('unsupported_option', 'SPARQL endpoint URL must not contain credentials', token);
  }
  if (typeof query !== 'string' || query.trim().length === 0) {
    fail('contract_invalid_response', 'SPARQL query must be non-empty text', token);
  }

  const target = `${url!.origin}${url!.pathname}${url!.search}`;
  const label = safeEndpointLabel(url!);
  const headers: Record<string, string> = {
    Accept: 'application/sparql-results+json',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const requestBody = `query=${encodeURIComponent(query)}`;

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const effectiveSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let response: Response;
  try {
    response = await fetchFn(target, {
      method: 'POST',
      headers,
      body: requestBody,
      signal: effectiveSignal,
      redirect: 'manual',
    });
  } catch (error) {
    if (error instanceof SparqlTransportError) throw error;
    fail('transport_invalid_response', `SPARQL transport failure for ${label}: ${error instanceof Error ? error.message : String(error)}`, token, {
      retryable: true,
      cause: error,
    });
  }

  if (response!.status >= 300 && response!.status < 400) {
    fail('transport_invalid_response', `Redirect rejected for ${label}: credentials are never forwarded off the endpoint`, token, {
      status: response!.status,
    });
  }

  let raw: string;
  try {
    raw = await safeResponseText(response!, label, maxBytes);
  } catch (error) {
    if (error instanceof SparqlTransportError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/too large|exceeded size/i.test(message)) {
      fail('response_too_large', `SPARQL response too large for ${label}`, token, { status: response!.status });
    }
    fail('transport_invalid_response', `SPARQL transport failure for ${label}: ${message}`, token, { status: response!.status });
  }

  if (!response!.ok) {
    let detail = '';
    if (raw!.length > 0) {
      try {
        const parsedError: unknown = JSON.parse(raw!);
        detail = `: ${typeof parsedError === 'string' ? parsedError : JSON.stringify(parsedError)}`;
      } catch {
        detail = `: ${raw}`;
      }
    }
    const status = response!.status;
    fail('transport_invalid_response', `SPARQL API error (HTTP ${status}) for ${label}${detail}`, token, {
      status,
      retryable: status >= 500,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw!);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail('transport_invalid_response', `SPARQL transport failure for ${label}: ${message}`, token, { status: response!.status });
  }

  return parsed as T;
}
