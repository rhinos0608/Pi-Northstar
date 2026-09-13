// Provider-neutral graph adapter seam v1: orchestration interface only.
// Adapters execute provider-native query strings verbatim: no query
// translation, no universal AST, no cross-provider rewriting. Probe returns
// portable cardinality (per-query hits). Schema snapshots are raw provider
// payloads; the four portable schema views (types/fields/search/describe)
// are derived by orchestration, never by translation here. No `kg` imports:
// `kg` stays Diffbot-only outside this seam.

import type {
  GraphError,
  GraphLanguage,
  GraphQueryShape,
  JsonValue,
} from './graph-contract.js';

/** Transport-agnostic fetch hook injected by callers (tests, orchestration). */
export interface GraphAdapterFetchOptions {
  host: string;
  path: string;
  method: 'GET' | 'POST';
  token: string;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type GraphAdapterFetchFn = (options: GraphAdapterFetchOptions) => Promise<unknown>;

/** Provider-neutral execution context. Token travels via transport only. */
export interface GraphAdapterContext {
  token: string;
  fetchFn?: GraphAdapterFetchFn;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Native query execution input: `query` is opaque provider-native syntax. */
export interface GraphAdapterQueryInput {
  query: string;
  pageSize: number;
  from: number;
}

export interface GraphAdapterQueryOutcome {
  provider: string;
  shape?: GraphQueryShape;
  result?: JsonValue;
  pagination?: { hasMore: boolean; nextFrom?: number };
  error?: GraphError;
}

export interface GraphAdapterProbeInput {
  queries: string[];
}

export type GraphAdapterProbeItem =
  | { query: string; status: 'ok'; hits: number }
  | { query: string; status: 'error'; error: GraphError };

export interface GraphAdapterProbeOutcome {
  provider: string;
  items: GraphAdapterProbeItem[];
}

/** Raw provider schema snapshot; portable views derive in orchestration. */
export interface GraphAdapterSchemaSnapshotOutcome {
  provider: string;
  snapshot?: JsonValue;
  error?: GraphError;
}

export interface GraphAdapter {
  readonly language: GraphLanguage;
  readonly provider: string;
  readonly adapterCursorV: number;
  executeQuery(input: GraphAdapterQueryInput, ctx: GraphAdapterContext): Promise<GraphAdapterQueryOutcome>;
  probeCardinality(input: GraphAdapterProbeInput, ctx: GraphAdapterContext): Promise<GraphAdapterProbeOutcome>;
  fetchSchemaSnapshot(ctx: GraphAdapterContext): Promise<GraphAdapterSchemaSnapshotOutcome>;
}
