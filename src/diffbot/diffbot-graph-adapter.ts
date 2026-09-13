// Diffbot GraphAdapter: thin wrapper over the native Diffbot graph helpers.
// Behavior unchanged: same DQL bodies, pagination cursors (`from` offsets),
// and error taxonomy as direct `diffbot-graph.ts` calls. No query
// translation, no schema-view mapping here (views derive in orchestration).

import {
  fetchDiffbotOntology,
  GRAPH_ADAPTER_V,
  GRAPH_PROVIDER,
  probeDiffbotGraph,
  queryDiffbotGraph,
  type DiffbotGraphContext,
} from './diffbot-graph.js';
import type { DiffbotFetchOptions } from './diffbot-transport.js';
import type {
  GraphAdapter,
  GraphAdapterContext,
  GraphAdapterFetchOptions,
  GraphAdapterProbeInput,
  GraphAdapterProbeOutcome,
  GraphAdapterQueryInput,
  GraphAdapterQueryOutcome,
  GraphAdapterSchemaSnapshotOutcome,
} from '../graph/graph-adapter.js';

function toDiffbotContext(ctx: GraphAdapterContext): DiffbotGraphContext {
  const fetchFn = ctx.fetchFn === undefined
    ? undefined
    : (options: DiffbotFetchOptions): Promise<unknown> => {
      const adapted: GraphAdapterFetchOptions = {
        host: String(options.host),
        path: options.path,
        method: options.method ?? 'GET',
        token: options.token,
        ...(options.body !== undefined ? { body: options.body } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      };
      return ctx.fetchFn!(adapted);
    };
  return {
    token: ctx.token,
    ...(fetchFn !== undefined ? { fetchFn } : {}),
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
  };
}

export const diffbotGraphAdapter: GraphAdapter = {
  language: 'dql',
  provider: GRAPH_PROVIDER,
  adapterCursorV: GRAPH_ADAPTER_V,

  executeQuery(input: GraphAdapterQueryInput, ctx: GraphAdapterContext): Promise<GraphAdapterQueryOutcome> {
    return queryDiffbotGraph(
      { query: input.query, pageSize: input.pageSize, from: input.from },
      toDiffbotContext(ctx),
    );
  },

  probeCardinality(input: GraphAdapterProbeInput, ctx: GraphAdapterContext): Promise<GraphAdapterProbeOutcome> {
    return probeDiffbotGraph({ queries: input.queries }, toDiffbotContext(ctx));
  },

  async fetchSchemaSnapshot(ctx: GraphAdapterContext): Promise<GraphAdapterSchemaSnapshotOutcome> {
    const outcome = await fetchDiffbotOntology(toDiffbotContext(ctx));
    if (outcome.error !== undefined) return { provider: outcome.provider, error: outcome.error };
    if (outcome.ontology === undefined) return { provider: outcome.provider };
    return { provider: outcome.provider, snapshot: outcome.ontology };
  },
};
