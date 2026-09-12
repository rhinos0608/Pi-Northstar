// Pi Web Access shared search/fetch/cache vocabulary (FINAL contract).
//
// Pure vocabulary + validation only. No provider imports, no Pi-runtime
// imports, no network, no disk. Node builtins only. Integration files
// (src/index.ts, src/native-tools.ts, src/web.ts, src/web-contract.ts,
// src/web-search-types.ts, src/result-contract.ts, src/providers.ts,
// src/capabilities.ts, src/untrusted-content.ts, src/tool-output.ts)
// are never edited here.
//
// FINAL rules encoded:
// - Public tools remain web_search and fetch. No provider/backend selector
//   exists in any model-facing input schema. `PI_SEARCH_WEB_BACKENDS` is the
//   sole operator selector (read by integration, never parsed here).
// - Provider ids below are internal inventory + model-visible OUTPUT
//   provenance only. Input selection (`provider`, `all`, `auto`, fallback
//   routing, provider-order concatenation) is rejected, never executed.
// - All rankings use the existing normalized-URL dedupe + equal RRF k=60 in
//   the canonical pipeline. This module defines no alternate ordering.
// - web_search input is XOR query:string or queries:string[1..8]; cursor
//   only with a single query. Optional limit / includeContent (default
//   false) / recency (day|week|month|year) / domains / category / source /
//   yearFrom / knowledge / mode.
// - yearFrom + recency intersect using the later lower bound; dated results
//   post-filter, undated retained without freshness claim.
// - Batch concurrency 3, input order. Explicit backend fanout (when the
//   operator env lists backends) runs all runnable concurrently, max 8;
//   absent/blank env uses the top 3 configured.
// - Fetch is discriminated: normal (action omitted) requires XOR url or
//   urls[1..8] or searchQuery+query; query is a passage selector for
//   url(s); followLinks only singular url+query; sitemap only singular url.
//   retrieve requires responseId (+ optional sourceIds/offset/limit/
//   findText, findText wins). source_check requires responseId +
//   claims[1..20] (+ optional sourceIds); cached corpus only, no network.
//   No format param.
// - Memory cache bounds: 1h TTL, 128 entries, 128 MiB. Retrieval slices cap
//   at 50k chars.

// ── Bounds ──

export const WEB_ACCESS_BATCH_CONCURRENCY = 3;
export const WEB_ACCESS_MAX_BATCH_QUERIES = 8;
export const WEB_ACCESS_MAX_NUM_RESULTS = 20;
export const WEB_ACCESS_DEFAULT_LIMIT = 5;
export const WEB_ACCESS_MIN_LIMIT = 1;
export const WEB_ACCESS_MAX_LIMIT = 20;
export const WEB_ACCESS_STORE_MAX_ENTRIES = 128;
export const WEB_ACCESS_STORE_MAX_BYTES = 128 * 1024 * 1024;
export const WEB_ACCESS_STORE_TTL_MS = 60 * 60 * 1000;
export const WEB_ACCESS_RETRIEVAL_MAX_CHARS = 50_000;
export const WEB_ACCESS_MAX_QUERY_LENGTH = 300;
export const WEB_ACCESS_MAX_URL_LENGTH = 2048;
export const WEB_ACCESS_MAX_DOMAINS = 32;
export const WEB_ACCESS_MAX_FETCH_URLS = 8;
export const WEB_ACCESS_MAX_CLAIMS = 20;
export const WEB_ACCESS_MAX_SOURCE_IDS = 32;
export const WEB_ACCESS_MIN_YEAR_FROM = 1900;

// ── Provider inventory (internal + output provenance only) ──
// Never accepted as model input. Integration resolves runnable backends
// from PI_SEARCH_WEB_BACKENDS and stamps these ids on output hits.

export const WEB_ACCESS_PROVIDER_IDS = [
  'tavily',
  'exa',
  'brave',
  'diffbot',
  'firecrawl',
  'jina',
  'searxng',
  'ollama-search',
  'duckduckgo',
  'parallel',
  'parallel-mcp',
  'tinyfish',
  'search1api',
  'searchinfinity',
  'querit',
  'perplexity',
  'gemini',
  'kimi',
  'serpdive',
  'kagi',
  'anysearch',
  'xai',
  'mistral',
  'brightdata',
  'serpbase',
  'serpapi',
  'serper',
  'valyu',
  'bocha',
  'xcrawl',
] as const;

export type WebAccessProviderId = (typeof WEB_ACCESS_PROVIDER_IDS)[number];

export function isWebAccessProviderId(value: unknown): value is WebAccessProviderId {
  return typeof value === 'string' && (WEB_ACCESS_PROVIDER_IDS as readonly string[]).includes(value);
}

// ── Error taxonomy (11-kind union) ──

export const WEB_ACCESS_ERROR_KINDS = [
  'auth',
  'quota',
  'rate_limited',
  'timeout',
  'aborted',
  'network',
  'upstream_error',
  'invalid_response',
  'invalid_request',
  'not_found',
  'unavailable',
] as const;

export type WebAccessErrorKind = (typeof WEB_ACCESS_ERROR_KINDS)[number];

export function isWebAccessErrorKind(value: unknown): value is WebAccessErrorKind {
  return typeof value === 'string' && (WEB_ACCESS_ERROR_KINDS as readonly string[]).includes(value);
}

const WEB_ACCESS_RETRYABLE_KINDS: ReadonlySet<WebAccessErrorKind> = new Set([
  'quota',
  'rate_limited',
  'timeout',
  'network',
  'upstream_error',
  'unavailable',
]);

export function isRetryableWebAccessError(kind: WebAccessErrorKind): boolean {
  return WEB_ACCESS_RETRYABLE_KINDS.has(kind);
}

/**
 * Map an HTTP status to the compat error kind. Tavily `432` is a quota
 * signal (not a generic upstream error). 5xx and unmapped statuses fall back
 * to `upstream_error`; 3xx (redirects are rejected, never followed) is also
 * `upstream_error`; a 2xx reaching the error path means a malformed success
 * payload, so it maps to `invalid_response`.
 */
export function webAccessErrorKindForStatus(status: number | undefined): WebAccessErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429 || status === 432) return status === 432 ? 'quota' : 'rate_limited';
  if (status === 400 || status === 422) return 'invalid_request';
  if (status === undefined) return 'upstream_error';
  if (status >= 300) return 'upstream_error';
  if (status >= 200) return 'invalid_response';
  return 'upstream_error';
}

// ── Search request (FINAL: XOR query/queries, no provider input) ──

export type WebAccessRecency = 'day' | 'week' | 'month' | 'year';

const WEB_ACCESS_RECENCIES: readonly string[] = ['day', 'week', 'month', 'year'];

/** Legacy alias kept for internal adapter requests (public field is `recency`). */
export type WebAccessRecencyFilter = WebAccessRecency;

export interface WebAccessSearchRequest {
  queries: string[];
  limit: number;
  includeContent: boolean;
  recency?: WebAccessRecency | undefined;
  domains?: string[] | undefined;
  category?: string | undefined;
  source?: string | undefined;
  yearFrom?: number | undefined;
  knowledge?: boolean | undefined;
  mode?: string | undefined;
  cursor?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface WebAccessRawSearchRequest {
  query?: unknown;
  queries?: unknown;
  cursor?: unknown;
  limit?: unknown;
  includeContent?: unknown;
  recency?: unknown;
  domains?: unknown;
  category?: unknown;
  source?: unknown;
  yearFrom?: unknown;
  knowledge?: unknown;
  mode?: unknown;
  signal?: unknown;
  provider?: unknown;
  recencyFilter?: unknown;
  domainFilter?: unknown;
  numResults?: unknown;
  workflow?: unknown;
  fallbackOn?: unknown;
}

export class WebAccessContractError extends Error {
  readonly code = 'invalid_request' as const;
  constructor(message: string) {
    super(message);
    this.name = 'WebAccessContractError';
  }
}

function cleanQuery(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > WEB_ACCESS_MAX_QUERY_LENGTH) {
    throw new WebAccessContractError(`query exceeds maximum length of ${WEB_ACCESS_MAX_QUERY_LENGTH}`);
  }
  return trimmed;
}

function parseQueries(raw: WebAccessRawSearchRequest): string[] {
  const hasQuery = raw.query !== undefined;
  const hasQueries = raw.queries !== undefined;
  if (hasQuery && hasQueries) {
    throw new WebAccessContractError('search accepts exactly one of query or queries, not both');
  }
  const out: string[] = [];
  if (hasQueries) {
    if (!Array.isArray(raw.queries)) throw new WebAccessContractError('queries must be an array of strings');
    for (const entry of raw.queries) {
      const q = cleanQuery(entry);
      if (q === undefined) throw new WebAccessContractError('queries entries must be non-empty strings');
      out.push(q);
    }
  } else if (hasQuery) {
    const q = cleanQuery(raw.query);
    if (q === undefined) throw new WebAccessContractError('query must be a non-empty string when provided');
    out.push(q);
  } else {
    throw new WebAccessContractError('search requires selector: query or queries');
  }
  if (out.length < 1 || out.length > WEB_ACCESS_MAX_BATCH_QUERIES) {
    throw new WebAccessContractError(`queries must contain 1-${WEB_ACCESS_MAX_BATCH_QUERIES} entries`);
  }
  return out;
}

function parseLimit(raw: WebAccessRawSearchRequest): number {
  if (raw.limit === undefined) return WEB_ACCESS_DEFAULT_LIMIT;
  if (
    typeof raw.limit !== 'number' ||
    !Number.isInteger(raw.limit) ||
    raw.limit < WEB_ACCESS_MIN_LIMIT ||
    raw.limit > WEB_ACCESS_MAX_LIMIT
  ) {
    throw new WebAccessContractError(
      `limit must be an integer in [${WEB_ACCESS_MIN_LIMIT}, ${WEB_ACCESS_MAX_LIMIT}]`,
    );
  }
  return raw.limit;
}

function parseDomains(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new WebAccessContractError('domains must be an array of hostnames');
  if (value.length > WEB_ACCESS_MAX_DOMAINS) {
    throw new WebAccessContractError(`domains must contain at most ${WEB_ACCESS_MAX_DOMAINS} entries`);
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new WebAccessContractError('domains entries must be non-empty strings');
    }
    const host = entry.trim().toLowerCase();
    if (host.length > 253 || !/^[a-z0-9.-]+$/.test(host)) {
      throw new WebAccessContractError(`invalid domains hostname: ${host.slice(0, 64)}`);
    }
    out.push(host);
  }
  return out;
}

function parseOptionalString(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WebAccessContractError(`${field} must be a non-empty string when provided`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new WebAccessContractError(`${field} exceeds maximum length of ${maxLength}`);
  }
  return trimmed;
}

function parseYearFrom(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const currentYear = new Date().getUTCFullYear();
  if (typeof value !== 'number' || !Number.isInteger(value) || value < WEB_ACCESS_MIN_YEAR_FROM || value > currentYear) {
    throw new WebAccessContractError(`yearFrom must be an integer in [${WEB_ACCESS_MIN_YEAR_FROM}, ${currentYear}]`);
  }
  return value;
}

/**
 * Validate a raw search request. Throws WebAccessContractError with
 * reject-on-out-of-range semantics (never clamps). Provider selection,
 * legacy recencyFilter/domainFilter/numResults/workflow/fallbackOn fields,
 * and ambiguous query+queries are rejected: operator backend selection
 * lives in PI_SEARCH_WEB_BACKENDS, never in model input.
 */
export function normalizeWebAccessSearchRequest(raw: WebAccessRawSearchRequest): WebAccessSearchRequest {
  if (raw.provider !== undefined) {
    throw new WebAccessContractError('provider selection is operator-only (PI_SEARCH_WEB_BACKENDS); omit provider');
  }
  if (raw.recencyFilter !== undefined) {
    throw new WebAccessContractError('recencyFilter is not a field; use recency');
  }
  if (raw.domainFilter !== undefined) {
    throw new WebAccessContractError('domainFilter is not a field; use domains');
  }
  if (raw.numResults !== undefined) {
    throw new WebAccessContractError('numResults is not a field; use limit');
  }
  if (raw.workflow !== undefined) {
    throw new WebAccessContractError('workflow is not a supported field');
  }
  if (raw.fallbackOn !== undefined) {
    throw new WebAccessContractError('fallbackOn is not a supported field');
  }
  const queries = parseQueries(raw);
  const limit = parseLimit(raw);
  let includeContent = false;
  if (raw.includeContent !== undefined) {
    if (typeof raw.includeContent !== 'boolean') {
      throw new WebAccessContractError('includeContent must be a boolean');
    }
    includeContent = raw.includeContent;
  }
  let recency: WebAccessRecency | undefined;
  if (raw.recency !== undefined) {
    if (typeof raw.recency !== 'string' || !WEB_ACCESS_RECENCIES.includes(raw.recency)) {
      throw new WebAccessContractError('recency must be one of: day, week, month, year');
    }
    recency = raw.recency as WebAccessRecency;
  }
  const domains = parseDomains(raw.domains);
  const category = parseOptionalString(raw.category, 'category', 64);
  const source = parseOptionalString(raw.source, 'source', 64);
  const yearFrom = parseYearFrom(raw.yearFrom);
  let knowledge: boolean | undefined;
  if (raw.knowledge !== undefined) {
    if (typeof raw.knowledge !== 'boolean') throw new WebAccessContractError('knowledge must be a boolean');
    knowledge = raw.knowledge;
  }
  const mode = parseOptionalString(raw.mode, 'mode', 64);
  let cursor: string | undefined;
  if (raw.cursor !== undefined) {
    if (typeof raw.cursor !== 'string' || raw.cursor.length === 0) {
      throw new WebAccessContractError('cursor must be a non-empty string when provided');
    }
    if (queries.length !== 1) {
      throw new WebAccessContractError('cursor is only supported with a single query');
    }
    cursor = raw.cursor;
  }
  let signal: AbortSignal | undefined;
  if (raw.signal !== undefined) {
    if (typeof raw.signal !== 'object' || raw.signal === null || !('aborted' in raw.signal)) {
      throw new WebAccessContractError('signal must be an AbortSignal when provided');
    }
    signal = raw.signal as AbortSignal;
  }
  const request: WebAccessSearchRequest = { queries, limit, includeContent };
  if (recency !== undefined) request.recency = recency;
  if (domains !== undefined) request.domains = domains;
  if (category !== undefined) request.category = category;
  if (source !== undefined) request.source = source;
  if (yearFrom !== undefined) request.yearFrom = yearFrom;
  if (knowledge !== undefined) request.knowledge = knowledge;
  if (mode !== undefined) request.mode = mode;
  if (cursor !== undefined) request.cursor = cursor;
  if (signal !== undefined) request.signal = signal;
  return request;
}

// ── Recency / yearFrom intersection ──
// Both bounds supplied: the later timestamp wins. Dated results at or after
// the bound pass; undated results are retained without freshness claim.

export interface WebAccessFreshnessOptions {
  recency?: WebAccessRecency | undefined;
  yearFrom?: number | undefined;
  now?: number | undefined;
}

export function resolveWebAccessRecencyLowerBound(options: WebAccessFreshnessOptions): number | undefined {
  const now = options.now ?? Date.now();
  let bound: number | undefined;
  if (options.recency !== undefined) {
    const date = new Date(now);
    switch (options.recency) {
      case 'day':
        bound = now - 24 * 60 * 60 * 1000;
        break;
      case 'week':
        bound = now - 7 * 24 * 60 * 60 * 1000;
        break;
      case 'month':
        bound = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, date.getUTCDate(), 0, 0, 0, 0);
        break;
      case 'year':
        bound = Date.UTC(date.getUTCFullYear() - 1, date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0);
        break;
    }
  }
  if (options.yearFrom !== undefined) {
    const yearBound = Date.UTC(options.yearFrom, 0, 1, 0, 0, 0, 0);
    bound = bound === undefined ? yearBound : Math.max(bound, yearBound);
  }
  return bound;
}

/** True when a dated hit satisfies the bound; undated hits always pass. */
export function passesWebAccessFreshness(publishedDate: string | undefined, lowerBound: number | undefined): boolean {
  if (lowerBound === undefined) return true;
  if (publishedDate === undefined) return true;
  const time = Date.parse(publishedDate);
  if (Number.isNaN(time)) return true;
  return time >= lowerBound;
}

// ── Provider response / failure / per-query result (output shapes) ──

export interface WebAccessSearchHit {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string | undefined;
}

export interface WebAccessProviderResponse {
  provider: WebAccessProviderId;
  /** Ordered hits in provider order. */
  results: WebAccessSearchHit[];
  answer?: string | undefined;
  /** Optional background-fetched page text, bounded by the fetch worker. */
  inlineContent?: string | undefined;
}

export interface WebAccessProviderFailure {
  provider: WebAccessProviderId;
  kind: WebAccessErrorKind;
  /** Safe human message; never contains secret values or URL query secrets. */
  message: string;
  status?: number | undefined;
  retryable: boolean;
}

export type WebAccessQueryResult =
  | { queryIndex: number; query: string; response: WebAccessProviderResponse; error?: undefined }
  | { queryIndex: number; query: string; response?: undefined; error: WebAccessProviderFailure };

/** Validate a runtime provider payload with item/byte bounds. */
export function validateWebAccessProviderResponse(value: unknown): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, issues: ['response is not an object'] };
  }
  const record = value as Record<string, unknown>;
  if (!isWebAccessProviderId(record.provider)) issues.push('provider is not a known web-access provider');
  if (!Array.isArray(record.results)) {
    issues.push('results must be an array');
  } else {
    if (record.results.length > WEB_ACCESS_MAX_NUM_RESULTS) {
      issues.push(`results exceed maximum of ${WEB_ACCESS_MAX_NUM_RESULTS}`);
    }
    let bytes = 0;
    for (const [index, entry] of record.results.entries()) {
      if (typeof entry !== 'object' || entry === null) {
        issues.push(`results[${index}] is not an object`);
        continue;
      }
      const hit = entry as Record<string, unknown>;
      if (typeof hit.title !== 'string') issues.push(`results[${index}].title must be a string`);
      if (typeof hit.url !== 'string') issues.push(`results[${index}].url must be a string`);
      else if (hit.url.length > WEB_ACCESS_MAX_URL_LENGTH) {
        issues.push(`results[${index}].url exceeds maximum length`);
      }
      if (typeof hit.snippet !== 'string') issues.push(`results[${index}].snippet must be a string`);
      bytes +=
        (typeof hit.title === 'string' ? hit.title.length : 0) +
        (typeof hit.snippet === 'string' ? hit.snippet.length : 0);
    }
    if (bytes > WEB_ACCESS_RETRIEVAL_MAX_CHARS) {
      issues.push(`response text exceeds maximum of ${WEB_ACCESS_RETRIEVAL_MAX_CHARS} chars`);
    }
  }
  if (record.answer !== undefined && typeof record.answer !== 'string') issues.push('answer must be a string');
  return { ok: issues.length === 0, issues };
}

// ── Fetch discriminated union (FINAL) ──
// Normal (action omitted): XOR url | urls[1..8] | searchQuery+query.
// query is a passage selector for url(s); followLinks only singular
// url+query; sitemap only singular url. retrieve: responseId required,
// optional sourceIds/offset/limit/findText (findText wins). source_check:
// responseId + claims[1..20] + optional sourceIds; cached corpus only.

export type WebAccessFetchNormalRequest = {
  url?: string | undefined;
  urls?: string[] | undefined;
  searchQuery?: string | undefined;
  query?: string | undefined;
  followLinks?: boolean | undefined;
  sitemap?: boolean | undefined;
};

export type WebAccessFetchRetrieveRequest = {
  action: 'retrieve';
  responseId: string;
  sourceIds?: string[] | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
  findText?: string | undefined;
};

export type WebAccessFetchSourceCheckRequest = {
  action: 'source_check';
  responseId: string;
  claims: string[];
  sourceIds?: string[] | undefined;
};

export type WebAccessFetchRequest =
  | WebAccessFetchNormalRequest
  | WebAccessFetchRetrieveRequest
  | WebAccessFetchSourceCheckRequest;

function cleanUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WebAccessContractError('url must be a non-empty string when provided');
  }
  const url = value.trim();
  if (url.length > WEB_ACCESS_MAX_URL_LENGTH) {
    throw new WebAccessContractError(`url exceeds maximum length of ${WEB_ACCESS_MAX_URL_LENGTH}`);
  }
  return url;
}

function parseSourceIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new WebAccessContractError('sourceIds must be an array of strings');
  if (value.length > WEB_ACCESS_MAX_SOURCE_IDS) {
    throw new WebAccessContractError(`sourceIds must contain at most ${WEB_ACCESS_MAX_SOURCE_IDS} entries`);
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new WebAccessContractError('sourceIds entries must be non-empty strings');
    }
    out.push(entry.trim());
  }
  return out;
}

function parseNormalFetch(raw: Record<string, unknown>): WebAccessFetchNormalRequest {
  const hasUrl = raw.url !== undefined;
  const hasUrls = raw.urls !== undefined;
  const hasSearchQuery = raw.searchQuery !== undefined;
  const selectors = [hasUrl, hasUrls, hasSearchQuery].filter(Boolean).length;
  if (selectors !== 1) {
    throw new WebAccessContractError('fetch requires exactly one of: url, urls, or searchQuery+query');
  }
  if (raw.action !== undefined) {
    throw new WebAccessContractError('action must be omitted for a normal fetch');
  }
  if (raw.responseId !== undefined || raw.sourceIds !== undefined || raw.claims !== undefined) {
    throw new WebAccessContractError('responseId/sourceIds/claims require action retrieve or source_check');
  }
  if (raw.offset !== undefined || raw.limit !== undefined || raw.findText !== undefined) {
    throw new WebAccessContractError('offset/limit/findText require action retrieve');
  }
  const out: WebAccessFetchNormalRequest = {};
  if (hasUrl) out.url = cleanUrl(raw.url);
  if (hasUrls) {
    if (!Array.isArray(raw.urls)) throw new WebAccessContractError('urls must be an array of strings');
    if (raw.urls.length < 1 || raw.urls.length > WEB_ACCESS_MAX_FETCH_URLS) {
      throw new WebAccessContractError(`urls must contain 1-${WEB_ACCESS_MAX_FETCH_URLS} entries`);
    }
    out.urls = raw.urls.map(cleanUrl);
  }
  if (hasSearchQuery) {
    if (typeof raw.searchQuery !== 'string' || raw.searchQuery.trim().length === 0) {
      throw new WebAccessContractError('searchQuery must be a non-empty string when provided');
    }
    out.searchQuery = raw.searchQuery.trim();
    const q = cleanQuery(raw.query);
    if (q === undefined) throw new WebAccessContractError('searchQuery requires query (passage selector)');
    out.query = q;
  } else if (raw.query !== undefined) {
    const q = cleanQuery(raw.query);
    if (q === undefined) throw new WebAccessContractError('query must be a non-empty string when provided');
    out.query = q;
  }
  if (raw.followLinks !== undefined) {
    if (raw.followLinks !== true) throw new WebAccessContractError('followLinks must be true when provided');
    if (out.url === undefined || out.query === undefined || out.urls !== undefined || out.searchQuery !== undefined) {
      throw new WebAccessContractError('followLinks requires singular url+query only');
    }
    out.followLinks = true;
  }
  if (raw.sitemap !== undefined) {
    if (raw.sitemap !== true) throw new WebAccessContractError('sitemap must be true when provided');
    if (out.url === undefined || out.urls !== undefined || out.searchQuery !== undefined || out.query !== undefined) {
      throw new WebAccessContractError('sitemap requires singular url only');
    }
    out.sitemap = true;
  }
  // Camel-case alias mirrors the route guard: urls arrays stay readable-only.
  // Singular-url siteMap handling lives in the route layer; the contract only
  // closes the silent-drop hole on the array path.
  if (raw.siteMap !== undefined && out.urls !== undefined) {
    throw new WebAccessContractError('urls array supports readable fetch only (no followLinks/sitemap)');
  }
  return out;
}

function parseRetrieveFetch(raw: Record<string, unknown>): WebAccessFetchRetrieveRequest {
  const responseId = cleanQuery(raw.responseId);
  if (responseId === undefined) throw new WebAccessContractError('retrieve requires responseId');
  const out: WebAccessFetchRetrieveRequest = { action: 'retrieve', responseId };
  const sourceIds = parseSourceIds(raw.sourceIds);
  if (sourceIds !== undefined) out.sourceIds = sourceIds;
  if (raw.findText !== undefined) {
    // findText wins: offset/limit are accepted but ignored downstream.
    if (typeof raw.findText !== 'string' || raw.findText.length === 0) {
      throw new WebAccessContractError('findText must be a non-empty string when provided');
    }
    out.findText = raw.findText;
  }
  if (raw.offset !== undefined) {
    if (!Number.isInteger(raw.offset) || (raw.offset as number) < 0) {
      throw new WebAccessContractError('offset must be a non-negative integer');
    }
    out.offset = raw.offset as number;
  }
  if (raw.limit !== undefined) {
    if (!Number.isInteger(raw.limit) || (raw.limit as number) < 1 || (raw.limit as number) > WEB_ACCESS_RETRIEVAL_MAX_CHARS) {
      throw new WebAccessContractError(`limit must be an integer in [1, ${WEB_ACCESS_RETRIEVAL_MAX_CHARS}]`);
    }
    out.limit = raw.limit as number;
  }
  if (raw.url !== undefined || raw.urls !== undefined || raw.searchQuery !== undefined || raw.query !== undefined) {
    throw new WebAccessContractError('retrieve accepts only responseId/sourceIds/offset/limit/findText');
  }
  for (const extra of ['topK', 'maxPages', 'maxChars', 'followLinks', 'sitemap', 'siteMap', 'claims'] as const) {
    if (raw[extra] !== undefined) {
      throw new WebAccessContractError('retrieve accepts only responseId/sourceIds/offset/limit/findText');
    }
  }
  return out;
}

function parseSourceCheckFetch(raw: Record<string, unknown>): WebAccessFetchSourceCheckRequest {
  const responseId = cleanQuery(raw.responseId);
  if (responseId === undefined) throw new WebAccessContractError('source_check requires responseId');
  if (!Array.isArray(raw.claims)) throw new WebAccessContractError('source_check requires claims[1..20]');
  if (raw.claims.length < 1 || raw.claims.length > WEB_ACCESS_MAX_CLAIMS) {
    throw new WebAccessContractError(`claims must contain 1-${WEB_ACCESS_MAX_CLAIMS} entries`);
  }
  const claims: string[] = [];
  for (const entry of raw.claims) {
    const c = cleanQuery(entry);
    if (c === undefined) throw new WebAccessContractError('claims entries must be non-empty strings');
    claims.push(c);
  }
  const out: WebAccessFetchSourceCheckRequest = { action: 'source_check', responseId, claims };
  const sourceIds = parseSourceIds(raw.sourceIds);
  if (sourceIds !== undefined) out.sourceIds = sourceIds;
  for (const extra of ['url', 'urls', 'searchQuery', 'query', 'offset', 'limit', 'findText', 'topK', 'maxPages', 'maxChars', 'followLinks', 'sitemap', 'siteMap'] as const) {
    if (raw[extra] !== undefined) {
      throw new WebAccessContractError('source_check accepts only responseId/claims/sourceIds');
    }
  }
  return out;
}

/** Validate a raw fetch request into the discriminated union. No format param. */
export function parseWebAccessFetchRequest(raw: Record<string, unknown>): WebAccessFetchRequest {
  if (raw.format !== undefined) {
    throw new WebAccessContractError('format is not a supported fetch field');
  }
  if (raw.provider !== undefined) {
    throw new WebAccessContractError('provider selection is operator-only (PI_SEARCH_WEB_BACKENDS); omit provider');
  }
  if (raw.action === undefined) return parseNormalFetch(raw);
  if (raw.action === 'retrieve') return parseRetrieveFetch(raw);
  if (raw.action === 'source_check') return parseSourceCheckFetch(raw);
  throw new WebAccessContractError('action must be one of: retrieve, source_check (or omitted)');
}

// ── Retrieval slice ──
// findText present discards offset/limit (upstream semantic), never rejects.

export interface WebAccessContentSlice {
  offset?: number | undefined;
  limit?: number | undefined;
  findText?: string | undefined;
  caseSensitive?: boolean | undefined;
  fuzzy?: boolean | undefined;
}

export function normalizeWebAccessContentSlice(raw: WebAccessContentSlice): WebAccessContentSlice {
  if (raw.findText !== undefined) {
    if (typeof raw.findText !== 'string' || raw.findText.length === 0) {
      throw new WebAccessContractError('findText must be a non-empty string when provided');
    }
    const out: WebAccessContentSlice = { findText: raw.findText };
    if (raw.caseSensitive === true) out.caseSensitive = true;
    if (raw.fuzzy === true) out.fuzzy = true;
    return out;
  }
  const out: WebAccessContentSlice = {};
  if (raw.offset !== undefined) {
    if (!Number.isInteger(raw.offset) || raw.offset < 0) {
      throw new WebAccessContractError('offset must be a non-negative integer');
    }
    out.offset = raw.offset;
  }
  if (raw.limit !== undefined) {
    if (!Number.isInteger(raw.limit) || raw.limit < 1 || raw.limit > WEB_ACCESS_RETRIEVAL_MAX_CHARS) {
      throw new WebAccessContractError(`limit must be an integer in [1, ${WEB_ACCESS_RETRIEVAL_MAX_CHARS}]`);
    }
    out.limit = raw.limit;
  }
  return out;
}

// ── Dependency interfaces (integration wires these; contract only types them) ──

export interface WebAccessPageReader {
  read(url: string, mode: 'readable' | 'raw', signal?: AbortSignal): Promise<{ title: string; content: string }>;
}

export interface WebAccessGithubMediaReader {
  read(url: string, signal?: AbortSignal): Promise<{ title: string; content: string } | undefined>;
}

export interface WebAccessStoredEntry {
  responseId: string;
  createdAt: number;
  bytes: number;
  queries: string[];
  results: WebAccessQueryResult[];
}

export interface WebAccessContentStore {
  get(responseId: string): WebAccessStoredEntry | undefined;
  put(entry: WebAccessStoredEntry): void;
  delete(responseId: string): void;
  size(): number;
}

export interface WebAccessClock {
  now(): number;
}

export interface WebAccessIdGenerator {
  randomId(): string;
}
