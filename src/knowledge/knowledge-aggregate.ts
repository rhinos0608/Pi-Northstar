// Provider-neutral knowledge aggregation (design sections 8, 11, 13).
// Alignment groups members without adjudication; conflicts surface
// disagreement without resolution; confidences never merged or averaged.

import { rrfMerge } from '../search/fusion.js';
import {
  type KgAlignmentBasis,
  type KgAlignmentStrength,
  type KgClaim,
  type KgEntity,
  type KgEvidence,
  type KgEvidenceStatus,
  type KgMention,
  type KgPartition,
} from './knowledge-contract.js';
import {
  conservativeIdentityKey,
  extractKgIdentitySignals,
  normalizeKgMention,
  type KgIdentitySignals,
} from './knowledge-normalize.js';

export interface KgEntityInput {
  entity: KgEntity;
  provider: string;
  raw?: unknown;
  /** Explicit normalized identity signals (1:1 with entity). Preferred over raw. Never serialized. */
  signals?: import('./knowledge-normalize.js').KgIdentitySignals;
}

export interface KgEntityMember {
  entity: KgEntity;
  provider: string;
}

export interface KgEntityGroup {
  key: string;
  basis: KgAlignmentBasis;
  strength: KgAlignmentStrength;
  /** Cross-provider alignment confidence; set only via caller callback, never computed. */
  alignmentConfidence?: number;
  members: KgEntityMember[];
}

export interface GroupKgOptions {
  alignmentConfidenceFor?: (basis: KgAlignmentBasis) => number | undefined;
}

/** Group inputs by conservative identity key. Order-preserving; members never merged. */
export function groupKgEntitiesByIdentity(inputs: ReadonlyArray<KgEntityInput>, opts: GroupKgOptions = {}): KgEntityGroup[] {
  const groups = new Map<string, KgEntityGroup>();
  for (const input of inputs) {
    const signals: KgIdentitySignals = input.signals ?? extractKgIdentitySignals(input.entity, input.raw);
    const identity = conservativeIdentityKey(input.entity, signals, input.provider);
    const existing = groups.get(identity.key);
    if (existing) {
      existing.members.push({ entity: input.entity, provider: input.provider });
      continue;
    }
    const alignmentConfidence = opts.alignmentConfidenceFor?.(identity.basis);
    groups.set(identity.key, {
      key: identity.key,
      basis: identity.basis,
      strength: identity.strength,
      ...(alignmentConfidence === undefined ? {} : { alignmentConfidence }),
      members: [{ entity: input.entity, provider: input.provider }],
    });
  }
  return [...groups.values()];
}

/**
 * Merge duplicate-identity representations without adjudication: identity
 * (id/type) and provider attribution stay with the earliest input for stable
 * keys; missing descriptive fields (name/url/confidence) backfill from later
 * copies so their evidence contributes instead of being discarded.
 * Conflicting values keep the earliest copy. Order-preserving.
 */
export function mergeKgEntityRepresentations(current: KgEntity, candidate: KgEntity): KgEntity {
  return {
    ...current,
    ...(current.name === undefined && candidate.name !== undefined ? { name: candidate.name } : {}),
    ...(current.url === undefined && candidate.url !== undefined ? { url: candidate.url } : {}),
    ...(current.confidence === undefined && candidate.confidence !== undefined
      ? { confidence: candidate.confidence }
      : {}),
  };
}

/** Identity-keyed dedupe; earliest input order wins, later copies backfill gaps. */
export function dedupeKgEntities(inputs: ReadonlyArray<KgEntityInput>): KgEntityMember[] {
  const byKey = new Map<string, KgEntityMember>();
  for (const input of inputs) {
    const signals: KgIdentitySignals = input.signals ?? extractKgIdentitySignals(input.entity, input.raw);
    const { key } = conservativeIdentityKey(input.entity, signals, input.provider);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { entity: input.entity, provider: input.provider });
      continue;
    }
    existing.entity = mergeKgEntityRepresentations(existing.entity, input.entity);
  }
  return [...byKey.values()];
}

export interface KgRrfOptions {
  k?: number;
}

/** RRF over per-provider entity rankings; identity-aware key so dupes fuse, representations merge. */
export function rrfRankKgEntities(rankings: KgEntity[][], opts: KgRrfOptions = {}): Array<{ item: KgEntity; rrfScore: number }> {
  return rrfMerge<KgEntity>(rankings, {
    ...(opts.k === undefined ? {} : { k: opts.k }),
    keyFn: (entity) => {
      const signals = extractKgIdentitySignals(entity);
      // Cross-provider fusion key omits provider scope so shared signals fuse.
      const identity = conservativeIdentityKey(entity, signals, '');
      return identity.basis === 'provider_id' ? `providerless:${entity.type}:${entity.id}` : identity.key;
    },
    mergeFn: mergeKgEntityRepresentations,
  });
}

export interface KgClaimPartition {
  claims: KgClaim[];
  conflicts: KgClaim[];
}

function claimGroupKey(claim: KgClaim): string {
  return `${claim.subjectId}\u0000${claim.predicate}`;
}

/**
 * Partition enhance claims: same subject+predicate with >1 distinct object
 * (case-sensitive, trimmed) → all rows in group listed as conflicts.
 * Claims array always preserves every input row; absence never becomes negation.
 */
export function partitionEnhanceClaims(claims: ReadonlyArray<KgClaim>): KgClaimPartition {
  const bySubjectPredicate = new Map<string, { objects: Set<string>; rows: KgClaim[] }>();
  for (const claim of claims) {
    const key = claimGroupKey(claim);
    let group = bySubjectPredicate.get(key);
    if (!group) {
      group = { objects: new Set(), rows: [] };
      bySubjectPredicate.set(key, group);
    }
    group.objects.add(claim.object ?? '\u0000absent');
    group.rows.push(claim);
  }
  const conflicts: KgClaim[] = [];
  for (const group of bySubjectPredicate.values()) {
    if (group.objects.size > 1) conflicts.push(...group.rows);
  }
  return { claims: [...claims], conflicts };
}

export interface KgTextAnalysisInput {
  text: string;
  entities: KgEntity[];
  mentions: ReadonlyArray<unknown>;
  facts: KgClaim[];
  topics: ReadonlyArray<unknown>;
  sentiment?: string;
  /** Alternate multi-source sentiments; >1 distinct → undefined (no vote). */
  sentiments?: ReadonlyArray<unknown>;
  partitions?: KgPartition[];
}

export interface KgTextAnalysisResult {
  entities: KgEntity[];
  mentions: KgMention[];
  facts: KgClaim[];
  topics: string[];
  sentiment?: string;
  partitions: KgPartition[];
}

/** Aggregate analyze_text outputs: validate spans, dedupe, preserve order, no adjudication. */
export function aggregateKgTextAnalysis(input: KgTextAnalysisInput): KgTextAnalysisResult {
  const deduped = dedupeKgEntities(input.entities.map((entity) => ({ entity, provider: '' })));
  const entities = deduped.map((member) => member.entity);

  const mentions: KgMention[] = [];
  for (const raw of input.mentions) {
    const parsed = normalizeKgMention(raw, input.text.length);
    if (parsed.ok && parsed.mention) mentions.push(parsed.mention);
  }

  const seenTopics = new Set<string>();
  const topics: string[] = [];
  for (const raw of input.topics) {
    if (typeof raw !== 'string') continue;
    const clean = raw.trim();
    if (!clean || seenTopics.has(clean.toLowerCase())) continue;
    seenTopics.add(clean.toLowerCase());
    topics.push(clean);
  }

  const candidates = input.sentiments ?? (input.sentiment === undefined ? [] : [input.sentiment]);
  const distinct = [...new Set(candidates.filter((s): s is string => typeof s === 'string' && s.trim().length > 0))];
  return {
    entities,
    mentions,
    facts: [...input.facts],
    topics,
    ...(distinct.length === 1 ? { sentiment: distinct[0] } : {}),
    partitions: input.partitions ? [...input.partitions] : [],
  };
}

export interface KgEvidenceInput {
  requested: boolean;
  providerSupports: boolean;
  provenance?: string;
}

/** Evidence status is a pure mapping of request/support/provenance; never inferred. */
export function resolveKgEvidenceStatus(input: KgEvidenceInput): KgEvidenceStatus {
  if (!input.requested) return 'not_requested';
  if (!input.providerSupports) return 'provider_unsupported';
  if (typeof input.provenance === 'string' && input.provenance.trim().length > 0) return 'provided';
  return 'unavailable';
}

/** Build KgEvidence object; provenance attached only when status is provided. */
export function buildKgEvidence(input: KgEvidenceInput): KgEvidence {
  const status = resolveKgEvidenceStatus(input);
  if (status === 'provided') return { status, provenance: (input.provenance as string).trim() };
  return { status };
}
