// Public graph result/request contract v1: `pi-northstar.graph-result`
// envelope, graph action validators, opaque cursor codec, bounded JsonValue.
// No provider HTTP or wiring here.

export const GRAPH_RESULT_SCHEMA = 'pi-northstar.graph-result';
export const GRAPH_RESULT_VERSION = 1 as const;

export const GRAPH_ADAPTER_CURSOR_V = 1 as const;
export const MAX_GRAPH_CURSOR_LENGTH = 4096 as const;
export const MAX_GRAPH_QUERY_CHARS = 50_000 as const;
export const MAX_GRAPH_BATCH = 32 as const;
export const GRAPH_PAGE_SIZE_MIN = 1 as const;
export const GRAPH_PAGE_SIZE_MAX = 100 as const;
export const GRAPH_DEFAULT_PAGE_SIZE = 10 as const;

export const MAX_GRAPH_JSON_DEPTH = 32 as const;
export const MAX_GRAPH_JSON_KEYS = 1_000 as const;
export const MAX_GRAPH_JSON_ITEMS = 10_000 as const;

export type GraphAction = 'query' | 'probe' | 'schema';
export type GraphLanguage = 'dql';
export type GraphStatus = 'ok' | 'empty' | 'partial' | 'error';
export type GraphQueryShape = 'rows' | 'facets' | 'aggregate' | 'scalar' | 'object';
export type GraphSchemaView = 'types' | 'fields' | 'search' | 'describe';

export type GraphErrorCode =
  | 'invalid_input'
  | 'unsupported_option'
  | 'auth_required'
  | 'rate_limited'
  | 'upstream_error'
  | 'transport_invalid_response'
  | 'contract_invalid_response'
  | 'response_too_large'
  | 'cursor_invalid'
  | 'operation_aborted';

export interface GraphError {
  code: GraphErrorCode;
  message: string;
  retryable: boolean;
  retryAfter?: number | undefined;
  provider?: string | undefined;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type GraphRequest =
  | { action: 'query'; language: GraphLanguage; query: string; pageSize?: number; cursor?: string }
  | { action: 'probe'; language: GraphLanguage; queries: string[] }
  | { action: 'schema'; language: GraphLanguage; view: GraphSchemaView; name?: string; query?: string; includeDeprecated?: boolean };

export interface GraphQueryInput {
  action: 'query';
  language: GraphLanguage;
  query: string;
  pageSize: number;
  cursor?: string | undefined;
}

export interface GraphProbeInput {
  action: 'probe';
  language: GraphLanguage;
  queries: string[];
}

export interface GraphSchemaInput {
  action: 'schema';
  language: GraphLanguage;
  view: GraphSchemaView;
  name?: string | undefined;
  query?: string | undefined;
  includeDeprecated?: boolean | undefined;
}

export type ValidatedGraphInput = GraphQueryInput | GraphProbeInput | GraphSchemaInput;

export type GraphValidationResult =
  | { ok: true; input: ValidatedGraphInput }
  | { ok: false; code: GraphErrorCode; message: string };

export interface GraphProbeOkItem {
  query: string;
  status: 'ok';
  hits: number;
}

export interface GraphProbeErrorItem {
  query: string;
  status: 'error';
  error: GraphError;
}

export type GraphProbeItem = GraphProbeOkItem | GraphProbeErrorItem;

export interface GraphQueryData {
  kind: 'query';
  shape: GraphQueryShape;
  result: JsonValue;
}

export interface GraphProbeData {
  kind: 'probe';
  items: GraphProbeItem[];
}

export type GraphSchemaResult =
  | { view: 'types'; types: string[] }
  | { view: 'fields'; type?: string; fields: Array<{ name: string; type?: string; description?: string }>; truncated?: boolean }
  | { view: 'search'; query: string; matches: Array<{ name: string; kind?: string; description?: string }>; truncated?: boolean }
  | { view: 'describe'; name: string; detail: JsonValue };

export interface GraphSchemaData {
  kind: 'schema';
  result: GraphSchemaResult;
  meta?: { fetchedAt?: string; stale?: boolean };
}

export type GraphData = GraphQueryData | GraphProbeData | GraphSchemaData;

export interface GraphResult {
  schema: typeof GRAPH_RESULT_SCHEMA;
  version: typeof GRAPH_RESULT_VERSION;
  status: GraphStatus;
  language: GraphLanguage;
  source: { provider: string };
  data: GraphData;
  pagination?: { hasMore: boolean; nextCursor?: string };
  errors: GraphError[];
  notes: string[];
}

export class GraphContractError extends Error {
  readonly code: GraphErrorCode;
  constructor(code: GraphErrorCode, message: string) {
    super(message);
    this.name = 'GraphContractError';
    this.code = code;
  }
}

// ── guards ──

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function trimmed(value: string): string {
  return value.trim();
}

function isPrimitiveStateValue(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

// ── request validation (strict discriminated union) ──

const QUERY_KEYS: ReadonlySet<string> = new Set(['action', 'language', 'query', 'pageSize', 'cursor']);
const PROBE_KEYS: ReadonlySet<string> = new Set(['action', 'language', 'queries']);
const SCHEMA_KEYS: ReadonlySet<string> = new Set(['action', 'language', 'view', 'name', 'query', 'includeDeprecated']);
const SCHEMA_VIEWS: ReadonlySet<string> = new Set(['types', 'fields', 'search', 'describe']);

function fail(code: GraphErrorCode, message: string): GraphValidationResult {
  return { ok: false, code, message };
}

function checkNoUnknownKeys(input: Record<string, unknown>, allowed: ReadonlySet<string>): string | undefined {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) return key;
  }
  return undefined;
}

function checkPageSize(value: unknown): number | undefined {
  if (value === undefined) return GRAPH_DEFAULT_PAGE_SIZE;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < GRAPH_PAGE_SIZE_MIN || value > GRAPH_PAGE_SIZE_MAX) {
    return undefined;
  }
  return value;
}

function checkQueryText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = trimmed(value);
  if (text.length === 0 || text.length > MAX_GRAPH_QUERY_CHARS) return undefined;
  return text;
}

export function validateGraphRequest(input: unknown): GraphValidationResult {
  if (!isRecord(input)) return fail('invalid_input', 'graph request must be an object');
  const action = input.action;
  if (action !== 'query' && action !== 'probe' && action !== 'schema') {
    return fail('invalid_input', 'action must be query, probe, or schema');
  }
  if (input.language !== 'dql') {
    return fail('unsupported_option', "language must be 'dql' in v1");
  }
  if (action === 'query') {
    const unknown = checkNoUnknownKeys(input, QUERY_KEYS);
    if (unknown !== undefined) return fail('invalid_input', `unknown query field: ${unknown}`);
    const query = checkQueryText(input.query);
    if (query === undefined) return fail('invalid_input', `query must be non-empty text 1..${MAX_GRAPH_QUERY_CHARS} chars`);
    const pageSize = checkPageSize(input.pageSize);
    if (pageSize === undefined) return fail('invalid_input', `pageSize must be an integer ${GRAPH_PAGE_SIZE_MIN}..${GRAPH_PAGE_SIZE_MAX}`);
    if (input.cursor !== undefined) {
      if (typeof input.cursor !== 'string' || input.cursor.length === 0) {
        return fail('cursor_invalid', 'cursor must be a non-empty opaque token');
      }
      if (input.cursor.length > MAX_GRAPH_CURSOR_LENGTH) {
        return fail('cursor_invalid', `cursor exceeds maximum length of ${MAX_GRAPH_CURSOR_LENGTH}`);
      }
    }
    const out: GraphQueryInput = { action: 'query', language: 'dql', query, pageSize };
    if (typeof input.cursor === 'string') out.cursor = input.cursor;
    return { ok: true, input: out };
  }
  if (action === 'probe') {
    const unknown = checkNoUnknownKeys(input, PROBE_KEYS);
    if (unknown !== undefined) return fail('invalid_input', `unknown probe field: ${unknown}`);
    if (!Array.isArray(input.queries) || input.queries.length < 1 || input.queries.length > MAX_GRAPH_BATCH) {
      return fail('invalid_input', `queries must contain 1..${MAX_GRAPH_BATCH} queries`);
    }
    const queries: string[] = [];
    for (const entry of input.queries) {
      const text = checkQueryText(entry);
      if (text === undefined) return fail('invalid_input', `each query must be non-empty text 1..${MAX_GRAPH_QUERY_CHARS} chars`);
      queries.push(text);
    }
    return { ok: true, input: { action: 'probe', language: 'dql', queries } };
  }
  const unknown = checkNoUnknownKeys(input, SCHEMA_KEYS);
  if (unknown !== undefined) return fail('invalid_input', `unknown schema field: ${unknown}`);
  if (typeof input.view !== 'string' || !SCHEMA_VIEWS.has(input.view)) {
    return fail('invalid_input', 'view must be types, fields, search, or describe');
  }
  const view = input.view as GraphSchemaView;
  if (input.includeDeprecated !== undefined && typeof input.includeDeprecated !== 'boolean') {
    return fail('invalid_input', 'includeDeprecated must be a boolean');
  }
  if (view === 'types') {
    if (input.name !== undefined || input.query !== undefined) {
      return fail('invalid_input', 'view types accepts no name or query selectors');
    }
  } else if (view === 'fields') {
    if (input.query !== undefined) return fail('invalid_input', 'view fields accepts no query selector');
    if (input.name !== undefined && !nonEmptyString(input.name)) {
      return fail('invalid_input', 'name must be non-empty text');
    }
  } else if (view === 'search') {
    if (input.name !== undefined) return fail('invalid_input', 'view search accepts no name selector');
    if (checkQueryText(input.query) === undefined) return fail('invalid_input', 'view search requires a non-empty query');
  } else {
    if (input.query !== undefined) return fail('invalid_input', 'view describe accepts no query selector');
    if (!nonEmptyString(input.name)) return fail('invalid_input', 'view describe requires a non-empty name');
  }
  const out: GraphSchemaInput = { action: 'schema', language: 'dql', view };
  if (typeof input.name === 'string' && nonEmptyString(input.name)) out.name = trimmed(input.name);
  if (typeof input.query === 'string' && nonEmptyString(input.query)) out.query = trimmed(input.query as string);
  if (typeof input.includeDeprecated === 'boolean') out.includeDeprecated = input.includeDeprecated;
  return { ok: true, input: out };
}

// ── bounded JsonValue validation (no truncation) ──

export function validateGraphJsonValue(value: unknown, depth = 0): boolean {
  if (value === null) return true;
  if (typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (depth > MAX_GRAPH_JSON_DEPTH) return false;
  if (Array.isArray(value)) {
    if (value.length > MAX_GRAPH_JSON_ITEMS) return false;
    if (depth === MAX_GRAPH_JSON_DEPTH && value.length > 0) return false;
    for (const entry of value) {
      if (!validateGraphJsonValue(entry, depth + 1)) return false;
    }
    return true;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length > MAX_GRAPH_JSON_KEYS) return false;
    if (depth === MAX_GRAPH_JSON_DEPTH && keys.length > 0) return false;
    for (const key of keys) {
      if (!validateGraphJsonValue((value as Record<string, unknown>)[key], depth + 1)) return false;
    }
    return true;
  }
  return false;
}

// ── cursor codec ──

export interface GraphCursorState {
  [key: string]: string | number | boolean | null;
}

export interface GraphCursorInput {
  provider: string;
  fingerprint: string;
  adapterCursorV: number;
  action: GraphAction;
  language: GraphLanguage;
  pageSize: number;
  state: GraphCursorState;
}

export interface DecodedGraphCursor extends GraphCursorInput {
  v: 1;
}

export function encodeGraphCursor(input: GraphCursorInput): string {
  if (!nonEmptyString(input.provider)) throw new GraphContractError('cursor_invalid', 'cursor provider is required');
  if (!nonEmptyString(input.fingerprint)) throw new GraphContractError('cursor_invalid', 'cursor fingerprint is required');
  if (!Number.isInteger(input.adapterCursorV)) throw new GraphContractError('cursor_invalid', 'cursor adapterCursorV must be an integer');
  if (input.action !== 'query' && input.action !== 'probe' && input.action !== 'schema') {
    throw new GraphContractError('cursor_invalid', 'cursor action is invalid');
  }
  if (input.language !== 'dql') throw new GraphContractError('cursor_invalid', 'cursor language is invalid');
  if (!Number.isInteger(input.pageSize) || input.pageSize < GRAPH_PAGE_SIZE_MIN || input.pageSize > GRAPH_PAGE_SIZE_MAX) {
    throw new GraphContractError('cursor_invalid', 'cursor pageSize is invalid');
  }
  if (!isRecord(input.state)) throw new GraphContractError('cursor_invalid', 'cursor state must be an object');
  const payload = {
    v: 1, provider: input.provider, fingerprint: input.fingerprint, adapterCursorV: input.adapterCursorV,
    action: input.action, language: input.language, pageSize: input.pageSize, state: input.state,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeGraphCursor(cursor: string): DecodedGraphCursor {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw new GraphContractError('cursor_invalid', 'cursor is required');
  }
  if (cursor.length > MAX_GRAPH_CURSOR_LENGTH) {
    throw new GraphContractError('cursor_invalid', `cursor exceeds maximum length of ${MAX_GRAPH_CURSOR_LENGTH}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new GraphContractError('cursor_invalid', 'cursor is not a valid opaque token');
  }
  if (!isRecord(payload) || payload.v !== 1) throw new GraphContractError('cursor_invalid', 'cursor payload is invalid');
  if (!nonEmptyString(payload.provider)) throw new GraphContractError('cursor_invalid', 'cursor provider is invalid');
  if (!nonEmptyString(payload.fingerprint)) throw new GraphContractError('cursor_invalid', 'cursor fingerprint is invalid');
  if (!Number.isInteger(payload.adapterCursorV)) throw new GraphContractError('cursor_invalid', 'cursor adapterCursorV is invalid');
  if (payload.action !== 'query' && payload.action !== 'probe' && payload.action !== 'schema') {
    throw new GraphContractError('cursor_invalid', 'cursor action is invalid');
  }
  if (payload.language !== 'dql') throw new GraphContractError('cursor_invalid', 'cursor language is invalid');
  if (!Number.isInteger(payload.pageSize) || (payload.pageSize as number) < GRAPH_PAGE_SIZE_MIN || (payload.pageSize as number) > GRAPH_PAGE_SIZE_MAX) {
    throw new GraphContractError('cursor_invalid', 'cursor pageSize is invalid');
  }
  if (!isRecord(payload.state)) throw new GraphContractError('cursor_invalid', 'cursor state is invalid');
  for (const [key, value] of Object.entries(payload.state)) {
    if (!isPrimitiveStateValue(value)) {
      throw new GraphContractError('cursor_invalid', `cursor state.${key} has an unsupported type`);
    }
  }
  return {
    v: 1,
    provider: payload.provider as string,
    fingerprint: payload.fingerprint as string,
    adapterCursorV: payload.adapterCursorV as number,
    action: payload.action as GraphAction,
    language: 'dql',
    pageSize: payload.pageSize as number,
    state: payload.state as GraphCursorState,
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Deterministic request fingerprint (query+pageSize hash input). Key-order independent. */
export function fingerprintGraphRequest(value: unknown): string {
  const text = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// ── envelope validation + builder (fail-closed) ──

const GRAPH_STATUSES: ReadonlySet<string> = new Set(['ok', 'empty', 'partial', 'error']);
const GRAPH_SHAPES: ReadonlySet<string> = new Set(['rows', 'facets', 'aggregate', 'scalar', 'object']);
const GRAPH_ERROR_CODES: ReadonlySet<string> = new Set([
  'invalid_input', 'unsupported_option', 'auth_required', 'rate_limited', 'upstream_error',
  'transport_invalid_response', 'contract_invalid_response', 'response_too_large', 'cursor_invalid', 'operation_aborted',
]);

export interface GraphValidationEnvelope {
  ok: boolean;
  result?: GraphResult;
  issues: string[];
}

function isValidGraphError(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.code !== 'string' || !GRAPH_ERROR_CODES.has(value.code)) return false;
  if (typeof value.message !== 'string') return false;
  if (typeof value.retryable !== 'boolean') return false;
  if (value.retryAfter !== undefined && (typeof value.retryAfter !== 'number' || !Number.isFinite(value.retryAfter))) return false;
  return true;
}

function validateSchemaResult(value: unknown, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push('data.result must be an object');
    return;
  }
  const view = (value as Record<string, unknown>).view;
  if (view === 'types') {
    const types = (value as Record<string, unknown>).types;
    if (!Array.isArray(types) || types.some((t) => typeof t !== 'string')) issues.push('data.result.types must be a string array');
  } else if (view === 'fields') {
    const fields = (value as Record<string, unknown>).fields;
    if (!Array.isArray(fields)) issues.push('data.result.fields must be an array');
  } else if (view === 'search') {
    const matches = (value as Record<string, unknown>).matches;
    if (typeof (value as Record<string, unknown>).query !== 'string') issues.push('data.result.query must be a string');
    if (!Array.isArray(matches)) issues.push('data.result.matches must be an array');
  } else if (view === 'describe') {
    if (!nonEmptyString((value as Record<string, unknown>).name)) issues.push('data.result.name is required');
    if (!('detail' in value)) issues.push('data.result.detail is required');
    else if (!validateGraphJsonValue((value as Record<string, unknown>).detail)) issues.push('data.result.detail exceeds JSON bounds');
  } else {
    issues.push('data.result.view is invalid');
  }
}

export function validateGraphResult(value: unknown): GraphValidationEnvelope {
  const issues: string[] = [];
  if (!isRecord(value)) return { ok: false, issues: ['result is not an object'] };
  const result = value as unknown as GraphResult;
  if (result.schema !== GRAPH_RESULT_SCHEMA) issues.push('schema must be pi-northstar.graph-result');
  if (result.version !== 1) issues.push('version must be 1');
  if (typeof result.status !== 'string' || !GRAPH_STATUSES.has(result.status)) issues.push('status is invalid');
  if (result.language !== 'dql') issues.push('language must be dql');
  if (!isRecord(result.source) || !nonEmptyString((result.source as unknown as Record<string, unknown>).provider)) {
    issues.push('source.provider is required');
  }
  if (!isRecord(result.data)) {
    issues.push('data must be an object');
  } else {
    const data = result.data as Record<string, unknown>;
    if (data.kind === 'query') {
      if (typeof data.shape !== 'string' || !GRAPH_SHAPES.has(data.shape)) issues.push('data.shape is invalid');
      if (!('result' in data)) issues.push('data.result is required');
      else if (!validateGraphJsonValue(data.result)) issues.push('data.result exceeds JSON bounds');
    } else if (data.kind === 'probe') {
      if (!Array.isArray(data.items)) issues.push('data.items must be an array');
      else {
        for (const [index, item] of (data.items as unknown[]).entries()) {
          if (!isRecord(item)) {
            issues.push(`data.items[${index}] must be an object`);
            continue;
          }
          const row = item as Record<string, unknown>;
          if (typeof row.query !== 'string') issues.push(`data.items[${index}].query must be a string`);
          if (row.status === 'ok') {
            if (typeof row.hits !== 'number' || !Number.isInteger(row.hits) || row.hits < 0) {
              issues.push(`data.items[${index}].hits must be a non-negative integer`);
            }
          } else if (row.status === 'error') {
            if (!isValidGraphError(row.error)) issues.push(`data.items[${index}].error is invalid`);
          } else {
            issues.push(`data.items[${index}].status is invalid`);
          }
        }
      }
    } else if (data.kind === 'schema') {
      if (!isRecord(data.result)) issues.push('data.result must be an object');
      else validateSchemaResult(data.result, issues);
      if (data.meta !== undefined) {
        if (!isRecord(data.meta)) issues.push('data.meta must be an object');
        else {
          const meta = data.meta as Record<string, unknown>;
          if (meta.fetchedAt !== undefined && typeof meta.fetchedAt !== 'string') issues.push('data.meta.fetchedAt must be a string');
          if (meta.stale !== undefined && typeof meta.stale !== 'boolean') issues.push('data.meta.stale must be a boolean');
        }
      }
    } else {
      issues.push('data.kind is invalid');
    }
  }
  if (result.pagination !== undefined) {
    if (!isRecord(result.pagination)) issues.push('pagination must be an object');
    else {
      const pagination = result.pagination as Record<string, unknown>;
      if (typeof pagination.hasMore !== 'boolean') issues.push('pagination.hasMore must be a boolean');
      if (pagination.nextCursor !== undefined && typeof pagination.nextCursor !== 'string') {
        issues.push('pagination.nextCursor must be a string');
      }
    }
  }
  if (!Array.isArray(result.errors)) issues.push('errors must be an array');
  else {
    for (const [index, error] of result.errors.entries()) {
      if (!isValidGraphError(error)) issues.push(`errors[${index}] is invalid`);
    }
  }
  if (!Array.isArray(result.notes)) issues.push('notes must be an array');
  else if (result.notes.some((note) => typeof note !== 'string')) issues.push('notes must contain only strings');
  return issues.length === 0 ? { ok: true, result, issues } : { ok: false, issues };
}

export interface BuildGraphResultParams {
  status: GraphStatus;
  language: GraphLanguage;
  provider: string;
  data: GraphData;
  pagination?: { hasMore: boolean; nextCursor?: string };
  errors?: GraphError[];
  notes?: string[];
}

export function buildGraphResult(params: BuildGraphResultParams): GraphResult {
  const envelope: GraphResult = {
    schema: GRAPH_RESULT_SCHEMA,
    version: GRAPH_RESULT_VERSION,
    status: params.status,
    language: params.language,
    source: { provider: params.provider },
    data: params.data,
    errors: params.errors ?? [],
    notes: params.notes ?? [],
  };
  if (params.pagination !== undefined) envelope.pagination = { ...params.pagination };
  if (!validateGraphResult(envelope).ok) {
    throw new GraphContractError('contract_invalid_response', 'Internal graph result failed contract validation.');
  }
  return envelope;
}

export function toGraphError(code: GraphErrorCode, message: string, retryable: boolean, provider?: string): GraphError {
  const error: GraphError = { code, message: message.slice(0, 500), retryable };
  if (provider !== undefined) error.provider = provider;
  return error;
}
