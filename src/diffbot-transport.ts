import { safeResponseJson } from './http.js';

export const DIFFBOT_LLM_HOST = 'https://llm.diffbot.com';
export const DIFFBOT_KG_HOST = 'https://kg.diffbot.com';
export const DIFFBOT_NL_HOST = 'https://nl.diffbot.com';
export const DIFFBOT_API_HOST = 'https://api.diffbot.com';

export type DiffbotHost =
  | typeof DIFFBOT_LLM_HOST
  | typeof DIFFBOT_KG_HOST
  | typeof DIFFBOT_NL_HOST
  | typeof DIFFBOT_API_HOST;

const FIXED_HOSTS = new Set<string>([DIFFBOT_LLM_HOST, DIFFBOT_KG_HOST, DIFFBOT_NL_HOST, DIFFBOT_API_HOST]);

export type DiffbotErrorCode =
  | 'transport_invalid_response'
  | 'contract_invalid_response'
  | 'semantic_invalid_response'
  | 'invalid_entity'
  | 'response_too_large'
  | 'unsupported_option'
  | 'upstream_error';

export class DiffbotError extends Error {
  readonly code: DiffbotErrorCode;
  readonly retryable: boolean;
  readonly status?: number | undefined;

  constructor(code: DiffbotErrorCode, message: string, options?: { retryable?: boolean; status?: number | undefined; cause?: unknown }) {
    super(message, options);
    this.name = 'DiffbotError';
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.status = options?.status;
  }
}

const ERROR_SLICE_MAX = 500;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface DiffbotFetchOptions {
  host: DiffbotHost;
  path: string;
  method?: 'GET' | 'POST';
  token: string;
  bearer?: boolean;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  form?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface DiffbotSpend {
  searchSize: number;
  enhanceSize: number;
  nlpMaxChars: number;
  maxProviders: number;
  fallbackBudget: number;
}

/** Strip token + email/phone selector values from an error string; slice to 500 chars. */
export function redactDiffbotError(message: string, token?: string): string {
  let out = message;
  if (token) out = out.split(token).join('[REDACTED]');
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]');
  out = out.replace(/\+?\d[\d\s().-]{6,}\d/g, '[REDACTED_PHONE]');
  return out.slice(0, ERROR_SLICE_MAX);
}

function fail(code: DiffbotErrorCode, message: string, token: string, extra?: { retryable?: boolean; status?: number | undefined; cause?: unknown }): never {
  throw new DiffbotError(code, redactDiffbotError(message, token), { ...extra });
}

/**
 * Secure native Diffbot HTTP transport: fixed hosts, Bearer or `?token=`
 * auth, manual redirects (3xx rejects, credentials never forwarded),
 * per-request timeout + AbortSignal, bounded body, HTTP-200 error-envelope
 * detection. No retry, no logging, no cache.
 */
export async function diffbotFetch<T = unknown>(options: DiffbotFetchOptions): Promise<T> {
  const { host, path, method = 'GET', token, bearer = false, query, body, form = false, signal, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes } = options;
  if (!FIXED_HOSTS.has(host)) {
    throw new DiffbotError('unsupported_option', `Unsupported Diffbot host: ${String(host)}`);
  }
  if (!token) {
    throw new DiffbotError('contract_invalid_response', 'DIFFBOT_TOKEN is not configured');
  }

  const url = new URL(path, host);
  if (url.origin !== new URL(host).origin) {
    throw new DiffbotError('unsupported_option', `Diffbot path must resolve to ${host}`);
  }
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  if (!bearer) url.searchParams.set('token', token);

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (bearer) headers.Authorization = `Bearer ${token}`;
  let requestBody: string | undefined;
  if (body !== undefined) {
    if (form) {
      requestBody = new URLSearchParams(body as Record<string, string>).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (typeof body === 'string') {
      requestBody = body;
      headers['Content-Type'] = 'text/plain; charset=utf-8';
    } else {
      requestBody = JSON.stringify(body);
      headers['Content-Type'] = 'application/json; charset=utf-8';
    }
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const effectiveSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const redactedUrl = `${host}${path}`;

  let response: Response;
  try {
    response = await fetch(url.href, {
      method,
      headers,
      ...(requestBody === undefined ? {} : { body: requestBody }),
      signal: effectiveSignal,
      redirect: 'manual',
    });
  } catch (error) {
    if (error instanceof DiffbotError) throw error;
    fail('transport_invalid_response', `Diffbot transport failure for ${redactedUrl}: ${error instanceof Error ? error.message : String(error)}`, token, {
      retryable: true,
      cause: error,
    });
  }

  if (response!.status >= 300 && response!.status < 400) {
    fail('transport_invalid_response', `Redirect rejected for ${redactedUrl}: credentials are never forwarded off the fixed host`, token, {
      status: response!.status,
    });
  }

  let parsed: unknown;
  try {
    parsed = maxBytes === undefined
      ? await safeResponseJson(response!, redactedUrl)
      : await safeResponseJson(response!, redactedUrl, maxBytes);
  } catch (error) {
    if (error instanceof DiffbotError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/too large|exceeded size/i.test(message)) {
      fail('response_too_large', `Diffbot response too large for ${redactedUrl}`, token, { status: response!.status });
    }
    fail('transport_invalid_response', `Diffbot transport failure for ${redactedUrl}: ${message}`, token, { status: response!.status });
  }

  if (!response!.ok) {
    const detail = parsed !== undefined ? `: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}` : '';
    const status = response!.status;
    fail('transport_invalid_response', `Diffbot API error (HTTP ${status}) for ${redactedUrl}${detail}`, token, {
      status,
      retryable: status >= 500,
    });
  }

  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const envelope = parsed as { error?: unknown; errorCode?: unknown };
    if (envelope.error !== undefined || envelope.errorCode !== undefined) {
      const detail = typeof envelope.error === 'string' && envelope.error ? `: ${envelope.error}` : '';
      fail('upstream_error', `Diffbot API error${detail} for ${redactedUrl}`, token, {
        status: typeof envelope.errorCode === 'number' ? envelope.errorCode : response!.status,
      });
    }
  }

  return parsed as T;
}

/** Resolve spend/env table; out-of-range throws, never clamps. */
export function resolveDiffbotSpend(env: Record<string, string | undefined> = process.env): DiffbotSpend {
  return {
    searchSize: parseBoundedInt(env.DIFFBOT_SEARCH_SIZE, 'DIFFBOT_SEARCH_SIZE', 10, 1, 50),
    enhanceSize: parseBoundedInt(env.DIFFBOT_ENHANCE_SIZE, 'DIFFBOT_ENHANCE_SIZE', 1, 1, 10),
    nlpMaxChars: parseBoundedInt(env.DIFFBOT_NLP_MAX_CHARS, 'DIFFBOT_NLP_MAX_CHARS', 100000, 1, 100000),
    maxProviders: parseBoundedInt(env.DIFFBOT_MAX_PROVIDERS, 'DIFFBOT_MAX_PROVIDERS', 3, 1, 8),
    fallbackBudget: parseBoundedInt(env.DIFFBOT_FALLBACK_BUDGET, 'DIFFBOT_FALLBACK_BUDGET', 3, 0, 25),
  };
}

function parseBoundedInt(raw: string | undefined, name: string, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new DiffbotError('unsupported_option', `${name} out of range: expected integer ${min}..${max}`);
  }
  return value;
}
