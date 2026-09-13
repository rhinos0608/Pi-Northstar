// Public graph orchestration: capability-routed query/probe/schema execution.
// Validates the full request before any adapter dispatch (invalid input costs
// zero paid calls), binds opaque cursors to action/language/provider/query/
// pageSize/adapter version, maps ontology snapshots to typed schema views,
// and returns validated, framed Northstar tool results. No provider input:
// v1 maps `dql` to the configured Diffbot adapter.

import type { BackendCallResult } from '../backend.js';
import type { DiffbotFetchOptions } from '../diffbot/diffbot-transport.js';
import {
  GRAPH_PROVIDER,
  GRAPH_ADAPTER_V,
  fetchDiffbotOntology,
  probeDiffbotGraph,
  queryDiffbotGraph,
} from '../diffbot/diffbot-graph.js';
import { resolveSparqlConfig } from '../setup/local-config.js';
import {
  createSparqlGraphAdapter,
  fetchSparqlSchemaView,
  SPARQL_PROVIDER,
} from '../sparql/sparql-graph.js';
import type { SparqlFetchFn } from '../sparql/sparql-transport.js';
import {
  buildGraphResult,
  decodeGraphCursor,
  encodeGraphCursor,
  fingerprintGraphRequest,
  GRAPH_DEFAULT_PAGE_SIZE,
  GRAPH_LANGUAGES,
  toGraphError,
  validateGraphRequest,
  type GraphData,
  type GraphError,
  type GraphLanguage,
  type GraphProbeItem,
  type GraphResult,
  type GraphSchemaResult,
  type GraphStatus,
  type JsonValue,
} from './graph-contract.js';
import {
  DEFAULT_GRAPH_ONTOLOGY_CACHE_PATH,
  ontologyCacheFresh,
  readOntologyCacheFile,
  writeOntologyCacheFileAtomic,
  type OntologyCachePayload,
} from './graph-schema-cache.js';
import { textResult } from '../core/tool-output.js';
import { wrapUntrustedText } from '../core/untrusted-content.js';

/** Language registry: native language to owning provider. No provider input. */
const GRAPH_LANGUAGE_ADAPTERS: Readonly<Record<string, string>> = { dql: GRAPH_PROVIDER, sparql: SPARQL_PROVIDER };

const GRAPH_MAX_FROM = 10_000 as const;
const GRAPH_SCHEMA_SEARCH_CAP = 100 as const;

export interface GraphToolOptions {
  env?: Record<string, string | undefined> | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  fetchFn?: ((options: DiffbotFetchOptions) => Promise<unknown>) | undefined;
  cachePath?: string | undefined;
  /** Test/operator override for the SPARQL endpoint URL (default: env config). */
  sparqlEndpoint?: string | undefined;
  /** Injected SPARQL fetch for deterministic tests; defaults to global fetch. */
  sparqlFetchFn?: SparqlFetchFn | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tokenFrom(env: Record<string, string | undefined>): string {
  const raw = env.DIFFBOT_TOKEN;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : '';
}

function queryPlaceholder(): GraphData {
  return { kind: 'query', shape: 'object', result: null };
}

function errorEnvelope(error: GraphError, data: GraphData, language: GraphLanguage = 'dql', provider: string = GRAPH_PROVIDER): GraphResult {
  return buildGraphResult({ status: 'error', language, provider, data, errors: [error], notes: [] });
}

/** Envelope scope for validation failures: sparql input errors stay sparql-scoped. */
function scopeFor(language: unknown): { language: GraphLanguage; provider: string } {
  if (language === 'sparql') return { language: 'sparql', provider: SPARQL_PROVIDER };
  return { language: 'dql', provider: GRAPH_PROVIDER };
}

function rowCount(result: JsonValue): number | undefined {
  if (Array.isArray(result)) return result.length;
  if (isRecord(result) && Array.isArray(result.data)) return result.data.length;
  return undefined;
}

interface RenderQueryTextParams {
  language: GraphLanguage;
  provider: string;
  shape: string;
  result: JsonValue;
  hasMore: boolean;
}

function renderQueryText({ language, provider, shape, result, hasMore }: RenderQueryTextParams): string {
  const count = rowCount(result);
  const rows = shape === 'rows' && count !== undefined ? ` (${count} row(s))` : '';
  return `Graph query (${language}, ${provider}, shape ${shape})${rows}${hasMore ? ', more pages available' : ''}.`;
}

function renderProbeText(items: GraphProbeItem[], language: GraphLanguage, provider: string): string {
  const ok = items.filter((item) => item.status === 'ok').length;
  return `Graph probe (${language}, ${provider}): ${ok}/${items.length} countable.`;
}

function renderSchemaText(result: GraphSchemaResult, stale: boolean, language: GraphLanguage = 'dql', provider: string = GRAPH_PROVIDER): string {
  const suffix = stale ? ' (stale cache)' : '';
  if (result.view === 'types') return `Graph schema types (${language}, ${provider}): ${result.types.length} type(s)${suffix}.`;
  if (result.view === 'fields') {
    const trunc = (result as { truncated?: boolean }).truncated === true ? `, truncated to ${GRAPH_SCHEMA_SEARCH_CAP}; narrow with view 'fields' + type name` : '';
    return `Graph schema fields (${language}, ${provider}): ${result.fields.length} field(s)${suffix}${trunc}.`;
  }
  if (result.view === 'search') {
    const trunc = (result as { truncated?: boolean }).truncated === true ? `, truncated to ${GRAPH_SCHEMA_SEARCH_CAP}; narrow with view 'search' and a more specific query` : '';
    return `Graph schema search (${language}, ${provider}): ${result.matches.length} match(es)${suffix}${trunc}.`;
  }
  return `Graph schema describe (${language}, ${provider}): ${result.name}${suffix}.`;
}

export async function callGraphTool(
  args: Record<string, unknown>,
  options: GraphToolOptions = {},
): Promise<BackendCallResult> {
  const env = options.env ?? process.env;
  const normalized: Record<string, unknown> = { ...args };
  if (normalized.language === undefined) normalized.language = 'dql';
  const validated = validateGraphRequest(normalized);
  if (!validated.ok) {
    const scope = scopeFor(normalized.language);
    const data = normalized.action === 'probe'
      ? ({ kind: 'probe', items: [] } as GraphData)
      : queryPlaceholder();
    const envelope = errorEnvelope(toGraphError(validated.code, validated.message, false, scope.provider), data, scope.language, scope.provider);
    return textResult(wrapUntrustedText(`Graph ${validated.code}: ${validated.message}`, { source: 'graph' }), {
      action: 'graph', language: scope.language, graph: envelope,
    });
  }
  const input = validated.input;
  if (GRAPH_LANGUAGE_ADAPTERS[input.language] === undefined || !GRAPH_LANGUAGES.includes(input.language)) {
    const envelope = errorEnvelope(toGraphError('unsupported_option', `No configured adapter for language '${input.language}'.`, false, GRAPH_PROVIDER), queryPlaceholder());
    return textResult(wrapUntrustedText('Graph unsupported_option: no configured adapter.', { source: 'graph' }), {
      action: 'graph', language: input.language, graph: envelope,
    });
  }
  const ctx = {
    token: tokenFrom(env),
    ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  };

  // Query narrows by language: DQL keeps pageSize/cursor pagination, SPARQL
  // carries neither (contract rejects them) and returns one bounded response.
  if (input.action === 'query') {
    if (input.language === 'sparql') return sparqlQuery(input.query, env, ctx, options);
    return graphQuery(input.query, input.pageSize, input.cursor, ctx);
  }
  if (input.action === 'probe') {
    if (input.language === 'sparql') return sparqlProbe(input.queries, env, ctx, options);
    return graphProbe(input.queries, ctx);
  }
  if (input.language === 'sparql') return sparqlSchema(input.view, input.name, input.query, input.includeDeprecated, env, ctx, options);
  return graphSchema(input.view, input.name, input.query, input.includeDeprecated, ctx, options.cachePath ?? DEFAULT_GRAPH_ONTOLOGY_CACHE_PATH);
}

interface GraphQueryCtx {
  token: string;
  fetchFn?: (options: DiffbotFetchOptions) => Promise<unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

async function graphQuery(
  query: string, pageSize: number, cursor: string | undefined, ctx: GraphQueryCtx,
): Promise<BackendCallResult> {
  const fingerprint = fingerprintGraphRequest({ action: 'query', language: 'dql', query, pageSize });
  let from = 0;
  if (cursor !== undefined) {
    let decoded;
    try {
      decoded = decodeGraphCursor(cursor);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid cursor.';
      const envelope = errorEnvelope(toGraphError('cursor_invalid', message, false, GRAPH_PROVIDER), queryPlaceholder());
      return textResult(wrapUntrustedText(`Graph cursor_invalid: ${message}`, { source: 'graph' }), {
        action: 'query', language: 'dql', graph: envelope,
      });
    }
    const stateFrom = decoded.state.from;
    const bindingsOk = decoded.provider === GRAPH_PROVIDER
      && decoded.action === 'query'
      && decoded.language === 'dql'
      && decoded.adapterCursorV === GRAPH_ADAPTER_V
      && decoded.pageSize === pageSize
      && decoded.fingerprint === fingerprint
      && typeof stateFrom === 'number'
      && Number.isInteger(stateFrom)
      && stateFrom >= 0
      && stateFrom <= GRAPH_MAX_FROM;
    if (!bindingsOk) {
      const envelope = errorEnvelope(toGraphError('cursor_invalid', 'Cursor does not match this query, page size, or provider request.', false, GRAPH_PROVIDER), queryPlaceholder());
      return textResult(wrapUntrustedText('Graph cursor_invalid: cursor does not match this request.', { source: 'graph' }), {
        action: 'query', language: 'dql', graph: envelope,
      });
    }
    from = stateFrom as number;
  }
  const outcome = await queryDiffbotGraph({ query, pageSize, from }, ctx);
  if (outcome.error) {
    const envelope = errorEnvelope(outcome.error, queryPlaceholder());
    return textResult(wrapUntrustedText(`Graph ${outcome.error.code}: ${outcome.error.message}`, { source: 'graph' }), {
      action: 'query', language: 'dql', graph: envelope,
    });
  }
  const data: GraphData = { kind: 'query', shape: outcome.shape!, result: outcome.result! };
  const hasMore = outcome.pagination?.hasMore ?? false;
  const nextFrom = outcome.pagination?.nextFrom;
  // Depth guard: a cursor past GRAPH_MAX_FROM would be rejected on redisplay,
  // so never emit it — report the page as terminal with a note instead.
  const canContinue = hasMore && nextFrom !== undefined && nextFrom <= GRAPH_MAX_FROM;
  const pagination = canContinue
    ? {
      hasMore: true,
      nextCursor: encodeGraphCursor({
        provider: GRAPH_PROVIDER, fingerprint, adapterCursorV: GRAPH_ADAPTER_V,
        action: 'query', language: 'dql', pageSize, state: { from: nextFrom },
      }),
    }
    : { hasMore: false };
  const notes = hasMore && !canContinue ? ['Pagination depth limit reached.'] : [];
  const count = rowCount(outcome.result!);
  const status: GraphStatus = data.shape === 'rows' && count === 0 ? 'empty' : 'ok';
  const envelope = buildGraphResult({ status, language: 'dql', provider: GRAPH_PROVIDER, data, pagination, errors: [], notes });
  return textResult(wrapUntrustedText(renderQueryText({ language: 'dql', provider: GRAPH_PROVIDER, shape: data.shape, result: outcome.result!, hasMore: canContinue }), { source: 'graph' }), {
    action: 'query', language: 'dql', graph: envelope,
  });
}

async function graphProbe(queries: string[], ctx: GraphQueryCtx): Promise<BackendCallResult> {
  const outcome = await probeDiffbotGraph({ queries }, ctx);
  const items: GraphProbeItem[] = outcome.items.map((item) =>
    item.status === 'ok' ? { query: item.query, status: 'ok' as const, hits: item.hits } : { query: item.query, status: 'error' as const, error: item.error },
  );
  const errors: GraphError[] = items.flatMap((item) => (item.status === 'error' ? [item.error] : []));
  const status: GraphStatus = errors.length === 0 ? 'ok' : errors.length === items.length ? 'error' : 'partial';
  const envelope = buildGraphResult({
    status, language: 'dql', provider: GRAPH_PROVIDER,
    data: { kind: 'probe', items }, errors, notes: [],
  });
  return textResult(wrapUntrustedText(renderProbeText(items, 'dql', GRAPH_PROVIDER), { source: 'graph' }), {
    action: 'probe', language: 'dql', graph: envelope,
  });
}

// ── SPARQL adapter dispatch (operator endpoint, SELECT/ASK only) ──

interface SparqlEndpoint {
  endpoint: string;
  token: string;
}

/** Resolve the operator SPARQL endpoint from test overrides or env config.
 *  The endpoint URL is env-only, never model input; the token stays opaque. */
function resolveSparqlEndpoint(
  env: Record<string, string | undefined>,
  options: GraphToolOptions,
): { ok: true; endpoint: SparqlEndpoint } | { ok: false; error: GraphError } {
  if (options.sparqlEndpoint !== undefined) {
    const endpoint = options.sparqlEndpoint.trim();
    if (endpoint.length === 0) {
      return { ok: false, error: toGraphError('auth_required', 'SPARQL endpoint is not configured.', false, SPARQL_PROVIDER) };
    }
    return { ok: true, endpoint: { endpoint, token: resolveSparqlConfig(env).token ?? '' } };
  }
  const resolved = resolveSparqlConfig(env);
  if (!resolved.configured || resolved.endpoint === undefined) {
    const message = resolved.error?.message ?? 'SPARQL endpoint is not configured: set GRAPH_SPARQL_ENDPOINT.';
    const code = resolved.error !== undefined ? 'unsupported_option' : 'auth_required';
    return { ok: false, error: toGraphError(code, message, false, SPARQL_PROVIDER) };
  }
  return { ok: true, endpoint: { endpoint: resolved.endpoint, token: resolved.token ?? '' } };
}

function sparqlAdapterContext(ctx: GraphQueryCtx, token: string): { token: string; signal?: AbortSignal; timeoutMs?: number } {
  return {
    token,
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
  };
}

function sparqlAdapterOptions(
  endpoint: SparqlEndpoint,
  ctx: GraphQueryCtx,
  options: GraphToolOptions,
): { endpoint: string; fetchFn?: SparqlFetchFn; timeoutMs?: number } {
  return {
    endpoint: endpoint.endpoint,
    ...(options.sparqlFetchFn !== undefined ? { fetchFn: options.sparqlFetchFn } : {}),
    ...(ctx.timeoutMs ?? options.timeoutMs ? { timeoutMs: (ctx.timeoutMs ?? options.timeoutMs) as number } : {}),
  };
}

/** SPARQL query: one bounded response, no cursor. pageSize/cursor never reach
 *  here — the contract rejects them before dispatch. */
async function sparqlQuery(
  query: string,
  env: Record<string, string | undefined>,
  ctx: GraphQueryCtx,
  options: GraphToolOptions,
): Promise<BackendCallResult> {
  const resolved = resolveSparqlEndpoint(env, options);
  if (!resolved.ok) {
    const envelope = errorEnvelope(resolved.error, queryPlaceholder(), 'sparql', SPARQL_PROVIDER);
    return textResult(wrapUntrustedText(`Graph ${resolved.error.code}: ${resolved.error.message}`, { source: 'graph' }), {
      action: 'query', language: 'sparql', graph: envelope,
    });
  }
  const adapter = createSparqlGraphAdapter(sparqlAdapterOptions(resolved.endpoint, ctx, options));
  const outcome = await adapter.executeQuery(
    { query, pageSize: GRAPH_DEFAULT_PAGE_SIZE, from: 0 },
    sparqlAdapterContext(ctx, resolved.endpoint.token),
  );
  if (outcome.error) {
    const envelope = errorEnvelope(outcome.error, queryPlaceholder(), 'sparql', SPARQL_PROVIDER);
    return textResult(wrapUntrustedText(`Graph ${outcome.error.code}: ${outcome.error.message}`, { source: 'graph' }), {
      action: 'query', language: 'sparql', graph: envelope,
    });
  }
  const data: GraphData = { kind: 'query', shape: outcome.shape!, result: outcome.result! };
  const envelope = buildGraphResult({
    status: 'ok', language: 'sparql', provider: SPARQL_PROVIDER,
    data, pagination: { hasMore: false }, errors: [], notes: [],
  });
  return textResult(wrapUntrustedText(renderQueryText({ language: 'sparql', provider: SPARQL_PROVIDER, shape: data.shape, result: outcome.result!, hasMore: false }), { source: 'graph' }), {
    action: 'query', language: 'sparql', graph: envelope,
  });
}

async function sparqlProbe(
  queries: string[],
  env: Record<string, string | undefined>,
  ctx: GraphQueryCtx,
  options: GraphToolOptions,
): Promise<BackendCallResult> {
  const resolved = resolveSparqlEndpoint(env, options);
  if (!resolved.ok) {
    const envelope = errorEnvelope(resolved.error, { kind: 'probe', items: [] }, 'sparql', SPARQL_PROVIDER);
    return textResult(wrapUntrustedText(`Graph ${resolved.error.code}: ${resolved.error.message}`, { source: 'graph' }), {
      action: 'probe', language: 'sparql', graph: envelope,
    });
  }
  const adapter = createSparqlGraphAdapter(sparqlAdapterOptions(resolved.endpoint, ctx, options));
  const outcome = await adapter.probeCardinality({ queries }, sparqlAdapterContext(ctx, resolved.endpoint.token));
  const items: GraphProbeItem[] = outcome.items.map((item) =>
    item.status === 'ok' ? { query: item.query, status: 'ok' as const, hits: item.hits } : { query: item.query, status: 'error' as const, error: item.error },
  );
  const errors: GraphError[] = items.flatMap((item) => (item.status === 'error' ? [item.error] : []));
  const status: GraphStatus = errors.length === 0 ? 'ok' : errors.length === items.length ? 'error' : 'partial';
  const envelope = buildGraphResult({
    status, language: 'sparql', provider: SPARQL_PROVIDER,
    data: { kind: 'probe', items }, errors, notes: [],
  });
  return textResult(wrapUntrustedText(renderProbeText(items, 'sparql', SPARQL_PROVIDER), { source: 'graph' }), {
    action: 'probe', language: 'sparql', graph: envelope,
  });
}

/** SPARQL schema: fixed bounded discovery queries per view, no file cache. */
async function sparqlSchema(
  view: 'types' | 'fields' | 'search' | 'describe',
  name: string | undefined,
  query: string | undefined,
  _includeDeprecated: boolean | undefined,
  env: Record<string, string | undefined>,
  ctx: GraphQueryCtx,
  options: GraphToolOptions,
): Promise<BackendCallResult> {
  const resolved = resolveSparqlEndpoint(env, options);
  if (!resolved.ok) {
    const envelope = errorEnvelope(resolved.error, emptySchemaData(view, name, query), 'sparql', SPARQL_PROVIDER);
    return textResult(wrapUntrustedText(`Graph ${resolved.error.code}: ${resolved.error.message}`, { source: 'graph' }), {
      action: 'schema', language: 'sparql', graph: envelope,
    });
  }
  const outcome = await fetchSparqlSchemaView(
    {
      action: 'schema', language: 'sparql', view,
      ...(name !== undefined ? { name } : {}),
      ...(query !== undefined ? { query } : {}),
    },
    sparqlAdapterOptions(resolved.endpoint, ctx, options),
    sparqlAdapterContext(ctx, resolved.endpoint.token),
  );
  if (outcome.error || outcome.result === undefined) {
    const error = outcome.error ?? toGraphError('contract_invalid_response', 'SPARQL schema view returned no result.', false, SPARQL_PROVIDER);
    const envelope = errorEnvelope(error, emptySchemaData(view, name, query), 'sparql', SPARQL_PROVIDER);
    return textResult(wrapUntrustedText(`Graph ${error.code}: ${error.message}`, { source: 'graph' }), {
      action: 'schema', language: 'sparql', graph: envelope,
    });
  }
  const truncated = (outcome.result.view === 'fields' || outcome.result.view === 'search')
    && (outcome.result as { truncated?: boolean }).truncated === true;
  const notes = truncated ? [`Schema ${view} truncated; narrow with a more specific selector.`] : [];
  const envelope = buildGraphResult({
    status: truncated ? 'partial' : 'ok', language: 'sparql', provider: SPARQL_PROVIDER,
    data: { kind: 'schema', result: outcome.result }, errors: [], notes,
  });
  return textResult(wrapUntrustedText(renderSchemaText(outcome.result, false, 'sparql', SPARQL_PROVIDER), { source: 'graph' }), {
    action: 'schema', language: 'sparql', graph: envelope,
  });
}

function emptySchemaData(view: string, name?: string, query?: string): GraphData {
  if (view === 'fields') return { kind: 'schema', result: { view: 'fields', ...(name !== undefined ? { type: name } : {}), fields: [] } };
  if (view === 'search') return { kind: 'schema', result: { view: 'search', query: query ?? '', matches: [] } };
  if (view === 'describe') return { kind: 'schema', result: { view: 'describe', name: name ?? '', detail: null } };
  return { kind: 'schema', result: { view: 'types', types: [] } };
}

async function graphSchema(
  view: 'types' | 'fields' | 'search' | 'describe',
  name: string | undefined,
  query: string | undefined,
  includeDeprecated: boolean | undefined,
  ctx: GraphQueryCtx,
  cachePath: string,
): Promise<BackendCallResult> {
  const cached = await readOntologyCacheFile(cachePath);
  const now = Date.now();
  if (cached.ok && ontologyCacheFresh(cached.payload.fetchedAt, now)) {
    return schemaSuccess(view, name, query, includeDeprecated, cached.payload.ontology, cached.payload.fetchedAt, false);
  }
  const fetched = await fetchDiffbotOntology(ctx);
  if (fetched.ontology !== undefined) {
    const payload: OntologyCachePayload = { fetchedAt: new Date().toISOString(), ontology: fetched.ontology };
    await writeOntologyCacheFileAtomic(cachePath, payload).catch(() => undefined);
    return schemaSuccess(view, name, query, includeDeprecated, fetched.ontology, payload.fetchedAt, false);
  }
  if (cached.ok) {
    const mapped = mapOntologyView(view, name, query, includeDeprecated, cached.payload.ontology);
    if (!mapped.ok) {
      const envelope = errorEnvelope(mapped.error, emptySchemaData(view, name, query));
      return textResult(wrapUntrustedText(`Graph ${mapped.error.code}: ${mapped.error.message}`, { source: 'graph' }), {
        action: 'schema', language: 'dql', graph: envelope,
      });
    }
    const truncatedStale = (mapped.result.view === 'fields' || mapped.result.view === 'search') && (mapped.result as { truncated?: boolean }).truncated === true;
    const envelope = buildGraphResult({
      status: 'partial', language: 'dql', provider: GRAPH_PROVIDER,
      data: { kind: 'schema', result: mapped.result, meta: { fetchedAt: cached.payload.fetchedAt, stale: true } },
      errors: [fetched.error!],
      notes: truncatedStale
        ? ['Serving stale cached ontology after retrieval failure.', mapped.result.view === 'search'
          ? `Schema search truncated to ${GRAPH_SCHEMA_SEARCH_CAP} matches; narrow with a more specific query.`
          : `Unscoped fields truncated to ${GRAPH_SCHEMA_SEARCH_CAP} entries; re-query with view 'fields' and a type name for the remaining scoped fields.`]
        : ['Serving stale cached ontology after retrieval failure.'],
    });
    return textResult(wrapUntrustedText(renderSchemaText(mapped.result, true), { source: 'graph' }), {
      action: 'schema', language: 'dql', graph: envelope,
    });
  }
  const envelope = errorEnvelope(fetched.error!, emptySchemaData(view, name, query));
  return textResult(wrapUntrustedText(`Graph ${fetched.error!.code}: ${fetched.error!.message}`, { source: 'graph' }), {
    action: 'schema', language: 'dql', graph: envelope,
  });
}

function schemaSuccess(
  view: 'types' | 'fields' | 'search' | 'describe',
  name: string | undefined,
  query: string | undefined,
  includeDeprecated: boolean | undefined,
  ontology: unknown,
  fetchedAt: string,
  stale: boolean,
): BackendCallResult {
  const mapped = mapOntologyView(view, name, query, includeDeprecated, ontology);
  if (!mapped.ok) {
    const envelope = errorEnvelope(mapped.error, emptySchemaData(view, name, query));
    return textResult(wrapUntrustedText(`Graph ${mapped.error.code}: ${mapped.error.message}`, { source: 'graph' }), {
      action: 'schema', language: 'dql', graph: envelope,
    });
  }
  const truncated = (mapped.result.view === 'fields' || mapped.result.view === 'search') && mapped.result.truncated === true;
  const notes = truncated
    ? [mapped.result.view === 'search'
      ? `Schema search truncated to ${GRAPH_SCHEMA_SEARCH_CAP} matches; narrow with a more specific query.`
      : `Unscoped fields truncated to ${GRAPH_SCHEMA_SEARCH_CAP} entries; re-query with view 'fields' and a type name for the remaining scoped fields.`]
    : [];
  const envelope = buildGraphResult({
    status: truncated ? 'partial' : 'ok', language: 'dql', provider: GRAPH_PROVIDER,
    data: { kind: 'schema', result: mapped.result, meta: { fetchedAt, stale } },
    errors: [], notes,
  });
  return textResult(wrapUntrustedText(renderSchemaText(mapped.result, stale), { source: 'graph' }), {
    action: 'schema', language: 'dql', graph: envelope,
  });
}

type OntologyViewResult = { ok: true; result: GraphSchemaResult } | { ok: false; error: GraphError };

function mapOntologyView(
  view: 'types' | 'fields' | 'search' | 'describe',
  name: string | undefined,
  query: string | undefined,
  includeDeprecated: boolean | undefined,
  ontology: unknown,
): OntologyViewResult {
  if (!isRecord(ontology) || !isRecord(ontology.types)) {
    return { ok: false, error: toGraphError('contract_invalid_response', 'Cached ontology is missing typed type markers.', false, GRAPH_PROVIDER) };
  }
  const types = ontology.types as Record<string, unknown>;
  const keepDeprecated = includeDeprecated === true;
  const typeEntry = (typeName: string): Record<string, unknown> | undefined => {
    if (isRecord(types[typeName])) return types[typeName] as Record<string, unknown>;
    const lower = typeName.toLowerCase();
    for (const key of Object.keys(types)) {
      if (key.toLowerCase() === lower && isRecord(types[key])) return types[key] as Record<string, unknown>;
    }
    return undefined;
  };
  if (view === 'types') {
    const names = Object.keys(types).filter((key) => keepDeprecated || (types[key] as Record<string, unknown>)?.isDeprecated !== true).sort();
    return { ok: true, result: { view: 'types', types: names } };
  }
  if (view === 'fields') {
    if (name !== undefined) {
      const entry = typeEntry(name);
      if (!entry) return { ok: false, error: toGraphError('invalid_input', `Unknown schema type: ${name}`, false, GRAPH_PROVIDER) };
      const typeName = typeof entry.name === 'string' && entry.name.trim().length > 0 ? entry.name : name;
      return { ok: true, result: { view: 'fields', type: typeName, fields: fieldList(entry, keepDeprecated) } };
    }
    // Unscoped: aggregate actual field names across entity types (qualified as
    // Type.field); type names are not fields and must not pose as entries.
    // Bounded by the established schema cap: stop collecting once full so a
    // large ontology cannot force unbounded allocation. Scoped (name) views
    // stay complete; unscoped callers page per type via view 'fields' + name.
    const fields: Array<{ name: string; type?: string; description?: string }> = [];
    let truncated = false;
    for (const key of Object.keys(types).sort()) {
      const entry = types[key];
      if (!isRecord(entry)) continue;
      if (entry.isDeprecated === true && !keepDeprecated) continue;
      for (const field of fieldList(entry, keepDeprecated)) {
        if (fields.length >= GRAPH_SCHEMA_SEARCH_CAP) { truncated = true; break; }
        fields.push({ ...field, name: `${key}.${field.name}` });
      }
      if (truncated) break;
    }
    return { ok: true, result: { view: 'fields', fields, ...(truncated ? { truncated: true as const } : {}) } };
  }
  if (view === 'search') {
    const needle = (query ?? '').toLowerCase();
    const matches: Array<{ name: string; kind?: string; description?: string }> = [];
    for (const key of Object.keys(types).sort()) {
      const entry = types[key];
      if (!isRecord(entry)) continue;
      if (entry.isDeprecated === true && !keepDeprecated) continue;
      if (key.toLowerCase().includes(needle)) matches.push({ name: key, kind: 'type' });
      const fields = isRecord(entry.fields) ? (entry.fields as Record<string, unknown>) : {};
      for (const fieldName of Object.keys(fields).sort()) {
        const field = fields[fieldName] as Record<string, unknown>;
        if (field?.isDeprecated === true && !keepDeprecated) continue;
        const description = typeof field?.description === 'string' ? field.description as string : '';
        if (fieldName.toLowerCase().includes(needle) || description.toLowerCase().includes(needle)) {
          const match: { name: string; kind?: string; description?: string } = { name: `${key}.${fieldName}`, kind: 'field' };
          if (description) match.description = description.slice(0, 500);
          matches.push(match);
        }
        if (matches.length > GRAPH_SCHEMA_SEARCH_CAP) break;
      }
      if (matches.length > GRAPH_SCHEMA_SEARCH_CAP) break;
    }
    const truncated = matches.length > GRAPH_SCHEMA_SEARCH_CAP;
    return { ok: true, result: { view: 'search', query: query ?? '', matches: matches.slice(0, GRAPH_SCHEMA_SEARCH_CAP), ...(truncated ? { truncated: true as const } : {}) } };
  }
  const entry = typeEntry(name!);
  if (entry) {
    const entryName = typeof entry.name === 'string' && entry.name.trim().length > 0 ? entry.name : name!;
    return { ok: true, result: { view: 'describe', name: entryName, detail: entry as unknown as JsonValue } };
  }
  for (const key of Object.keys(types)) {
    const fields = (types[key] as Record<string, unknown>)?.fields;
    if (isRecord(fields) && isRecord(fields[name!])) {
      return { ok: true, result: { view: 'describe', name: name!, detail: { type: key, field: fields[name!] } as unknown as JsonValue } };
    }
  }
  return { ok: false, error: toGraphError('invalid_input', `Unknown schema name: ${name}`, false, GRAPH_PROVIDER) };
}

function fieldList(entry: Record<string, unknown>, keepDeprecated: boolean): Array<{ name: string; type?: string; description?: string }> {
  const fields = isRecord(entry.fields) ? (entry.fields as Record<string, unknown>) : {};
  const out: Array<{ name: string; type?: string; description?: string }> = [];
  for (const key of Object.keys(fields).sort()) {
    const field = fields[key] as Record<string, unknown>;
    if (!isRecord(field)) continue;
    if (field.isDeprecated === true && !keepDeprecated) continue;
    const item: { name: string; type?: string; description?: string } = { name: key };
    if (typeof field.type === 'string') item.type = (field.type as string).slice(0, 128);
    if (typeof field.description === 'string' && (field.description as string).length > 0) {
      item.description = (field.description as string).slice(0, 500);
    }
    out.push(item);
  }
  return out;
}
