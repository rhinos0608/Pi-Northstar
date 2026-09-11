import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  conservativeIdentityKey,
  extractKgIdentitySignals,
  normalizeKgClaim,
  normalizeKgEntity,
  normalizeKgMention,
  normalizeKgOntologyType,
} from '../src/knowledge-normalize.js';

function entity(id = 'e1') {
  return {
    entityVersion: 1 as const,
    id,
    type: 'Person',
    name: 'Ada Lovelace',
    url: 'https://example.com/ada',
    confidence: 0.9,
  };
}

// ── Ontology namespacing ──

test('known type passes through, unknown gets diffbot: prefix', () => {
  assert.equal(normalizeKgOntologyType('Person', ['Person', 'Organization']), 'Person');
  assert.equal(normalizeKgOntologyType('Founder', ['Person', 'Organization']), 'diffbot:Founder');
  assert.equal(normalizeKgOntologyType('  Founder  ', ['Person']), 'diffbot:Founder');
  assert.equal(normalizeKgOntologyType('', ['Person']), undefined);
});

test('normalizeKgEntity preserves info and namespaces unknown type', () => {
  const parsed = normalizeKgEntity(
    { id: 'e1', type: 'Founder', name: 'Ada', url: 'https://example.com/ada', confidence: 0.7 },
    'diffbot',
    ['Person'],
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.entity.type, 'diffbot:Founder');
  assert.equal(parsed.entity.name, 'Ada');
  assert.equal(parsed.entity.url, 'https://example.com/ada');
  assert.equal(parsed.entity.confidence, 0.7);
});

test('normalizeKgEntity keeps known type and rejects bad rows', () => {
  const ok = normalizeKgEntity({ id: 'e1', type: 'Person' }, 'diffbot', ['Person']);
  assert.equal(ok.ok, true);
  assert.equal(normalizeKgEntity({ nope: 1 }, 'diffbot').ok, false);
  assert.equal(normalizeKgEntity({ id: 'e1', type: 'Person', confidence: 9 }, 'diffbot').ok, false);
});

// ── Claims: provider confidence kept distinct, never merged ──

test('normalizeKgClaim trims and preserves claim confidence', () => {
  const parsed = normalizeKgClaim({ subjectId: ' e1 ', predicate: ' worksFor ', object: ' Acme ', confidence: 0.6 });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.claim.subjectId, 'e1');
  assert.equal(parsed.claim.predicate, 'worksFor');
  assert.equal(parsed.claim.object, 'Acme');
  assert.equal(parsed.claim.confidence, 0.6);
});

test('normalizeKgClaim rejects missing ids and out-of-range confidence', () => {
  assert.equal(normalizeKgClaim({ subjectId: '', predicate: 'p' }).ok, false);
  assert.equal(normalizeKgClaim({ subjectId: 's', predicate: '' }).ok, false);
  assert.equal(normalizeKgClaim({ subjectId: 's', predicate: 'p', confidence: 2 }).ok, false);
  assert.equal(normalizeKgClaim(null).ok, false);
});

// ── Mentions: spans validated against original input ──

test('normalizeKgMention keeps in-bounds spans with matching length', () => {
  const text = 'Ada worked at Acme';
  const parsed = normalizeKgMention({ entityId: 'e1', text: 'Acme', offset: 13, length: 4 }, text.length);
  assert.equal(parsed.ok, true);
});

test('normalizeKgMention drops out-of-bounds and mismatched spans', () => {
  const len = 'Ada worked at Acme'.length;
  assert.equal(normalizeKgMention({ entityId: 'e1', text: 'Acme', offset: 13, length: 9 }, len).ok, false);
  assert.equal(normalizeKgMention({ entityId: 'e1', text: 'Acme', offset: -1, length: 4 }, len).ok, false);
  assert.equal(normalizeKgMention({ entityId: 'e1', text: 'Acme', offset: 13, length: 0 }, len).ok, false);
  assert.equal(normalizeKgMention({ entityId: 'e1', text: 'AcmeCorp', offset: 13, length: 4 }, len).ok, false);
  assert.equal(normalizeKgMention({ entityId: '', text: 'Acme', offset: 13, length: 4 }, len).ok, false);
});

// ── Identity signals: conservative, no invented specificity ──

test('extractKgIdentitySignals normalizes email/url, preserves provider id', () => {
  const signals = extractKgIdentitySignals(entity(), {
    email: ' Ada@Example.COM ',
    phone: ' +1-555-0100 ',
    externalIds: [' wikidata:Q7259 ', ''],
  });
  assert.equal(signals.providerId, 'e1');
  assert.deepEqual(signals.emails, ['ada@example.com']);
  assert.deepEqual(signals.phones, ['+1-555-0100']);
  assert.deepEqual(signals.externalIds, ['wikidata:Q7259']);
  assert.ok(signals.canonicalUrl?.includes('example.com/ada'));
});

test('conservativeIdentityKey prefers url over typed identity, scopes provider_id', () => {
  const withUrl = conservativeIdentityKey(entity('e1'), extractKgIdentitySignals(entity('e1')));
  assert.equal(withUrl.basis, 'canonical_url');
  assert.equal(withUrl.strength, 'exact');

  const noSignals = conservativeIdentityKey(
    { entityVersion: 1 as const, id: 'x', type: 'Person' },
    { providerId: 'x', emails: [], phones: [], externalIds: [] },
  );
  assert.equal(noSignals.basis, 'provider_id');
  assert.ok(noSignals.key.includes('x'));

  const a = conservativeIdentityKey(
    { entityVersion: 1 as const, id: 'same', type: 'Person' },
    { providerId: 'same', emails: [], phones: [], externalIds: [] },
    'p1',
  );
  const b = conservativeIdentityKey(
    { entityVersion: 1 as const, id: 'same', type: 'Person' },
    { providerId: 'same', emails: [], phones: [], externalIds: [] },
    'p2',
  );
  assert.notEqual(a.key, b.key);
});

test('extractEnhanceClaims whitelists documented fields, tags provider, never leaks raw', async () => {
  const { extractEnhanceClaims } = await import('../src/knowledge-normalize.js');
  const raw = {
    name: 'Ada',
    homepageUri: 'https://example.com/ada',
    emailAddresses: [{ contactString: 'ada@example.com' }],
    employments: [{ employer: { name: 'Acme', diffbotUri: 'https://diffbot.com/entity/acme' }, title: 'Engineer' }],
    founders: [{ name: 'Eve' }],
    undocumentedBlob: { secret: 'x' },
  };
  const claims = extractEnhanceClaims(raw, 'https://diffbot.com/entity/p1', { provider: 'diffbot' });
  assert.ok(claims.some((c: { predicate: string; object?: string; provider?: string; subjectId: string }) => c.predicate === 'email' && c.object === 'ada@example.com'));
  assert.ok(claims.some((c: { predicate: string; object?: string; provider?: string; subjectId: string }) => c.predicate === 'employer' && c.object === 'Acme'));
  assert.ok(claims.every((c: { predicate: string; provider?: string; subjectId: string }) => c.provider === 'diffbot' && c.subjectId === 'https://diffbot.com/entity/p1'));
  assert.ok(!JSON.stringify(claims).includes('undocumentedBlob'));
});

test('extractEnhanceClaims with includeRelationships=false suppresses linked entities only', async () => {
  const { extractEnhanceClaims } = await import('../src/knowledge-normalize.js');
  const raw = { name: 'Ada', emailAddresses: [{ contactString: 'a@e.com' }], employments: [{ employer: { name: 'Acme' } }] };
  const claims = extractEnhanceClaims(raw, 'e1', { provider: 'diffbot', includeRelationships: false });
  assert.ok(claims.some((c: { predicate: string; object?: string; provider?: string; subjectId: string }) => c.predicate === 'email'));
  assert.ok(!claims.some((c: { predicate: string; object?: string; provider?: string; subjectId: string }) => c.predicate === 'employer'));
});

test('fields projection and confidence filter keep missing-confidence rows', async () => {
  const { projectEnhanceClaimsByFields, filterKgClaimsByConfidence, filterKgEntitiesByConfidence } =
    await import('../src/knowledge-normalize.js');
  const claims = [
    { subjectId: 'e1', predicate: 'email', object: 'a@e.com' },
    { subjectId: 'e1', predicate: 'employer', object: 'Acme' },
    { subjectId: 'e1', predicate: 'name', object: 'Ada', confidence: 0.2 },
    { subjectId: 'e1', predicate: 'phone', object: '123' },
  ];
  assert.deepEqual(projectEnhanceClaimsByFields(claims, 'contact').map((c: { predicate: string }) => c.predicate).sort(), ['email', 'phone']);
  const filtered = filterKgClaimsByConfidence(claims, 0.5);
  assert.ok(filtered.some((c: { predicate: string }) => c.predicate === 'email'));
  assert.ok(!filtered.some((c: { predicate: string }) => c.predicate === 'name'));
  const entities = filterKgEntitiesByConfidence(
    [{ entityVersion: 1 as const, id: 'a', type: 'Person' }, { entityVersion: 1 as const, id: 'b', type: 'Person', confidence: 0.1 }],
    0.5,
  );
  assert.equal(entities.length, 1);
  assert.equal(entities[0]?.id, 'a');
});

test('extractDiffbotKgIdentitySignals reads documented contact/canonical/external fields bounded', async () => {
  const { extractDiffbotKgIdentitySignals } = await import('../src/knowledge-normalize.js');
  const signals = extractDiffbotKgIdentitySignals(
    {
      emailAddresses: [{ contactString: ' Shared@Example.COM ' }, { contactString: 'second@example.com' }],
      phoneNumbers: [{ contactString: ' +1-555-0100 ' }],
      homepageUri: 'https://example.com/jane',
      wikidata_id: 'Q999',
    },
    'e1',
  );
  assert.deepEqual(signals.emails, ['shared@example.com', 'second@example.com']);
  assert.deepEqual(signals.phones, ['+1-555-0100']);
  assert.deepEqual(signals.externalIds, ['Q999']);
  assert.ok(signals.canonicalUrl?.includes('example.com/jane'));
  assert.equal(signals.providerId, 'e1');
  const bounded = extractDiffbotKgIdentitySignals(
    {
      emailAddresses: ['a1@e.com', 'a2@e.com', 'a3@e.com', 'a4@e.com', 'a5@e.com', 'a6@e.com', 'a7@e.com'],
      phoneNumbers: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
      externalIds: ['x1', 'x2', 'x3', 'x4', 'x5', 'x6'],
    },
    'e9',
  );
  assert.equal(bounded.emails.length, 5);
  assert.equal(bounded.phones.length, 5);
  assert.equal(bounded.externalIds.length, 5);
});
