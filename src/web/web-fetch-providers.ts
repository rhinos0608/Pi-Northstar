import type {
  WebFetchAdapter,
  WebFetchAdapterInput,
  WebFetchedPage,
} from './web-search-types.js';

export const WEB_FETCH_PROVIDER_IDS = ['firecrawl', 'jina'] as const;

export type WebFetchProviderId = (typeof WEB_FETCH_PROVIDER_IDS)[number];

export const DEFAULT_WEB_FETCH_PROVIDER_TIMEOUT_MS = 15_000;
export const MIN_WEB_FETCH_PROVIDER_TIMEOUT_MS = 1_000;
export const MAX_WEB_FETCH_PROVIDER_TIMEOUT_MS = 30_000;
export const MAX_WEB_FETCH_PROVIDERS = 2;

export interface ResolvedWebFetchPolicy {
  enabled: boolean;
  providers: Array<'firecrawl' | 'jina'>;
  unavailable: Array<'firecrawl' | 'jina'>;
  timeoutMs: number;
}

function parseFetchGate(env: Record<string, string | undefined>): boolean {
  const raw = env.PI_SEARCH_EXTERNAL_FETCH;
  if (raw === undefined || raw.trim() === '') return false;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '0' || normalized === 'false') return false;
  throw new Error(
    `Invalid PI_SEARCH_EXTERNAL_FETCH: expected 1/true/0/false, received ${raw.slice(0, 64)}`,
  );
}

function parseFetchTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = env.PI_SEARCH_FETCH_PROVIDER_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_WEB_FETCH_PROVIDER_TIMEOUT_MS;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (
    !Number.isFinite(parsed)
    || !Number.isInteger(parsed)
    || parsed < MIN_WEB_FETCH_PROVIDER_TIMEOUT_MS
    || parsed > MAX_WEB_FETCH_PROVIDER_TIMEOUT_MS
  ) {
    throw new Error(
      `Invalid PI_SEARCH_FETCH_PROVIDER_TIMEOUT_MS: expected integer ${MIN_WEB_FETCH_PROVIDER_TIMEOUT_MS}..${MAX_WEB_FETCH_PROVIDER_TIMEOUT_MS}`,
    );
  }
  return parsed;
}

function parseFetchBackends(env: Record<string, string | undefined>): Array<'firecrawl' | 'jina'> {
  const raw = env.PI_SEARCH_FETCH_BACKENDS;
  if (raw === undefined || raw.trim() === '') return [];
  const ids = raw.split(',').map((entry) => entry.trim());
  for (const id of ids) {
    if (id === '') {
      throw new Error('Invalid PI_SEARCH_FETCH_BACKENDS: empty entry in backend list');
    }
    if (id !== 'firecrawl' && id !== 'jina') {
      throw new Error(`Invalid PI_SEARCH_FETCH_BACKENDS: unknown backend ${id.slice(0, 64)}`);
    }
  }
  const typed = ids as Array<'firecrawl' | 'jina'>;
  if (new Set(typed).size !== typed.length) {
    throw new Error('Invalid PI_SEARCH_FETCH_BACKENDS: duplicate backend ids');
  }
  if (typed.length > MAX_WEB_FETCH_PROVIDERS) {
    throw new Error(
      `Invalid PI_SEARCH_FETCH_BACKENDS: at most ${MAX_WEB_FETCH_PROVIDERS} backends`,
    );
  }
  return typed;
}

/**
 * Failure classes eligible for ordered external (Firecrawl/Jina) fallback.
 * Eligible: transport/network failure, non-caller timeout, HTTP 401/403/408/429,
 * retryable 5xx (500/502/503/504), empty or structurally unusable extraction.
 * Never eligible: caller abort, policy/input/URL/DNS failures, response-size
 * violations, HTTP 404/410, or other 4xx/5xx. Unknown errors fail open so a
 * recoverable native failure can still try the gated fallback; every known
 * terminal class fails closed. Mirrors isDiffbotFallbackEligible fail-open shape.
 */
export function isExternalFetchEligible(error: unknown, callerSignal?: AbortSignal): boolean {
  if (callerSignal?.aborted) return false;
  const name = (error as { name?: unknown })?.name;
  if (name === 'DiffbotError') return false;
  if (name === 'AbortError') return callerSignal?.aborted ? false : true;
  if (name === 'TimeoutError') return true;
  const message = error instanceof Error ? error.message : String(error);
  // Policy/DNS/size failures fail closed before generic timeout phrasing:
  // a DNS lookup timeout is a DNS failure, never a retryable timeout.
  if (
    /Disallowed URL scheme|URL credentials are not allowed|Blocked hostname|Private\/reserved|DNS resolved .* private\/reserved|DNS lookup|credentials are never forwarded|too large|exceeded size|exceeds maximum|out of range|invalid_request|unsupported_action|unsupported_option|cursor_invalid|contract_invalid_response|response_too_large/i.test(
      message,
    )
  ) {
    return false;
  }
  if (/timed out|aborted due to timeout|request timeout/i.test(message)) return true;
  const statusField = (error as { status?: unknown })?.status;
  const statusMatch = /^HTTP (\d{3}) for /.exec(message)?.[1];
  const status =
    typeof statusField === 'number' ? statusField : statusMatch !== undefined ? Number(statusMatch) : undefined;
  if (status !== undefined) {
    if (status === 404 || status === 410) return false;
    if (status === 401 || status === 403 || status === 408 || status === 429) return true;
    if (status === 500 || status === 502 || status === 503 || status === 504) return true;
    if (status >= 400 && status < 600) return false;
  }
  return true;
}

export interface WebFetchAttemptFailure {
  backend: 'firecrawl' | 'jina';
  message: string;
}

export interface WebExternalFetchResult {
  page?: WebFetchedPage;
  failures: WebFetchAttemptFailure[];
}

/**
 * Ordered external page-fetch fallback over injectable Firecrawl/Jina adapters.
 * Policy resolves (and throws on invalid config) before any adapter call.
 * Attempts run sequentially in exact PI_SEARCH_FETCH_BACKENDS order, at most
 * two, stopping at the first valid nonempty page. Unconfigured named adapters
 * are recorded as diagnostic failures; unlisted adapters are never added.
 * Adapters receive the bounded policy timeout, never the raw caller value.
 * One call per adapter, no retries, no concurrent extraction.
 */
export async function fetchExternalReadablePage(
  input: WebFetchAdapterInput,
  adapters: readonly WebFetchAdapter[] = [],
): Promise<WebExternalFetchResult> {
  const policy = resolveWebFetchPolicy(input.env, adapters);
  const failures: WebFetchAttemptFailure[] = [];
  for (const id of policy.unavailable) {
    failures.push({ backend: id, message: `${id} external fetch not configured` });
  }
  if (!policy.enabled || policy.providers.length === 0 || input.signal?.aborted) {
    return { failures };
  }
  for (const id of policy.providers) {
    if (input.signal?.aborted) break;
    const adapter = adapters.find((entry) => entry.id === id);
    if (!adapter) {
      failures.push({ backend: id, message: `${id} external fetch adapter missing` });
      continue;
    }
    try {
      const page = await adapter.fetch({ ...input, timeoutMs: policy.timeoutMs });
      if (page.content.trim() !== '') {
        return { page, failures };
      }
      failures.push({ backend: id, message: `${id} returned empty extraction` });
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      failures.push({ backend: id, message });
      if (input.signal?.aborted) break;
    }
    if (input.signal?.aborted) break;
  }
  return { failures };
}

export function resolveWebFetchPolicy(
  env: Record<string, string | undefined>,
  adapters: readonly WebFetchAdapter[] = [],
): ResolvedWebFetchPolicy {
  // Validate everything before consulting any adapter: invalid policy never
  // reaches a vendor call.
  const enabled = parseFetchGate(env);
  const timeoutMs = parseFetchTimeoutMs(env);
  const requested = parseFetchBackends(env);
  const providers: Array<'firecrawl' | 'jina'> = [];
  const unavailable: Array<'firecrawl' | 'jina'> = [];
  for (const id of requested) {
    const adapter = adapters.find((entry) => entry.id === id);
    if (adapter && adapter.configured(env)) {
      providers.push(id);
    } else {
      unavailable.push(id);
    }
  }
  return { enabled, providers, unavailable, timeoutMs };
}
