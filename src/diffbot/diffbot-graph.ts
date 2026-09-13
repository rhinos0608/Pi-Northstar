// Diffbot graph adapter: native DQL query/probe plus raw ontology retrieval.
// Only module aware of Diffbot graph payload details. Reuses the secure
// diffbotFetch transport (fixed hosts, token redaction, manual redirect
// rejection, bounded bodies, timeout, AbortSignal). Token travels via
// `?token=` query only, never in POST bodies. No routing or tool wiring here.
//
// Verified authoritative endpoints:
// - DQL POST https://kg.diffbot.com/kg/v3/dql body {type:'query', query, size, from}
// - Ontology GET https://kg.diffbot.com/kg/ontology -> {metadata, types: {...}}

import {
  DIFFBOT_KG_HOST,
  DiffbotError,
  diffbotFetch,
  type DiffbotFetchOptions,
} from './diffbot-transport.js';
import {
  GRAPH_ADAPTER_CURSOR_V,
  validateGraphJsonValue,
  type GraphError,
  type GraphErrorCode,
  type GraphQueryShape,
  type JsonValue,
} from '../graph/graph-contract.js';

export const GRAPH_PROVIDER = 'diffbot' as const;
export const GRAPH_ADAPTER_V: typeof GRAPH_ADAPTER_CURSOR_V = GRAPH_ADAPTER_CURSOR_V;
export const GRAPH_LANGUAGES = ['dql'] as const;
export const GRAPH_DQL_PATH = '/kg/v3/dql' as const;
export const GRAPH_ONTOLOGY_PATH = '/kg/ontology' as const;
export const GRAPH_PROBE_CONCURRENCY = 8 as const;

type FetchFn = (options: DiffbotFetchOptions) => Promise<unknown>;

export interface DiffbotGraphContext {
  token: string;
  fetchFn?: FetchFn;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface DiffbotGraphQueryInput {
  query: string;
  pageSize: number;
  from: number;
}

export interface DiffbotGraphQueryOutcome {
  provider: typeof GRAPH_PROVIDER;
  shape?: GraphQueryShape;
  result?: JsonValue;
  pagination?: { hasMore: boolean; nextFrom?: number };
  error?: GraphError;
}

export interface DiffbotGraphProbeInput {
  queries: string[];
}

export interface DiffbotGraphProbeOutcome {
  provider: typeof GRAPH_PROVIDER;
  items: Array<{ query: string; status: 'ok'; hits: number } | { query: string; status: 'error'; error: GraphError }>;
}

export interface DiffbotGraphOntologyOutcome {
  provider: typeof GRAPH_PROVIDER;
  ontology?: JsonValue;
  error?: GraphError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Redact token + email/phone selector values from adapter-built error strings. */
function redactGraphError(message: string, token: string): string {
  let out = token ? message.split(token).join('[REDACTED]') : message;
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]');
  out = out.replace(/\+?\d[\d\s().-]{6,}\d/g, '[REDACTED_PHONE]');
  return out.slice(0, 500);
}

function toGraphError(code: GraphErrorCode, message: string, retryable: boolean, token: string): GraphError {
  return { code, message: redactGraphError(message, token), retryable, provider: GRAPH_PROVIDER };
}

function statusOf(error: DiffbotError): number | undefined {
  if (typeof error.status === 'number') return error.status;
  const match = /HTTP (\d{3})/.exec(error.message);
  return match ? Number(match[1]) : undefined;
}

function fromDiffbotError(error: DiffbotError, token: string, ctx: DiffbotGraphContext): GraphError {
  const status = statusOf(error);
  if (status === 401 || status === 403) return toGraphError('auth_required', error.message, false, token);
  if (status === 429) return toGraphError('rate_limited', error.message, true, token);
  if (ctx.signal?.aborted || /abort/i.test(error.message) || error.message.includes('aborted')) {
    return toGraphError('operation_aborted', 'Graph request was aborted.', false, token);
  }
  if (error.code === 'response_too_large') return toGraphError('response_too_large', error.message, false, token);
  if (error.code === 'unsupported_option') return toGraphError('unsupported_option', error.message, false, token);
  if (
    error.code === 'contract_invalid_response' ||
    error.code === 'semantic_invalid_response' ||
    error.code === 'invalid_entity'
  ) {
    return toGraphError('contract_invalid_response', error.message, false, token);
  }
  if (/HTTP \d{3}|upstream|error envelope/i.test(error.message)) {
    return toGraphError('upstream_error', error.message, error.retryable, token);
  }
  return toGraphError('transport_invalid_response', error.message, error.retryable, token);
}

function missingToken(): GraphError {
  return { code: 'auth_required', message: 'DIFFBOT_TOKEN is not configured', retryable: false, provider: GRAPH_PROVIDER };
}

// Entity-returning DQL only for probe/count semantics. Facet/report/export/
// collection/crawl syntax is fail-closed unsupported_option, never narrowed.
const DQL_NON_COUNTABLE = /\b(facet|facets|report|reports|export|exports|collection|collections|crawl|bulkenhance|bulk\s+enhance)\b|format\s*=\s*(csv|xml|jsonl?)|\bfrom\s+[a-z0-9_-]*collection/i;

function isCountableQuery(query: string): boolean {
  const unquoted = query.replace(/"(?:[^"\\]|\\.)*"/g, ' ');
  return !DQL_NON_COUNTABLE.test(unquoted);
}

// Explicit aggregate/report markers only. Anything ambiguous stays `object`.
const AGGREGATE_MARKERS: ReadonlySet<string> = new Set(['aggregate', 'aggregation', 'aggregations', 'report']);

function classifyGraphShape(parsed: unknown): GraphQueryShape | undefined {
  if (parsed === null || typeof parsed === 'boolean' || typeof parsed === 'string') return 'scalar';
  if (typeof parsed === 'number') return Number.isFinite(parsed) ? 'scalar' : undefined;
  if (Array.isArray(parsed)) return 'rows';
  if (!isRecord(parsed)) return undefined;
  if (parsed.facet === true) return 'facets';
  if (Array.isArray(parsed.data)) return 'rows';
  for (const marker of AGGREGATE_MARKERS) {
    const value = parsed[marker];
    if (value !== undefined && (isRecord(value) || Array.isArray(value))) return 'aggregate';
  }
  return 'object';
}

async function postDql(body: Record<string, unknown>, ctx: DiffbotGraphContext): Promise<unknown> {
  const fetchFn: FetchFn = ctx.fetchFn ?? diffbotFetch;
  return fetchFn({
    host: DIFFBOT_KG_HOST,
    path: GRAPH_DQL_PATH,
    method: 'POST',
    token: ctx.token,
    body,
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
  });
}

export async function queryDiffbotGraph(
  input: DiffbotGraphQueryInput,
  ctx: DiffbotGraphContext,
): Promise<DiffbotGraphQueryOutcome> {
  if (!ctx.token) return { provider: GRAPH_PROVIDER, error: missingToken() };
  let parsed: unknown;
  try {
    parsed = await postDql({ type: 'query', query: input.query, size: input.pageSize, from: input.from }, ctx);
  } catch (error) {
    if (error instanceof DiffbotError) return { provider: GRAPH_PROVIDER, error: fromDiffbotError(error, ctx.token, ctx) };
    return { provider: GRAPH_PROVIDER, error: toGraphError('transport_invalid_response', error instanceof Error ? error.message : String(error), true, ctx.token) };
  }
  const shape = classifyGraphShape(parsed);
  if (shape === undefined) {
    return { provider: GRAPH_PROVIDER, error: toGraphError('contract_invalid_response', 'Diffbot graph response has an unsupported shape.', false, ctx.token) };
  }
  if (!validateGraphJsonValue(parsed)) {
    return { provider: GRAPH_PROVIDER, error: toGraphError('response_too_large', 'Diffbot graph response exceeds JSON safety bounds.', false, ctx.token) };
  }
  const result = parsed as JsonValue;
  if (shape !== 'rows') return { provider: GRAPH_PROVIDER, shape, result };
  const hits = isRecord(parsed) && typeof parsed.hits === 'number' ? parsed.hits : undefined;
  const hasMore = hits !== undefined && Number.isInteger(hits) && hits >= 0 && input.from + input.pageSize < hits;
  return {
    provider: GRAPH_PROVIDER,
    shape,
    result,
    pagination: hasMore ? { hasMore: true, nextFrom: input.from + input.pageSize } : { hasMore: false },
  };
}

export async function probeDiffbotGraph(
  input: DiffbotGraphProbeInput,
  ctx: DiffbotGraphContext,
): Promise<DiffbotGraphProbeOutcome> {
  if (!ctx.token) {
    return {
      provider: GRAPH_PROVIDER,
      items: input.queries.map((query) => ({ query, status: 'error' as const, error: missingToken() })),
    };
  }
  const items: DiffbotGraphProbeOutcome['items'] = new Array(input.queries.length);
  const pending: Array<{ index: number; query: string }> = [];
  for (const [index, query] of input.queries.entries()) {
    if (!isCountableQuery(query)) {
      items[index] = {
        query,
        status: 'error',
        error: toGraphError('unsupported_option', 'facet/report/export/collection/crawl modes have no probe cardinality', false, ctx.token),
      };
    } else {
      pending.push({ index, query });
    }
  }
  for (let start = 0; start < pending.length; start += GRAPH_PROBE_CONCURRENCY) {
    const batch = pending.slice(start, start + GRAPH_PROBE_CONCURRENCY);
    await Promise.all(batch.map(async ({ index, query }) => {
      let parsed: unknown;
      try {
        parsed = await postDql({ type: 'query', query, size: 0, from: 0 }, ctx);
      } catch (error) {
        const mapped = error instanceof DiffbotError
          ? fromDiffbotError(error, ctx.token, ctx)
          : toGraphError('transport_invalid_response', error instanceof Error ? error.message : String(error), true, ctx.token);
        items[index] = { query, status: 'error', error: mapped };
        return;
      }
      const hits = isRecord(parsed) ? parsed.hits : undefined;
      if (typeof hits !== 'number' || !Number.isInteger(hits) || hits < 0 || !Number.isFinite(hits)) {
        items[index] = {
          query,
          status: 'error',
          error: toGraphError('contract_invalid_response', 'Diffbot probe response is missing countable hits.', false, ctx.token),
        };
        return;
      }
      items[index] = { query, status: 'ok', hits };
    }));
  }
  return { provider: GRAPH_PROVIDER, items };
}

/** Retrieve and validate the raw Diffbot ontology snapshot (typed view mapping lives in graph-tools). */
export async function fetchDiffbotOntology(ctx: DiffbotGraphContext): Promise<DiffbotGraphOntologyOutcome> {
  if (!ctx.token) return { provider: GRAPH_PROVIDER, error: missingToken() };
  const fetchFn: FetchFn = ctx.fetchFn ?? diffbotFetch;
  let parsed: unknown;
  try {
    parsed = await fetchFn({
      host: DIFFBOT_KG_HOST,
      path: GRAPH_ONTOLOGY_PATH,
      method: 'GET',
      token: ctx.token,
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
    });
  } catch (error) {
    if (error instanceof DiffbotError) return { provider: GRAPH_PROVIDER, error: fromDiffbotError(error, ctx.token, ctx) };
    return { provider: GRAPH_PROVIDER, error: toGraphError('transport_invalid_response', error instanceof Error ? error.message : String(error), true, ctx.token) };
  }
  if (!isRecord(parsed) || !isRecord(parsed.types)) {
    return { provider: GRAPH_PROVIDER, error: toGraphError('contract_invalid_response', 'Diffbot ontology response is missing typed type markers.', false, ctx.token) };
  }
  if (!validateGraphJsonValue(parsed)) {
    return { provider: GRAPH_PROVIDER, error: toGraphError('response_too_large', 'Diffbot ontology response exceeds JSON safety bounds.', false, ctx.token) };
  }
  return { provider: GRAPH_PROVIDER, ontology: parsed as JsonValue };
}
