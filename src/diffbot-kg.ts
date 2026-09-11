// Diffbot KG provider adapter: kg search (DQL POST), enhance (POST),
// analyze_text (NL Process Text POST). Canonical docs win over CLI shape:
// POST https://kg.diffbot.com/kg/v3/dql body {query, size, from}
// POST https://kg.diffbot.com/kg/v3/enhance body {type, selectors, size}
// POST https://nl.diffbot.com/v1/?fields=&token= body [{content, lang?}]
// Token travels via diffbotFetch `?token=` query only, never in POST bodies.
// No routing, fusion, or tool registration here.

import {
  DIFFBOT_KG_HOST,
  DIFFBOT_NL_HOST,
  DiffbotError,
  diffbotFetch,
  type DiffbotFetchOptions,
} from './diffbot-transport.js';
import {
  buildKgEvidence,
} from './knowledge-aggregate.js';
import {
  extractDiffbotKgIdentitySignals,
  extractEnhanceClaims,
  filterKgClaimsByConfidence,
  filterKgEntitiesByConfidence,
  projectEnhanceClaimsByFields,
  type KgIdentitySignals,
} from './knowledge-normalize.js';
import {
  normalizeOntologyTerm,
  parseKgEntity,
  validateKgEnhance,
  validateKgNlp,
  validateKgSearch,
  type KgClaim,
  type KgEntity,
  type KgEntityEvidence,
  type KgError,
  type KgErrorCode,
  type KgMention,
} from './knowledge-contract.js';

export const DIFFBOT_KG_PROVIDER = 'diffbot' as const;
export const DIFFBOT_KG_ADAPTER_CURSOR_V = 1 as const;

const DEFAULT_SEARCH_SIZE = 10;
const DEFAULT_ENHANCE_SIZE = 1;

// Ontology terms seen on Diffbot KG/NL payloads (docs ontology + CLI types).
const KNOWN_ONTOLOGY_TERMS = [
  'Person',
  'Organization',
  'Article',
  'Product',
  'Place',
  'Event',
  'CreativeWork',
  'JobPost',
  'AdministrativeArea',
  'Skill',
  'Discussion',
  'Image',
  'Video',
  'LegalEntity',
  'Research',
] as const;

type FetchFn = (options: DiffbotFetchOptions) => Promise<unknown>;

export interface DiffbotKgSpend {
  /** Operator-configured search default (omitted limit) and cap (reject above, never clamp). */
  searchDefault?: number;
  searchCap?: number;
  /** Operator-configured enhance default (omitted maxEntities) and cap. */
  enhanceDefault?: number;
  enhanceCap?: number;
  /** Operator-configured NLP input cap; hard ceiling 100000 remains. */
  nlpMaxChars?: number;
}

export interface DiffbotKgContext {
  token: string;
  fetchFn?: FetchFn;
  signal?: AbortSignal;
  timeoutMs?: number;
  spend?: DiffbotKgSpend;
}

export const DIFFBOT_KG_MAX_FROM = 10_000 as const;

export interface DiffbotKgOutcome {
  provider: typeof DIFFBOT_KG_PROVIDER;
  entities: KgEntity[];
  invalid: number;
  /** Normalized internal identity signals aligned 1:1 with entities. Never serialized. */
  signals?: KgIdentitySignals[];
  error?: KgError;
  /** Enhance/search notes (match-score presence, text fallback). Never raw payload. */
  notes?: string[];
  /** Enhance-only: whitelisted provider-normalized claims with provider trace tags. */
  claims?: KgClaim[];
  /** Enhance-only: per-entity evidence records. */
  evidence?: KgEntityEvidence[];
}

export interface DiffbotNlpOutcome extends DiffbotKgOutcome {
  mentions: KgMention[];
  facts: KgClaim[];
  topics: string[];
  sentiment?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** Redact email/phone selector PII from adapter-built error strings. */
function redactSelectors(message: string): string {
  return message
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[REDACTED_PHONE]')
    .slice(0, 500);
}

function toKgError(code: KgErrorCode, message: string, retryable: boolean): KgError {
  return { code, message: redactSelectors(message), retryable, provider: DIFFBOT_KG_PROVIDER };
}

function fromDiffbotError(error: DiffbotError, token: string): KgError {
  const scrubbed = token ? error.message.split(token).join('[REDACTED]') : error.message;
  return toKgError(error.code, scrubbed, error.retryable);
}

function missingToken(): DiffbotKgOutcome {
  return {
    provider: DIFFBOT_KG_PROVIDER,
    entities: [],
    invalid: 0,
    error: toKgError('contract_invalid_response', 'DIFFBOT_TOKEN is not configured', false),
  };
}

function canonicalType(raw: unknown): string | undefined {
  const text = trimmedString(raw);
  if (!text) return undefined;
  const single = text.split(/[/:]/).pop() ?? text;
  const titled = single.charAt(0).toUpperCase() + single.slice(1);
  return normalizeOntologyTerm(
    (KNOWN_ONTOLOGY_TERMS as readonly string[]).includes(single)
      ? single
      : titled,
    KNOWN_ONTOLOGY_TERMS as unknown as readonly string[],
  );
}

/** Map a Diffbot KG/NL entity object onto a contract row for parseKgEntity. */
function toEntityRow(raw: unknown): { row: Record<string, unknown>; source: Record<string, unknown> } | { invalid: string } {
  if (!isRecord(raw)) return { invalid: 'row is not an object' };
  if (Array.isArray((raw as Record<string, unknown>).errors) && ((raw as Record<string, unknown>).errors as unknown[]).length > 0) {
    return { invalid: 'row upstream errors present' };
  }
  const row = raw.entity !== undefined ? raw.entity : raw;
  if (!isRecord(row)) return { invalid: 'row entity is not an object' };
  if (Array.isArray(row.errors) && (row.errors as unknown[]).length > 0) {
    return { invalid: 'row entity upstream errors present' };
  }
  if (row.error !== undefined || row.errorCode !== undefined) {
    return { invalid: `row upstream error: ${trimmedString(row.error) ?? 'unknown'}` };
  }
  const type = canonicalType(row.type ?? row.types) ?? trimmedString((row as Record<string, unknown>).entityType);
  const firstType = Array.isArray(row.allTypes)
    ? canonicalType((row.allTypes[0] as Record<string, unknown> | undefined)?.name)
    : undefined;
  return {
    row: {
      id: row.diffbotUri ?? row.id ?? row.uri ?? row.pageUrl,
      provider_id: row.id,
      type: type ?? firstType ?? row.type,
      name: row.name ?? row.label ?? row.title,
      url: row.homepageUri ?? row.pageUrl ?? row.resolvedPageUrl ?? row.url,
      canonical_url: row.homepageUri ?? row.pageUrl,
      confidence: row.confidence,
    },
    source: row,
  };
}

function collectEntities(rows: unknown): { entities: KgEntity[]; invalid: number; signals: KgIdentitySignals[] } {
  const entities: KgEntity[] = [];
  const signals: KgIdentitySignals[] = [];
  let invalid = 0;
  for (const item of rows as unknown[]) {
    const mapped = toEntityRow(item);
    if ('invalid' in mapped) {
      invalid += 1;
      continue;
    }
    const parsed = parseKgEntity(mapped.row, DIFFBOT_KG_PROVIDER);
    if (parsed.ok) {
      entities.push(parsed.entity);
      signals.push(extractDiffbotKgIdentitySignals(mapped.source, parsed.entity.id));
    } else invalid += 1;
  }
  return { entities, invalid, signals };
}

const SEARCH_HARD_CEILING = 50;
const ENHANCE_HARD_CEILING = 10;
// Docs Enhance POST types: only name/url/email are string[]; id, location,
// phone, description, employer, title, school are strings. Never wrap strings in arrays.
const ARRAY_SELECTORS: ReadonlySet<string> = new Set(['name', 'url', 'email']);

/** Top-level `errors[]` envelope on 200 responses (Diffbot enhance/DQL shape). Never raw. */
function topLevelErrors(message: Record<string, unknown>, token: string): string | undefined {
  if (!Array.isArray(message.errors) || (message.errors as unknown[]).length === 0) return undefined;
  const detail = (message.errors as unknown[]).filter((entry) => typeof entry === 'string').join('; ');
  const scrubbed = token ? detail.split(token).join('[REDACTED]') : detail;
  return redactSelectors(scrubbed.slice(0, 500) || 'upstream errors present');
}

export interface DiffbotKgSearchInput {
  query?: unknown;
  language?: unknown;
  limit?: unknown;
  from?: unknown;
}

export async function searchDiffbotKg(
  input: DiffbotKgSearchInput,
  ctx: DiffbotKgContext,
): Promise<DiffbotKgOutcome> {
  const fail = (code: KgErrorCode, message: string): DiffbotKgOutcome => ({
    provider: DIFFBOT_KG_PROVIDER,
    entities: [],
    invalid: 0,
    error: toKgError(code, message, false),
  });
  if (!ctx.token) return missingToken();
  const language = input.language === undefined ? 'dql' : input.language;
  const validated = validateKgSearch({ query: input.query, language, limit: input.limit });
  if (!validated.ok) return fail(validated.code, validated.message);
  const searchSize = validated.limit ?? ctx.spend?.searchDefault ?? DEFAULT_SEARCH_SIZE;
  const searchCap = ctx.spend?.searchCap ?? SEARCH_HARD_CEILING;
  if (searchSize > searchCap) {
    return fail('invalid_input', `limit ${searchSize} exceeds operator cap ${searchCap}`);
  }
  let from = 0;
  if (input.from !== undefined) {
    if (typeof input.from !== 'number' || !Number.isInteger(input.from) || input.from < 0) {
      return fail('invalid_input', 'from must be an integer >= 0');
    }
    if (input.from > DIFFBOT_KG_MAX_FROM || input.from + searchSize > DIFFBOT_KG_MAX_FROM) {
      return fail('cursor_invalid', `from offset out of range: must satisfy from <= ${DIFFBOT_KG_MAX_FROM} and from+size <= ${DIFFBOT_KG_MAX_FROM}`);
    }
    from = input.from;
  }
  const fetchFn: FetchFn = ctx.fetchFn ?? diffbotFetch;
  let parsed: unknown;
  try {
    parsed = await fetchFn({
      host: DIFFBOT_KG_HOST,
      path: '/kg/v3/dql',
      method: 'POST',
      token: ctx.token,
      body: { type: 'query', query: validated.query, size: searchSize, from },
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
    });
  } catch (error) {
    if (error instanceof DiffbotError) {
      return { provider: DIFFBOT_KG_PROVIDER, entities: [], invalid: 0, error: fromDiffbotError(error, ctx.token) };
    }
    throw error;
  }
  if (!isRecord(parsed)) {
    return fail('contract_invalid_response', 'DQL response envelope is not an object');
  }
  const topErrors = topLevelErrors(parsed, ctx.token);
  if (topErrors !== undefined) {
    return {
      provider: DIFFBOT_KG_PROVIDER,
      entities: [],
      invalid: 0,
      error: toKgError('upstream_error', topErrors, false),
    };
  }
  if (parsed.facet === true) {
    return {
      provider: DIFFBOT_KG_PROVIDER,
      entities: [],
      invalid: 0,
      error: toKgError('semantic_invalid_response', 'DQL response is a facet report, not entity rows', false),
    };
  }
  if (!Array.isArray(parsed.data)) {
    return fail('contract_invalid_response', 'DQL response data[] is missing');
  }
  const { entities, invalid, signals } = collectEntities(parsed.data);
  const notes: string[] = [];
  if (parsed.textFallback === true) notes.push('diffbot:text_fallback');
  return {
    provider: DIFFBOT_KG_PROVIDER,
    entities,
    invalid,
    signals,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

// ── enhance (POST, portable options only) ──

export async function enhanceDiffbotKg(
  input: unknown,
  ctx: DiffbotKgContext,
): Promise<DiffbotKgOutcome> {
  const fail = (code: KgErrorCode, message: string): DiffbotKgOutcome => ({
    provider: DIFFBOT_KG_PROVIDER,
    entities: [],
    invalid: 0,
    error: toKgError(code, message, false),
  });
  if (!ctx.token) return missingToken();
  const validated = validateKgEnhance(input);
  if (!validated.ok) return fail(validated.code, validated.message);
  // Portable mapping: maxEntities -> size. fields/includeRelationships/
  // includeEvidence/confidenceThreshold apply client-side post-fetch.
  // No refresh/threshold/search/filter native options are sent.
  const enhanceSize = validated.maxEntities ?? ctx.spend?.enhanceDefault ?? DEFAULT_ENHANCE_SIZE;
  const enhanceCap = ctx.spend?.enhanceCap ?? ENHANCE_HARD_CEILING;
  if (enhanceSize > enhanceCap) {
    return fail('invalid_input', `maxEntities ${enhanceSize} exceeds operator cap ${enhanceCap}`);
  }
  const body: Record<string, unknown> = { type: validated.type };
  for (const [key, value] of Object.entries(validated.selectors)) {
    body[key] = ARRAY_SELECTORS.has(key) ? [value] : value;
  }
  body.size = enhanceSize;
  const fetchFn: FetchFn = ctx.fetchFn ?? diffbotFetch;
  let parsed: unknown;
  try {
    parsed = await fetchFn({
      host: DIFFBOT_KG_HOST,
      path: '/kg/v3/enhance',
      method: 'POST',
      token: ctx.token,
      body,
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
    });
  } catch (error) {
    if (error instanceof DiffbotError) {
      return { provider: DIFFBOT_KG_PROVIDER, entities: [], invalid: 0, error: fromDiffbotError(error, ctx.token) };
    }
    throw error;
  }
  if (!isRecord(parsed)) {
    return fail('contract_invalid_response', 'Enhance response envelope is not an object');
  }
  const enhanceErrors = topLevelErrors(parsed, ctx.token);
  if (enhanceErrors !== undefined) {
    return {
      provider: DIFFBOT_KG_PROVIDER,
      entities: [],
      invalid: 0,
      error: toKgError('upstream_error', enhanceErrors, false),
    };
  }
  const data = parsed.data ?? parsed.entities;
  if (!Array.isArray(data)) {
    return fail('contract_invalid_response', 'Enhance response data[] is missing');
  }
  const entities: KgEntity[] = [];
  const sources: Record<string, unknown>[] = [];
  let invalid = 0;
  let matchScoresPresent = false;
  for (const item of data as unknown[]) {
    if (isRecord(item) && (item.score !== undefined || item.esscore !== undefined)) matchScoresPresent = true;
    const mapped = toEntityRow(item);
    if ('invalid' in mapped) {
      invalid += 1;
      continue;
    }
    const parsedEntity = parseKgEntity(mapped.row, DIFFBOT_KG_PROVIDER);
    if (!parsedEntity.ok) {
      invalid += 1;
      continue;
    }
    entities.push(parsedEntity.entity);
    sources.push(mapped.source);
  }
  const threshold = validated.confidenceThreshold;
  const keptEntities = filterKgEntitiesByConfidence(entities, threshold);
  const keptSources = sources.filter((_, index) => keptEntities.includes(entities[index] as KgEntity));
  const evidenceRequested = validated.includeEvidence === true;
  const claimEvidenceStatus = evidenceRequested ? 'provider_unsupported' as const : 'not_requested' as const;
  let claims: KgClaim[] = [];
  for (let index = 0; index < keptEntities.length; index += 1) {
    const entity = keptEntities[index] as KgEntity;
    const extracted = extractEnhanceClaims(keptSources[index], entity.id, {
      provider: DIFFBOT_KG_PROVIDER,
      ...(validated.includeRelationships === undefined ? {} : { includeRelationships: validated.includeRelationships }),
    });
    for (const claim of extracted) {
      claims.push({ ...claim, evidence: { status: claimEvidenceStatus } });
    }
  }
  claims = projectEnhanceClaimsByFields(claims, validated.fields ?? 'all');
  claims = filterKgClaimsByConfidence(claims, threshold);
  const evidence: KgEntityEvidence[] = keptEntities.map((entity) => ({
    entityId: entity.id,
    evidence: buildKgEvidence({
      requested: evidenceRequested,
      providerSupports: true,
      provenance: entity.url ?? entity.id,
    }),
  }));
  const signals: KgIdentitySignals[] = keptEntities.map((entity, index) =>
    extractDiffbotKgIdentitySignals(keptSources[index], entity.id),
  );
  const notes: string[] = [];
  if (matchScoresPresent) notes.push('diffbot:match_scores_present');
  return {
    provider: DIFFBOT_KG_PROVIDER,
    entities: keptEntities,
    invalid,
    signals,
    claims,
    evidence,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

// ── analyze_text (NL Process Text POST, one-document array) ──

export async function analyzeTextDiffbotKg(
  input: unknown,
  ctx: DiffbotKgContext,
): Promise<DiffbotNlpOutcome> {
  const fail = (code: KgErrorCode, message: string): DiffbotNlpOutcome => ({
    provider: DIFFBOT_KG_PROVIDER,
    entities: [],
    invalid: 0,
    mentions: [],
    facts: [],
    topics: [],
    error: toKgError(code, message, false),
  });
  if (!ctx.token) {
    return {
      provider: DIFFBOT_KG_PROVIDER,
      entities: [],
      invalid: 0,
      mentions: [],
      facts: [],
      topics: [],
      error: toKgError('contract_invalid_response', 'DIFFBOT_TOKEN is not configured', false),
    };
  }
  const validated = validateKgNlp(input);
  if (!validated.ok) return fail(validated.code, validated.message);
  if (ctx.spend?.nlpMaxChars !== undefined && validated.text.length > ctx.spend.nlpMaxChars) {
    return fail('invalid_input', `text length ${validated.text.length} exceeds operator cap ${ctx.spend.nlpMaxChars}`);
  }
  const fields: string[] = [];
  if (validated.extractEntities) fields.push('entities');
  if (validated.extractFacts) fields.push('facts');
  if (validated.extractSentiment) fields.push('sentiment');
  // Topics derive client-side from the categories object; no native field
  // passthrough beyond the three canonical extract flags.
  const doc: Record<string, unknown> = { content: validated.text };
  if (validated.language !== 'auto') doc.lang = validated.language;
  const fetchFn: FetchFn = ctx.fetchFn ?? diffbotFetch;
  let parsed: unknown;
  try {
    parsed = await fetchFn({
      host: DIFFBOT_NL_HOST,
      path: '/v1/',
      method: 'POST',
      token: ctx.token,
      ...(fields.length > 0 ? { query: { fields: fields.join(',') } } : {}),
      body: [doc],
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
    });
  } catch (error) {
    if (error instanceof DiffbotError) {
      return { ...fail('upstream_error', error.message), error: fromDiffbotError(error, ctx.token) };
    }
    throw error;
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !isRecord(parsed[0])) {
    return fail('contract_invalid_response', 'NLP response is not a one-document array');
  }
  const docOut = parsed[0] as Record<string, unknown>;
  let invalid = 0;
  const entities: KgEntity[] = [];
  const mentions: KgMention[] = [];
  if (validated.extractEntities || (!validated.extractFacts && !validated.extractSentiment && !validated.extractTopics)) {
    const rawEntities = Array.isArray(docOut.entities) ? docOut.entities : [];
    for (const raw of rawEntities) {
      const mapped = toEntityRow(raw);
      if ('invalid' in mapped) {
        invalid += 1;
        continue;
      }
      const parsedEntity = parseKgEntity(mapped.row, DIFFBOT_KG_PROVIDER);
      if (!parsedEntity.ok) {
        invalid += 1;
        continue;
      }
      entities.push(parsedEntity.entity);
      if (!isRecord(raw)) continue;
      const rawMentions = (raw as Record<string, unknown>).mentions;
      if (!Array.isArray(rawMentions)) continue;
      for (const mention of rawMentions) {
        if (!isRecord(mention)) {
          invalid += 1;
          continue;
        }
        const text = trimmedString(mention.text);
        const begin = mention.beginOffset;
        const end = mention.endOffset;
        if (
          text === undefined ||
          typeof begin !== 'number' ||
          !Number.isInteger(begin) ||
          typeof end !== 'number' ||
          !Number.isInteger(end) ||
          begin < 0 ||
          end <= begin ||
          end > validated.text.length ||
          validated.text.slice(begin, end) !== text
        ) {
          invalid += 1;
          continue;
        }
        mentions.push({ entityId: parsedEntity.entity.id, text, offset: begin, length: end - begin });
      }
    }
  }
  const facts: KgClaim[] = [];
  if (validated.extractFacts || (!validated.extractEntities && !validated.extractSentiment && !validated.extractTopics)) {
    const rawFacts = Array.isArray(docOut.facts) ? docOut.facts : [];
    for (const fact of rawFacts) {
      if (!isRecord(fact)) {
        invalid += 1;
        continue;
      }
      const entity = isRecord(fact.entity) ? fact.entity : undefined;
      const property = isRecord(fact.property) ? fact.property : undefined;
      const value = isRecord(fact.value) ? fact.value : undefined;
      const subjectId = trimmedString(entity?.diffbotUri) ?? trimmedString(entity?.name);
      const predicate = trimmedString(property?.name);
      if (!subjectId || !predicate) {
        invalid += 1;
        continue;
      }
      const object = trimmedString(value?.name) ?? trimmedString(fact.humanReadable);
      const confidence = typeof entity?.confidence === 'number' && entity.confidence >= 0 && entity.confidence <= 1
        ? entity.confidence
        : undefined;
      facts.push({
        subjectId: subjectId.slice(0, 512),
        predicate: predicate.slice(0, 128),
        ...(object !== undefined ? { object: object.slice(0, 8_000) } : {}),
        ...(confidence !== undefined ? { confidence } : {}),
      });
    }
  }
  const topics: string[] = [];
  if (validated.extractTopics) {
    const categories = isRecord(docOut.categories) ? docOut.categories : undefined;
    if (categories) {
      for (const group of Object.values(categories)) {
        if (!Array.isArray(group)) continue;
        for (const category of group) {
          const name = isRecord(category) ? (trimmedString(category.name) ?? trimmedString(category.path)) : undefined;
          if (name && !topics.includes(name.slice(0, 128))) topics.push(name.slice(0, 128));
        }
      }
    }
  }
  let sentiment: string | undefined;
  if (validated.extractSentiment && typeof docOut.sentiment === 'number') {
    sentiment = docOut.sentiment > 0.1 ? 'positive' : docOut.sentiment < -0.1 ? 'negative' : 'neutral';
  }
  return { provider: DIFFBOT_KG_PROVIDER, entities, invalid, mentions, facts, topics, ...(sentiment !== undefined ? { sentiment } : {}) };
}
