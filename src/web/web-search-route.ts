import { validateWebRequest } from './web-contract.js';

// Model-facing shape: single {query} or batch {queries[1..8]}.
// Cursor/category/source stay field-level value constraints enforced below.
interface SearchFilterFields {
  category?: string | undefined;
  source?: string | undefined;
  yearFrom?: number | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
  knowledge?: { entities?: boolean; facts?: boolean; topics?: boolean; sentiment?: boolean; enhance?: boolean } | undefined;
  includeContent?: boolean | undefined;
  recency?: string | undefined;
  domains?: string[] | undefined;
}

export interface SingleSearchParams extends SearchFilterFields {
  query: string;
  queries?: undefined;
}

export interface BatchSearchParams extends SearchFilterFields {
  queries: string[];
  query?: undefined;
}

export type SearchRouteParams = SingleSearchParams | BatchSearchParams;

export interface SearchRoute {
  tool: string;
  args: Record<string, unknown>;
  timeout: number;
}

interface SearchContractInput {
  action: string;
  query?: string;
  queries?: unknown;
  limit?: number;
  includeContent?: unknown;
  recency?: unknown;
  domains?: unknown;
  yearFrom?: unknown;
  category?: string;
  cursor?: string;
  knowledge?: unknown;
}

function assertSupportedSearchCombination(params: SearchRouteParams): void {
  // Knowledge composition is web-only; reject research/academic combinations
  // before dispatch. Mirrors isResearchCategory in web-contract (not exported;
  // web-contract must stay untouched) so academic cannot slip to the web route
  // where web.ts early-returns an empty envelope and silently drops knowledge.
  if (params.knowledge !== undefined && (params.category === 'research' || params.category === 'academic')) {
    throw new Error(`knowledge is not supported with category "${params.category}"`);
  }
  // Continuation cursors are research-only by contract; reject non-research
  // cursor use before any dispatch.
  if (params.cursor !== undefined && params.category !== 'research') {
    throw new Error('cursor requires category "research"');
  }
  // includeContent/recency/domains refine plain search only: the research
  // backend takes query/source/limit/yearFrom/cursor. Reject research use
  // here so direct route callers fail loudly instead of silent drop.
  if (params.category === 'research' && params.includeContent !== undefined) {
    throw new Error('includeContent is not supported with category "research"');
  }
  if (params.category === 'research' && params.recency !== undefined) {
    throw new Error('recency is not supported with category "research"');
  }
  if (params.category === 'research' && params.domains !== undefined) {
    throw new Error('domains is not supported with category "research"');
  }
  // Source pins one exact research source; non-research callers must not
  // send it (the canonical route would otherwise silently drop it).
  if (params.source !== undefined && params.category !== 'research') {
    throw new Error('source requires category "research"');
  }
}

function buildSearchContractInput(params: SearchRouteParams): SearchContractInput {
  // Per-category caps enforced by the web contract: out-of-range limits reject
  // with invalid_request instead of silently clamping. The contract also owns
  // XOR query|queries, single-query cursor, and search-only field guards.
  const contractInput: SearchContractInput = { action: 'search' };
  if (params.query !== undefined) contractInput.query = params.query;
  if (params.queries !== undefined) contractInput.queries = params.queries;
  if (params.limit !== undefined) contractInput.limit = params.limit;
  if ('includeContent' in params && params.includeContent !== undefined) contractInput.includeContent = params.includeContent;
  if (params.recency !== undefined) contractInput.recency = params.recency;
  if (params.domains !== undefined) contractInput.domains = params.domains;
  if (params.yearFrom !== undefined) contractInput.yearFrom = params.yearFrom;
  if (params.category !== undefined) contractInput.category = params.category;
  // Cursor rides route-level only: the web contract rejects every cursor
  // (research cursors belong to the research adapters). Single-query only.
  if (params.knowledge !== undefined) contractInput.knowledge = params.knowledge;
  return contractInput;
}

const MAX_SEARCH_CURSOR_LENGTH = 4096;

function assertSingleQueryCursor(params: SearchRouteParams): void {
  if (params.cursor !== undefined) {
    if (params.cursor.trim().length === 0) throw new Error('cursor must be a non-empty string when provided');
    if (params.cursor.length > MAX_SEARCH_CURSOR_LENGTH) {
      throw new Error(`cursor exceeds maximum length of ${MAX_SEARCH_CURSOR_LENGTH}`);
    }
    if (params.source === undefined || params.source === 'all') {
      throw new Error('cursor requires one exact research source, not "all"');
    }
    const queryCount = params.queries !== undefined ? params.queries.length : 1;
    if (queryCount !== 1) throw new Error('cursor is only supported with a single query');
  }
}

function buildResearchRoute(params: SearchRouteParams, contractInput: SearchContractInput): SearchRoute {
  const { request } = validateWebRequest({ ...contractInput, limit: contractInput.limit ?? 12 });
  if (request.queries.length !== 1) {
    throw new Error('queries batch is not supported with category "research": pass a single query');
  }
  const single = request.queries[0]!;
  return {
    tool: 'research',
    args: {
      action: 'academic',
      query: single,
      source: params.source ?? 'all',
      limit: request.limit,
      ...(request.yearFrom !== undefined ? { yearFrom: request.yearFrom } : {}),
      ...(params.cursor ? { cursor: params.cursor } : {}),
    },
    timeout: 120_000,
  };
}

function buildCanonicalSearchRoute(params: SearchRouteParams, contractInput: SearchContractInput): SearchRoute {
  const { request } = validateWebRequest(contractInput);
  const single = request.queries.length === 1 ? request.queries[0]! : undefined;
  return {
    tool: 'web_search',
    args: {
      // No provider selection input: backends stay operator-owned
      // (PI_SEARCH_WEB_BACKENDS). Batch order rides the canonical runtime.
      ...(single !== undefined ? { query: single } : { queries: [...request.queries] }),
      limit: request.limit,
      ...(params.category ? { category: params.category } : {}),
      ...(request.includeContent ? { includeContent: true } : {}),
      ...(request.recency !== undefined ? { recency: request.recency } : {}),
      ...(request.domains !== undefined ? { domains: [...request.domains] } : {}),
      ...(request.yearFrom !== undefined ? { yearFrom: request.yearFrom } : {}),
      ...(params.knowledge !== undefined ? { knowledge: params.knowledge } : {}),
    },
    timeout: 120_000,
  };
}

export function buildSearchRoute(params: SearchRouteParams | Record<string, unknown>): SearchRoute {
  const normalized = params as SearchRouteParams & Record<string, unknown>;
  if (normalized.mode !== undefined || normalized.depth !== undefined) {
    throw new Error('web_search no longer supports agent mode or depth; use the agent tool');
  }
  assertSupportedSearchCombination(normalized as SearchRouteParams);
  const contractInput = buildSearchContractInput(normalized as SearchRouteParams);
  assertSingleQueryCursor(normalized as SearchRouteParams);
  if (normalized.category === 'research') {
    return buildResearchRoute(normalized as SearchRouteParams, contractInput);
  }
  return buildCanonicalSearchRoute(normalized as SearchRouteParams, contractInput);
}
