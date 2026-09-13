import { DEFAULT_WEB_READ_MAX_CHARS } from './web-contract.js';

export interface FetchReadParams {
  url: string;
  maxChars?: number;
}

export interface FetchCrawlUrlParams {
  source: { type: 'url'; url: string; followLinks?: boolean };
  query: string;
  topK?: number;
  maxPages?: number;
  maxChars?: number;
}

export interface FetchCrawlSearchParams {
  source: { type: 'search'; searchQuery: string };
  query: string;
  topK?: number;
  maxPages?: number;
  maxChars?: number;
}

export interface FetchBatchReadParams {
  urls: string[];
  maxChars?: number;
}

export interface FetchBatchCrawlParams {
  urls: string[];
  query: string;
  topK?: number;
  maxPages?: number;
  maxChars?: number;
}

export interface FetchSitemapParams {
  url: string;
  siteMap: true;
  query?: string;
  maxPages?: number;
}

export interface FetchRetrieveParams {
  action: 'retrieve';
  responseId: string;
  sourceIds?: string[];
  offset?: number;
  limit?: number;
  findText?: string;
}

export interface FetchSourceCheckParams {
  action: 'source_check';
  responseId: string;
  claims: string[];
  sourceIds?: string[];
}

export type FetchRouteParams =
  | FetchReadParams
  | FetchCrawlUrlParams
  | FetchCrawlSearchParams
  | FetchBatchReadParams
  | FetchBatchCrawlParams
  | FetchSitemapParams
  | FetchRetrieveParams
  | FetchSourceCheckParams;

export interface FetchRoute {
  tool: string;
  args: Record<string, unknown>;
  timeout: number;
}

function buildRetrieveFetchRoute(params: FetchRetrieveParams): FetchRoute {
  if (!params.responseId.trim()) throw new Error('retrieve requires responseId');
  return { tool: 'fetch', args: { action: 'retrieve', responseId: params.responseId, ...(params.sourceIds !== undefined ? { sourceIds: params.sourceIds } : {}), ...(params.offset !== undefined ? { offset: params.offset } : {}), ...(params.limit !== undefined ? { limit: params.limit } : {}), ...(params.findText !== undefined ? { findText: params.findText } : {}) }, timeout: 60_000 };
}

function buildSourceCheckFetchRoute(params: FetchSourceCheckParams): FetchRoute {
  if (!params.responseId.trim()) throw new Error('source_check requires responseId');
  if (params.claims.length < 1 || params.claims.length > 20) throw new Error('source_check requires claims[1..20]');
  return { tool: 'fetch', args: { action: 'source_check', responseId: params.responseId, claims: params.claims, ...(params.sourceIds !== undefined ? { sourceIds: params.sourceIds } : {}) }, timeout: 60_000 };
}

function buildReadFetchRoute(params: FetchReadParams): FetchRoute {
  return {
    tool: 'agentic_browse',
    args: buildBrowseArgs({ url: params.url.trim(), ...(params.maxChars !== undefined ? { maxChars: params.maxChars } : {}) }),
    timeout: 120_000,
  };
}

function buildCrawlUrlFetchRoute(params: FetchCrawlUrlParams): FetchRoute {
  const followLinks = params.source.followLinks === true;
  return {
    tool: 'semantic_crawl',
    args: {
      source: { type: 'url', url: params.source.url.trim() },
      query: params.query,
      topK: params.topK ?? 8,
      maxPages: params.maxPages ?? 10,
      ...(params.maxChars !== undefined ? { maxChars: params.maxChars } : {}),
      ...(followLinks ? { followLinks: true } : {}),
      maxDepth: followLinks ? 3 : 1,
    },
    timeout: 300_000,
  };
}

function buildCrawlSearchFetchRoute(params: FetchCrawlSearchParams): FetchRoute {
  return {
    tool: 'semantic_crawl',
    args: {
      source: { type: 'search', query: params.source.searchQuery.trim(), maxSeedUrls: 8 },
      query: params.query,
      topK: params.topK ?? 8,
      maxPages: params.maxPages ?? 10,
      ...(params.maxChars !== undefined ? { maxChars: params.maxChars } : {}),
      maxDepth: 0,
    },
    timeout: 300_000,
  };
}

function buildBatchReadFetchRoute(params: FetchBatchReadParams): FetchRoute {
  return { tool: 'fetch', args: { urls: params.urls, ...(params.maxChars !== undefined ? { maxChars: params.maxChars } : {}) }, timeout: 120_000 };
}

function buildBatchCrawlFetchRoute(params: FetchBatchCrawlParams): FetchRoute {
  return { tool: 'fetch', args: { urls: params.urls, query: params.query, ...(params.topK !== undefined ? { topK: params.topK } : {}), ...(params.maxPages !== undefined ? { maxPages: params.maxPages } : {}), ...(params.maxChars !== undefined ? { maxChars: params.maxChars } : {}) }, timeout: 120_000 };
}

function buildSitemapFetchRoute(params: FetchSitemapParams): FetchRoute {
  if (!params.url?.trim()) throw new Error('sitemap requires url');
  // Route ceiling sits above the fixed 150s Tavily Map provider bound.
  return {
    tool: 'fetch',
    args: {
      url: params.url.trim(),
      siteMap: true,
      ...(params.query !== undefined ? { query: params.query } : {}),
      ...(params.maxPages !== undefined ? { maxPages: params.maxPages } : {}),
    },
    timeout: 180_000,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function buildFetchRoute(params: FetchRouteParams): FetchRoute {
  if (!isRecord(params)) throw new Error('fetch requires exactly one of: url, urls, source, or url+siteMap:true');
  const action = (params as { action?: unknown }).action;
  if (action !== undefined) {
    if (action === 'retrieve') return buildRetrieveFetchRoute(params as FetchRetrieveParams);
    if (action === 'source_check') return buildSourceCheckFetchRoute(params as FetchSourceCheckParams);
    throw new Error('action must be one of: retrieve, source_check (or omitted)');
  }
  if (isRecord((params as { source?: unknown }).source)) {
    const source = (params as { source: Record<string, unknown> }).source;
    if (source.type === 'url') return buildCrawlUrlFetchRoute(params as FetchCrawlUrlParams);
    if (source.type === 'search') return buildCrawlSearchFetchRoute(params as FetchCrawlSearchParams);
    throw new Error('source type must be one of: url, search');
  }
  if (Array.isArray((params as { urls?: unknown }).urls)) {
    if ((params as { query?: unknown }).query !== undefined) return buildBatchCrawlFetchRoute(params as FetchBatchCrawlParams);
    return buildBatchReadFetchRoute(params as FetchBatchReadParams);
  }
  if ((params as { siteMap?: unknown }).siteMap !== undefined) {
    if ((params as { siteMap?: unknown }).siteMap !== true) throw new Error('siteMap must be true');
    return buildSitemapFetchRoute(params as FetchSitemapParams);
  }
  if ((params as { url?: unknown }).url !== undefined) return buildReadFetchRoute(params as FetchReadParams);
  throw new Error('fetch requires exactly one of: url, urls, source, or url+siteMap:true');
}

export function buildBrowseArgs(params: { url: string; maxChars?: number }): Record<string, unknown> {
  return {
    action: 'read',
    url: params.url,
    maxChars: params.maxChars ?? DEFAULT_WEB_READ_MAX_CHARS,
  };
}

export function buildSemanticSource(url: string | undefined, searchQuery: string | undefined): Record<string, unknown> {
  if (url?.trim()) return { type: 'url', url: url.trim() };
  if (searchQuery?.trim()) return { type: 'search', query: searchQuery.trim(), maxSeedUrls: 8 };

  throw new Error('Provide either url or searchQuery.');
}
