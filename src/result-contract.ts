// Pi-owned canonical result contract (V1): normalized envelope,
// entities, errors, pagination, and opaque continuation cursors.
//
// Legacy observable fields (details.platform/action/backend/items/...) are
// never replaced; this contract is attached additively under
// `details.northstar` via tool-output.withNorthstarDetails.

import { createHash } from 'node:crypto';

export const NORTHSTAR_RESULT_SCHEMA = 'pi-northstar.result';
export const NORTHSTAR_RESULT_VERSION = 1 as const;

export type ResultStatus = 'ok' | 'empty' | 'partial' | 'degraded' | 'error';

export type NorthstarErrorCode =
  | 'invalid_input'
  | 'unsupported_action'
  | 'backend_unavailable'
  | 'backend_http_error'
  | 'rate_limited'
  | 'timeout'
  | 'invalid_backend_response'
  | 'invalid_entity'
  | 'pagination_not_supported';

export interface NorthstarErrorV1 {
  code: NorthstarErrorCode;
  message: string;
  retryable: boolean;
  source?: string;
  backend?: string;
}

export type NorthstarEntityKind =
  | 'work'
  | 'question'
  | 'organization'
  | 'article'
  | 'social_post'
  | 'social_comment'
  | 'social_account'
  | 'social_thread'
  | 'social_community'
  | 'social_media'
  | 'social_relationship'
  | 'social_engagement'
  | 'social_topic'
  | 'social_notification'
  | 'social_reference'
  | 'profile'
  | 'video'
  | 'feed_entry';

export interface NorthstarAuthor {
  name: string;
  id?: string;
}

export interface NorthstarEntityMetrics {
  citations?: number;
  score?: number;
  comments?: number;
  views?: number;
}

export interface NorthstarEntityV1 {
  entityVersion: 1;
  kind: NorthstarEntityKind;
  id: string;
  source: string;
  title: string;
  url: string;
  snippet?: string;
  authors?: Array<{ name: string; id?: string }>;
  year?: number;
  publishedAt?: string;
  venue?: string;
  doi?: string;
  metrics?: NorthstarEntityMetrics;
}

export interface NorthstarRequestV1 {
  tool: string;
  channel: string;
  action: string;
  requestedAction?: string;
  source?: string;
}

export type NorthstarDataV1 =
  | { kind: 'entities'; entities: NorthstarEntityV1[] }
  // Raw backend text is reserved for non-social consumers pending migration.
  // Social channels must always emit validated `entities`, never `backend_text`.
  | { kind: 'backend_text'; text: string };

export interface NorthstarPaginationV1 {
  supported: boolean;
  limit: number;
  returned: number;
  hasMore: boolean;
  nextCursor?: string;
}

export interface NorthstarSourceStatusV1 {
  source: string;
  backend: string;
  status: ResultStatus;
  count: number;
  retryAfterMs?: number;
}

export interface NorthstarResultV1 {
  schema: typeof NORTHSTAR_RESULT_SCHEMA;
  version: typeof NORTHSTAR_RESULT_VERSION;
  status: ResultStatus;
  request: NorthstarRequestV1;
  data: NorthstarDataV1;
  pagination: NorthstarPaginationV1;
  sources: NorthstarSourceStatusV1[];
  errors: NorthstarErrorV1[];
  notes: string[];
}

// ── Runtime-safe entity normalization ──
// Provider rows are untrusted: minimal container/field validation, invalid
// rows dropped and reported, valid siblings still surface as partial.

export interface EntityParseContext {
  source: string;
  kind: NorthstarEntityKind;
}

export type EntityParseResult =
  | { ok: true; entity: NorthstarEntityV1 }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) ? value : undefined;
}

function parseAuthors(value: unknown): Array<{ name: string; id?: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const authors = value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || !entry.name.trim()) return [];
    const author: { name: string; id?: string } = { name: entry.name.trim() };
    const id = optionalString(entry.id);
    if (id !== undefined) author.id = id;
    return [author];
  });
  return authors.length > 0 ? authors : undefined;
}

function parseMetrics(value: unknown): NorthstarEntityMetrics | undefined {
  if (!isRecord(value)) return undefined;
  const metrics: NorthstarEntityMetrics = {};
  let present = false;
  for (const key of ['citations', 'score', 'comments', 'views'] as const) {
    const raw = value[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      metrics[key] = raw;
      present = true;
    }
  }
  return present ? metrics : undefined;
}

const MAX_ENTITY_TEXT_CHARS = 8_000;

// Bounded text: provider fields never carry unbounded payloads into the
// canonical entity; long fields are truncated at the trust boundary.
function boundedText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length > MAX_ENTITY_TEXT_CHARS ? value.slice(0, MAX_ENTITY_TEXT_CHARS) : value;
}

export function parseEntity(raw: unknown, context: EntityParseContext): EntityParseResult {
  if (!isRecord(raw)) return { ok: false, reason: 'row is not an object' };

  const id = optionalString(raw.id) ?? optionalString(raw.doi) ?? optionalString(raw.permalink);
  if (!id) return { ok: false, reason: 'row missing id' };
  const url = optionalString(raw.url) ?? optionalString(raw.permalink) ?? optionalString(raw.link);
  if (!url) return { ok: false, reason: 'row missing url' };

  const entity: NorthstarEntityV1 = {
    entityVersion: 1,
    kind: context.kind,
    id: id.slice(0, 512),
    source: context.source,
    title: typeof raw.title === 'string' ? boundedText(raw.title) ?? '' : '',
    url: url.slice(0, 2_048),
  };

  const snippet = boundedText(optionalString(raw.snippet ?? raw.abstract ?? raw.description));
  if (snippet !== undefined) entity.snippet = snippet;

  const authors = parseAuthors(raw.authors ?? raw.author);
  if (authors !== undefined) entity.authors = authors;

  const year = optionalInt(raw.year ?? raw.publicationYear);
  if (year !== undefined && year >= 1000 && year <= 2200) entity.year = year;

  const publishedAt = optionalString(raw.publishedAt ?? raw.published_at ?? raw.created_utc);
  if (publishedAt !== undefined) entity.publishedAt = publishedAt;

  const venue = boundedText(optionalString(raw.venue));
  if (venue !== undefined) entity.venue = venue;

  const doi = optionalString(raw.doi);
  if (doi !== undefined) entity.doi = doi;

  const metrics = parseMetrics(raw.metrics ?? { citations: raw.citations, score: raw.score, comments: raw.comments, views: raw.views });
  if (metrics !== undefined) entity.metrics = metrics;

  return { ok: true, entity };
}

// ── Envelope construction with status precedence ──

export interface NorthstarSourceOutcome {
  source: string;
  backend: string;
  /** Validated entities produced by this source. */
  entities?: ReadonlyArray<NorthstarEntityV1>;
  /** Rows dropped by parseEntity — reported as invalid_entity errors. */
  invalid?: number;
  error?: Omit<NorthstarErrorV1, 'source' | 'backend'>;
  /** Fallback or limited backend contributing to `degraded` status. */
  degraded?: boolean;
  retryAfterMs?: number;
}

export interface BuildNorthstarResultParams {
  request: NorthstarRequestV1;
  outcomes: ReadonlyArray<NorthstarSourceOutcome>;
  pagination?: Partial<NorthstarPaginationV1> & { limit?: number };
  notes?: string[];
}

/**
 * Status precedence:
 * 1. no entities plus errors → error
 * 2. entities plus errors/invalid rows → partial
 * 3. fallback or limited backend → degraded
 * 4. no entities and no errors → empty
 * 5. otherwise → ok
 */
export function computeStatus(params: {
  entityCount: number;
  errorCount: number;
  invalidCount: number;
  degraded: boolean;
}): ResultStatus {
  const { entityCount, errorCount, invalidCount, degraded } = params;
  if (entityCount === 0 && (errorCount > 0 || invalidCount > 0)) return 'error';
  if (entityCount > 0 && (errorCount > 0 || invalidCount > 0)) return 'partial';
  if (degraded) return 'degraded';
  if (entityCount === 0) return 'empty';
  return 'ok';
}

export function buildNorthstarResult(params: BuildNorthstarResultParams): NorthstarResultV1 {
  const entities: NorthstarEntityV1[] = params.outcomes.flatMap(
    (outcome) => (outcome.entities ? [...outcome.entities] : []),
  );
  const invalidCount = params.outcomes.reduce((total, outcome) => total + (outcome.invalid ?? 0), 0);

  const errors: NorthstarErrorV1[] = [];
  const sources: NorthstarSourceStatusV1[] = [];
  let degraded = false;

  for (const outcome of params.outcomes) {
    if (outcome.error) {
      const error: NorthstarErrorV1 = { ...outcome.error, source: outcome.source, backend: outcome.backend };
      errors.push(error);
    }
    if ((outcome.invalid ?? 0) > 0) {
      errors.push({
        code: 'invalid_entity',
        message: `Dropped ${outcome.invalid} malformed row(s) from ${outcome.source}.`,
        retryable: false,
        source: outcome.source,
        backend: outcome.backend,
      });
    }
    if (outcome.degraded) degraded = true;
    const count = outcome.entities?.length ?? 0;
    const hasFailure = Boolean(outcome.error) || (outcome.invalid ?? 0) > 0;
    const status: ResultStatus = hasFailure
      ? (count > 0 ? 'partial' : 'error')
      : (outcome.degraded ? 'degraded' : (count > 0 ? 'ok' : 'empty'));
    const sourceStatus: NorthstarSourceStatusV1 = {
      source: outcome.source,
      backend: outcome.backend,
      status,
      count,
    };
    if (outcome.retryAfterMs !== undefined) sourceStatus.retryAfterMs = outcome.retryAfterMs;
    sources.push(sourceStatus);
  }

  const limit = params.pagination?.limit ?? entities.length;
  const pagination: NorthstarPaginationV1 = {
    supported: params.pagination?.supported ?? false,
    limit,
    returned: entities.length,
    hasMore: params.pagination?.hasMore ?? false,
  };
  if (params.pagination?.nextCursor !== undefined) pagination.nextCursor = params.pagination.nextCursor;

  const result: NorthstarResultV1 = {
    schema: NORTHSTAR_RESULT_SCHEMA,
    version: NORTHSTAR_RESULT_VERSION,
    status: computeStatus({
      entityCount: entities.length,
      errorCount: errors.length,
      invalidCount,
      degraded,
    }),
    request: params.request,
    data: { kind: 'entities', entities },
    pagination,
    sources,
    errors,
    notes: params.notes ?? [],
  };
  return result;
}

// ── Envelope validation (semantic output validation before backend success) ──

const RESULT_STATUSES: ReadonlySet<string> = new Set(['ok', 'empty', 'partial', 'degraded', 'error']);

const ERROR_CODES: ReadonlySet<string> = new Set([
  'invalid_input', 'unsupported_action', 'backend_unavailable', 'backend_http_error',
  'rate_limited', 'timeout', 'invalid_backend_response', 'invalid_entity',
  'pagination_not_supported',
]);

const ENTITY_KINDS: ReadonlySet<string> = new Set([
  'work', 'question', 'organization', 'article', 'social_post', 'social_comment',
  'social_account', 'social_thread', 'social_community', 'social_media',
  'social_relationship', 'social_engagement', 'social_topic', 'social_notification',
  'social_reference', 'profile', 'video', 'feed_entry',
]);

export interface EntityValidationResult {
  ok: boolean;
  entity?: NorthstarEntityV1;
  issues: string[];
}

export function validateNorthstarEntity(value: unknown): EntityValidationResult {
  const issues: string[] = [];
  if (!isRecord(value)) return { ok: false, issues: ['entity is not an object'] };

  const entity = value as unknown as NorthstarEntityV1;
  if (entity.entityVersion !== 1) issues.push('entityVersion must be 1');
  if (typeof entity.kind !== 'string' || !ENTITY_KINDS.has(entity.kind)) issues.push('kind is not a valid entity kind');
  if (!nonEmptyString(entity.id)) issues.push('id is required');
  if (!nonEmptyString(entity.source)) issues.push('source is required');
  if (typeof entity.title !== 'string') issues.push('title must be a string');
  if (!nonEmptyString(entity.url)) issues.push('url is required');
  if (entity.snippet !== undefined && typeof entity.snippet !== 'string') issues.push('snippet must be a string');
  if (entity.year !== undefined && !Number.isFinite(entity.year)) issues.push('year must be a finite number');
  if (entity.authors !== undefined) {
    if (!Array.isArray(entity.authors)) issues.push('authors must be an array');
    else if (entity.authors.some((author) => !isRecord(author) || typeof (author as { name?: unknown }).name !== 'string')) {
      issues.push('authors entries must have string names');
    }
  }
  if (entity.metrics !== undefined) {
    if (!isRecord(entity.metrics)) issues.push('metrics must be an object');
    else {
      for (const key of ['citations', 'score', 'comments', 'views'] as const) {
        const metric = (entity.metrics as Record<string, unknown>)[key];
        if (metric !== undefined && (typeof metric !== 'number' || !Number.isFinite(metric))) {
          issues.push(`metrics.${key} must be a finite number`);
        }
      }
    }
  }
  return issues.length === 0 ? { ok: true, entity, issues } : { ok: false, issues };
}

export interface ResultValidationResult {
  ok: boolean;
  result?: NorthstarResultV1;
  issues: string[];
}

/** Runtime validation of a full V1 envelope (all entity rows included). */
export function validateNorthstarResult(value: unknown): ResultValidationResult {
  const issues: string[] = [];
  if (!isRecord(value)) return { ok: false, issues: ['result is not an object'] };
  const result = value as unknown as NorthstarResultV1;

  if (result.schema !== NORTHSTAR_RESULT_SCHEMA) issues.push('schema must be pi-northstar.result');
  if (result.version !== 1) issues.push('version must be 1');
  if (typeof result.status !== 'string' || !RESULT_STATUSES.has(result.status)) issues.push('status is not a valid result status');

  if (!isRecord(result.request)) issues.push('request must be an object');
  else {
    for (const key of ['tool', 'channel', 'action'] as const) {
      if (!nonEmptyString((result.request as Record<string, unknown>)[key])) issues.push(`request.${key} is required`);
    }
  }

  if (!isRecord(result.data)) issues.push('data must be an object');
  else if (result.data.kind === 'entities') {
    if (!Array.isArray(result.data.entities)) issues.push('data.entities must be an array');
    else {
      for (const [index, entity] of result.data.entities.entries()) {
        const check = validateNorthstarEntity(entity);
        if (!check.ok) issues.push(`data.entities[${index}]: ${check.issues.join('; ')}`);
      }
    }
  } else if (result.data.kind === 'backend_text') {
    if (typeof result.data.text !== 'string') issues.push('data.text must be a string');
  } else {
    issues.push('data.kind must be entities or backend_text');
  }

  if (!isRecord(result.pagination)) issues.push('pagination must be an object');
  else {
    const pagination = result.pagination as Record<string, unknown>;
    if (typeof pagination.supported !== 'boolean') issues.push('pagination.supported must be a boolean');
    if (typeof pagination.limit !== 'number' || !Number.isFinite(pagination.limit)) issues.push('pagination.limit must be a number');
    if (typeof pagination.returned !== 'number' || !Number.isFinite(pagination.returned)) issues.push('pagination.returned must be a number');
    if (typeof pagination.hasMore !== 'boolean') issues.push('pagination.hasMore must be a boolean');
   }

  if (!Array.isArray(result.sources)) issues.push('sources must be an array');
  else {
    for (const [index, source] of result.sources.entries()) {
      if (!isRecord(source)) {
        issues.push(`sources[${index}] must be an object`);
        continue;
      }
      const row = source as Record<string, unknown>;
      if (!nonEmptyString(row.source)) issues.push(`sources[${index}].source is required`);
      if (!nonEmptyString(row.backend)) issues.push(`sources[${index}].backend is required`);
      if (typeof row.status !== 'string' || !RESULT_STATUSES.has(row.status)) issues.push(`sources[${index}].status is invalid`);
      if (typeof row.count !== 'number' || !Number.isFinite(row.count)) issues.push(`sources[${index}].count must be a number`);
    }
  }

  if (!Array.isArray(result.errors)) issues.push('errors must be an array');
  else {
    for (const [index, error] of result.errors.entries()) {
      if (!isRecord(error)) {
        issues.push(`errors[${index}] must be an object`);
        continue;
      }
      const row = error as Record<string, unknown>;
      if (typeof row.code !== 'string' || !ERROR_CODES.has(row.code)) issues.push(`errors[${index}].code is invalid`);
      if (typeof row.message !== 'string') issues.push(`errors[${index}].message must be a string`);
      if (typeof row.retryable !== 'boolean') issues.push(`errors[${index}].retryable must be a boolean`);
    }
  }

  if (!Array.isArray(result.notes)) issues.push('notes must be an array');
  else if (result.notes.some((note) => typeof note !== 'string')) issues.push('notes must contain only strings');

  return issues.length === 0 ? { ok: true, result, issues } : { ok: false, issues };
}

// ── Opaque continuation cursors ──
// Opaque base64url JSON {v, source, queryHash, state}; bound to source, query,
// and yearFrom through a SHA-256 fingerprint. Never store or trust a
// continuation URL inside the cursor; providers rebuild URLs from typed state.

export const MAX_CURSOR_LENGTH = 4096;

export interface CursorState {
  [key: string]: string | number | boolean | null;
}

export interface DecodedCursor {
  source: string;
  state: CursorState;
}

export class ResultContractError extends Error {
  readonly code: 'invalid_input' | 'pagination_not_supported';

  constructor(code: 'invalid_input' | 'pagination_not_supported', message: string) {
    super(message);
    this.name = 'ResultContractError';
    this.code = code;
  }
}

function queryFingerprint(input: { source: string; query: string; yearFrom?: number }): string {
  return createHash('sha256')
    .update(`${input.source}|${input.query}|${input.yearFrom ?? ''}`)
    .digest('hex');
}

export function encodeResultCursor(input: {
  source: string;
  query: string;
  yearFrom?: number;
  state: CursorState;
}): string {
  const payload = {
    v: 1,
    source: input.source,
    queryHash: queryFingerprint(input),
    state: input.state,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decode and verify a cursor against the current request. Rejects cursors for
 * a different source/query/yearFrom binding and `source: "all"` continuation.
 * Never returns a URL: callers rebuild provider requests from `state`.
 */
export function decodeResultCursor(
  cursor: string,
  expected: { source: string; query: string; yearFrom?: number },
): DecodedCursor {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw new ResultContractError('invalid_input', 'cursor is required');
  }
  if (cursor.length > MAX_CURSOR_LENGTH) {
    throw new ResultContractError('invalid_input', `cursor exceeds maximum length of ${MAX_CURSOR_LENGTH}`);
  }
  if (expected.source === 'all') {
    throw new ResultContractError('pagination_not_supported', 'Continuation cursors require one exact research source, not "all".');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new ResultContractError('invalid_input', 'cursor is not a valid opaque token');
  }
  if (!isRecord(payload) || payload.v !== 1) {
    throw new ResultContractError('invalid_input', 'cursor payload is invalid');
  }
  if (payload.source !== expected.source) {
    throw new ResultContractError('pagination_not_supported', `cursor was issued for source "${String(payload.source)}", not "${expected.source}"`);
  }
  if (payload.queryHash !== queryFingerprint(expected)) {
    throw new ResultContractError('invalid_input', 'cursor does not match the current query (source, query, or yearFrom changed)');
  }
  if (!isRecord(payload.state)) {
    throw new ResultContractError('invalid_input', 'cursor state is invalid');
  }
  for (const [key, value] of Object.entries(payload.state)) {
    if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new ResultContractError('invalid_input', `cursor state.${key} has an unsupported type`);
    }
  }
  return { source: expected.source, state: payload.state as CursorState };
}
