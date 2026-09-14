import { DEFAULT_WEB_READ_MAX_CHARS } from './web-contract.js';

// Mode-free 5-branch fetch union (clean break, no discriminants).
// Every branch validates its own required fields explicitly; legacy
// discriminants (mode/action/source/searchQuery/followLinks/maxDepth) and
// filesystem paths reject before any dispatch.

export interface FetchSingleParams {
  /** Single URL, optional query/topK for the read-query path. */
  url: string;
  query?: string;
  topK?: number;
  maxChars?: number;
}

export interface FetchMultiParams {
  /** Multiple URLs (1..8) in input order, optional query/topK. No maxPages. */
  urls: string[];
  query?: string;
  topK?: number;
  maxChars?: number;
}

export interface FetchSitemapParams {
  url: string;
  siteMap: true;
  query?: string;
  maxPages?: number;
}

export interface FetchRetrieveParams {
  responseId: string;
  sourceIds?: string[];
  offset?: number;
  limit?: number;
  findText?: string;
}

export interface FetchSourceCheckParams {
  responseId: string;
  claims: string[];
  sourceIds?: string[];
}

export type FetchRouteParams =
  | FetchSingleParams
  | FetchMultiParams
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

function buildReadQueryFetchRoute(params: { url: string; query?: string; topK?: number; maxChars?: number }): FetchRoute {
  return {
    tool: 'fetch',
    args: {
      url: params.url.trim(),
      ...(params.query !== undefined ? { query: params.query } : {}),
      ...(params.topK !== undefined ? { topK: params.topK } : {}),
      ...(params.maxChars !== undefined ? { maxChars: params.maxChars } : {}),
    },
    timeout: 120_000,
  };
}

function buildMultiFetchRoute(params: { urls: string[]; query?: string; topK?: number; maxChars?: number }): FetchRoute {
  return { tool: 'fetch', args: { urls: params.urls, ...(params.query !== undefined ? { query: params.query } : {}), ...(params.topK !== undefined ? { topK: params.topK } : {}), ...(params.maxChars !== undefined ? { maxChars: params.maxChars } : {}) }, timeout: 120_000 };
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

const FETCH_LEGACY_KEYS = ['mode', 'action', 'source', 'searchQuery', 'followLinks', 'maxDepth'] as const;

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

/** Key-presence check: an empty/non-string url key still counts as present,
 *  so `{url:'', urls:[...]}` rejects as both-set instead of silently
 *  routing to multi. */
function hasUrlKey(record: Record<string, unknown>): boolean {
  return record['url'] !== undefined;
}

function hasUrls(record: Record<string, unknown>): boolean {
  return record['urls'] !== undefined;
}

function requireUrls(record: Record<string, unknown>): string[] {
  const value: unknown = record['urls'];
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 8 ||
    value.some((entry: unknown) => typeof entry !== 'string' || (entry as string).trim() === '')
  ) {
    throw new Error('fetch requires urls[1..8]');
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

/** HTTP(S)/GitHub asset URLs only; filesystem paths and other schemes reject. */
function requireHttpUrl(record: Record<string, unknown>, key: string, message: string): string {
  const url = requireNonEmptyString(record, key, message);
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`fetch url must be an HTTP(S) or GitHub asset URL, got unsupported scheme or filesystem path in '${key}'`);
  }
  return url;
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], branch: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new Error(`fetch ${branch} rejects field '${key}'`);
  }
}

/**
 * Total router over unknown input: legacy discriminants reject, then exactly
 * one of the five approved branches validates its own fields. No casts happen
 * before validation — each branch builds a fresh typed params object from the
 * validated record.
 */
export function buildFetchRoute(params: FetchRouteParams | Record<string, unknown>): FetchRoute {
  if (!isRecord(params)) throw new Error('fetch request must be an object: pass url, urls[1..8], siteMap, or responseId');
  const record: Record<string, unknown> = params;
  for (const key of FETCH_LEGACY_KEYS) {
    if (record[key] !== undefined) {
      throw new Error(`fetch no longer accepts '${key}': pass a 5-branch union {url}|{urls}|{url,siteMap:true}|{responseId}|{responseId,claims}`);
    }
  }
  // Claim-check branch first: claims present selects it, offset/limit/findText
  // reject with the offending field named.
  if (record['claims'] !== undefined) {
    for (const field of ['offset', 'limit', 'findText'] as const) {
      if (record[field] !== undefined) throw new Error(`fetch source_check rejects '${field}': claim-check serves cached claims only`);
    }
    rejectUnknownKeys(record, ['responseId', 'claims', 'sourceIds'], 'source_check');
    const responseId = requireNonEmptyString(record, 'responseId', 'source_check requires responseId');
    const claims = requireClaims(record);
    const sourceIds = requireSourceIds(record);
    return buildSourceCheckFetchRoute({ responseId, claims, ...(sourceIds !== undefined ? { sourceIds } : {}) });
  }
  if (record['responseId'] !== undefined) {
    rejectUnknownKeys(record, ['responseId', 'sourceIds', 'offset', 'limit', 'findText'], 'retrieve');
    const responseId = requireNonEmptyString(record, 'responseId', 'retrieve requires responseId');
    const sourceIds = requireSourceIds(record);
    const offset = optionalNumber(record, 'offset');
    const limit = optionalNumber(record, 'limit');
    const findText = optionalString(record, 'findText');
    return buildRetrieveFetchRoute({
      responseId,
      ...(sourceIds !== undefined ? { sourceIds } : {}),
      ...(offset !== undefined ? { offset } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(findText !== undefined ? { findText } : {}),
    });
  }
  if (record['siteMap'] !== undefined) {
    if (record['siteMap'] !== true) throw new Error('sitemap requires siteMap:true');
    rejectUnknownKeys(record, ['url', 'siteMap', 'query', 'maxPages'], 'sitemap');
    const url = requireHttpUrl(record, 'url', 'sitemap requires url');
    const query = optionalString(record, 'query');
    const maxPages = optionalNumber(record, 'maxPages');
    return buildSitemapFetchRoute({
      url,
      siteMap: true,
      ...(query !== undefined ? { query } : {}),
      ...(maxPages !== undefined ? { maxPages } : {}),
    });
  }
  if (hasUrls(record)) {
    if (hasUrlKey(record)) throw new Error('fetch accepts either url or urls[1..8], not both');
    rejectUnknownKeys(record, ['urls', 'query', 'topK', 'maxChars'], 'multi');
    const urls = requireUrls(record);
    for (const url of urls) {
      if (!/^https?:\/\//i.test(url)) {
        throw new Error("fetch url must be an HTTP(S) or GitHub asset URL, got unsupported scheme or filesystem path in 'urls'");
      }
    }
    const query = optionalString(record, 'query');
    const topK = optionalNumber(record, 'topK');
    const maxChars = optionalNumber(record, 'maxChars');
    return buildMultiFetchRoute({
      urls,
      ...(query !== undefined ? { query } : {}),
      ...(topK !== undefined ? { topK } : {}),
      ...(maxChars !== undefined ? { maxChars } : {}),
    });
  }
  if (hasUrlKey(record)) {
    rejectUnknownKeys(record, ['url', 'query', 'topK', 'maxChars'], 'read');
    const url = requireHttpUrl(record, 'url', 'fetch requires url or urls[1..8]');
    const query = optionalString(record, 'query');
    const topK = optionalNumber(record, 'topK');
    const maxChars = optionalNumber(record, 'maxChars');
    return buildReadQueryFetchRoute({
      url,
      ...(query !== undefined ? { query } : {}),
      ...(topK !== undefined ? { topK } : {}),
      ...(maxChars !== undefined ? { maxChars } : {}),
    });
  }
  throw new Error('fetch requires one of: url, urls[1..8], siteMap:true with url, responseId, or responseId with claims[1..20]');
}

export function buildBrowseArgs(params: { url: string; maxChars?: number }): Record<string, unknown> {
  return {
    action: 'read',
    url: params.url,
    maxChars: params.maxChars ?? DEFAULT_WEB_READ_MAX_CHARS,
  };
}
