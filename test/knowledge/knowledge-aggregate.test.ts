import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aggregateKgTextAnalysis,
  buildKgEvidence,
  dedupeKgEntities,
  groupKgEntitiesByIdentity,
  partitionEnhanceClaims,
  resolveKgEvidenceStatus,
  rrfRankKgEntities,
  type KgEntityGroup,
  type KgEntityMember,
} from '../../src/knowledge/knowledge-aggregate.js';
import type { KgClaim } from '../../src/knowledge/knowledge-contract.js';

function entity(id: string, extra: Record<string, unknown> = {}) {
  return { entityVersion: 1 as const, id, type: 'Person', ...extra };
}

// ── Alignment: basis/strength tiers, claim vs alignment confidence distinct ──

test('same canonical url aligns exact across providers', () => {
  const groups = groupKgEntitiesByIdentity([
    { entity: entity('a1', { url: 'https://Example.com/Ada?utm_source=x' }), provider: 'p1' },
    { entity: entity('b2', { url: 'https://example.com/Ada' }), provider: 'p2' },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.basis, 'canonical_url');
  assert.equal(groups[0]?.strength, 'exact');
  assert.equal(groups[0]?.members.length, 2);
});

test('shared email aligns strong; different ids never merge without signals', () => {
  const groups = groupKgEntitiesByIdentity([
    { entity: entity('a1'), provider: 'p1', raw: { email: 'ada@example.com' } },
    { entity: entity('b2'), provider: 'p2', raw: { email: 'ADA@example.com' } },
    { entity: entity('c3'), provider: 'p3' },
  ]);
  assert.equal(groups.length, 2);
  const emailGroup = groups.find((g: KgEntityGroup) => g.basis === 'email');
  assert.equal(emailGroup?.strength, 'strong');
  assert.equal(emailGroup?.members.length, 2);
});

test('claim confidence and alignment confidence stay distinct fields', () => {
  const groups = groupKgEntitiesByIdentity(
    [
      { entity: entity('a1', { url: 'https://example.com/x', confidence: 0.4 }), provider: 'p1' },
      { entity: entity('b2', { url: 'https://example.com/x', confidence: 0.8 }), provider: 'p2' },
    ],
    { alignmentConfidenceFor: () => 0.99 },
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.alignmentConfidence, 0.99);
  const confidences = groups[0]?.members.map((m: KgEntityMember) => m.entity.confidence).sort();
  assert.deepEqual(confidences, [0.4, 0.8]);
});

test('no alignment confidence computed by default (no arithmetic)', () => {
  const groups = groupKgEntitiesByIdentity([
    { entity: entity('a1', { url: 'https://example.com/x', confidence: 0.4 }), provider: 'p1' },
    { entity: entity('b2', { url: 'https://example.com/x', confidence: 0.8 }), provider: 'p2' },
  ]);
  assert.equal(groups[0]?.alignmentConfidence, undefined);
});

// ── Dedupe + RRF ──

test('dedupeKgEntities is first-wins, order-preserving', () => {
  const out = dedupeKgEntities([
    { entity: entity('a1', { url: 'https://example.com/x', name: 'First' }), provider: 'p1' },
    { entity: entity('b2', { url: 'https://example.com/x', name: 'Second' }), provider: 'p2' },
    { entity: entity('c3', { url: 'https://example.com/y', name: 'Third' }), provider: 'p1' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0]?.entity.name, 'First');
  assert.equal(out[1]?.entity.name, 'Third');
});

test('rrfRankKgEntities surfaces items ranked by multiple providers first', () => {
  const sharedA1 = entity('a1', { url: 'https://example.com/shared' });
  const sharedA2 = entity('a2', { url: 'https://example.com/shared' });
  const onlyB = entity('b', { url: 'https://example.com/b-only' });
  const onlyC = entity('c', { url: 'https://example.com/c-only' });
  const ranked = rrfRankKgEntities([[sharedA1, onlyB], [sharedA2, onlyC]]);
  assert.ok(['a1', 'a2'].includes(ranked[0]?.item.id ?? ''));
  assert.equal(ranked[0]?.item.url, 'https://example.com/shared');
  assert.ok((ranked[0]?.rrfScore ?? 0) > (ranked[1]?.rrfScore ?? 0));
  assert.equal(ranked.length, 3);
});

test('rrfRankKgEntities exercises providerless identity branch for signal-free entities', () => {
  const lone1 = entity('lone1', { type: 'Person' });
  const lone2 = entity('lone2', { type: 'Person' });
  const ranked = rrfRankKgEntities([[lone1], [lone2]]);
  assert.equal(ranked.length, 2);
});

// ── Enhance conflicts: surface disagreement, never adjudicate ──

test('partitionEnhanceClaims flags differing objects, keeps all rows', () => {
  const { claims, conflicts } = partitionEnhanceClaims([
    { subjectId: 'e1', predicate: 'worksFor', object: 'Acme' },
    { subjectId: 'e1', predicate: 'worksFor', object: 'Globex' },
    { subjectId: 'e1', predicate: 'livesIn', object: 'Paris' },
  ]);
  assert.equal(claims.length, 3);
  assert.equal(conflicts.length, 2);
  assert.ok(conflicts.every((c: KgClaim) => c.predicate === 'worksFor'));
});

test('absence is not negation: single claims never conflict', () => {
  const { conflicts } = partitionEnhanceClaims([
    { subjectId: 'e1', predicate: 'worksFor', object: 'Acme' },
    { subjectId: 'e2', predicate: 'worksFor', object: 'Globex' },
  ]);
  assert.equal(conflicts.length, 0);
});

// ── Text-analysis aggregation ──

test('aggregateKgTextAnalysis validates spans, dedupes topics, keeps agreed sentiment', () => {
  const text = 'Ada worked at Acme';
  const out = aggregateKgTextAnalysis({
    text,
    entities: [entity('a', { url: 'https://example.com/x' }), entity('b', { url: 'https://example.com/x' })],
    mentions: [
      { entityId: 'a', text: 'Acme', offset: 13, length: 4 },
      { entityId: 'a', text: 'Acme', offset: 13, length: 9 },
    ],
    facts: [{ subjectId: 'a', predicate: 'worksFor', object: 'Acme', confidence: 0.5 }],
    topics: [' AI ', 'ai', '', 'Science'],
    sentiment: 'positive',
  });
  assert.equal(out.entities.length, 1);
  assert.equal(out.mentions.length, 1);
  assert.deepEqual(out.topics, ['AI', 'Science']);
  assert.equal(out.sentiment, 'positive');
  assert.equal(out.facts[0]?.confidence, 0.5);
  assert.deepEqual(out.partitions, []);
});

test('conflicting sentiments collapse to undefined, no voting', () => {
  const out = aggregateKgTextAnalysis({
    text: 'hello world',
    entities: [],
    mentions: [],
    facts: [],
    topics: [],
    sentiments: ['positive', 'negative'],
  });
  assert.equal(out.sentiment, undefined);
});

// ── Evidence status ──

test('evidence status mapping follows request/support/provenance', () => {
  assert.equal(resolveKgEvidenceStatus({ requested: false, providerSupports: true }), 'not_requested');
  assert.equal(resolveKgEvidenceStatus({ requested: true, providerSupports: false }), 'provider_unsupported');
  assert.equal(resolveKgEvidenceStatus({ requested: true, providerSupports: true }), 'unavailable');
  assert.equal(
    resolveKgEvidenceStatus({ requested: true, providerSupports: true, provenance: 'p1:doc' }),
    'provided',
  );
  assert.equal(buildKgEvidence({ requested: true, providerSupports: true, provenance: 'p1' }).status, 'provided');
  assert.equal(buildKgEvidence({ requested: false, providerSupports: true }).provenance, undefined);
});

test('shared phone aligns strong with internal key kept out of public shape', async () => {
  const groups = groupKgEntitiesByIdentity([
    { entity: entity('a1'), provider: 'p1', raw: { phone: '+1-555-123-4567' } },
    { entity: entity('b2'), provider: 'p2', raw: { phone: '+1-555-123-4567' } },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.basis, 'phone');
  assert.equal(groups[0]?.strength, 'strong');
  const internalKey = groups[0]?.key ?? '';
  assert.ok(internalKey.startsWith('phone:'), 'internal key carries raw signal');
  assert.ok(internalKey.includes('+1-555-123-4567'));
  const { validateKnowledgeResult, buildKnowledgeResult } = await import('../../src/knowledge/knowledge-contract.js');
  const leaked = buildKnowledgeResult({
    request: { tool: 'kg', action: 'search' },
    outcomes: [{ provider: 'p1', entities: [{ entityVersion: 1 as const, id: 'a1', type: 'Person' }] }],
  });
  const withLeakedKey = {
    ...leaked,
    data: {
      kind: 'enhance',
      entities: [{ entityVersion: 1, id: 'a1', type: 'Person' }],
      claims: [],
      conflicts: [],
      partitions: [{ provider: 'p1', status: 'ok' }],
      groups: [
        {
          key: internalKey,
          basis: 'phone',
          strength: 'strong',
          members: [{ entity: { entityVersion: 1, id: 'a1', type: 'Person' }, provider: 'p1' }],
        },
      ],
    },
  };
  assert.equal(validateKnowledgeResult(withLeakedKey).ok, false, 'internal key must never validate as public group');
});

test('email alignment keeps raw signal in internal key only; opaque public id remaps conflicts', async () => {
  const groups = groupKgEntitiesByIdentity([
    { entity: entity('a1'), provider: 'p1', raw: { email: 'ada@example.com' } },
    { entity: entity('b2'), provider: 'p2', raw: { email: 'ADA@example.com' } },
  ]);
  assert.equal(groups.length, 1);
  const internalKey = groups[0]?.key ?? '';
  assert.ok(internalKey.includes('ada@example.com'));
  const opaqueId = 'alignment:1';
  const { claims, conflicts } = partitionEnhanceClaims([
    { subjectId: opaqueId, predicate: 'employer', object: 'Acme', provider: 'p1' },
    { subjectId: opaqueId, predicate: 'employer', object: 'Globex', provider: 'p2' },
  ]);
  assert.equal(conflicts.length, 2, 'both conflicting claims survive under the same opaque subjectId');
  assert.ok(claims.every((c: KgClaim) => c.subjectId === opaqueId));
  assert.ok(!JSON.stringify({ claims, conflicts }).includes(internalKey));
});

test('explicit signals are consumed by group and dedupe without raw', async () => {
  const { extractDiffbotKgIdentitySignals } = await import('../../src/knowledge/knowledge-normalize.js');
  const a = { entityVersion: 1 as const, id: 'diffbot:e1', type: 'Person', name: 'Alice A' };
  const b = { entityVersion: 1 as const, id: 'diffbot:e2', type: 'Person', name: 'Bob B' };
  const signalsA = extractDiffbotKgIdentitySignals({ emailAddresses: [{ contactString: 'shared@example.com' }] }, a.id);
  const signalsB = extractDiffbotKgIdentitySignals({ emailAddresses: [{ contactString: 'SHARED@example.com' }] }, b.id);
  const groups = groupKgEntitiesByIdentity([
    { entity: a, provider: 'diffbot', signals: signalsA },
    { entity: b, provider: 'diffbot', signals: signalsB },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.basis, 'email');
  assert.equal(groups[0]?.strength, 'strong');
  const deduped = dedupeKgEntities([
    { entity: a, provider: 'diffbot', signals: signalsA },
    { entity: b, provider: 'diffbot', signals: signalsB },
  ]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0]?.entity.id, 'diffbot:e1');
});
