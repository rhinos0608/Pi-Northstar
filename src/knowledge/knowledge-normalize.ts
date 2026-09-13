// Provider-neutral knowledge normalization (design section 11).
// Information-preserving: trims/shapes rows into public contract types,
// never invents specificity, never merges confidences, never adjudicates.

import { normalizeUrl } from '../search/fusion.js';
import {
  normalizeOntologyTerm,
  parseKgEntity,
  type KgAlignmentBasis,
  type KgAlignmentStrength,
  type KgClaim,
  type KgEntity,
  type KgEntityParseResult,
} from './knowledge-contract.js';

export type KgClaimParseResult =
  | { ok: true; claim: KgClaim; reason?: undefined }
  | { ok: false; claim?: undefined; reason: string };

export type KgMentionParseResult =
  | { ok: true; mention: { entityId: string; text: string; offset: number; length: number }; reason?: undefined }
  | { ok: false; mention?: undefined; reason: string };

export interface KgIdentitySignals {
  providerId: string;
  canonicalUrl?: string;
  emails: string[];
  phones: string[];
  externalIds: string[];
}

export interface KgIdentityKey {
  key: string;
  basis: KgAlignmentBasis;
  strength: KgAlignmentStrength;
}

function trimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Namespace unknown ontology type via contract helper. Empty → undefined (no invented term). */
export function normalizeKgOntologyType(term: unknown, knownTerms: ReadonlyArray<string>): string | undefined {
  const clean = trimmed(term);
  if (clean === undefined) return undefined;
  return normalizeOntologyTerm(clean, knownTerms);
}

/**
 * Parse entity row then namespace its type. Bounds/truncation follow
 * parseKgEntity; type mapping is only addition. knownTerms omitted → type kept as-is.
 */
export function normalizeKgEntity(
  raw: unknown,
  provider: string,
  knownTerms?: ReadonlyArray<string>,
): KgEntityParseResult {
  const parsed = parseKgEntity(raw, provider);
  if (!parsed.ok || knownTerms === undefined) return parsed;
  const namespaced = normalizeKgOntologyType(parsed.entity.type, knownTerms);
  if (namespaced === undefined) return parsed;
  return { ok: true, entity: { ...parsed.entity, type: namespaced.slice(0, 128) } };
}

/** Shape raw row into KgClaim. Claim confidence kept as provider assertion; never merged. */
export function normalizeKgClaim(raw: unknown): KgClaimParseResult {
  if (!isRecord(raw)) return { ok: false, reason: 'claim is not an object' };
  const subjectId = trimmed(raw.subjectId);
  if (subjectId === undefined) return { ok: false, reason: 'claim missing subjectId' };
  const predicate = trimmed(raw.predicate);
  if (predicate === undefined) return { ok: false, reason: 'claim missing predicate' };
  const object = trimmed(raw.object);
  const claim: KgClaim = { subjectId: subjectId.slice(0, 512), predicate: predicate.slice(0, 128) };
  if (object !== undefined) claim.object = object.slice(0, 8_000);
  if (raw.confidence !== undefined) {
    if (typeof raw.confidence !== 'number' || !(raw.confidence >= 0 && raw.confidence <= 1)) {
      return { ok: false, reason: 'claim confidence must be 0..1' };
    }
    claim.confidence = raw.confidence;
  }
  return { ok: true, claim };
}

/**
 * Validate mention span against original input length. Span text must match
 * declared length; bounds-checked. Invalid → dropped row-level by caller.
 */
export function normalizeKgMention(raw: unknown, textLength: number): KgMentionParseResult {
  if (!isRecord(raw)) return { ok: false, reason: 'mention is not an object' };
  const entityId = trimmed(raw.entityId);
  if (entityId === undefined) return { ok: false, reason: 'mention missing entityId' };
  if (typeof raw.text !== 'string' || raw.text.length === 0) return { ok: false, reason: 'mention missing text' };
  if (!Number.isInteger(raw.offset) || (raw.offset as number) < 0) {
    return { ok: false, reason: 'mention offset out of bounds' };
  }
  const offset = raw.offset as number;
  if (!Number.isInteger(raw.length) || (raw.length as number) < 1) {
    return { ok: false, reason: 'mention length out of bounds' };
  }
  const length = raw.length as number;
  if (offset + length > textLength) return { ok: false, reason: 'mention span exceeds input' };
  if ((raw.text as string).length !== length) return { ok: false, reason: 'mention text mismatches length' };
  return {
    ok: true,
    mention: { entityId: entityId.slice(0, 512), text: raw.text as string, offset, length },
  };
}

const MAX_DIFFBOT_IDENTITY_VALUES = 5;
const MAX_DIFFBOT_EMAIL_CHARS = 320;
const MAX_DIFFBOT_PHONE_CHARS = 64;
const MAX_DIFFBOT_EXTERNAL_ID_CHARS = 512;

function dedupeBounded(values: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Bounded Diffbot-documented identity signals for internal alignment only.
 * Reads emailAddresses[].contactString, phoneNumbers[].contactString, plus
 * canonical/all-URI and external-ID fields. Never serialized; never raw payload.
 */
export function extractDiffbotKgIdentitySignals(source: unknown, providerId: string): KgIdentitySignals {
  const record: Record<string, unknown> = isRecord(source) ? source : {};
  const cleanId = trimmed(providerId)?.slice(0, 512) ?? '';
  const emailCandidates: string[] = [];
  const emailArrays = Array.isArray(record.emailAddresses) ? (record.emailAddresses as unknown[]) : [];
  for (const item of emailArrays) {
    const contact = contactString(item);
    if (contact !== undefined && contact.includes('@')) emailCandidates.push(contact.toLowerCase().slice(0, MAX_DIFFBOT_EMAIL_CHARS));
  }
  for (const fallback of stringList(record.email ?? record.emails ?? record.email_address, true)) {
    if (fallback.includes('@')) emailCandidates.push(fallback.slice(0, MAX_DIFFBOT_EMAIL_CHARS));
  }
  const phoneCandidates: string[] = [];
  const phoneArrays = Array.isArray(record.phoneNumbers) ? (record.phoneNumbers as unknown[]) : [];
  for (const item of phoneArrays) {
    const contact = contactString(item);
    if (contact !== undefined) phoneCandidates.push(contact.slice(0, MAX_DIFFBOT_PHONE_CHARS));
  }
  for (const fallback of stringList(record.phone ?? record.phones ?? record.phone_number, false)) {
    phoneCandidates.push(fallback.slice(0, MAX_DIFFBOT_PHONE_CHARS));
  }
  const externalCandidates: string[] = [];
  const pushExternal = (value: unknown): void => {
    for (const entry of stringList(value, false)) {
      const clean = entry.slice(0, MAX_DIFFBOT_EXTERNAL_ID_CHARS);
      if (clean.length > 0) externalCandidates.push(clean);
    }
  };
  pushExternal(record.external_id ?? record.external_ids ?? record.externalIds ?? record.wikidata_id ?? record.wikidataId);
  for (const key of ['allUris', 'all_uris', 'uris'] as const) {
    if (record[key] !== undefined) pushExternal(record[key]);
  }
  const urlCandidate = trimmed(record.homepageUri ?? record.pageUrl ?? record.resolvedPageUrl ?? record.canonical_url ?? record.canonicalUri ?? record.url ?? record.uri);
  const signals: KgIdentitySignals = {
    providerId: cleanId,
    emails: dedupeBounded(emailCandidates.filter((v) => v.trim().length > 0), MAX_DIFFBOT_IDENTITY_VALUES),
    phones: dedupeBounded(phoneCandidates.filter((v) => v.trim().length > 0), MAX_DIFFBOT_IDENTITY_VALUES),
    externalIds: dedupeBounded(externalCandidates.filter((v) => v.trim().length > 0), MAX_DIFFBOT_IDENTITY_VALUES),
  };
  if (urlCandidate !== undefined) {
    try {
      signals.canonicalUrl = normalizeUrl(urlCandidate).slice(0, 2048);
    } catch {
      signals.canonicalUrl = urlCandidate.slice(0, 2048);
    }
  }
  return signals;
}

function stringList(value: unknown, lower: boolean): string[] {
  const items = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of items) {
    const clean = trimmed(item);
    if (clean === undefined) continue;
    out.push(lower ? clean.toLowerCase() : clean);
  }
  return out;
}

/** Extract conservative identity signals. Email lowercased; phone/url trimmed only. */
export function extractKgIdentitySignals(entity: KgEntity, raw?: unknown): KgIdentitySignals {
  const source: Record<string, unknown> = isRecord(raw) ? raw : {};
  const url = trimmed(entity.url ?? source.canonical_url ?? source.url);
  const signals: KgIdentitySignals = {
    providerId: entity.id,
    emails: dedupeBounded(
      stringList(source.email ?? source.emails ?? source.email_address, true).map((v) => v.slice(0, MAX_DIFFBOT_EMAIL_CHARS)),
      MAX_DIFFBOT_IDENTITY_VALUES,
    ),
    phones: dedupeBounded(
      stringList(source.phone ?? source.phones ?? source.phone_number, false).map((v) => v.slice(0, MAX_DIFFBOT_PHONE_CHARS)),
      MAX_DIFFBOT_IDENTITY_VALUES,
    ),
    externalIds: dedupeBounded(
      stringList(source.external_id ?? source.external_ids ?? source.externalIds ?? source.wikidata_id, false).map((v) => v.slice(0, MAX_DIFFBOT_EXTERNAL_ID_CHARS)),
      MAX_DIFFBOT_IDENTITY_VALUES,
    ),
  };
  if (url !== undefined) {
    try {
      signals.canonicalUrl = normalizeUrl(url);
    } catch {
      signals.canonicalUrl = url;
    }
  }
  return signals;
}

function typedIdentity(entity: KgEntity): string | undefined {
  const name = trimmed(entity.name)?.toLowerCase();
  if (name === undefined) return undefined;
  return `${entity.type.toLowerCase()}:${name}`;
}

/**
 * Single deterministic key by basis priority:
 * canonical_url (exact) > email/phone/external_identifier (strong) >
 * typed_identity (heuristic) > provider-scoped provider_id (exact, never cross-provider).
 * No transitive closure: one entity casts one key, preventing false merges.
 */
export function conservativeIdentityKey(
  entity: KgEntity,
  signals: KgIdentitySignals,
  provider = '',
): KgIdentityKey {
  if (signals.canonicalUrl !== undefined) {
    return { key: `canonical_url:${entity.type.toLowerCase()}:${signals.canonicalUrl}`, basis: 'canonical_url', strength: 'exact' };
  }
  if (signals.emails.length > 0) {
    return { key: `email:${signals.emails[0]}`, basis: 'email', strength: 'strong' };
  }
  if (signals.phones.length > 0) {
    return { key: `phone:${signals.phones[0]}`, basis: 'phone', strength: 'strong' };
  }
  if (signals.externalIds.length > 0) {
    return { key: `external_identifier:${signals.externalIds[0]}`, basis: 'external_identifier', strength: 'strong' };
  }
  const typed = typedIdentity(entity);
  if (typed !== undefined) {
    return { key: `typed_identity:${typed}`, basis: 'typed_identity', strength: 'heuristic' };
  }
  return { key: `provider_id:${provider}:${signals.providerId}`, basis: 'provider_id', strength: 'exact' };
}

// ── Enhance claim extraction (documented Diffbot ontology paths only) ──

export type KgEnhanceFieldsOption = 'basic' | 'contact' | 'professional' | 'all';

export interface ExtractEnhanceClaimsOptions {
  provider?: string;
  /** false suppresses linked-entity relationship predicates; omitted surfaces explicit ones. Never invents. */
  includeRelationships?: boolean;
}

const RELATIONSHIP_PREDICATES: ReadonlySet<string> = new Set([
  'employer',
  'title',
  'education',
  'ceo',
  'founder',
  'boardMember',
  'parentCompany',
  'subsidiary',
  'competitor',
  'partner',
  'customer',
  'supplier',
  'investment',
  'acquiredBy',
]);

function explicitConfidence(value: unknown): number | undefined {
  return typeof value === 'number' && value >= 0 && value <= 1 ? value : undefined;
}

function contactString(item: unknown): string | undefined {
  if (typeof item === 'string') return trimmed(item);
  if (!isRecord(item)) return undefined;
  return trimmed(item.contactString ?? item.email ?? item.phone ?? item.value ?? item.name);
}

function linkedName(item: unknown): string | undefined {
  if (typeof item === 'string') return trimmed(item);
  if (!isRecord(item)) return undefined;
  return trimmed(item.name ?? item.diffbotUri ?? item.uri ?? item.title);
}

function stringOrName(item: unknown): string | undefined {
  if (typeof item === 'string') return trimmed(item);
  if (!isRecord(item)) return undefined;
  return trimmed(item.name ?? item.path ?? item.value);
}

/**
 * Extract whitelisted claims from a Diffbot ontology record. Only documented
 * paths become predicates; unknown keys never leak into output. Entity-level
 * explicit confidence attaches to claims; score/esscore are never treated as
 * confidence. Missing confidence stays missing (fail-open for thresholds).
 */
export function extractEnhanceClaims(
  rawEntity: unknown,
  subjectId: string,
  opts: ExtractEnhanceClaimsOptions = {},
): KgClaim[] {
  if (!isRecord(rawEntity)) return [];
  const cleanSubject = trimmed(subjectId);
  if (cleanSubject === undefined) return [];
  const record = rawEntity as Record<string, unknown>;
  const entityConfidence = explicitConfidence(record.confidence);
  const out: KgClaim[] = [];
  const push = (predicate: string, object: string | undefined, confidence?: number): void => {
    const cleanObject = object !== undefined ? trimmed(object) : undefined;
    if (cleanObject === undefined) return;
    const claim: KgClaim = { subjectId: cleanSubject.slice(0, 512), predicate: predicate.slice(0, 128) };
    claim.object = cleanObject.slice(0, 8_000);
    const explicit = confidence ?? entityConfidence;
    if (explicit !== undefined) claim.confidence = explicit;
    if (opts.provider !== undefined) claim.provider = opts.provider;
    out.push(claim);
  };
  push('name', stringOrName(record.name));
  push('type', stringOrName(record.type));
  push('description', stringOrName(record.description));
  const url = stringOrName(record.homepageUri ?? record.pageUrl ?? record.url);
  if (url !== undefined) push('url', url);
  const emails = Array.isArray(record.emailAddresses) ? record.emailAddresses : [];
  for (const item of emails) {
    push('email', contactString(item), isRecord(item) ? explicitConfidence(item.confidence) ?? entityConfidence : entityConfidence);
  }
  const phones = Array.isArray(record.phoneNumbers) ? record.phoneNumbers : [];
  for (const item of phones) {
    push('phone', contactString(item), isRecord(item) ? explicitConfidence(item.confidence) ?? entityConfidence : entityConfidence);
  }
  const skills = Array.isArray(record.skills) ? record.skills : [];
  for (const item of skills) push('skill', stringOrName(item));
  const languages = Array.isArray(record.languages) ? record.languages : [];
  for (const item of languages) push('language', stringOrName(item));
  const categories = Array.isArray(record.categories) ? record.categories : [];
  for (const item of categories) push('category', stringOrName(item));
  const locations = Array.isArray(record.locations) ? record.locations : [];
  for (const item of locations) push('location', stringOrName(item));
  const employees = record.nbEmployees ?? record.nbEmployeesRange;
  if (typeof employees === 'number' || typeof employees === 'string') push('employeeCount', String(employees));
  else if (isRecord(employees)) push('employeeCount', stringOrName(employees));
  if (opts.includeRelationships === false) return out;
  const employments = Array.isArray(record.employments) ? record.employments : [];
  for (const item of employments) {
    if (!isRecord(item)) continue;
    push('employer', linkedName(item.employer), explicitConfidence(item.confidence) ?? entityConfidence);
    push('title', stringOrName(item.title));
  }
  const educations = Array.isArray(record.educations) ? record.educations : [];
  for (const item of educations) {
    if (!isRecord(item)) continue;
    push('education', linkedName(item.institution ?? item.school), explicitConfidence(item.confidence) ?? entityConfidence);
  }
  push('ceo', linkedName(record.ceo));
  const founders = Array.isArray(record.founders) ? record.founders : [];
  for (const item of founders) push('founder', linkedName(item));
  const board = Array.isArray(record.boardMembers) ? record.boardMembers : [];
  for (const item of board) push('boardMember', linkedName(item));
  push('parentCompany', linkedName(record.parentCompany));
  const listPaths: ReadonlyArray<{ key: string; predicate: string }> = [
    { key: 'subsidiaries', predicate: 'subsidiary' },
    { key: 'competitors', predicate: 'competitor' },
    { key: 'partnerships', predicate: 'partner' },
    { key: 'customers', predicate: 'customer' },
    { key: 'suppliers', predicate: 'supplier' },
    { key: 'investments', predicate: 'investment' },
  ];
  for (const { key, predicate } of listPaths) {
    const items = Array.isArray(record[key]) ? (record[key] as unknown[]) : [];
    for (const item of items) push(predicate, linkedName(item));
  }
  push('acquiredBy', linkedName(record.acquiredBy));
  return out;
}

function familyOfPredicate(predicate: string): KgEnhanceFieldsOption {
  if ((['name', 'type', 'url', 'description'] as const).includes(predicate as 'name')) return 'basic';
  if (predicate === 'email' || predicate === 'phone') return 'contact';
  return 'professional';
}

/** Project claims by Atlas-owned fields. Omitted/all preserves everything. */
export function projectEnhanceClaimsByFields(
  claims: ReadonlyArray<KgClaim>,
  fields?: KgEnhanceFieldsOption,
): KgClaim[] {
  if (fields === undefined || fields === 'all') return [...claims];
  return claims.filter((claim) => {
    if (RELATIONSHIP_PREDICATES.has(claim.predicate)) return fields === 'professional';
    return familyOfPredicate(claim.predicate) === fields;
  });
}

function passesThreshold(confidence: number | undefined, threshold: number | undefined): boolean {
  if (threshold === undefined) return true;
  if (typeof threshold !== 'number' || Number.isNaN(threshold)) return true;
  if (confidence === undefined) return true;
  return confidence >= threshold;
}

/** Drop only claims with explicit numeric confidence below threshold; missing survives. */
export function filterKgClaimsByConfidence(
  claims: ReadonlyArray<KgClaim>,
  threshold?: number,
): KgClaim[] {
  return claims.filter((claim) => passesThreshold(claim.confidence, threshold));
}

/** Drop only entities with explicit numeric confidence below threshold; missing survives. */
export function filterKgEntitiesByConfidence(
  entities: ReadonlyArray<KgEntity>,
  threshold?: number,
): KgEntity[] {
  return entities.filter((entity) => passesThreshold(entity.confidence, threshold));
}
