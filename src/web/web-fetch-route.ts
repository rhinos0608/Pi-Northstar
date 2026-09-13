import { DEFAULT_WEB_READ_MAX_CHARS } from './web-contract.js';

export interface FetchReadParams {
  mode: 'read';
  url: string;
  maxChars?: number;
}

export interface FetchCrawlUrlParams {
  mode: 'crawl';
  source: { type: 'url'; url: string; followLinks?: boolean };
  query: string;
  topK?: number;
  maxPages?: number;
  maxChars?: number;
}

export interface FetchCrawlSearchParams {
  mode: 'crawl';
  source: { type: 'search'; searchQuery: string };
  query: string;
  topK?: number;
  maxPages?: number;
  maxChars?: number;
}

export interface FetchBatchReadParams {
  mode: 'batch_read';
  urls: string[];
  maxChars?: number;
}

export interface FetchBatchCrawlParams {
  mode: 'batch_crawl';
  urls: string[];
  query: string;
  topK?: number;
  maxPages?: number;
  maxChars?: number;
}

export interface FetchSitemapParams {
  mode: 'sitemap';
  url: string;
  siteMap: true;
  query?: string;
  maxPages?: number;
}

export interface FetchRetrieveParams {
  mode: 'retrieve';
  responseId: string;
  sourceIds?: string[];
  offset?: number;
  limit?: number;
  findText?: string;
}

export interface FetchSourceCheckParams {
  mode: 'source_check';
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

const FETCH_MODES = [
  'read',
  'crawl',
  'batch_read',
  'batch_crawl',
  'sitemap',
  'retrieve',
  'source_check',
] as const;

const FETCH_MODE_ERROR =
  'mode must be one of: read, crawl, batch_read, batch_crawl, sitemap, retrieve, source_check';
const FETCH_EXPLICIT_MODE_ERROR =
  'fetch requires explicit mode: read, crawl, batch_read, batch_crawl, sitemap, retrieve, or source_check';
const FETCH_CRAWL_SOURCE_ERROR = 'crawl source.type must be one of: url, search';

function requireNonEmptyString(record: Record<string, unknown>, key: string, message: string): string {
  const value: unknown = record[key];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(message);
  return value.trim();
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value: unknown = record[key];
  return typeof value === 'number' ? value : undefined;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value: unknown = record[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function requireUrls(record: Record<string, unknown>, mode: string): string[] {
  const value: unknown = record['urls'];
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 8 ||
    value.some((entry: unknown) => typeof entry !== 'string' || (entry as string).trim() === '')
  ) {
    throw new Error(`${mode} requires urls[1..8]`);
  }
  return (value as string[]).map((entry) => (entry as string).trim());
}

function requireClaims(record: Record<string, unknown>): string[] {
  const value: unknown = record['claims'];
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new Error('source_check requires claims[1..20]');
  }
  return value as string[];
}

function requireSourceIds(record: Record<string, unknown>): string[] | undefined {
  const value: unknown = record['sourceIds'];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('sourceIds must be an array');
  return value as string[];
}

/**
 * Total router over unknown input: every branch validates its own required
 * fields explicitly and unknown modes/sources reject. No discriminant casts
 * happen before validation — each branch builds a fresh typed params object
 * from the validated record.
 */
export function buildFetchRoute(params: FetchRouteParams): FetchRoute {
  if (!isRecord(params)) throw new Error(FETCH_EXPLICIT_MODE_ERROR);
  const record: Record<string, unknown> = params;
  const mode: unknown = record['mode'];
  if (mode === undefined) throw new Error(FETCH_EXPLICIT_MODE_ERROR);
  if (typeof mode !== 'string' || !(FETCH_MODES as readonly string[]).includes(mode)) {
    throw new Error(FETCH_MODE_ERROR);
  }
  switch (mode) {
    case 'read': {
      const url = requireNonEmptyString(record, 'url', 'read requires url');
      const maxChars = optionalNumber(record, 'maxChars');
      return buildReadFetchRoute({ mode: 'read', url, ...(maxChars !== undefined ? { maxChars } : {}) });
    }
    case 'crawl': {
      const query = requireNonEmptyString(record, 'query', 'crawl requires query');
      const source: unknown = record['source'];
      if (!isRecord(source)) throw new Error(FETCH_CRAWL_SOURCE_ERROR);
      const sourceType: unknown = source['type'];
      if (sourceType === 'url') {
        const url = requireNonEmptyString(source, 'url', 'crawl source url requires url');
        const followLinks = source['followLinks'] === true ? true : undefined;
        const topK = optionalNumber(record, 'topK');
        const maxPages = optionalNumber(record, 'maxPages');
        const maxChars = optionalNumber(record, 'maxChars');
        return buildCrawlUrlFetchRoute({
          mode: 'crawl',
          source: { type: 'url', url, ...(followLinks !== undefined ? { followLinks } : {}) },
          query,
          ...(topK !== undefined ? { topK } : {}),
          ...(maxPages !== undefined ? { maxPages } : {}),
          ...(maxChars !== undefined ? { maxChars } : {}),
        });
      }
      if (sourceType === 'search') {
        const searchQuery = requireNonEmptyString(source, 'searchQuery', 'crawl source search requires searchQuery');
        const topK = optionalNumber(record, 'topK');
        const maxPages = optionalNumber(record, 'maxPages');
        const maxChars = optionalNumber(record, 'maxChars');
        return buildCrawlSearchFetchRoute({
          mode: 'crawl',
          source: { type: 'search', searchQuery },
          query,
          ...(topK !== undefined ? { topK } : {}),
          ...(maxPages !== undefined ? { maxPages } : {}),
          ...(maxChars !== undefined ? { maxChars } : {}),
        });
      }
      throw new Error(FETCH_CRAWL_SOURCE_ERROR);
    }
    case 'batch_read': {
      const urls = requireUrls(record, 'batch_read');
      const maxChars = optionalNumber(record, 'maxChars');
      return buildBatchReadFetchRoute({ mode: 'batch_read', urls, ...(maxChars !== undefined ? { maxChars } : {}) });
    }
    case 'batch_crawl': {
      const urls = requireUrls(record, 'batch_crawl');
      const query = requireNonEmptyString(record, 'query', 'batch_crawl requires query');
      const topK = optionalNumber(record, 'topK');
      const maxPages = optionalNumber(record, 'maxPages');
      const maxChars = optionalNumber(record, 'maxChars');
      return buildBatchCrawlFetchRoute({
        mode: 'batch_crawl',
        urls,
        query,
        ...(topK !== undefined ? { topK } : {}),
        ...(maxPages !== undefined ? { maxPages } : {}),
        ...(maxChars !== undefined ? { maxChars } : {}),
      });
    }
    case 'sitemap': {
      const url = requireNonEmptyString(record, 'url', 'sitemap requires url');
      const query = optionalString(record, 'query');
      const maxPages = optionalNumber(record, 'maxPages');
      return buildSitemapFetchRoute({
        mode: 'sitemap',
        url,
        siteMap: true,
        ...(query !== undefined ? { query } : {}),
        ...(maxPages !== undefined ? { maxPages } : {}),
      });
    }
    case 'retrieve': {
      const responseId = requireNonEmptyString(record, 'responseId', 'retrieve requires responseId');
      const sourceIds = requireSourceIds(record);
      const offset = optionalNumber(record, 'offset');
      const limit = optionalNumber(record, 'limit');
      const findText = optionalString(record, 'findText');
      return buildRetrieveFetchRoute({
        mode: 'retrieve',
        responseId,
        ...(sourceIds !== undefined ? { sourceIds } : {}),
        ...(offset !== undefined ? { offset } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(findText !== undefined ? { findText } : {}),
      });
    }
    case 'source_check': {
      const responseId = requireNonEmptyString(record, 'responseId', 'source_check requires responseId');
      const claims = requireClaims(record);
      const sourceIds = requireSourceIds(record);
      return buildSourceCheckFetchRoute({
        mode: 'source_check',
        responseId,
        claims,
        ...(sourceIds !== undefined ? { sourceIds } : {}),
      });
    }
    default:
      throw new Error(FETCH_MODE_ERROR);
  }
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
