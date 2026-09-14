// Stage 4 web contract: shared web vocabulary, canonical action validation,
// tool-to-action routing, request/limit validation, normalized article
// entities, result-page validation, backend plan ordering, and cursor policy.
//
// This module owns vocabulary and validation only. Backend selection lives in
// the native web/search integrator. Canonical capability data stays in the
// capability registry (src/capabilities.ts); the web channel there advertises
// search/read natively, and crawl arrives via the fetch/semantic path.
//
// Canonical-only contract: unknown action names are rejected with
// unsupported_action before any backend dispatch — no pass-through.
//
// Reject-on-out-of-range choice: schema-visible caps (search limit, research
// limit, topK, maxPages, maxChars, query length) throw invalid_request instead
// of silent clamping. Silent clamping hides caller bugs and makes pagination
// accounting lie; the media/social contracts clamp, but web callers span
// external backends where an unasked-for smaller limit changes billing and
// result composition. Every rejection names the cap.
//
// Dependency-light by design: node:crypto plus the shared SocialError only.
// No child_process, no fetch. URL reachability stays with validateHttpUrl /
// validatePublicHttpUrl at runtime — this contract checks shape only.

import { createHash } from 'node:crypto';
import { SocialError } from '../social/social-contract.js';
import { WEB_PROVIDER_MIN_YEAR_FROM, type WebKnowledgeRequest, type WebProviderRecency } from './web-search-types.js';

// ── Core vocabulary ──

export const WEB_ACTIONS = ['search', 'read', 'crawl'] as const;

export type WebAction = (typeof WEB_ACTIONS)[number];

export type WebAuthTier = 'cookie' | 'anonymous' | 'api_key';

export type WebPaginationMode = 'unsupported';

export type WebBackendQuality = 'full' | 'degraded';

export type WebEntityKind = 'article';

export const WEB_ENTITY_KINDS: ReadonlySet<string> = new Set(['article']);

export function isWebAction(value: unknown): value is WebAction {
  return typeof value === 'string' && (WEB_ACTIONS as readonly string[]).includes(value);
}

function isWebEntityKind(value: unknown): value is WebEntityKind {
  return typeof value === 'string' && WEB_ENTITY_KINDS.has(value);
}

// ── Errors ──
// SocialError is platform-generic; the web channel rides in an untyped slot.
// Alias keeps call sites readable while preserving the single error class.

export type WebError = SocialError;
export { SocialError };

function webError(
  code: 'invalid_request' | 'unsupported_action' | 'cursor_invalid' | 'cursor_mismatch',
  message: string,
  options?: { backend?: string },
): SocialError {
  return new SocialError(code, message, {
    ...(options?.backend !== undefined ? { backend: options.backend } : {}),
  });
}

// ── Canonical actions ──

export function resolveWebAction(action: string): WebAction {
  if (!isWebAction(action)) {
    throw webError('unsupported_action', `Unsupported web action: ${String(action).slice(0, 32)}`);
  }
  return action;
}

/**
 * Route a public tool call to its canonical web action.
 * web_search maps to search; fetch maps to read (the mode-free 5-branch
 * union carries no crawl/read discriminant — query-bearing fetches route
 * through the read-query path). Anything else throws unsupported_action
 * with the tool name echoed capped to 32 chars.
 */
export function resolveWebActionForTool(tool: string, args: Record<string, unknown>): WebAction {
  if (tool === 'web_search') return 'search';
  if (tool === 'fetch') {
    void args;
    return 'read';
  }
  throw webError('unsupported_action', `Unsupported web tool: ${String(tool).slice(0, 32)}`);
}

// ── Limits ──
// Runtime truth mirrors src/native-tools.ts: WEB_SEARCH_LIMIT_MAX=20,
// RESEARCH_LIMIT_MAX=30, SEMANTIC_TOP_K_MAX=20, SEMANTIC_MAX_PAGES_MAX=25.

export const DEFAULT_WEB_SEARCH_LIMIT = 8;
export const WEB_SEARCH_LIMIT_MAX = 20;
export const RESEARCH_SEARCH_LIMIT_MAX = 30;
export const DEFAULT_WEB_CRAWL_TOP_K = 8;
export const WEB_CRAWL_TOP_K_MAX = 20;
export const DEFAULT_WEB_CRAWL_MAX_PAGES = 10;
export const WEB_CRAWL_MAX_PAGES_MAX = 25;
export const DEFAULT_WEB_READ_MAX_CHARS = 30000;
export const WEB_READ_MAX_CHARS_MAX = 50000;
export const MAX_WEB_QUERY_LENGTH = 300;
export const MAX_WEB_URL_LENGTH = 2048;
export const WEB_SEARCH_MAX_BATCH_QUERIES = 8;
export const WEB_SEARCH_MAX_DOMAINS = 32;

/** Canonical model-facing web_search category names (single source of truth).
 *  'video' is a provider-neutral discovery category capped at the plain
 *  search limit (WEB_SEARCH_LIMIT_MAX=20). */
export const SEARCH_CATEGORY_NAMES = [
  'company',
  'research paper',
  'news',
  'pdf',
  'github',
  'tweet',
  'personal site',
  'people',
  'financial report',
  'research',
  'video',
] as const;
const WEB_SEARCH_RECENCIES: readonly string[] = ['day', 'week', 'month', 'year'];

export interface WebRequestInput {
  action: string;
  query?: string;
  queries?: unknown;
  url?: string;
  limit?: number;
  includeContent?: unknown;
  recency?: unknown;
  domains?: unknown;
  yearFrom?: unknown;
  topK?: number;
  maxPages?: number;
  maxChars?: number;
  /** 'research'/'academic' selects the research-category search cap (30). */
  category?: string;
  cursor?: string;
  /**
   * Optional model-facing knowledge request. Validated object with known
   * boolean flags only (entities/facts/topics/sentiment/enhance); at least
   * one true flag required when supplied. Unknown keys, non-boolean values,
   * and all-false objects reject with invalid_request. Environment gate
   * (PI_SEARCH_KG_ENRICHMENT) enforced at runtime, not here.
   */
  knowledge?: unknown;
  mode?: unknown;
}

export interface WebRequest {
  action: WebAction;
  query?: string;
  /** Normalized search queries (XOR query|queries, 1..8). Always set on search. */
  queries: string[];
  /** Cost-gated full content reuse; default false. Search-only. */
  includeContent: boolean;
  /** Optional recency filter; intersects with yearFrom. Search-only. */
  recency?: WebProviderRecency;
  /** Optional domain allow/exclude list ('-host' = exclude). Search-only. */
  domains?: string[];
  /** Optional earliest publication year. Search-only. */
  yearFrom?: number;
  url?: string;
  limit: number;
  topK: number;
  maxPages: number;
  maxChars: number;
  researchCategory: boolean;
  knowledge?: WebKnowledgeRequest;
  agentMode: boolean;
}

function parseAgentMode(value: unknown): boolean {
  if (value === undefined) return false;
  if (value === 'agent') return true;
  throw webError('invalid_request', "mode must be 'agent'");
}

function cleanField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isResearchCategory(category: unknown): boolean {
  return category === 'research' || category === 'academic';
}

const WEB_KNOWLEDGE_KEYS: ReadonlySet<string> = new Set([
  'entities',
  'facts',
  'topics',
  'sentiment',
  'enhance',
]);

/**
 * Validate the optional model-facing knowledge request. Unknown keys and
 * non-boolean values reject with invalid_request; a supplied object needs at
 * least one true flag. Returns undefined when omitted.
 */
function parseWebKnowledge(input: unknown): WebKnowledgeRequest | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw webError('invalid_request', 'knowledge must be an object with boolean flags');
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!WEB_KNOWLEDGE_KEYS.has(key)) {
      throw webError('invalid_request', `unknown knowledge option: ${key.slice(0, 32)}`);
    }
  }
  const out: WebKnowledgeRequest = {};
  for (const key of WEB_KNOWLEDGE_KEYS) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') {
      throw webError('invalid_request', `knowledge.${key} must be a boolean`);
    }
    (out as Record<string, boolean>)[key] = value;
  }
  if (!Object.values(out).some((value) => value === true)) {
    throw webError('invalid_request', 'knowledge requires at least one true flag');
  }
  return out;
}

/**
 * Normalize the XOR query|queries selector. Search-only: non-search actions
 * reject `queries`. Returns 1..8 trimmed queries; query+queries together
 * reject. Length caps mirror single-query rules.
 */
function parseSearchQueries(input: WebRequestInput, action: WebAction, query: string | undefined): string[] {
  const hasQueries = input.queries !== undefined;
  if (action !== 'search') {
    if (hasQueries) throw webError('invalid_request', 'queries is only supported on web search');
    return query !== undefined ? [query] : [];
  }
  if (input.queries !== undefined && input.query !== undefined) {
    throw webError('invalid_request', 'search accepts exactly one of query or queries, not both');
  }
  if (hasQueries) {
    if (!Array.isArray(input.queries)) throw webError('invalid_request', 'queries must be an array of strings');
    const out: string[] = [];
    for (const entry of input.queries) {
      if (typeof entry !== 'string' || entry.trim().length === 0) {
        throw webError('invalid_request', 'queries entries must be non-empty strings');
      }
      const trimmed = entry.trim();
      if (trimmed.length > MAX_WEB_QUERY_LENGTH) {
        throw webError('invalid_request', `query exceeds maximum length of ${MAX_WEB_QUERY_LENGTH}`);
      }
      out.push(trimmed);
    }
    if (out.length < 1 || out.length > WEB_SEARCH_MAX_BATCH_QUERIES) {
      throw webError('invalid_request', `queries must contain 1-${WEB_SEARCH_MAX_BATCH_QUERIES} entries`);
    }
    return out;
  }
  return query !== undefined ? [query] : [];
}

function parseSearchRecency(value: unknown): WebProviderRecency | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !WEB_SEARCH_RECENCIES.includes(value)) {
    throw webError('invalid_request', 'recency must be one of: day, week, month, year');
  }
  return value as WebProviderRecency;
}

function parseSearchDomains(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw webError('invalid_request', 'domains must be an array of hostnames');
  if (value.length > WEB_SEARCH_MAX_DOMAINS) {
    throw webError('invalid_request', `domains must contain at most ${WEB_SEARCH_MAX_DOMAINS} entries`);
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw webError('invalid_request', 'domains entries must be non-empty strings');
    }
    const host = entry.trim().toLowerCase();
    const bare = host.startsWith('-') ? host.slice(1) : host;
    if (bare.length === 0 || bare.length > 253 || !/^[a-z0-9.-]+$/.test(bare)) {
      throw webError('invalid_request', `invalid domains hostname: ${bare.slice(0, 64)}`);
    }
    out.push(host);
  }
  return out;
}

function parseSearchYearFrom(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const currentYear = new Date().getUTCFullYear();
  if (typeof value !== 'number' || !Number.isInteger(value) || value < WEB_PROVIDER_MIN_YEAR_FROM || value > currentYear) {
    throw webError('invalid_request', `yearFrom must be an integer in [${WEB_PROVIDER_MIN_YEAR_FROM}, ${currentYear}]`);
  }
  return value;
}

function resolveBoundedInt(
  raw: unknown,
  field: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
    throw webError('invalid_request', `${field} must be an integer in [${min}, ${max}]`);
  }
  return raw;
}

/**
 * Parse and validate a raw web request: resolve the canonical action, enforce
 * per-action selector requirements and length caps, and bound every numeric
 * field with reject-on-out-of-range. URL values are shape-checked only
 * (non-empty, length-capped); validateHttpUrl/validatePublicHttpUrl own
 * reachability at runtime. Throws SocialError before any backend dispatch.
 */
export function validateWebRequest(input: WebRequestInput): { request: WebRequest; warnings: string[] } {
  const warnings: string[] = [];
  const action = resolveWebAction(input.action);
  const researchCategory = isResearchCategory(input.category);
  const agentMode = parseAgentMode((input as { mode?: unknown }).mode);
  if (agentMode && (input as { knowledge?: unknown }).knowledge !== undefined) {
    throw webError('invalid_request', 'knowledge is not supported with mode "agent"');
  }
  if (agentMode && researchCategory) {
    throw webError('invalid_request', 'mode "agent" is not supported with research categories');
  }
  if (researchCategory && Array.isArray(input.queries) && input.queries.length > 1) {
    throw webError('invalid_request', 'queries batch is not supported with category "research": pass a single query');
  }

  if (input.cursor !== undefined && input.cursor !== null && !(typeof input.cursor === 'string' && input.cursor.length === 0)) {
    const rawQueries = Array.isArray(input.queries) ? input.queries : undefined;
    const queryCount = rawQueries !== undefined ? rawQueries.length : 1;
    if (queryCount !== 1) {
      throw webError('invalid_request', 'cursor is only supported with a single query');
    }
  }
  assertNoWebCursor(input.cursor);

  const query = cleanField(input.query);
  if (typeof input.query === 'string' && query === undefined) {
    throw webError('invalid_request', 'query must be a non-empty string when provided');
  }
  if (query !== undefined && query.length > MAX_WEB_QUERY_LENGTH) {
    throw webError('invalid_request', `query exceeds maximum length of ${MAX_WEB_QUERY_LENGTH}`);
  }

  const url = cleanField(input.url);
  if (typeof input.url === 'string' && url === undefined) {
    throw webError('invalid_request', 'url must be a non-empty string when provided');
  }
  if (url !== undefined && url.length > MAX_WEB_URL_LENGTH) {
    throw webError('invalid_request', `url exceeds maximum length of ${MAX_WEB_URL_LENGTH}`);
  }

  const queries = parseSearchQueries(input, action, query);
  if (action === 'search' && queries.length === 0) {
    throw webError('invalid_request', 'web search requires selector: query');
  }
  if (action === 'read' && url === undefined) {
    throw webError('invalid_request', 'web read requires selector: url');
  }
  if (action === 'crawl' && (url === undefined || query === undefined)) {
    throw webError('invalid_request', 'web crawl requires selectors: url, query');
  }

  // maxChars honored on both page-bearing paths (read and crawl).
  const maxChars = resolveBoundedInt(input.maxChars, 'maxChars', 1, WEB_READ_MAX_CHARS_MAX, DEFAULT_WEB_READ_MAX_CHARS);
  const topK = resolveBoundedInt(input.topK, 'topK', 1, WEB_CRAWL_TOP_K_MAX, DEFAULT_WEB_CRAWL_TOP_K);
  const maxPages = resolveBoundedInt(input.maxPages, 'maxPages', 1, WEB_CRAWL_MAX_PAGES_MAX, DEFAULT_WEB_CRAWL_MAX_PAGES);
  const searchCap = researchCategory ? RESEARCH_SEARCH_LIMIT_MAX : WEB_SEARCH_LIMIT_MAX;
  const limit = resolveBoundedInt(input.limit, 'limit', 1, searchCap, DEFAULT_WEB_SEARCH_LIMIT);

  let includeContent = false;
  if (input.includeContent !== undefined) {
    if (action !== 'search') throw webError('invalid_request', 'includeContent is only supported on web search');
    if (typeof input.includeContent !== 'boolean') {
      throw webError('invalid_request', 'includeContent must be a boolean');
    }
    includeContent = input.includeContent;
  }
  let recency: WebProviderRecency | undefined;
  if (input.recency !== undefined) {
    if (action !== 'search') throw webError('invalid_request', 'recency is only supported on web search');
    recency = parseSearchRecency(input.recency);
  }
  let domains: string[] | undefined;
  if (input.domains !== undefined) {
    if (action !== 'search') throw webError('invalid_request', 'domains is only supported on web search');
    domains = parseSearchDomains(input.domains);
  }
  let yearFrom: number | undefined;
  if (input.yearFrom !== undefined) {
    if (action !== 'search') throw webError('invalid_request', 'yearFrom is only supported on web search');
    yearFrom = parseSearchYearFrom(input.yearFrom);
  }
  const rawKnowledge = (input as { knowledge?: unknown }).knowledge;
  if (rawKnowledge !== undefined && action !== 'search') {
    throw webError('invalid_request', 'knowledge is only supported on web search');
  }
  const knowledge = parseWebKnowledge(rawKnowledge);
  const request: WebRequest = { action, queries, includeContent, limit, topK, maxPages, maxChars, researchCategory, agentMode };
  if (query !== undefined) request.query = query;
  if (url !== undefined) request.url = url;
  if (recency !== undefined) request.recency = recency;
  if (domains !== undefined) request.domains = domains;
  if (yearFrom !== undefined) request.yearFrom = yearFrom;
  if (knowledge !== undefined) request.knowledge = knowledge;
  return { request, warnings };
}

// ── Normalized entities ──
// Sparse 'article' rows for web search results and readable pages: title, url,
// snippet/content excerpt, source/backend. 'work' passthrough for research
// categories is NOT part of this contract — research keeps its own adapters,
// and 'work'-kind payloads are rejected here. backend_text-shaped payloads are
// rejected as unknown-shape (fail-closed).

export interface WebArticleV1 {
  version: 1;
  kind: 'article';
  id: string;
  url: string;
  source: string;
  backend: string;
  title?: string;
  snippet?: string;
  content?: string;
}

export type WebEntityV1 = WebArticleV1;

export const WEB_ENTITY_CONTENT_MAX = 8000;
export const WEB_PAGE_CONTENT_MAX = 60000;

const WEB_ARTICLE_FIELDS: ReadonlySet<string> = new Set([
  'version',
  'kind',
  'id',
  'url',
  'source',
  'backend',
  'title',
  'snippet',
  'content',
]);

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateWebEntity(value: unknown): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, issues: ['entity is not an object'] };
  }
  const entity = value as Record<string, unknown>;
  if (entity.backend_text !== undefined || entity.backendText !== undefined) {
    issues.push('backend_text is not allowed on web paths');
  }
  if (entity.kind === 'work') {
    issues.push("kind 'work' is not part of the web contract; research keeps its own adapters");
    return { ok: false, issues };
  }
  if (!isWebEntityKind(entity.kind)) {
    return { ok: false, issues: [...issues, 'kind is not a valid web entity kind'] };
  }
  if (entity.version !== 1) issues.push('version must be 1');
  if (typeof entity.id !== 'string' || entity.id.trim().length === 0) issues.push('id is required');
  if (typeof entity.url !== 'string' || !isValidHttpUrl(entity.url)) {
    issues.push('url is not a valid http(s) URL');
  }
  if (typeof entity.source !== 'string' || entity.source.trim().length === 0) {
    issues.push('source is required');
  }
  if (typeof entity.backend !== 'string' || entity.backend.trim().length === 0) {
    issues.push('backend is required');
  }
  if (entity.title !== undefined && typeof entity.title !== 'string') issues.push('title must be a string');
  if (entity.snippet !== undefined && typeof entity.snippet !== 'string') {
    issues.push('snippet must be a string');
  }
  if (entity.content !== undefined) {
    if (typeof entity.content !== 'string') {
      issues.push('content must be a string');
    } else if (Buffer.byteLength(entity.content, 'utf8') > WEB_ENTITY_CONTENT_MAX) {
      issues.push(`content exceeds maximum of ${WEB_ENTITY_CONTENT_MAX} bytes (UTF-8)`);
    }
  }
  if (typeof entity.snippet === 'string' && Buffer.byteLength(entity.snippet, 'utf8') > WEB_ENTITY_CONTENT_MAX) {
    issues.push(`snippet exceeds maximum of ${WEB_ENTITY_CONTENT_MAX} bytes (UTF-8)`);
  }
  for (const key of Object.keys(entity)) {
    if (!WEB_ARTICLE_FIELDS.has(key)) issues.push(`${key} is not a known field for kind article`);
  }
  return { ok: issues.length === 0, issues };
}

// ── Result pages ──

export interface WebPageV1 {
  entities: WebEntityV1[];
  pagination: {
    supported: boolean;
    limit: number;
    returned: number;
    hasMore: boolean;
    nextCursor?: string;
  };
  partial: boolean;
  warnings: string[];
}

/** Dedupe entities by url, first-wins. */
export function dedupeWebEntities(entities: WebEntityV1[]): WebEntityV1[] {
  const seen = new Set<string>();
  const out: WebEntityV1[] = [];
  for (const entity of entities) {
    if (seen.has(entity.url)) continue;
    seen.add(entity.url);
    out.push(entity);
  }
  return out;
}

function webEntityTextLength(entity: WebEntityV1): number {
  return Buffer.byteLength(entity.snippet ?? '', 'utf8') + Buffer.byteLength(entity.content ?? '', 'utf8');
}

export function validateWebPage(value: unknown): { ok: boolean; issues: string[]; page?: WebPageV1 } {
  const issues: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, issues: ['page is not an object'] };
  }
  const page = value as Record<string, unknown>;
  for (const key of Object.keys(page)) {
    if (key !== 'entities' && key !== 'pagination' && key !== 'partial' && key !== 'warnings') {
      issues.push(`${key} is not a known page field`);
    }
  }
  if (page.backend_text !== undefined || page.backendText !== undefined) {
    issues.push('backend_text is not allowed on web paths');
  }
  let entities: WebEntityV1[] | undefined;
  if (!Array.isArray(page.entities)) {
    issues.push('entities must be an array');
  } else {
    for (const [index, entity] of page.entities.entries()) {
      const check = validateWebEntity(entity);
      if (!check.ok) issues.push(`entities[${index}]: ${check.issues.join('; ')}`);
    }
    if (issues.length === 0) {
      entities = dedupeWebEntities(page.entities as WebEntityV1[]);
      if (entities.length !== (page.entities as unknown[]).length) {
        issues.push('entities contain duplicate urls (dedupe by url, first-wins)');
      }
      const total = entities.reduce((sum, entity) => sum + webEntityTextLength(entity), 0);
      if (total > WEB_PAGE_CONTENT_MAX) {
        issues.push(`page content exceeds maximum of ${WEB_PAGE_CONTENT_MAX} bytes (UTF-8)`);
      }
    }
  }
  if (typeof page.partial !== 'boolean') issues.push('partial must be a boolean');
  if (!Array.isArray(page.warnings) || page.warnings.some((warning) => typeof warning !== 'string')) {
    issues.push('warnings must be an array of strings');
  }
  if (typeof page.pagination !== 'object' || page.pagination === null || Array.isArray(page.pagination)) {
    issues.push('pagination must be an object');
  } else {
    const pagination = page.pagination as Record<string, unknown>;
    if (typeof pagination.supported !== 'boolean') issues.push('pagination.supported must be a boolean');
    if (typeof pagination.hasMore !== 'boolean') issues.push('pagination.hasMore must be a boolean');
    if (typeof pagination.limit !== 'number' || !Number.isFinite(pagination.limit)) {
      issues.push('pagination.limit must be a finite number');
    }
    if (typeof pagination.returned !== 'number' || !Number.isFinite(pagination.returned)) {
      issues.push('pagination.returned must be a finite number');
    }
    if (Array.isArray(page.entities) && pagination.returned !== page.entities.length) {
      issues.push('pagination.returned must equal entities.length');
    }
    if (pagination.supported !== false) issues.push('pagination.supported must be false for web paths');
    if (pagination.hasMore === true) issues.push('hasMore must be false for web paths');
    if (pagination.nextCursor !== undefined) issues.push('nextCursor is not issued on web paths');
  }
  return issues.length === 0 ? { ok: true, issues, page: page as unknown as WebPageV1 } : { ok: false, issues };
}

// ── Pagination: unsupported ──
// Web search/crawl/read never issue continuation cursors. Any cursor-bearing
// web request is rejected with cursor_invalid. Research-category cursors pass
// through the research adapters untouched — they never enter this contract.
// The fingerprint/encode/decode helpers below are a minimal local
// opaque-cursor util (social cursor helpers are platform/action-bound and not
// generic); web paths use only the rejection entry point.

export const WEB_PAGINATION_MODE: WebPaginationMode = 'unsupported';
export const WEB_MAX_CURSOR_LENGTH = 4096;

export function assertNoWebCursor(cursor: unknown): void {
  if (cursor === undefined || cursor === null) return;
  if (typeof cursor === 'string' && cursor.length === 0) return;
  throw webError('cursor_invalid', 'cursors are not supported on web paths');
}

export interface WebCursorFingerprintInput {
  action: WebAction;
  query?: string;
  url?: string;
  limit: number;
}

/** SHA-256 fingerprint over canonical selectors and limit. */
export function webCursorFingerprint(input: WebCursorFingerprintInput): string {
  const parts: string[] = [input.action, input.query ?? '', input.url ?? '', String(input.limit)];
  return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
}

export type WebCursorState = Record<string, string | number | boolean>;

export function encodeWebCursor(input: {
  action: WebAction;
  backend: string;
  fingerprint: string;
  state: WebCursorState;
}): string {
  const payload = { v: 1, action: input.action, backend: input.backend, fingerprint: input.fingerprint, state: input.state };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  if (encoded.length > WEB_MAX_CURSOR_LENGTH) {
    throw webError('cursor_invalid', `cursor exceeds maximum length of ${WEB_MAX_CURSOR_LENGTH}`);
  }
  return encoded;
}

/**
 * Decode path exists only so cursor-bearing callers get a deterministic
 * cursor_invalid (never cursor_mismatch): web backends pin no cursors.
 */
export function decodeWebCursor(
  cursor: string,
  expected: { action: WebAction; backend: string; fingerprint: string },
): { action: WebAction; backend: string; state: WebCursorState } {
  void expected;
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw webError('cursor_invalid', 'cursor is required');
  }
  throw webError('cursor_invalid', 'cursors are not supported on web paths');
}

// ── Backend plan seam ──

export interface WebExecutionContext {
  /** Abort signal propagated to every backend execution. */
  signal?: AbortSignal;
}

export interface WebBackendPlan {
  backend: string;
  authTier: WebAuthTier;
  degraded: boolean;
  quality: WebBackendQuality;
  execute(signal?: AbortSignal): Promise<unknown>;
}

export interface WebWorker {
  readonly backends: readonly string[];
  plans(request: WebRequest, context: WebExecutionContext): Promise<readonly WebBackendPlan[]>;
  normalize(request: WebRequest, plan: WebBackendPlan, payload: unknown): WebPageV1;
}

/**
 * Backend preference order, mirroring the capability registry
 * (full backends before degraded fallbacks).
 */
export const WEB_BACKEND_PREFERENCE: Readonly<Record<WebAction, readonly string[]>> = {
  search: ['codex', 'tavily', 'exa', 'brave', 'searxng', 'diffbot', 'ollama-search', 'duckduckgo'],
  read: ['native-fetch'],
  crawl: ['native-fetch'],
};

const WEB_AUTH_TIER_RANK: Readonly<Record<WebAuthTier, number>> = {
  anonymous: 0,
  cookie: 1,
  api_key: 2,
};

function webPreferenceIndex(action: WebAction, backend: string): number {
  const index = WEB_BACKEND_PREFERENCE[action].indexOf(backend);
  return index >= 0 ? index : WEB_BACKEND_PREFERENCE[action].length;
}

/**
 * Order backend plans: non-degraded (complete) first, full quality before
 * degraded, then auth-tier rank, then per-action backend preference. Mirrors
 * orderMediaPlans in src/media-contract.ts.
 */
export function orderWebPlans(action: WebAction, plans: readonly WebBackendPlan[]): WebBackendPlan[] {
  return [...plans].sort((a, b) => {
    if (a.degraded !== b.degraded) return a.degraded ? 1 : -1;
    const qualityRank = (quality: WebBackendQuality): number => (quality === 'full' ? 0 : 1);
    if (qualityRank(a.quality) !== qualityRank(b.quality)) {
      return qualityRank(a.quality) - qualityRank(b.quality);
    }
    const tier = WEB_AUTH_TIER_RANK[a.authTier] - WEB_AUTH_TIER_RANK[b.authTier];
    if (tier !== 0) return tier;
    return webPreferenceIndex(action, a.backend) - webPreferenceIndex(action, b.backend);
  });
}
