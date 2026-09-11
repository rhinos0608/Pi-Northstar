// Knowledge result/request contract v1: `pi-northstar.knowledge-result`
// envelope, kg action validators, opaque cursor codec, claim/alignment/
// evidence types. Mirrors src/result-contract.ts status precedence.
// No provider HTTP or wiring here.

export const KNOWLEDGE_RESULT_SCHEMA = 'pi-northstar.knowledge-result';
export const KNOWLEDGE_RESULT_VERSION = 1 as const;

export type KgAction = 'search' | 'enhance' | 'analyze_text';
export type KgStatus = 'ok' | 'empty' | 'partial' | 'degraded' | 'error';

export type KgErrorCode =
  | 'invalid_input'
  | 'unsupported_option'
  | 'cursor_invalid'
  | 'pagination_not_supported'
  | 'transport_invalid_response'
  | 'contract_invalid_response'
  | 'semantic_invalid_response'
  | 'invalid_entity'
  | 'response_too_large'
  | 'upstream_error';

export interface KgError {
  code: KgErrorCode;
  message: string;
  retryable: boolean;
  provider?: string;
}

export interface KgRequest {
  tool: 'kg';
  action: KgAction;
  provider?: string;
  providers?: string[];
}

export interface KgEntity {
  entityVersion: 1;
  id: string;
  type: string;
  name?: string;
  url?: string;
  confidence?: number;
}

export interface KgClaim {
  subjectId: string;
  predicate: string;
  object?: string;
  /** Provider-asserted claim confidence. Never merged with alignment confidence. */
  confidence?: number;
  /** Trace tag: which provider asserted this claim. Follows conflicts across providers. */
  provider?: string;
  /** Fact-level evidence: provider_unsupported without jsonmode origins in v1. */
  evidence?: KgEvidence;
}

export type KgAlignmentBasis =
  | 'provider_id'
  | 'canonical_url'
  | 'email'
  | 'phone'
  | 'external_identifier'
  | 'typed_identity';

export type KgAlignmentStrength = 'exact' | 'strong' | 'heuristic';

export interface KgAlignment {
  basis: KgAlignmentBasis;
  strength: KgAlignmentStrength;
  /** Cross-provider alignment confidence. Distinct from claim confidence. */
  confidence?: number;
}

export type KgEvidenceStatus = 'provided' | 'not_requested' | 'provider_unsupported' | 'unavailable';

export interface KgEvidence {
  status: KgEvidenceStatus;
  provenance?: string;
}

export type KgData =
  | { kind: 'search'; entities: KgEntity[] }
  | {
      kind: 'enhance';
      entities: KgEntity[];
      claims: KgClaim[];
      conflicts: KgClaim[];
      partitions: KgPartition[];
      groups?: KgAlignedGroup[];
      evidence?: KgEntityEvidence[];
    }
  | {
      kind: 'analyze_text';
      entities: KgEntity[];
      mentions: KgMention[];
      facts: KgClaim[];
      topics: string[];
      sentiment?: string;
      partitions: KgPartition[];
    };

export interface KgMention {
  entityId: string;
  text: string;
  offset: number;
  length: number;
}

export interface KgPartition {
  provider: string;
  status: KgStatus;
  error?: KgError;
}

/** Aligned entity group view: members grouped without adjudication.
 * id is an opaque response-local deterministic-by-order tag
 * (alignment:1, alignment:2, ...). The internal identity key is never public. */
export interface KgAlignedMember {
  entity: KgEntity;
  provider: string;
}

export interface KgAlignedGroup {
  id: string;
  basis: KgAlignmentBasis;
  strength: KgAlignmentStrength;
  /** Cross-provider alignment confidence; set only when explicitly supplied, never computed. */
  alignmentConfidence?: number;
  members: KgAlignedMember[];
}

/** Per-entity evidence record for enhance output. */
export interface KgEntityEvidence {
  entityId: string;
  evidence: KgEvidence;
}

/** Atlas-owned field projection: normalized claim families per validated enhance fields. */
export const KG_BASIC_CLAIM_PREDICATES = ['name', 'type', 'url', 'description'] as const;
export const KG_CONTACT_CLAIM_PREDICATES = ['email', 'phone'] as const;
export const KG_PROFESSIONAL_CLAIM_PREDICATES = [
  'employer',
  'title',
  'education',
  'skill',
  'language',
  'category',
  'ceo',
  'founder',
  'boardMember',
  'employeeCount',
  'location',
  'parentCompany',
  'subsidiary',
  'competitor',
  'partner',
  'customer',
  'supplier',
  'investment',
  'acquiredBy',
] as const;

export const KG_FIELD_PROJECTION: Record<KgEnhanceFields, readonly string[]> = {
  basic: KG_BASIC_CLAIM_PREDICATES,
  contact: KG_CONTACT_CLAIM_PREDICATES,
  professional: KG_PROFESSIONAL_CLAIM_PREDICATES,
  all: [...KG_BASIC_CLAIM_PREDICATES, ...KG_CONTACT_CLAIM_PREDICATES, ...KG_PROFESSIONAL_CLAIM_PREDICATES],
};

export interface KgPagination {
  supported: boolean;
  limit: number;
  returned: number;
  hasMore: boolean;
  nextCursor?: string;
}

export interface KgSourceStatus {
  provider: string;
  status: KgStatus;
  count: number;
}

export interface KgResult {
  schema: typeof KNOWLEDGE_RESULT_SCHEMA;
  version: typeof KNOWLEDGE_RESULT_VERSION;
  status: KgStatus;
  request: KgRequest;
  data: KgData;
  pagination: KgPagination;
  sources: KgSourceStatus[];
  errors: KgError[];
  notes: string[];
}

export class KgContractError extends Error {
  readonly code: KgErrorCode;

  constructor(code: KgErrorCode, message: string) {
    super(message);
    this.name = 'KgContractError';
    this.code = code;
  }
}

// ── Small runtime guards ──

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalTrimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isPrimitiveStateValue(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

// ── Status precedence (mirrors result-contract.ts) ──
// 1. no entities plus errors → error
// 2. entities plus errors/invalid rows → partial
// 3. fallback/limited provider → degraded
// 4. no entities and no errors → empty
// 5. otherwise → ok

export function computeKgStatus(params: {
  entityCount: number;
  errorCount: number;
  invalidCount: number;
  degraded: boolean;
}): KgStatus {
  const { entityCount, errorCount, invalidCount, degraded } = params;
  if (entityCount === 0 && (errorCount > 0 || invalidCount > 0)) return 'error';
  if (entityCount > 0 && (errorCount > 0 || invalidCount > 0)) return 'partial';
  if (degraded) return 'degraded';
  if (entityCount === 0) return 'empty';
  return 'ok';
}

export interface KgSourceOutcome {
  provider: string;
  entities?: ReadonlyArray<KgEntity>;
  invalid?: number;
  error?: Omit<KgError, 'provider'>;
  degraded?: boolean;
}

export interface BuildKgResultParams {
  request: KgRequest;
  outcomes: ReadonlyArray<KgSourceOutcome>;
  data?: KgData;
  pagination?: Partial<KgPagination> & { limit?: number };
  notes?: string[];
}

function defaultKgData(action: KgAction, entities: KgEntity[]): KgData {
  if (action === 'enhance') return { kind: 'enhance', entities, claims: [], conflicts: [], partitions: [] };
  if (action === 'analyze_text') return { kind: 'analyze_text', entities, mentions: [], facts: [], topics: [], partitions: [] };
  return { kind: 'search', entities };
}

export function buildKnowledgeResult(params: BuildKgResultParams): KgResult {
  const entities: KgEntity[] = params.outcomes.flatMap((outcome) =>
    outcome.entities ? [...outcome.entities] : [],
  );
  const invalidCount = params.outcomes.reduce((total, outcome) => total + (outcome.invalid ?? 0), 0);
  const errors: KgError[] = [];
  const sources: KgSourceStatus[] = [];
  let degraded = false;

  for (const outcome of params.outcomes) {
    if (outcome.error) errors.push({ ...outcome.error, provider: outcome.provider });
    if ((outcome.invalid ?? 0) > 0) {
      errors.push({
        code: 'invalid_entity',
        message: `Dropped ${outcome.invalid} malformed row(s) from ${outcome.provider}.`,
        retryable: false,
        provider: outcome.provider,
      });
    }
    if (outcome.degraded) degraded = true;
    const count = outcome.entities?.length ?? 0;
    const failed = Boolean(outcome.error) || (outcome.invalid ?? 0) > 0;
    const status: KgStatus = failed
      ? (count > 0 ? 'partial' : 'error')
      : (outcome.degraded ? 'degraded' : (count > 0 ? 'ok' : 'empty'));
    sources.push({ provider: outcome.provider, status, count });
  }

  const data: KgData = params.data ?? defaultKgData(params.request.action, entities);
  const limit = params.pagination?.limit ?? entities.length;
  const pagination: KgPagination = {
    supported: params.pagination?.supported ?? false,
    limit,
    returned: entities.length,
    hasMore: params.pagination?.hasMore ?? false,
  };
  if (params.pagination?.nextCursor !== undefined) pagination.nextCursor = params.pagination.nextCursor;

  const envelope: KgResult = {
    schema: KNOWLEDGE_RESULT_SCHEMA,
    version: KNOWLEDGE_RESULT_VERSION,
    status: computeKgStatus({
      entityCount: entities.length,
      errorCount: errors.length,
      invalidCount,
      degraded,
    }),
    request: params.request,
    data,
    pagination,
    sources,
    errors,
    notes: params.notes ?? [],
  };
  // Fail closed: never return an envelope that violates the public contract.
  // Generic bounded message only; never serialize the offending payload/PII.
  // No recursion: validateKnowledgeResult is a pure shape check.
  if (!validateKnowledgeResult(envelope).ok) {
    throw new KgContractError('contract_invalid_response', 'Internal knowledge result failed contract validation.');
  }
  return envelope;
}

// ── Envelope validation (fail-closed) ──

const KG_STATUSES: ReadonlySet<string> = new Set(['ok', 'empty', 'partial', 'degraded', 'error']);
const KG_ACTIONS: ReadonlySet<string> = new Set(['search', 'enhance', 'analyze_text']);
const KG_ERROR_CODES: ReadonlySet<string> = new Set([
  'invalid_input',
  'unsupported_option',
  'cursor_invalid',
  'pagination_not_supported',
  'transport_invalid_response',
  'contract_invalid_response',
  'semantic_invalid_response',
  'invalid_entity',
  'response_too_large',
  'upstream_error',
]);

export interface KgValidationResult {
  ok: boolean;
  result?: KgResult;
  issues: string[];
}

export function validateKnowledgeResult(value: unknown): KgValidationResult {
  const issues: string[] = [];
  if (!isRecord(value)) return { ok: false, issues: ['result is not an object'] };
  const result = value as unknown as KgResult;
  if (result.schema !== KNOWLEDGE_RESULT_SCHEMA) issues.push('schema must be pi-northstar.knowledge-result');
  if (result.version !== 1) issues.push('version must be 1');
  if (typeof result.status !== 'string' || !KG_STATUSES.has(result.status)) issues.push('status is invalid');
  if (!isRecord(result.request)) issues.push('request must be an object');
  else {
    const request = result.request as Record<string, unknown>;
    if (request.tool !== 'kg') issues.push('request.tool must be kg');
    if (typeof request.action !== 'string' || !KG_ACTIONS.has(request.action)) {
      issues.push('request.action is invalid');
    }
  }
  if (!isRecord(result.data)) issues.push('data must be an object');
  else if (!nonEmptyString((result.data as { kind?: unknown }).kind)) issues.push('data.kind is required');
  if (!isRecord(result.pagination)) issues.push('pagination must be an object');
  else {
    const pagination = result.pagination as Record<string, unknown>;
    if (typeof pagination.supported !== 'boolean') issues.push('pagination.supported must be a boolean');
    if (typeof pagination.limit !== 'number' || !Number.isFinite(pagination.limit)) {
      issues.push('pagination.limit must be a number');
    }
    if (typeof pagination.returned !== 'number' || !Number.isFinite(pagination.returned)) {
      issues.push('pagination.returned must be a number');
    }
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
      if (!nonEmptyString(row.provider)) issues.push(`sources[${index}].provider is required`);
      if (typeof row.status !== 'string' || !KG_STATUSES.has(row.status)) {
        issues.push(`sources[${index}].status is invalid`);
      }
      if (typeof row.count !== 'number' || !Number.isFinite(row.count)) {
        issues.push(`sources[${index}].count must be a number`);
      }
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
      if (typeof row.code !== 'string' || !KG_ERROR_CODES.has(row.code)) {
        issues.push(`errors[${index}].code is invalid`);
      }
      if (typeof row.message !== 'string') issues.push(`errors[${index}].message must be a string`);
      if (typeof row.retryable !== 'boolean') issues.push(`errors[${index}].retryable must be a boolean`);
    }
  }
  if (!Array.isArray(result.notes)) issues.push('notes must be an array');
  else if (result.notes.some((note) => typeof note !== 'string')) issues.push('notes must contain only strings');
  if (issues.length === 0 && isRecord(result.data)) validateEnhanceDataShape(result.data as Record<string, unknown>, issues);
  return issues.length === 0 ? { ok: true, result, issues } : { ok: false, issues };
}

const KG_ENHANCE_DATA_KEYS: ReadonlySet<string> = new Set([
  'kind',
  'entities',
  'claims',
  'conflicts',
  'partitions',
  'groups',
  'evidence',
]);

const KG_CLAIM_KEYS: ReadonlySet<string> = new Set([
  'subjectId',
  'predicate',
  'object',
  'confidence',
  'provider',
  'evidence',
]);

const KG_EVIDENCE_KEYS: ReadonlySet<string> = new Set(['status', 'provenance']);
const KG_EVIDENCE_STATUSES: ReadonlySet<string> = new Set(['provided', 'not_requested', 'provider_unsupported', 'unavailable']);
const KG_ENTITY_KEYS: ReadonlySet<string> = new Set(['entityVersion', 'id', 'type', 'name', 'url', 'confidence']);
const KG_GROUP_KEYS: ReadonlySet<string> = new Set(['id', 'basis', 'strength', 'alignmentConfidence', 'members']);
const KG_MEMBER_KEYS: ReadonlySet<string> = new Set(['entity', 'provider']);
const KG_ENTITY_EVIDENCE_KEYS: ReadonlySet<string> = new Set(['entityId', 'evidence']);
const KG_ALIGNMENT_BASES: ReadonlySet<string> = new Set([
  'provider_id',
  'canonical_url',
  'email',
  'phone',
  'external_identifier',
  'typed_identity',
]);
const KG_ALIGNMENT_STRENGTHS: ReadonlySet<string> = new Set(['exact', 'strong', 'heuristic']);

function isValidKgEvidenceShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  for (const key of Object.keys(value)) {
    if (!KG_EVIDENCE_KEYS.has(key)) return false;
  }
  const row = value as Record<string, unknown>;
  if (typeof row.status !== 'string' || !KG_EVIDENCE_STATUSES.has(row.status)) return false;
  if (row.provenance !== undefined && !nonEmptyString(row.provenance)) return false;
  return true;
}

function isValidKgEntityShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  for (const key of Object.keys(value)) {
    if (!KG_ENTITY_KEYS.has(key)) return false;
  }
  const row = value as Record<string, unknown>;
  if (row.entityVersion !== 1) return false;
  if (!nonEmptyString(row.id) || !nonEmptyString(row.type)) return false;
  if (row.confidence !== undefined && (typeof row.confidence !== 'number' || !(row.confidence >= 0 && row.confidence <= 1))) {
    return false;
  }
  return true;
}

function isValidKgClaimShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  for (const key of Object.keys(value)) {
    if (!KG_CLAIM_KEYS.has(key)) return false;
  }
  const row = value as Record<string, unknown>;
  if (!nonEmptyString(row.subjectId) || !nonEmptyString(row.predicate)) return false;
  if (row.object !== undefined && typeof row.object !== 'string') return false;
  if (row.confidence !== undefined && (typeof row.confidence !== 'number' || !(row.confidence >= 0 && row.confidence <= 1))) {
    return false;
  }
  if (row.provider !== undefined && !nonEmptyString(row.provider)) return false;
  if (row.evidence !== undefined && !isValidKgEvidenceShape(row.evidence)) return false;
  return true;
}

function isValidKgAlignedMember(value: unknown): boolean {
  if (!isRecord(value)) return false;
  for (const key of Object.keys(value)) {
    if (!KG_MEMBER_KEYS.has(key)) return false;
  }
  const row = value as Record<string, unknown>;
  if (!nonEmptyString(row.provider)) return false;
  return isValidKgEntityShape(row.entity);
}

/** Action-specific enhance shape check: typed claims/partitions, no raw payload keys, no payload echo. */
function validateEnhanceDataShape(data: Record<string, unknown>, issues: string[]): void {
  if (data.kind === 'search') {
    validateSearchDataShape(data, issues);
    return;
  }
  if (data.kind === 'analyze_text') {
    validateAnalyzeTextDataShape(data, issues);
    return;
  }
  if (data.kind !== 'enhance') return;
  for (const key of Object.keys(data)) {
    if (!KG_ENHANCE_DATA_KEYS.has(key)) {
      issues.push('data must not contain raw provider payload');
      return;
    }
  }
  if (!Array.isArray(data.entities)) issues.push('data.entities must be an array');
  else {
    for (const [index, item] of (data.entities as unknown[]).entries()) {
      if (!isValidKgEntityShape(item)) issues.push(`data.entities[${index}] is not a valid entity`);
    }
  }
  for (const field of ['claims', 'conflicts'] as const) {
    if (!Array.isArray(data[field])) issues.push(`data.${field} must be an array`);
    else {
      for (const [index, item] of (data[field] as unknown[]).entries()) {
        if (!isValidKgClaimShape(item)) issues.push(`data.${field}[${index}] is not a valid claim`);
      }
    }
  }
  if (!Array.isArray(data.partitions)) issues.push('data.partitions must be an array');
  else {
    for (const [index, item] of (data.partitions as unknown[]).entries()) {
      if (!isRecord(item)) {
        issues.push(`data.partitions[${index}] must be an object`);
        continue;
      }
      const row = item as Record<string, unknown>;
      if (!nonEmptyString(row.provider)) issues.push(`data.partitions[${index}].provider is required`);
      if (typeof row.status !== 'string' || !KG_STATUSES.has(row.status)) {
        issues.push(`data.partitions[${index}].status is invalid`);
      }
    }
  }
  if (data.groups !== undefined) {
    if (!Array.isArray(data.groups)) issues.push('data.groups must be an array');
    else {
      for (const [index, item] of (data.groups as unknown[]).entries()) {
        if (!isRecord(item)) {
          issues.push(`data.groups[${index}] must be an object`);
          continue;
        }
        const row = item as Record<string, unknown>;
        for (const key of Object.keys(row)) {
          if (!KG_GROUP_KEYS.has(key)) {
            issues.push(`data.groups[${index}] must not contain raw provider payload`);
            break;
          }
        }
        if (!nonEmptyString(row.id)) issues.push(`data.groups[${index}].id is required`);
        if (typeof row.basis !== 'string' || !KG_ALIGNMENT_BASES.has(row.basis)) {
          issues.push(`data.groups[${index}].basis is invalid`);
        }
        if (typeof row.strength !== 'string' || !KG_ALIGNMENT_STRENGTHS.has(row.strength)) {
          issues.push(`data.groups[${index}].strength is invalid`);
        }
        if (
          row.alignmentConfidence !== undefined &&
          (typeof row.alignmentConfidence !== 'number' || !(row.alignmentConfidence >= 0 && row.alignmentConfidence <= 1))
        ) {
          issues.push(`data.groups[${index}].alignmentConfidence must be 0..1`);
        }
        if (!Array.isArray(row.members)) issues.push(`data.groups[${index}].members must be an array`);
        else {
          for (const [memberIndex, member] of (row.members as unknown[]).entries()) {
            if (!isValidKgAlignedMember(member)) {
              issues.push(`data.groups[${index}].members[${memberIndex}] is not a valid member`);
            }
          }
        }
      }
    }
  }
  if (data.evidence !== undefined) {
    if (!Array.isArray(data.evidence)) issues.push('data.evidence must be an array');
    else {
      for (const [index, item] of (data.evidence as unknown[]).entries()) {
        if (!isRecord(item)) {
          issues.push(`data.evidence[${index}] must be an object`);
          continue;
        }
        const row = item as Record<string, unknown>;
        for (const key of Object.keys(row)) {
          if (!KG_ENTITY_EVIDENCE_KEYS.has(key)) {
            issues.push(`data.evidence[${index}] must not contain raw provider payload`);
            break;
          }
        }
        if (!nonEmptyString(row.entityId)) issues.push(`data.evidence[${index}].entityId is required`);
        if (!isValidKgEvidenceShape(row.evidence)) issues.push(`data.evidence[${index}].evidence is invalid`);
      }
    }
  }
}

const KG_SEARCH_DATA_KEYS: ReadonlySet<string> = new Set(['kind', 'entities']);
const KG_ANALYZE_DATA_KEYS: ReadonlySet<string> = new Set([
  'kind',
  'entities',
  'mentions',
  'facts',
  'topics',
  'sentiment',
  'partitions',
]);

function validateEntityArray(data: Record<string, unknown>, issues: string[]): void {
  if (!Array.isArray(data.entities)) issues.push('data.entities must be an array');
  else {
    for (const [index, item] of (data.entities as unknown[]).entries()) {
      if (!isValidKgEntityShape(item)) issues.push(`data.entities[${index}] is not a valid entity`);
    }
  }
}

function validateSearchDataShape(data: Record<string, unknown>, issues: string[]): void {
  for (const key of Object.keys(data)) {
    if (!KG_SEARCH_DATA_KEYS.has(key)) {
      issues.push('data must not contain raw provider payload');
      return;
    }
  }
  validateEntityArray(data, issues);
}

function validateAnalyzeTextDataShape(data: Record<string, unknown>, issues: string[]): void {
  for (const key of Object.keys(data)) {
    if (!KG_ANALYZE_DATA_KEYS.has(key)) {
      issues.push('data must not contain raw provider payload');
      return;
    }
  }
  validateEntityArray(data, issues);
  if (!Array.isArray(data.mentions)) issues.push('data.mentions must be an array');
  else {
    for (const [index, item] of (data.mentions as unknown[]).entries()) {
      if (!isRecord(item)) {
        issues.push(`data.mentions[${index}] must be an object`);
        continue;
      }
      const row = item as Record<string, unknown>;
      if (!nonEmptyString(row.entityId) || typeof row.text !== 'string' || !Number.isInteger(row.offset) || !Number.isInteger(row.length)) {
        issues.push(`data.mentions[${index}] is not a valid mention`);
      }
    }
  }
  if (!Array.isArray(data.facts)) issues.push('data.facts must be an array');
  else {
    for (const [index, item] of (data.facts as unknown[]).entries()) {
      if (!isValidKgClaimShape(item)) issues.push(`data.facts[${index}] is not a valid claim`);
    }
  }
  if (!Array.isArray(data.topics)) issues.push('data.topics must be an array');
  else if ((data.topics as unknown[]).some((topic) => typeof topic !== 'string')) {
    issues.push('data.topics must contain only strings');
  }
  if (data.sentiment !== undefined && typeof data.sentiment !== 'string') {
    issues.push('data.sentiment must be a string');
  }
  if (!Array.isArray(data.partitions)) issues.push('data.partitions must be an array');
}

// ── Action validators (public inputs, runtime-checked) ──

export type KgSearchInput = { query?: unknown; language?: unknown; limit?: unknown };
export type KgSearchResult =
  | { ok: true; query: string; language: 'dql'; limit?: number }
  | { ok: false; code: KgErrorCode; message: string };

// Entity-returning DQL only. Facet/report/export/collection/crawl syntax
// is fail-closed unsupported_option, never silently narrowed.
const DQL_UNSUPPORTED = /\b(facet|facets|report|reports|export|exports|collection|collections|crawl|bulkenhance|bulk\s+enhance)\b|format\s*=\s*(csv|xml|jsonl?)|\bfrom\s+[a-z0-9_-]*collection/i;

export function validateKgSearch(input: KgSearchInput): KgSearchResult {
  if (!isRecord(input)) return { ok: false, code: 'invalid_input', message: 'search input must be an object' };
  if (input.language !== 'dql') {
    return { ok: false, code: 'unsupported_option', message: "language must be 'dql' in v1" };
  }
  if (!nonEmptyString(input.query)) return { ok: false, code: 'invalid_input', message: 'query is required' };
  const query = (input.query as string).trim();
  const unquoted = query.replace(/"(?:[^"\\]|\\.)*"/g, ' ');
  if (DQL_UNSUPPORTED.test(unquoted)) {
    return { ok: false, code: 'unsupported_option', message: 'facet/report/export/collection/crawl modes are unsupported in v1' };
  }
  if (input.limit !== undefined) {
    if (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) {
      return { ok: false, code: 'invalid_input', message: 'limit must be an integer 1..50' };
    }
    return { ok: true, query, language: 'dql', limit: input.limit };
  }
  return { ok: true, query, language: 'dql' };
}

export const KG_ENHANCE_FIELDS = ['basic', 'contact', 'professional', 'all'] as const;
export type KgEnhanceFields = (typeof KG_ENHANCE_FIELDS)[number];

export type KgEnhanceResult =
  | {
      ok: true;
      type: 'Person' | 'Organization';
      selectors: Record<string, string>;
      fields?: KgEnhanceFields;
      maxEntities?: number;
      includeRelationships?: boolean;
      includeEvidence?: boolean;
      confidenceThreshold?: number;
    }
  | { ok: false; code: KgErrorCode; message: string };

const ENHANCE_SELECTOR_KEYS = ['id', 'name', 'url', 'email', 'phone', 'location', 'description'] as const;
const PERSON_ONLY_KEYS = ['employer', 'title', 'school'] as const;

export function validateKgEnhance(input: unknown): KgEnhanceResult {
  if (!isRecord(input)) return { ok: false, code: 'invalid_input', message: 'enhance input must be an object' };
  if (input.type !== 'Person' && input.type !== 'Organization') {
    return { ok: false, code: 'invalid_input', message: 'type must be Person or Organization' };
  }
  for (const key of PERSON_ONLY_KEYS) {
    if (input[key] !== undefined && input.type !== 'Person') {
      return { ok: false, code: 'invalid_input', message: `${key} is Person-only` };
    }
  }
  const selectors: Record<string, string> = {};
  for (const key of [...ENHANCE_SELECTOR_KEYS, ...PERSON_ONLY_KEYS]) {
    const trimmed = optionalTrimmed(input[key]);
    if (trimmed !== undefined) selectors[key] = trimmed;
  }
  if (Object.keys(selectors).length === 0) {
    return { ok: false, code: 'invalid_input', message: 'at least one selector is required' };
  }
  if (input.fields !== undefined && !KG_ENHANCE_FIELDS.includes(input.fields as KgEnhanceFields)) {
    return { ok: false, code: 'invalid_input', message: `fields must be one of ${KG_ENHANCE_FIELDS.join(', ')}` };
  }
  if (input.maxEntities !== undefined) {
    if (typeof input.maxEntities !== 'number' || !Number.isInteger(input.maxEntities) || input.maxEntities < 1 || input.maxEntities > 10) {
      return { ok: false, code: 'invalid_input', message: 'maxEntities must be an integer 1..10' };
    }
  }
  for (const key of ['includeRelationships', 'includeEvidence'] as const) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') {
      return { ok: false, code: 'invalid_input', message: `${key} must be a boolean` };
    }
  }
  if (input.confidenceThreshold !== undefined) {
    if (typeof input.confidenceThreshold !== 'number' || !(input.confidenceThreshold >= 0 && input.confidenceThreshold <= 1)) {
      return { ok: false, code: 'invalid_input', message: 'confidenceThreshold must be 0..1' };
    }
  }
  return {
    ok: true,
    type: input.type,
    selectors,
    ...(input.fields !== undefined ? { fields: input.fields as KgEnhanceFields } : {}),
    ...(typeof input.maxEntities === 'number' ? { maxEntities: input.maxEntities } : {}),
    ...(typeof input.includeRelationships === 'boolean' ? { includeRelationships: input.includeRelationships } : {}),
    ...(typeof input.includeEvidence === 'boolean' ? { includeEvidence: input.includeEvidence } : {}),
    ...(typeof input.confidenceThreshold === 'number' ? { confidenceThreshold: input.confidenceThreshold } : {}),
  };
}

export const KG_NLP_MAX_CHARS = 100_000;

export type KgNlpResult =
  | {
      ok: true;
      text: string;
      extractEntities: boolean;
      extractFacts: boolean;
      extractSentiment: boolean;
      extractTopics: boolean;
      language: string;
    }
  | { ok: false; code: KgErrorCode; message: string };

export function validateKgNlp(input: unknown): KgNlpResult {
  if (!isRecord(input)) return { ok: false, code: 'invalid_input', message: 'analyze_text input must be an object' };
  if (typeof input.text !== 'string' || input.text.length < 1 || input.text.length > KG_NLP_MAX_CHARS) {
    return { ok: false, code: 'invalid_input', message: `text must be 1..${KG_NLP_MAX_CHARS} chars` };
  }
  for (const key of ['extractEntities', 'extractFacts', 'extractSentiment', 'extractTopics'] as const) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') {
      return { ok: false, code: 'invalid_input', message: `${key} must be a boolean` };
    }
  }
  const language = input.language === undefined ? 'auto' : input.language;
  if (language !== 'auto' && !(typeof language === 'string' && /^[a-z]{2}$/.test(language))) {
    return { ok: false, code: 'invalid_input', message: 'language must be ISO 639-1 or auto' };
  }
  return {
    ok: true,
    text: input.text,
    extractEntities: input.extractEntities === true,
    extractFacts: input.extractFacts === true,
    extractSentiment: input.extractSentiment === true,
    extractTopics: input.extractTopics === true,
    language,
  };
}

// ── Cursor codec (opaque, hostile-input validated) ──
// Payload {v: 1, provider, fingerprint, adapterCursorV, state}.
// Explicit multi-provider fanout never issues a cursor: single-provider
// adapters call encodeKgCursor; fanout paths return one bounded page.

export const MAX_KG_CURSOR_LENGTH = 4096;

export interface KgCursorState {
  [key: string]: string | number | boolean | null;
}

export interface KgCursorInput {
  provider: string;
  fingerprint: string;
  adapterCursorV: number;
  state: KgCursorState;
}

export interface DecodedKgCursor extends KgCursorInput {
  v: 1;
}

export function encodeKgCursor(input: KgCursorInput): string {
  if (!nonEmptyString(input.provider)) throw new KgContractError('cursor_invalid', 'cursor provider is required');
  if (!nonEmptyString(input.fingerprint)) throw new KgContractError('cursor_invalid', 'cursor fingerprint is required');
  if (!Number.isInteger(input.adapterCursorV)) throw new KgContractError('cursor_invalid', 'cursor adapterCursorV must be an integer');
  if (!isRecord(input.state)) throw new KgContractError('cursor_invalid', 'cursor state must be an object');
  const payload = { v: 1, provider: input.provider, fingerprint: input.fingerprint, adapterCursorV: input.adapterCursorV, state: input.state };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeKgCursor(cursor: string): DecodedKgCursor {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw new KgContractError('cursor_invalid', 'cursor is required');
  }
  if (cursor.length > MAX_KG_CURSOR_LENGTH) {
    throw new KgContractError('cursor_invalid', `cursor exceeds maximum length of ${MAX_KG_CURSOR_LENGTH}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new KgContractError('cursor_invalid', 'cursor is not a valid opaque token');
  }
  if (!isRecord(payload) || payload.v !== 1) throw new KgContractError('cursor_invalid', 'cursor payload is invalid');
  if (!nonEmptyString(payload.provider)) throw new KgContractError('cursor_invalid', 'cursor provider is invalid');
  if (!nonEmptyString(payload.fingerprint)) throw new KgContractError('cursor_invalid', 'cursor fingerprint is invalid');
  if (!Number.isInteger(payload.adapterCursorV)) {
    throw new KgContractError('cursor_invalid', 'cursor adapterCursorV is invalid');
  }
  if (!isRecord(payload.state)) throw new KgContractError('cursor_invalid', 'cursor state is invalid');
  for (const [key, value] of Object.entries(payload.state)) {
    if (!isPrimitiveStateValue(value)) {
      throw new KgContractError('cursor_invalid', `cursor state.${key} has an unsupported type`);
    }
  }
  return {
    v: 1,
    provider: payload.provider as string,
    fingerprint: payload.fingerprint as string,
    adapterCursorV: payload.adapterCursorV as number,
    state: payload.state as KgCursorState,
  };
}

// ── Ontology + row parsing (provider-normalized outputs validated) ──

export function normalizeOntologyTerm(term: string, knownTerms: ReadonlyArray<string>): string {
  if (knownTerms.includes(term)) return term;
  return `diffbot:${term}`;
}

export type KgEntityParseResult =
  | { ok: true; entity: KgEntity }
  | { ok: false; code: 'invalid_entity'; reason: string };

const MAX_KG_TEXT_CHARS = 8_000;

export function parseKgEntity(raw: unknown, provider: string): KgEntityParseResult {
  if (!nonEmptyString(provider)) return { ok: false, code: 'invalid_entity', reason: 'provider is required' };
  if (!isRecord(raw)) return { ok: false, code: 'invalid_entity', reason: 'row is not an object' };
  const id = optionalTrimmed(raw.id) ?? optionalTrimmed(raw.provider_id);
  if (!id) return { ok: false, code: 'invalid_entity', reason: 'row missing id' };
  const type = optionalTrimmed(raw.type);
  if (!type) return { ok: false, code: 'invalid_entity', reason: 'row missing type' };
  void provider;
  const entity: KgEntity = {
    entityVersion: 1,
    id: id.slice(0, 512),
    type: type.slice(0, 128),
  };
  const name = optionalTrimmed(raw.name);
  if (name !== undefined) entity.name = name.slice(0, MAX_KG_TEXT_CHARS);
  const url = optionalTrimmed(raw.url ?? raw.canonical_url);
  if (url !== undefined) entity.url = url.slice(0, 2_048);
  if (raw.confidence !== undefined) {
    if (typeof raw.confidence !== 'number' || !(raw.confidence >= 0 && raw.confidence <= 1)) {
      return { ok: false, code: 'invalid_entity', reason: 'row confidence must be 0..1' };
    }
    entity.confidence = raw.confidence;
  }
  return { ok: true, entity };
}
