import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  admitFromFetch,
  admitGithubContent,
  admitKgFields,
  admitResearchAbstract,
  admitSocialBody,
  admitVideoTranscriptSegment,
  collectCandidates,
} from '../../../src/web/agent/agent-acquisition.js';
import { createAgentState } from '../../../src/web/agent/agent-state.js';

test('research abstract admits as abstract-scoped evidence; metadata rows stay candidates', () => {
  const state = createAgentState({ goal: 'g' });
  // Metadata rows (title/year, no abstract) are candidates only: no ledger write.
  const candidates = collectCandidates('research', [
    { title: 'Paper one', url: 'https://example.com/p1', snippet: '2024 · citations 12' },
    { title: 'Paper two', url: 'https://example.com/p2' },
  ]);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0]!.route, 'research');
  assert.equal(state.admittedEvidence.length, 0, 'candidates never touch the ledger');
  // The returned abstract admits with academic class and research route.
  const abstract = 'Returned abstract text supporting claims limited to that abstract scope only';
  const admitted = admitResearchAbstract(state, {
    abstract,
    canonicalUrl: 'https://example.com/p1',
    provider: 'openalex',
    query: 'zebra migration',
  }, ['q-1'], 1);
  assert.equal(admitted.evidence.length, 1);
  assert.equal(admitted.rejectedCount, 0);
  const entry = admitted.evidence[0]!;
  assert.equal(entry.sourceRef.acquisitionRoute, 'research');
  assert.equal(entry.sourceRef.sourceClass, 'academic');
  assert.deepEqual(entry.locator, { start: 0, end: abstract.length });
  // Empty abstract (metadata-only payload) rejects: no content, no evidence.
  const empty = admitResearchAbstract(state, { abstract: '  ', provider: 'openalex', query: 'q' });
  assert.equal(empty.evidence.length, 0);
  assert.equal(empty.rejectedCount, 1);
  assert.deepEqual(empty.rejectionReasons, ['excerpt is empty']);
  assert.equal(state.admittedEvidence.length, 1);
});

test('research abstract without url admits via structured identity', () => {
  const state = createAgentState({ goal: 'g' });
  const abstract = 'Abstract retrieved without a canonical link for this artifact';
  const admitted = admitResearchAbstract(state, { abstract, provider: 'semantic-scholar', query: 'zebra' });
  assert.equal(admitted.evidence.length, 1);
  const entry = admitted.evidence[0]!;
  assert.equal(entry.sourceRef.canonicalUrl, '');
  assert.deepEqual(entry.sourceRef.identity, { provider: 'semantic-scholar', query: 'zebra' });
});

test('github file content admits as repo evidence with char-range chunks', () => {
  const state = createAgentState({ goal: 'g' });
  const content = 'Github file content about pricing tiers and plan details. '.repeat(40);
  const admitted = admitGithubContent(state, {
    content,
    canonicalUrl: 'https://github.com/o/r/blob/main/README.md',
  }, ['q-1'], 1);
  assert.ok(admitted.evidence.length > 0);
  assert.equal(admitted.rejectedCount, 0);
  for (const entry of admitted.evidence) {
    assert.equal(entry.sourceRef.acquisitionRoute, 'github');
    assert.equal(entry.sourceRef.sourceClass, 'repo');
    assert.ok('start' in entry.locator && 'end' in entry.locator);
  }
});

test('github issue ref records as responseId', () => {
  const state = createAgentState({ goal: 'g' });
  const admitted = admitGithubContent(state, {
    content: 'Issue body describing the zebra migration bug with enough text to chunk over minimum. '.repeat(3),
    canonicalUrl: 'https://github.com/o/r/issues/42',
    ref: 'o/r#42',
  });
  assert.equal(admitted.evidence.length, 1);
  assert.equal(admitted.evidence[0]!.sourceRef.responseId, 'o/r#42');
});

test('social body admits as community evidence', () => {
  const state = createAgentState({ goal: 'g' });
  const body = 'Retrieved thread body with community discussion about zebra corridors and seasonal routes.';
  const admitted = admitSocialBody(state, { body, canonicalUrl: 'https://example.com/thread/1' }, ['q-1'], 2);
  assert.equal(admitted.evidence.length, 1);
  const entry = admitted.evidence[0]!;
  assert.equal(entry.sourceRef.acquisitionRoute, 'social');
  assert.equal(entry.sourceRef.sourceClass, 'community');
  assert.deepEqual(entry.locator, { start: 0, end: body.length });
});

test('video transcript segment admits with timestamp locator', () => {
  const state = createAgentState({ goal: 'g' });
  const segment = 'Transcript segment describing the migration corridor crossing at dawn.';
  const admitted = admitVideoTranscriptSegment(state, {
    segment,
    timestamp: 83.5,
    canonicalUrl: 'https://www.youtube.com/watch?v=abc123',
  }, ['q-1'], 1);
  assert.equal(admitted.evidence.length, 1);
  const entry = admitted.evidence[0]!;
  assert.equal(entry.sourceRef.acquisitionRoute, 'video');
  assert.deepEqual(entry.locator, { timestamp: 83.5 });
});

test('kg fields admit per explicit field with node locator and structured identity', () => {
  const state = createAgentState({ goal: 'g' });
  const admitted = admitKgFields(state, {
    provider: 'wikidata',
    query: 'zebra',
    fields: [
      { nodeId: 'Q123', field: 'description', value: 'Zebra herds migrate seasonally across savanna corridors.' },
      { nodeId: 'Q123', field: 'label', value: 'Plains zebra' },
    ],
  }, ['q-1'], 1);
  assert.equal(admitted.evidence.length, 2);
  assert.equal(admitted.rejectedCount, 0);
  const [first, second] = admitted.evidence;
  assert.deepEqual(first!.locator, { nodeId: 'Q123', field: 'description' });
  assert.deepEqual(first!.sourceRef.identity, { provider: 'wikidata', query: 'zebra', nodeId: 'Q123' });
  assert.equal(first!.sourceRef.acquisitionRoute, 'kg');
  assert.deepEqual(second!.locator, { nodeId: 'Q123', field: 'label' });
  // Empty field list admits nothing and rejects nothing.
  const empty = admitKgFields(state, { provider: 'wikidata', query: 'zebra', fields: [] });
  assert.equal(empty.evidence.length, 0);
  assert.equal(empty.rejectedCount, 0);
});

test('search hits stay candidates: no admission path', () => {
  const state = createAgentState({ goal: 'g' });
  const candidates = collectCandidates('search', [{ title: 'hit', url: 'https://example.com/h', snippet: 'snip' }]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.route, 'search');
  assert.equal(state.admittedEvidence.length, 0);
});

test('admitFromFetch web path stays byte-compatible', () => {
  const state = createAgentState({ goal: 'g' });
  const content = 'Alpha evidence sentence about pricing tiers and plan details. '.repeat(40);
  const admitted = admitFromFetch(state, { kind: 'fetch', url: 'https://example.com/page', canonicalUrl: 'https://example.com/page', content });
  assert.equal(admitted.truncated, false);
  assert.ok(admitted.evidence.length > 0);
  assert.equal(admitted.rejectedCount, 0);
  assert.equal(admitted.evidence[0]!.sourceRef.acquisitionRoute, 'fetch');
  assert.ok(!('identity' in admitted.evidence[0]!.sourceRef));
});

test('kg admission stores trimmed nodeId/field (checkLocator validates trimmed)', () => {
  const state = createAgentState({ goal: 'g' });
  const admitted = admitKgFields(state, {
    provider: 'wikidata',
    query: 'zebra',
    fields: [{ nodeId: '  Q123  ', field: '  description  ', value: 'Zebra herds migrate seasonally across savanna corridors.' }],
  });
  assert.equal(admitted.evidence.length, 1);
  assert.deepEqual(admitted.evidence[0]!.locator, { nodeId: 'Q123', field: 'description' });
  assert.deepEqual(admitted.evidence[0]!.sourceRef.identity, { provider: 'wikidata', query: 'zebra', nodeId: 'Q123' });
});
