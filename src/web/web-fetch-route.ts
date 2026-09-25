import { DEFAULT_WEB_READ_MAX_CHARS, isFetchMode, type FetchMode } from './web-contract.js';
import { requireAnswerPrompt } from './page-query.js';

// Five-branch fetch union with read modes on the URL branches.
// Single/multi accept an optional read mode: readable (default: readability
// extract via the canonical path), raw (raw HTTP text body: direct HTTP,
// no readability/Jina/Diffbot/specializers; executor gates text/*+json/xml,
// 5MB cap, utf-8 default, preserves non-2xx bodies+status, skips data-URI
// sanitize; SSRF/DNS guards stay on), answer (nested-model Q&A: prompt
// required, full raw extract kept in the responseId store for provenance).
// Every branch validates its own required fields explicitly; legacy
// discriminants (action/source/searchQuery/followLinks/maxDepth) and
// filesystem paths reject before any public Pi dispatch. Local video remains a
// separate operator/native command seam and is not model-addressable here.

export interface FetchSingleParams {
  /** Single URL, optional query/topK for the read-query path. */
  url: string;
  query?: string;
  topK?: number;
  maxChars?: number;
  /** Read mode: readable (default), raw (exact HTTP), answer (page Q&A). */
  mode?: FetchMode;
  /** Answer-mode question (required iff mode is answer, forbidden otherwise). */
  prompt?: string;
}

export interface FetchMultiParams {
  /** Multiple URLs (1..8) in input order, optional query/topK. No maxPages. */
  urls: string[];
  query?: string;
  topK?: number;
  maxChars?: number;
  /** Read mode: readable (default), raw (exact HTTP), answer (page Q&A). */
  mode?: FetchMode;
  /** Answer-mode question (required iff mode is answer, forbidden otherwise). */
  prompt?: string;
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

function buildReadQueryFetchRoute(params: { url: string; query?: string; topK?: number; maxChars?: number; mode?: FetchMode; prompt?: string }): FetchRoute {
  const answer = params.mode === 'answer';
  return {
    tool: 'fetch',
    args: {
      url: params.url.trim(),
      ...(params.query !== undefined ? { query: params.query } : {}),
      ...(params.topK !== undefined ? { topK: params.topK } : {}),
      ...(params.maxChars !== undefined ? { maxChars: params.maxChars } : {}),
      ...(params.mode !== undefined ? { mode: params.mode } : {}),
      ...(params.prompt !== undefined ? { prompt: params.prompt } : {}),
    },
    // Answer fans out to a nested model call after the page read.
    timeout: answer ? 180_000 : 120_000,
  };
}

function buildMultiFetchRoute(params: { urls: string[]; query?: string; topK?: number; maxChars?: number; mode?: FetchMode; prompt?: string }): FetchRoute {
  const answer = params.mode === 'answer';
  return { tool: 'fetch', args: { urls: params.urls, ...(params.query !== undefined ? { query: params.query } : {}), ...(params.topK !== undefined ? { topK: params.topK } : {}), ...(params.maxChars !== undefined ? { maxChars: params.maxChars } : {}), ...(params.mode !== undefined ? { mode: params.mode } : {}), ...(params.prompt !== undefined ? { prompt: params.prompt } : {}) }, timeout: answer ? 180_000 : 120_000 };
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

const FETCH_LEGACY_KEYS = ['action', 'source', 'searchQuery', 'followLinks', 'maxDepth'] as const;

function requireNonEmptyString(record: Record<string, unknown>, key: string, message: string): string {
  const value: unknown = record[key];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(message);
  return value.trim();
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value: unknown = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function requireTopK(record: Record<string, unknown>): number | undefined {
  const value: unknown = record['topK'];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 20) {
    throw new Error('topK must be an integer 1..20');
  }
  return value;
}

function requireMaxChars(record: Record<string, unknown>): number | undefined {
  const value: unknown = record['maxChars'];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 50000) {
    throw new Error('maxChars must be an integer 1..50000');
  }
  return value;
}

function requireMaxPages(record: Record<string, unknown>): number | undefined {
  const value: unknown = record['maxPages'];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 25) {
    throw new Error('maxPages must be an integer 1..25');
  }
  return value;
}

function requireOffset(record: Record<string, unknown>): number | undefined {
  const value: unknown = record['offset'];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error('offset must be a non-negative integer');
  }
  return value;
}

function requireLimit(record: Record<string, unknown>): number | undefined {
  const value: unknown = record['limit'];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 50000) {
    throw new Error('limit must be an integer 1..50000');
  }
  return value;
}

/** Read mode for the URL branches. Absent means readable. */
function requireFetchMode(record: Record<string, unknown>): FetchMode | undefined {
  const value: unknown = record['mode'];
  if (value === undefined) return undefined;
  if (!isFetchMode(value)) throw new Error('fetch mode must be one of readable|raw|answer');
  return value;
}

/**
 * Mutual-exclusion guards for the read modes (reject, never silently drop):
 * answer requires prompt and forbids the read-query rankers (query/topK:
 * prompt is the question); raw bypasses readability and forbids query/topK plus
 * prompt; non-answer modes forbid prompt. Per-call answerModel is removed:
 * any answerModel value rejects on every branch (unknown-key check fires
 * first; this guard stays as defense-in-depth). There are no other
 * auth/model fields on fetch: answer auth resolves server-side
 * (ModelRuntime auth.json, never .env keys). Returns validated mode/prompt
 * to forward.
 */
export function requireReadModeFields(
  record: Record<string, unknown>,
  branch: string,
  makeError: (message: string) => Error = (message) => new Error(message),
): { mode?: FetchMode; prompt?: string } {
  const mode = requireFetchMode(record);
  if (record['answerModel'] !== undefined) throw makeError(`fetch ${branch} rejects 'answerModel': quick-investigate reuses the session model; per-call override removed`);
  const hasPrompt = record['prompt'] !== undefined;
  const hasQuery = record['query'] !== undefined;
  const hasTopK = record['topK'] !== undefined;
  const hasMaxChars = record['maxChars'] !== undefined;
  if (mode === 'answer') {
    if (hasQuery) throw makeError(`fetch ${branch} answer rejects 'query': prompt is the question`);
    if (hasTopK) throw makeError(`fetch ${branch} answer rejects 'topK': prompt is the question`);
    if (hasMaxChars) throw makeError(`fetch ${branch} answer rejects 'maxChars': answer mode budgets evidence from the active model context`);
    const prompt = requireAnswerPrompt(record['prompt']);
    return { mode, prompt };
  }
  if (mode === 'raw') {
    if (hasQuery) throw makeError(`fetch ${branch} raw rejects 'query': raw returns the admitted HTTP text body directly`);
    if (hasTopK) throw makeError(`fetch ${branch} raw rejects 'topK': raw returns the admitted HTTP text body directly`);
    if (hasMaxChars) throw makeError(`fetch ${branch} raw rejects 'maxChars': raw uses the fixed byte ceiling before UTF-8 decoding`);
    if (hasPrompt) throw makeError(`fetch ${branch} raw rejects 'prompt': prompt needs mode:"answer"`);
    return { mode };
  }
  if (hasPrompt) throw makeError(`fetch ${branch} rejects 'prompt': prompt needs mode:"answer"`);
  return mode === undefined ? {} : { mode };
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
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error('claims must contain non-empty strings');
    }
    out.push(entry.trim());
  }
  return out;
}

function requireSourceIds(record: Record<string, unknown>): string[] | undefined {
  const value: unknown = record['sourceIds'];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('sourceIds must be an array');
  if (value.length > 32) throw new Error('sourceIds must contain at most 32 entries');
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error('sourceIds entries must be non-empty strings');
    }
    out.push(entry.trim());
  }
  return out;
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
      throw new Error(`fetch no longer accepts '${key}': use one flat request family {url}|{urls}|{url,siteMap:true}|{responseId}|{responseId,claims}`);
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
    const offset = requireOffset(record);
    const limit = requireLimit(record);
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
    const maxPages = requireMaxPages(record);
    return buildSitemapFetchRoute({
      url,
      siteMap: true,
      ...(query !== undefined ? { query } : {}),
      ...(maxPages !== undefined ? { maxPages } : {}),
    });
  }
  if (hasUrls(record)) {
    if (hasUrlKey(record)) throw new Error('fetch accepts either url or urls[1..8], not both');
    rejectUnknownKeys(record, ['urls', 'query', 'topK', 'maxChars', 'mode', 'prompt'], 'multi');
    const urls = requireUrls(record);
    for (const url of urls) {
      if (!/^https?:\/\//i.test(url)) {
        throw new Error("fetch url must be an HTTP(S) or GitHub asset URL, got unsupported scheme or filesystem path in 'urls'");
      }
    }
    const query = optionalString(record, 'query');
    const topK = requireTopK(record);
    const maxChars = requireMaxChars(record);
    const readMode = requireReadModeFields(record, 'multi');
    return buildMultiFetchRoute({
      urls,
      ...(query !== undefined ? { query } : {}),
      ...(topK !== undefined ? { topK } : {}),
      ...(maxChars !== undefined ? { maxChars } : {}),
      ...readMode,
    });
  }
  if (hasUrlKey(record)) {
    rejectUnknownKeys(record, ['url', 'query', 'topK', 'maxChars', 'mode', 'prompt'], 'read');
    const url = requireHttpUrl(record, 'url', 'fetch requires url or urls[1..8]');
    const query = optionalString(record, 'query');
    const topK = requireTopK(record);
    const maxChars = requireMaxChars(record);
    const readMode = requireReadModeFields(record, 'url');
    return buildReadQueryFetchRoute({
      url,
      ...(query !== undefined ? { query } : {}),
      ...(topK !== undefined ? { topK } : {}),
      ...(maxChars !== undefined ? { maxChars } : {}),
      ...readMode,
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
