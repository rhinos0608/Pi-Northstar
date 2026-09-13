// Shared plumbing for the native research adapters (semantic scholar,
// openalex, pubmed, datacite). Each adapter is a flat src/research-*.ts
// module that talks to exactly one official provider API and returns a
// Pi-owned NorthstarResultV1 envelope — never raw provider objects.
//
// Conventions enforced here:
// - Fixed official hosts only; requests go through the shared SSRF-validated
//   HTTP helper and never follow redirects (credentials stay on the fixed host).
// - Bounded pagination: limit is clamped to 1..MAX_RESEARCH_LIMIT (30).
// - Auth only via Pi env conventions (SEMANTIC_SCHOLAR_API_KEY,
//   OPENALEX_API_KEY, NCBI_API_KEY, NCBI_EMAIL); never echoed into
//   errors, URLs in errors, or result output.
// - Malformed upstream HTTP-200 payloads are rejected as
//   invalid_backend_response, not treated as empty success.
// - No retry loops; aborts always propagate.

import { fetchJsonNoRedirect, fetchText } from '../core/http.js';
import { researchSourceCapability } from '../capabilities.js';
import {
  buildNorthstarResult,
  decodeResultCursor,
  ResultContractError,
  type CursorState,
  type NorthstarEntityKind,
  type NorthstarEntityV1,
  type NorthstarErrorV1,
  type NorthstarRequestV1,
  type NorthstarResultV1,
  parseEntity,
  validateNorthstarEntity,
} from '../result-contract.js';

/** Fanout bound from the threat controls table: one request/source, limit ≤ 30. */
export const MAX_RESEARCH_LIMIT = 30;
export const DEFAULT_RESEARCH_LIMIT = 10;

/**
 * Canonical research action vocabulary. `search` is the single canonical
 * action; `academic` is a legacy alias the research() route still accepts for
 * stability. Any other action spelling is rejected with an invalid_input
 * envelope instead of being silently coerced.
 */
export const RESEARCH_CANONICAL_ACTION = 'search';
export const RESEARCH_LEGACY_ACTION_ALIAS = 'academic';

export function isSupportedResearchAction(action: string): boolean {
  return action === RESEARCH_CANONICAL_ACTION || action === RESEARCH_LEGACY_ACTION_ALIAS;
}

export interface ResearchAdapterRequest {
  query: string;
  limit?: number;
  /** Opaque cursor returned in a previous envelope's pagination.nextCursor. */
  cursor?: string;
  /** Inclusive earliest publication year where the source supports date filters. */
  yearFrom?: number;
  /** Inclusive latest publication year. No adapter wires it yet — the seam
   * surfaces it per-source as unsupported instead of dropping it silently. */
  yearTo?: number;
  /** Author filter — only supported by sources that document a wire-level way. */
  author?: string;
  doi?: string;
  /** Venue/journal filter — unsupported sources reject this explicitly. */
  venue?: string;
  signal?: AbortSignal;
  /** Defaults to process.env; injectable for tests. */
  env?: Record<string, string | undefined>;
}

export interface ResearchAdapterContext {
  tool?: string;
  channel?: string;
  action?: string;
  requestedAction?: string;
}

export function researchRequestV1(source: string, context?: ResearchAdapterContext): NorthstarRequestV1 {
  const request: NorthstarRequestV1 = {
    tool: typeof context?.tool === 'string' && context.tool ? context.tool : 'web_search',
    channel: typeof context?.channel === 'string' && context.channel ? context.channel : 'research',
    action: typeof context?.action === 'string' && context.action ? context.action : 'search',
    source,
  };
  if (typeof context?.requestedAction === 'string' && context.requestedAction) {
    request.requestedAction = context.requestedAction;
  }
  return request;
}

// ── Small untrusted-JSON guards (mirrors result-contract internals) ──

export function researchRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function researchString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function researchInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) ? value : undefined;
}

// ── Input normalization ──

export interface NormalizedResearchInput {
  query: string;
  limit: number;
  yearFrom?: number;
  yearTo?: number;
  author?: string;
  doi?: string;
  venue?: string;
}

/** Max filter value lengths — over-long values are rejected, never truncated
 * (truncation would silently change the selected author/doi/venue). */
export const MAX_AUTHOR_FILTER_LENGTH = 200;
export const MAX_DOI_FILTER_LENGTH = 100;
export const MAX_VENUE_FILTER_LENGTH = 200;

export type NormalizedInputResult =
  | { ok: true; input: NormalizedResearchInput }
  | { ok: false; message: string };

export function normalizeResearchInput(
  request: ResearchAdapterRequest,
): { ok: true; input: NormalizedResearchInput } | { ok: false; message: string } {
  const query = typeof request.query === 'string' ? request.query.trim() : '';
  if (!query) return { ok: false, message: 'query is required' };

  let limit = DEFAULT_RESEARCH_LIMIT;
  if (request.limit !== undefined) {
    if (typeof request.limit !== 'number' || !Number.isFinite(request.limit) || !Number.isInteger(request.limit)) {
      return { ok: false, message: 'limit must be an integer' };
    }
    limit = Math.min(Math.max(request.limit, 1), MAX_RESEARCH_LIMIT);
  }

  if (request.yearFrom !== undefined) {
    if (typeof request.yearFrom !== 'number' || !Number.isInteger(request.yearFrom) || request.yearFrom < 1000 || request.yearFrom > 2200) {
      return { ok: false, message: 'yearFrom must be a four-digit year' };
    }
  }
  if (request.yearTo !== undefined) {
    if (typeof request.yearTo !== 'number' || !Number.isInteger(request.yearTo) || request.yearTo < 1000 || request.yearTo > 2200) {
      return { ok: false, message: 'yearTo must be a four-digit year' };
    }
    if (request.yearFrom !== undefined && request.yearTo < request.yearFrom) {
      return { ok: false, message: 'yearTo must not be earlier than yearFrom' };
    }
  }

  const capped = cappedFilter(request.author, MAX_AUTHOR_FILTER_LENGTH, 'author');
  if (!capped.ok) return capped;
  const cappedDoi = cappedFilter(request.doi, MAX_DOI_FILTER_LENGTH, 'doi');
  if (!cappedDoi.ok) return cappedDoi;
  const cappedVenue = cappedFilter(request.venue, MAX_VENUE_FILTER_LENGTH, 'venue');
  if (!cappedVenue.ok) return cappedVenue;

  const input: NormalizedResearchInput = { query, limit };
  if (request.yearFrom !== undefined) input.yearFrom = request.yearFrom;
  if (request.yearTo !== undefined) input.yearTo = request.yearTo;
  const author = optionalField(request.author);
  const doi = optionalField(request.doi);
  const venue = optionalField(request.venue);
  if (author !== undefined) input.author = author;
  if (doi !== undefined) input.doi = doi;
  if (venue !== undefined) input.venue = venue;
  return { ok: true, input };
}

function cappedFilter(
  value: unknown,
  maxLength: number,
  field: string,
): { ok: true } | { ok: false; message: string } {
  if (typeof value !== 'string' || value.trim().length === 0) return { ok: true };
  if (value.trim().length > maxLength) return { ok: false, message: `${field} filter exceeds ${maxLength} characters` };
  return { ok: true };
}

function optionalField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

// ── Auth helpers (Pi env conventions; never logged or echoed) ──

export function envApiKey(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

// ── HTTP with sanitized failures ──
// Error messages never contain URLs (PubMed api_key travels in the query
// string) or response bodies. Only the numeric status survives.

export class ResearchHttpError extends Error {
  readonly kind: 'http' | 'redirect' | 'timeout' | 'network';
  readonly status?: number;

  constructor(kind: 'http' | 'redirect' | 'timeout' | 'network', message: string, status?: number) {
    super(message);
    this.name = 'ResearchHttpError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

export async function fetchResearchJson(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  try {
    return await fetchJsonNoRedirect(url, headers, signal);
  } catch (error) {
    throw toResearchHttpError(error);
  }
}

function toResearchHttpError(error: unknown): ResearchHttpError {
  if (error instanceof ResearchHttpError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const status = /^HTTP (\d{3}) for /.exec(message);
  if (status) return new ResearchHttpError('http', `HTTP ${status[1]}`, Number(status[1]));
  if (/Redirect rejected/.test(message)) return new ResearchHttpError('redirect', 'Redirect rejected');
  if (/exceeded size limit|too large/i.test(message)) return new ResearchHttpError('http', 'Response exceeded size limit');
  if (error instanceof Error && (error.name === 'TimeoutError' || /timed out|aborted due to timeout/i.test(message))) {
    return new ResearchHttpError('timeout', 'Request timed out');
  }
  return new ResearchHttpError('network', 'Network request failed');
}

/** Text variant of fetchResearchJson for XML providers (arXiv Atom API). */
export async function fetchResearchText(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<string> {
  try {
    return await fetchText(url, headers, signal);
  } catch (error) {
    throw toResearchHttpError(error);
  }
}

export function httpOutcomeError(
  error: unknown,
): Omit<NorthstarErrorV1, 'source' | 'backend'> {
  const kind = error instanceof ResearchHttpError ? error.kind : 'network';
  const status = error instanceof ResearchHttpError ? error.status : undefined;
  if (kind === 'timeout') {
    return { code: 'timeout', message: 'Research request timed out.', retryable: true };
  }
  if (status === 429) {
    return { code: 'rate_limited', message: 'Rate limited (HTTP 429).', retryable: true };
  }
  if (status !== undefined) {
    return {
      code: 'backend_http_error',
      message: `HTTP ${status}.`,
      retryable: status >= 500,
    };
  }
  return { code: 'backend_unavailable', message: 'Research backend request failed.', retryable: false };
}

// ── Container + row validation ──

export interface ParsedRows {
  entities: NorthstarEntityV1[];
  invalid: number;
}

export function parseAdapterRows(
  rows: readonly unknown[],
  source: string,
  kind: NorthstarEntityKind,
): ParsedRows {
  const entities: NorthstarEntityV1[] = [];
  let invalid = 0;
  for (const row of rows) {
    const parsed = parseEntity(row, { source, kind });
    if (!parsed.ok) {
      invalid += 1;
      continue;
    }
    // Strict contract gate: a row that parses but fails the canonical entity
    // validator is a per-source error (counted invalid), never a silent skip.
    if (!validateNorthstarEntity(parsed.entity).ok) {
      invalid += 1;
      continue;
    }
    entities.push(parsed.entity);
  }
  return { entities, invalid };
}

// ── Cursor state access with numeric/string bounds ──

export function cursorNumber(
  state: CursorState,
  key: string,
  min: number,
  max: number,
): { ok: true; value: number } | { ok: false; message: string } {
  const raw = state[key];
  if (raw === undefined) return { ok: false, message: `cursor state.${key} is missing` };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
    return { ok: false, message: `cursor state.${key} is out of range` };
  }
  return { ok: true, value: raw };
}

export function cursorToken(
  state: CursorState,
  key: string,
  maxLength = 512,
): { ok: true; value: string } | { ok: false; message: string } {
  const raw = state[key];
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > maxLength) {
    return { ok: false, message: `cursor state.${key} is invalid` };
  }
  return { ok: true, value: raw };
}

/**
 * Decode a caller-supplied cursor into typed state. Returns an error outcome
 * (invalid_input / pagination_not_supported) instead of throwing so adapters
 * can render it into the envelope contract.
 */
export function decodeCursorState(
  cursor: string,
  expected: { source: string; query: string; yearFrom?: number },
): { ok: true; state: CursorState } | { ok: false; error: Omit<NorthstarErrorV1, 'source' | 'backend'> } {
  try {
    return { ok: true, state: decodeResultCursor(cursor, expected).state };
  } catch (error) {
    if (error instanceof ResultContractError) {
      return { ok: false, error: { code: error.code, message: error.message, retryable: false } };
    }
    return { ok: false, error: { code: 'invalid_input', message: 'cursor could not be decoded.', retryable: false } };
  }
}

// ── Envelope assembly ──

export interface AdapterOutcomeParams {
  request: NorthstarRequestV1;
  source: string;
  backend: string;
  entities: NorthstarEntityV1[];
  invalid: number;
  error?: Omit<NorthstarErrorV1, 'source' | 'backend'>;
  pagination: { limit: number; hasMore: boolean; nextCursor?: string; supported?: boolean };
  notes?: string[];
  retryAfterMs?: number;
}

/**
 * Explicit unsupported-filter rejection (no silent filter dropping).
 * `pagination.supported` reflects the source's registry pagination mode so
 * sources without any pagination (e.g. wikipedia, gdelt) never advertise a
 * continuation they cannot serve, even on filter/input errors.
 */
export function rejectedInputEnvelope(
  request: NorthstarRequestV1,
  source: string,
  backend: string,
  message: string,
  limit: number,
): NorthstarResultV1 {
  const paginationUnsupported = researchSourceCapability(source)?.pagination === 'unsupported';
  return buildAdapterEnvelope({
    request,
    source,
    backend,
    entities: [],
    invalid: 0,
    error: { code: 'invalid_input', message, retryable: false },
    pagination: { limit, hasMore: false, ...(paginationUnsupported ? { supported: false } : {}) },
  });
}

/**
 * Envelope for cursor decode failures: preserves the contract code from
 * decodeCursorState (pagination_not_supported survives; numeric/string state
 * failures stay invalid_input). Used instead of rejectedInputEnvelope so
 * cross-source/foreign cursors are never mislabeled as plain input errors.
 * pagination.supported stays capability-derived: a source without pagination
 * never advertises it, and a foreign-cursor pagination_not_supported error
 * never advertises a continuation the caller cannot resume.
 */
export function cursorErrorEnvelope(
  request: NorthstarRequestV1,
  source: string,
  backend: string,
  limit: number,
  error: Omit<NorthstarErrorV1, 'source' | 'backend'>,
): NorthstarResultV1 {
  const capabilitySupported = researchSourceCapability(source)?.pagination !== 'unsupported';
  return buildNorthstarResult({
    request,
    outcomes: [{ source, backend, error }],
    pagination: { supported: capabilitySupported && error.code !== 'pagination_not_supported', limit, hasMore: false },
  });
}

export function buildAdapterEnvelope(params: AdapterOutcomeParams): NorthstarResultV1 {
  const pagination: { limit: number; hasMore: boolean; nextCursor?: string } = {
    limit: params.pagination.limit,
    hasMore: params.pagination.hasMore,
  };
  if (params.pagination.nextCursor !== undefined) pagination.nextCursor = params.pagination.nextCursor;
  return buildNorthstarResult({
    request: params.request,
    outcomes: [
      {
        source: params.source,
        backend: params.backend,
        entities: params.entities,
        invalid: params.invalid,
        ...(params.error ? { error: params.error } : {}),
        ...(params.retryAfterMs !== undefined ? { retryAfterMs: params.retryAfterMs } : {}),
      },
    ],
    pagination: { supported: params.pagination.supported ?? true, ...pagination },
    notes: params.notes ?? [],
  });
}
