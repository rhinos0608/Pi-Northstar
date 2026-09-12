// Final web_search coordinator: batch/filter/include-content fanout.
//
// Focused web-access module only. Vocabulary + validation stays in
// web-access-contract.ts. Ranking reuses existing normalized-URL dedupe +
// equal RRF k=60 from src/fusion.ts. No provider/backend selector exists in
// model input; PI_SEARCH_WEB_BACKENDS is the sole operator selector.
// Pure coordinator: no network, no disk, no Pi-runtime imports.
import { normalizeUrl, rrfMerge } from './fusion.js';
import {
  WEB_ACCESS_BATCH_CONCURRENCY,
  WEB_ACCESS_MAX_BATCH_QUERIES,
  isWebAccessProviderId,
  normalizeWebAccessSearchRequest,
  passesWebAccessFreshness,
  resolveWebAccessRecencyLowerBound,
  type WebAccessContractError,
  type WebAccessProviderFailure,
  type WebAccessProviderId,
  type WebAccessRawSearchRequest,
  type WebAccessSearchHit,
  type WebAccessSearchRequest,
} from './web-access-contract.js';
import { passesWebAccessDomainFilter } from './web-access-domain.js';

export const WEB_ACCESS_MAX_BACKENDS = 8;
export const WEB_ACCESS_DEFAULT_BACKEND_COUNT = 3;
export const WEB_ACCESS_RRF_K = 60;

// Structural adapter seam. Matches src/web-access-provider-adapters.ts
// WebAccessAdapterRequest/WebAccessAdapter without importing it, so this
// coordinator stays decoupled from transport details.
export interface WebAccessSearchAdapterRequest {
  query: string;
  numResults: number;
  recencyFilter?: 'day' | 'week' | 'month' | 'year' | undefined;
  domainFilter?: string[] | undefined;
  includeContent?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export interface WebAccessSearchAdapterResponse {
  provider: WebAccessProviderId;
  results: WebAccessSearchHit[];
  answer?: string | undefined;
  inlineContent?: string | undefined;
}

export interface WebAccessSearchAdapter {
  readonly id: WebAccessProviderId;
  isConfigured(env: Record<string, string | undefined>): boolean;
  search(
    request: WebAccessSearchAdapterRequest,
    env: Record<string, string | undefined>,
  ): Promise<WebAccessSearchAdapterResponse>;
}

export interface WebAccessBackendSelection {
  explicit: boolean;
  selected: WebAccessProviderId[];
  runnable: WebAccessSearchAdapter[];
  unavailable: WebAccessProviderId[];
}

function parseExplicitBackends(raw: string): WebAccessProviderId[] {
  const ids = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`PI_SEARCH_WEB_BACKENDS: duplicate backend "${id}"`);
    seen.add(id);
    if (!isWebAccessProviderId(id)) throw new Error(`PI_SEARCH_WEB_BACKENDS: unknown backend "${id}"`);
  }
  if (ids.length > WEB_ACCESS_MAX_BACKENDS) {
    throw new Error(`PI_SEARCH_WEB_BACKENDS: at most ${WEB_ACCESS_MAX_BACKENDS} backends, got ${ids.length}`);
  }
  return ids as WebAccessProviderId[];
}

// Operator-only backend resolution. Absent/blank env uses first 3
// configured adapters in input order; explicit list runs all runnable
// concurrently (max 8). Never reads model input.
export function resolveWebAccessBackends(
  env: Record<string, string | undefined>,
  adapters: readonly WebAccessSearchAdapter[],
): WebAccessBackendSelection {
  const raw = env['PI_SEARCH_WEB_BACKENDS'];
  if (raw === undefined || raw.trim() === '') {
    const runnable: WebAccessSearchAdapter[] = [];
    for (const adapter of adapters) {
      if (runnable.length >= WEB_ACCESS_DEFAULT_BACKEND_COUNT) break;
      if (adapter.isConfigured(env)) runnable.push(adapter);
    }
    return { explicit: false, selected: runnable.map((a) => a.id), runnable, unavailable: [] };
  }
  const selected = parseExplicitBackends(raw);
  const byId = new Map(adapters.map((a) => [a.id, a] as const));
  const runnable: WebAccessSearchAdapter[] = [];
  const unavailable: WebAccessProviderId[] = [];
  for (const id of selected) {
    const adapter = byId.get(id);
    if (adapter !== undefined && adapter.isConfigured(env)) runnable.push(adapter);
    else unavailable.push(id);
  }
  return { explicit: true, selected, runnable, unavailable };
}

export interface WebAccessMergedQueryResult {
  queryIndex: number;
  query: string;
  hits: WebAccessSearchHit[];
  providers: WebAccessProviderId[];
  failures: WebAccessProviderFailure[];
  answer?: string | undefined;
  inlineContent?: string | undefined;
}

export interface WebAccessSearchRunOptions {
  adapters: readonly WebAccessSearchAdapter[];
  env: Record<string, string | undefined>;
  now?: (() => number) | undefined;
  signal?: AbortSignal | undefined;
}

function hostnameOf(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.length > 0 ? host : undefined;
  } catch {
    return undefined;
  }
}

function applyDomainFilter(hits: WebAccessSearchHit[], domains: string[] | undefined): WebAccessSearchHit[] {
  if (domains === undefined || domains.length === 0) return hits;
  return hits.filter((hit) => {
    const host = hostnameOf(hit.url);
    if (host === undefined) return false;
    return passesWebAccessDomainFilter(host, domains);
  });
}

function applyFreshnessFilter(
  hits: WebAccessSearchHit[],
  request: WebAccessSearchRequest,
  now: number,
): WebAccessSearchHit[] {
  const bound = resolveWebAccessRecencyLowerBound({ recency: request.recency, yearFrom: request.yearFrom, now });
  if (bound === undefined) return hits;
  return hits.filter((hit) => passesWebAccessFreshness(hit.publishedDate, bound));
}

// Equal-weight RRF k=60 over normalized URLs. First-seen hit wins per URL
// (richest-donor text preserved); provider provenance stays output-visible
// via the providers/failures lists.
function mergeResponses(
  responses: WebAccessSearchAdapterResponse[],
  limit: number,
): { hits: WebAccessSearchHit[]; answer?: string | undefined; inlineContent?: string | undefined } {
  const rankings = responses.map((r) => r.results);
  const merged = rrfMerge<WebAccessSearchHit>(rankings, {
    k: WEB_ACCESS_RRF_K,
    keyFn: (hit) => normalizeUrl(hit.url),
  });
  const hits = merged.map((m) => m.item).slice(0, limit);
  let answer: string | undefined;
  for (const r of responses) {
    if (r.answer !== undefined && r.answer.length > 0) {
      answer = r.answer;
      break;
    }
  }
  const inline = responses.map((r) => r.inlineContent).filter((c): c is string => typeof c === 'string' && c.length > 0);
  const out: { hits: WebAccessSearchHit[]; answer?: string | undefined; inlineContent?: string | undefined } = { hits };
  if (answer !== undefined) out.answer = answer;
  if (inline.length > 0) out.inlineContent = inline.join('\n\n');
  return out;
}

async function runSingleQuery(
  query: string,
  queryIndex: number,
  request: WebAccessSearchRequest,
  selection: WebAccessBackendSelection,
  options: WebAccessSearchRunOptions,
  now: number,
): Promise<WebAccessMergedQueryResult> {
  const adapterRequest: WebAccessSearchAdapterRequest = {
    query,
    numResults: request.limit,
    signal: request.signal ?? options.signal,
  };
  if (request.recency !== undefined) adapterRequest.recencyFilter = request.recency;
  if (request.domains !== undefined) adapterRequest.domainFilter = [...request.domains];
  if (request.includeContent === true) adapterRequest.includeContent = true;
  const settled = await Promise.all(
    selection.runnable.map(async (adapter) => {
      try {
        return { ok: true as const, response: await adapter.search({ ...adapterRequest, ...(adapterRequest.domainFilter ? { domainFilter: [...adapterRequest.domainFilter] } : {}) }, options.env) };
      } catch (error) {
        // Cancellation is never a provider failure: rethrow so callers
        // observe the abort instead of a synthetic upstream_error entry.
        if (adapterRequest.signal?.aborted || options.signal?.aborted) throw error;
        if (error instanceof Error && error.name === 'AbortError') throw error;
        const nested = (error as { failure?: unknown } | null | undefined)?.failure;
        const failure: WebAccessProviderFailure =
          nested !== null && typeof nested === 'object' && 'provider' in nested && 'kind' in nested
            ? (nested as WebAccessProviderFailure)
            : error !== null && typeof error === 'object' && 'provider' in error && 'kind' in error
            ? (error as unknown as WebAccessProviderFailure)
            : {
                provider: adapter.id,
                kind: 'upstream_error' as const,
                message: error instanceof Error ? error.message.slice(0, 500) : 'search failed',
                retryable: false,
              };
        if (failure.kind === 'aborted') throw error;
        return { ok: false as const, failure };
      }
    }),
  );
  const responses = settled.filter((s) => s.ok).map((s) => s.response);
  const failures = settled.filter((s) => !s.ok).map((s) => s.failure);
  const merged = mergeResponses(responses, responses.reduce((total, r) => total + r.results.length, 0));
  const filtered = applyFreshnessFilter(applyDomainFilter(merged.hits, request.domains), request, now).slice(0, request.limit);
  const result: WebAccessMergedQueryResult = {
    queryIndex,
    query,
    hits: filtered,
    providers: responses.map((r) => r.provider),
    failures,
  };
  if (merged.answer !== undefined) result.answer = merged.answer;
  if (request.includeContent === true && merged.inlineContent !== undefined) {
    result.inlineContent = merged.inlineContent;
  }
  return result;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return out;
}

export interface WebAccessBatchSearchOutput {
  request: WebAccessSearchRequest;
  selection: WebAccessBackendSelection;
  results: WebAccessMergedQueryResult[];
}

// Final entry point. Validates raw model input (XOR query/queries, cursor
// only single query, no provider field), resolves operator backends, runs
// batch queries with concurrency 3 in input order.
export async function runWebAccessBatchSearch(
  raw: WebAccessRawSearchRequest,
  options: WebAccessSearchRunOptions,
): Promise<WebAccessBatchSearchOutput> {
  const request = normalizeWebAccessSearchRequest(raw);
  if (request.queries.length > WEB_ACCESS_MAX_BATCH_QUERIES) {
    const err: WebAccessContractError = new Error(
      `queries must contain 1-${WEB_ACCESS_MAX_BATCH_QUERIES} entries`,
    ) as WebAccessContractError;
    err.name = 'WebAccessContractError';
    throw err;
  }
  const selection = resolveWebAccessBackends(options.env, options.adapters);
  const now = options.now?.() ?? Date.now();
  const results = await mapWithConcurrency(request.queries, WEB_ACCESS_BATCH_CONCURRENCY, (query, queryIndex) =>
    runSingleQuery(query, queryIndex, request, selection, options, now),
  );
  return { request, selection, results };
}
