// Web-access provider error taxonomy (Phase 1 compat).
//
// Source-verified against upstream pi-web-access pinned commit
// 192ac1875e3b8f88c78953dbc314949ec9fcaa27:
// - gemini-search.ts classifyProviderError: message/status rules for
//   credential, abort, xai-403-quota, 401/403 auth, openai 400/422
//   unsupported-tool, 400/422 invalid-request, 402/429 quota,
//   Tavily 432 quota, 408/425/5xx transient, rate-limit/quota phrasing,
//   invalid-response phrasing, network phrasing.
// - gemini-search.ts providerErrorStatus: first /\\b(?:error|status|http)\\s+(\\d{3})\\b/i.
// - Upstream SearchProviderErrorKind: transient, quota, network, credential,
//   config, auth, invalid-request, invalid-response, unsupported, aborted,
//   unknown (gemini-search.ts).
//
// Contract mapping (src/web-access-contract.ts, 11-kind union):
// transient/unknown -> upstream_error; credential -> auth; config ->
// invalid_request; unsupported -> unavailable; invalid-request ->
// invalid_request; invalid-response -> invalid_response. Retryability defers
// to isRetryableWebAccessError. Tavily 432 -> quota is explicit per handoff.

import {
  isRetryableWebAccessError,
  type WebAccessErrorKind,
  type WebAccessProviderFailure,
  type WebAccessProviderId,
} from './web-access-contract.js';

export interface ClassifiedWebAccessError {
  kind: WebAccessErrorKind;
  status: number | undefined;
  retryable: boolean;
}

function errorStatusField(error: unknown): number | undefined {
  const status = (error as { status?: unknown })?.status;
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
}

function statusFromMessage(message: string): number | undefined {
  const match = /\b(?:error|status|http)\s+(\d{3})\b/i.exec(message);
  return match?.[1] !== undefined ? Number(match[1]) : undefined;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

function isAbortLike(error: unknown, message: string): boolean {
  if (errorName(error) === 'AbortError') return true;
  return message.toLowerCase().includes('abort');
}

const UNSUPPORTED_TOOL_PATTERN =
  /(?:web[_ -]?search|web[_ -]?search_preview|(?:the )?tool)\b.*\b(?:unsupported|not supported|does not support|doesn't support|unknown|unrecognized|unavailable|not found)|\b(?:unsupported|not supported|does not support|doesn't support|unknown|unrecognized|unavailable|not found)\b.*\b(?:web[_ -]?search|web[_ -]?search_preview|(?:the )?tool)/i;

/**
 * Classify a provider failure into the compat error taxonomy. Pure: no I/O,
 * no secrets in the returned kind. Mirrors upstream classifyProviderError
 * with the contract 11-kind vocabulary.
 */
export function classifyWebAccessError(
  provider: WebAccessProviderId,
  error: unknown,
): ClassifiedWebAccessError {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const status = errorStatusField(error) ?? statusFromMessage(message);
  let kind: WebAccessErrorKind;

  if (/(?:api )?key (?:not found|missing)|credential resolution/.test(lower)) {
    kind = 'auth';
  } else if (errorName(error) === 'TimeoutError' || /timed out|request timeout/.test(lower)) {
    kind = 'timeout';
  } else if (isAbortLike(error, message)) {
    kind = 'aborted';
  } else if (provider === 'xai' && status === 403 && /spending[- ]limit|(?:no|out of) credits?|insufficient quota|quota (?:exceeded|exhausted)|credits? (?:exhausted|depleted|used up)/.test(lower)) {
    kind = 'quota';
  } else if (status === 401 || status === 403) {
    kind = 'auth';
  } else if (status === 404) {
    kind = 'not_found';
  } else if (provider === 'openai' as WebAccessProviderId && (status === 400 || status === 422) && UNSUPPORTED_TOOL_PATTERN.test(lower)) {
    // Defensive: 'openai' is not a contract provider id; kept for parity with
    // the upstream openai-unsupported branch in case callers pass it through.
    kind = 'unavailable';
  } else if (status === 400 || status === 422) {
    kind = 'invalid_request';
  } else if (status === 402 || status === 429 || (provider === 'tavily' && status === 432)) {
    kind = status === 429 ? 'rate_limited' : 'quota';
  } else if (status === 408 || status === 504) {
    kind = 'timeout';
  } else if (status !== undefined && status >= 500) {
    kind = 'upstream_error';
  } else if (/rate limit|quota|too many requests/.test(lower)) {
    kind = /too many requests/.test(lower) ? 'rate_limited' : 'quota';
  } else if (/unauthorized|forbidden|permission denied/.test(lower)) {
    kind = 'auth';
  } else if (/bad request|invalid request/.test(lower)) {
    kind = 'invalid_request';
  } else if (/invalid json|no parseable response|no parseable results|invalid response|returned empty response|unexpected response shape|unsuccessful/.test(lower)) {
    kind = 'invalid_response';
  } else if (/service unavailable|server error/.test(lower)) {
    kind = 'upstream_error';
  } else if (/not configured|unavailable/.test(lower)) {
    kind = 'unavailable';
  } else if (
    error instanceof TypeError ||
    /fetch failed|network|econnreset|econnrefused|enotfound|etimedout|socket/.test(lower)
  ) {
    kind = 'network';
  } else if (status !== undefined && status >= 400) {
    kind = 'upstream_error';
  } else {
    kind = 'upstream_error';
  }

  return { kind, status, retryable: isRetryableWebAccessError(kind) };
}

/** Replace exact secret values so failure messages stay safe to surface. */
export function redactWebAccessSecrets(message: string, secrets: Array<string | undefined>): string {
  let out = message;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 4) continue;
    out = out.split(secret).join('[REDACTED]');
  }
  // Strip api-key-ish query param values that may carry credentials in URLs.
  out = out.replace(/([?&](?:api[_-]?key|key|token|auth)=)[^&\s]*/gi, '$1[REDACTED]');
  return out;
}

/** Credential-key pattern for secret collection: only values stored under
 * credential-like keys are treated as secrets (never every env value). */
const CREDENTIAL_KEY_PATTERN = /(?:api[_-]?key|token|secret|password|auth|bearer|credential)/i;

function collectSecrets(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && entry[1].length >= 4 && CREDENTIAL_KEY_PATTERN.test(entry[0]),
    )
    .map(([, value]) => value);
}

/** Build the contract failure envelope with secrets redacted. */
export function toWebAccessFailure(
  provider: WebAccessProviderId,
  error: unknown,
  env: Record<string, string | undefined>,
): WebAccessProviderFailure {
  const classified = classifyWebAccessError(provider, error);
  const raw = error instanceof Error ? error.message : String(error);
  const message = redactWebAccessSecrets(raw, collectSecrets(env)).slice(0, 500);
  const failure: WebAccessProviderFailure = {
    provider,
    kind: classified.kind,
    message,
    retryable: classified.retryable,
  };
  if (classified.status !== undefined) failure.status = classified.status;
  return failure;
}

/** Error carrying the contract failure for ranking-router consumption. */
export class WebAccessProviderError extends Error {
  readonly failure: WebAccessProviderFailure;
  constructor(failure: WebAccessProviderFailure) {
    super(`${failure.provider} search failed (${failure.kind}): ${failure.message}`);
    this.name = 'WebAccessProviderError';
    this.failure = failure;
  }
}
