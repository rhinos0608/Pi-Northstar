import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAgentState, independentSourcesFor, isNearDuplicate, questionId, type AgentEvidenceInput } from '../../../src/web/agent/agent-state.js';

const baseInput = (overrides: Partial<AgentEvidenceInput> = {}): AgentEvidenceInput => {
  // Default locator tracks the excerpt length: the locator/excerpt identity
  // check is unconditional, so explicit locators must match explicit excerpts.
  const excerpt = overrides.excerpt ?? 'Sample evidence excerpt text';
  return {
    sourceRef: { canonicalUrl: 'https://example.com/page', sourceClass: 'unknown', acquisitionRoute: 'fetch' },
    documentHash: 'hash-1',
    locator: { start: 0, end: excerpt.length },
    excerpt,
    questionIds: ['q-1'],
    round: 0,
    status: 'admitted',
    ...overrides,
  };
};

test('admission validation rejects invalid evidence instead of throwing', () => {
  const state = createAgentState({ goal: 'g' });
  const cases: Array<[AgentEvidenceInput, string]> = [
    [baseInput({ excerpt: '   ' }), 'excerpt is empty'],
    [baseInput({ sourceRef: { canonicalUrl: 'ftp://example.com/x', sourceClass: 'unknown', acquisitionRoute: 'fetch' } }), 'canonicalUrl must be an http(s) URL'],
    [baseInput({ locator: { start: 5, end: 5 } }), 'invalid locator'],
    [baseInput({ locator: { start: -1, end: 5 } }), 'invalid locator'],
    [baseInput({ locator: { start: 0, end: 1.5 } }), 'invalid locator'],
    [baseInput({ locator: { start: 0, end: 5 }, contentLength: 3 }), 'invalid locator'],
    [baseInput({ status: 'bogus' as never }), 'unknown status'],
    [baseInput({ documentHash: '  ' }), 'documentHash is required'],
  ];
  for (const [input, expected] of cases) {
    const result = state.addEvidence(input);
    assert.ok('rejected' in result, `expected rejection for ${JSON.stringify(expected)}`);
    assert.equal(result.rejected.reason, expected);
  }
});

test('duplicate id unions questionIds into the first-seen entry instead of rejecting', () => {
  const state = createAgentState({ goal: 'g' });
  const first = state.addEvidence(baseInput());
  assert.ok(!('rejected' in first));
  // Identical questionIds → plain existing, no rejection, no marker.
  const same = state.addEvidence(baseInput());
  assert.ok(!('rejected' in same));
  assert.ok(!('mergedQuestions' in same));
  assert.equal(state.admittedEvidence.length, 1);
  // New question → union linkage, first-seen excerpt kept, no duplicate entry.
  const linked = state.addEvidence(baseInput({ questionIds: ['q-2'] }));
  assert.ok(!('rejected' in linked));
  assert.ok('mergedQuestions' in linked);
  assert.deepEqual(linked.mergedQuestions, ['q-2']);
  assert.equal(state.admittedEvidence.length, 1);
  assert.deepEqual(state.admittedEvidence[0]!.questionIds.slice().sort(), ['q-1', 'q-2']);
  assert.equal(state.admittedEvidence[0]!.excerpt, 'Sample evidence excerpt text');
  // Ephemeral marker ships on a COPY only: stored entry never gains the key.
  assert.ok(!('mergedQuestions' in state.admittedEvidence[0]!));
  assert.ok(!state.snapshot().includes('mergedQuestions'), 'snapshot stays free of ephemeral keys');
});

test('union validates questionId format: invalid ids never merged', () => {
  const state = createAgentState({ goal: 'g' });
  const first = state.addEvidence(baseInput());
  assert.ok(!('rejected' in first));
  const linked = state.addEvidence(baseInput({ questionIds: ['q-2', 'evil-id', '', 42 as never, 'Q-3', 'x-ff'] }));
  assert.ok(!('rejected' in linked));
  assert.ok('mergedQuestions' in linked);
  assert.deepEqual(linked.mergedQuestions, ['q-2']);
  assert.deepEqual(state.admittedEvidence[0]!.questionIds.slice().sort(), ['q-1', 'q-2']);
});

test('union sorts questionIds ascending lexical regardless of arrival order', () => {
  const one = createAgentState({ goal: 'g' });
  one.addEvidence(baseInput({ questionIds: ['q-aa'] }));
  one.addEvidence(baseInput({ questionIds: ['q-cc'] }));
  one.addEvidence(baseInput({ questionIds: ['q-bb'] }));
  const two = createAgentState({ goal: 'g' });
  two.addEvidence(baseInput({ questionIds: ['q-aa'] }));
  two.addEvidence(baseInput({ questionIds: ['q-bb'] }));
  two.addEvidence(baseInput({ questionIds: ['q-cc'] }));
  assert.deepEqual(one.admittedEvidence[0]!.questionIds, ['q-aa', 'q-bb', 'q-cc']);
  assert.deepEqual(two.admittedEvidence[0]!.questionIds, ['q-aa', 'q-bb', 'q-cc']);
  assert.equal(one.snapshot(), two.snapshot(), 'snapshots byte-identical regardless of arrival order');
});

test('union caps questionIds at MAX_QUESTIONS, overflow silently ignored', async () => {
  const { MAX_QUESTIONS } = await import('../../../src/web/agent/agent-state.js');
  const state = createAgentState({ goal: 'g' });
  const first = state.addEvidence(baseInput({ questionIds: ['q-aa'] }));
  assert.ok(!('rejected' in first));
  const hex = (i: number) => `q-${i.toString(16).padStart(4, '0')}`;
  const many = Array.from({ length: MAX_QUESTIONS + 10 }, (_, i) => hex(i));
  const linked = state.addEvidence(baseInput({ questionIds: many }));
  assert.ok(!('rejected' in linked));
  assert.ok(state.admittedEvidence[0]!.questionIds.length <= MAX_QUESTIONS);
  assert.deepEqual(state.admittedEvidence[0]!.questionIds, [...state.admittedEvidence[0]!.questionIds].sort());
});

test('union overflow keeps lexical set regardless of arrival order', async () => {
  const { MAX_QUESTIONS } = await import('../../../src/web/agent/agent-state.js');
  const hex = (i: number) => `q-${i.toString(16).padStart(4, '0')}`;
  // Pre-fill so merge room is small (3) while the fresh set (10 ids) stays
  // under the sanitize cap: overflow resolves inside the merge, not sanitize.
  const seed = Array.from({ length: MAX_QUESTIONS - 3 }, (_, i) => hex(i));
  const fresh = Array.from({ length: 10 }, (_, i) => hex(100 + i));
  const build = (ids: string[]) => {
    const state = createAgentState({ goal: 'g' });
    const first = state.addEvidence(baseInput({ questionIds: seed }));
    assert.ok(!('rejected' in first));
    const linked = state.addEvidence(baseInput({ questionIds: ids }));
    assert.ok(!('rejected' in linked));
    return state;
  };
  const forward = build(fresh);
  const reversed = build([...fresh].reverse());
  assert.deepEqual(forward.admittedEvidence[0]!.questionIds, reversed.admittedEvidence[0]!.questionIds);
  assert.deepEqual(forward.admittedEvidence[0]!.questionIds, [...seed, ...[...fresh].sort().slice(0, 3)].sort());
  assert.equal(forward.snapshot(), reversed.snapshot());
});

test('dedup-merge proceeds at the evidence cap; new ids still reject', async () => {
  const { MAX_EVIDENCE } = await import('../../../src/web/agent/agent-state.js');
  const state = createAgentState({ goal: 'g' });
  const first = state.addEvidence(baseInput());
  assert.ok(!('rejected' in first));
  for (let i = 0; i < MAX_EVIDENCE - 1; i += 1) {
    const admitted = state.addEvidence(baseInput({
      sourceRef: { canonicalUrl: `https://example.com/fill${i}`, sourceClass: 'unknown', acquisitionRoute: 'fetch' },
      excerpt: `distinct evidence passage number ${i} about zebra herds`,
    }));
    assert.ok(!('rejected' in admitted), `insert ${i} must admit`);
  }
  // At cap: existing-id union still merges.
  const merged = state.addEvidence(baseInput({ questionIds: ['q-2'] }));
  assert.ok(!('rejected' in merged));
  assert.ok('mergedQuestions' in merged);
  // At cap: brand-new content rejects.
  const over = state.addEvidence(baseInput({
    sourceRef: { canonicalUrl: 'https://example.com/overflow', sourceClass: 'unknown', acquisitionRoute: 'fetch' },
    excerpt: 'one passage too many for the evidence budget',
  }));
  assert.ok('rejected' in over);
  assert.equal(over.rejected.reason, 'evidence limit reached');
});

test('stable id identical across insertion order', () => {
  const inputA = baseInput({ sourceRef: { canonicalUrl: 'https://example.com/a', sourceClass: 'unknown', acquisitionRoute: 'fetch' }, excerpt: 'Alpha evidence text' });
  const inputB = baseInput({ sourceRef: { canonicalUrl: 'https://example.com/b', sourceClass: 'unknown', acquisitionRoute: 'fetch' }, excerpt: 'Beta evidence text' });
  const stateOne = createAgentState({ goal: 'g' });
  const stateTwo = createAgentState({ goal: 'g' });
  stateOne.addEvidence(inputA);
  stateOne.addEvidence(inputB);
  stateTwo.addEvidence(inputB);
  stateTwo.addEvidence(inputA);
  const idOf = (state: ReturnType<typeof createAgentState>, url: string) => {
    const entry = state.admittedEvidence.find((e) => e.sourceRef.canonicalUrl.includes(url));
    assert.ok(entry, `missing evidence for ${url}`);
    return entry.id;
  };
  assert.equal(idOf(stateOne, '/a'), idOf(stateTwo, '/a'));
  assert.equal(idOf(stateOne, '/b'), idOf(stateTwo, '/b'));
});

test('isNearDuplicate: same text different hosts true, different text false', () => {
  const state = createAgentState({ goal: 'g' });
  const a = state.addEvidence(baseInput({ sourceRef: { canonicalUrl: 'https://alpha.example.com/page', sourceClass: 'unknown', acquisitionRoute: 'fetch' }, excerpt: 'Zebra herds migrate seasonally across savanna corridors in large groups' }));
  const b = state.addEvidence(baseInput({ sourceRef: { canonicalUrl: 'https://beta.example.org/page', sourceClass: 'unknown', acquisitionRoute: 'fetch' }, excerpt: 'Zebra herds migrate seasonally across savanna corridors in large groups' }));
  const c = state.addEvidence(baseInput({ sourceRef: { canonicalUrl: 'https://gamma.example.net/page', sourceClass: 'unknown', acquisitionRoute: 'fetch' }, excerpt: 'Completely unrelated content about Victorian postage stamps and ink' }));
  assert.ok(a && b && c && !('rejected' in a) && !('rejected' in b) && !('rejected' in c));
  assert.equal(isNearDuplicate(a, b), true);
  assert.equal(isNearDuplicate(a, c), false);
});

test('independentSourcesFor counts distinct fingerprints', () => {
  const state = createAgentState({ goal: 'g' });
  const a = state.addEvidence(baseInput({ excerpt: 'Shared corroborating passage text about zebra herds' }));
  const b = state.addEvidence(baseInput({ sourceRef: { canonicalUrl: 'https://other.example.com/page', sourceClass: 'unknown', acquisitionRoute: 'fetch' }, excerpt: 'Shared corroborating passage text about zebra herds' }));
  const c = state.addEvidence(baseInput({ sourceRef: { canonicalUrl: 'https://third.example.com/page', sourceClass: 'unknown', acquisitionRoute: 'fetch' }, excerpt: 'Distinct corroborating passage about bicycle repair stands' }));
  assert.ok(a && b && c && !('rejected' in a) && !('rejected' in b) && !('rejected' in c));
  assert.equal(independentSourcesFor([a, b, c]), 2);
  assert.equal(independentSourcesFor([a, b]), 1);
});

test('promoteToGrounded rejects unknown question, empty evidence, unadmitted evidence', () => {
  const state = createAgentState({ goal: 'g' });
  const unknown = state.promoteToGrounded('nope', ['ev-1']);
  assert.ok(typeof unknown === 'object' && 'rejected' in unknown);
  assert.equal(unknown.rejected.reason, 'unknown question id');
  state.questions.push({ id: questionId('pricing'), question: 'pricing', priority: 1, required: true, status: 'open' });
  const empty = state.promoteToGrounded(questionId('pricing'), []);
  assert.ok(typeof empty === 'object' && 'rejected' in empty);
  assert.equal(empty.rejected.reason, 'evidenceIds must be non-empty');
  const unadmitted = state.promoteToGrounded(questionId('pricing'), ['ev-missing']);
  assert.ok(typeof unadmitted === 'object' && 'rejected' in unadmitted);
  assert.equal(unadmitted.rejected.reason, 'evidence id is not admitted');
  const admitted = state.addEvidence(baseInput());
  assert.ok(!('rejected' in admitted));
  assert.equal(state.promoteToGrounded(questionId('pricing'), [admitted.id]), true);
  assert.equal(state.questions[0]!.status, 'grounded');
});

test('recordQuery rejects exact duplicates; isSimilar stays advisory', () => {
  const state = createAgentState({ goal: 'g' });
  const first = state.recordQuery({ query: 'zebra migration', route: 'search' });
  assert.ok(!('rejected' in first));
  const exact = state.recordQuery({ query: 'ZEBRA MIGRATION ', route: 'search' });
  assert.ok('rejected' in exact);
  assert.equal(exact.rejected.reason, 'exact duplicate query');
  assert.equal(state.hasExactDuplicate({ query: 'zebra migration', route: 'search' }), true);
  assert.equal(state.hasExactDuplicate({ query: 'zebra migration', route: 'fetch' }), false);
  const similar = state.recordQuery({ query: 'zebra migration patterns seasonal routes', route: 'search' });
  assert.ok(!('rejected' in similar), 'different query must not be exact-rejected');
  const advisory = state.isSimilar('zebra migration');
  assert.ok(Array.isArray(advisory));
  assert.ok(advisory.length >= 1, 'similar queries surface in advisory list');
});

test('snapshot parses via JSON.parse and round-trips canonical', () => {
  const state = createAgentState({ goal: 'g' });
  const admitted = state.addEvidence(baseInput());
  assert.ok(!('rejected' in admitted));
  state.questions.push({ id: questionId('pricing'), question: 'pricing', priority: 1, required: true, status: 'open' });
  state.recordQuery({ query: 'zebra migration', route: 'search' });
  const snapshotOne = state.snapshot();
  const parsed = JSON.parse(snapshotOne) as Record<string, unknown>;
  assert.equal(typeof parsed, 'object');
  assert.equal(parsed['goal'], 'g');
  assert.ok(Array.isArray(parsed['admittedEvidence']));
  assert.equal((parsed['admittedEvidence'] as unknown[]).length, 1);
  assert.ok(Array.isArray(parsed['questions']));
  assert.ok(Array.isArray(parsed['queries']));
  // Canonical: sorted keys, JSON-only values (no functions, Maps, or Sets).
  const keys = Object.keys(parsed);
  assert.deepEqual([...keys].sort(), keys);
  assert.equal(snapshotOne, state.snapshot(), 'snapshot is byte-stable for unchanged state');
});

test('caller-supplied id/hash/fingerprint overrides are ignored and recomputed', () => {
  const state = createAgentState({ goal: 'g' });
  const injected = { ...baseInput(), id: 'ev-spoofed', excerptHash: 'spoof', corroboratingFingerprint: 'spoof-fp' } as unknown as AgentEvidenceInput;
  const result = state.addEvidence(injected);
  assert.ok(!('rejected' in result));
  assert.ok(result.id !== 'ev-spoofed' && result.id.startsWith('ev-'));
  assert.ok(result.excerptHash !== 'spoof' && result.corroboratingFingerprint !== 'spoof-fp');
  const clean = createAgentState({ goal: 'g' });
  const second = clean.addEvidence(baseInput());
  assert.ok(!('rejected' in second));
  assert.equal(result.id, second.id, 'ids stable across spoofed and clean insertions');
  assert.equal(result.excerptHash, second.excerptHash);
});

test('locator length mismatch rejects when contentLength provided', () => {
  const state = createAgentState({ goal: 'g' });
  const excerpt = 'x'.repeat(50);
  const ok = state.addEvidence(baseInput({ excerpt, locator: { start: 0, end: 50 }, contentLength: 200 }));
  assert.ok(!('rejected' in ok));
  const bad = state.addEvidence(baseInput({ sourceRef: { canonicalUrl: 'https://example.com/other', sourceClass: 'unknown', acquisitionRoute: 'fetch' }, excerpt, locator: { start: 0, end: 10 }, contentLength: 200 }));
  assert.ok('rejected' in bad);
  assert.equal(bad.rejected.reason, 'locator does not match excerpt length');
});

test('locator length mismatch rejects without contentLength', () => {
  const state = createAgentState({ goal: 'g' });
  const excerpt = 'y'.repeat(40);
  const bad = state.addEvidence(baseInput({
    sourceRef: { canonicalUrl: 'https://example.com/nolength', sourceClass: 'unknown', acquisitionRoute: 'fetch' },
    excerpt,
    locator: { start: 0, end: 10 },
  }));
  assert.ok('rejected' in bad);
  assert.equal(bad.rejected.reason, 'locator does not match excerpt length');
  const ok = state.addEvidence(baseInput({
    sourceRef: { canonicalUrl: 'https://example.com/matching', sourceClass: 'unknown', acquisitionRoute: 'fetch' },
    excerpt,
    locator: { start: 0, end: 40 },
  }));
  assert.ok(!('rejected' in ok));
});

test('oversized excerpt rejects; evidence limit rejects past the cap', async () => {
  const { MAX_EVIDENCE } = await import('../../../src/web/agent/agent-state.js');
  const state = createAgentState({ goal: 'g' });
  const big = state.addEvidence(baseInput({ excerpt: 'é'.repeat(3000) }));
  assert.ok('rejected' in big);
  assert.equal(big.rejected.reason, 'excerpt exceeds maximum bytes');
  for (let i = 0; i < MAX_EVIDENCE; i += 1) {
    const admitted = state.addEvidence(baseInput({
      sourceRef: { canonicalUrl: `https://example.com/p${i}`, sourceClass: 'unknown', acquisitionRoute: 'fetch' },
      excerpt: `distinct evidence passage number ${i} about zebra herds`,
    }));
    assert.ok(!('rejected' in admitted), `insert ${i} must admit`);
  }
  const over = state.addEvidence(baseInput({
    sourceRef: { canonicalUrl: 'https://example.com/overflow', sourceClass: 'unknown', acquisitionRoute: 'fetch' },
    excerpt: 'one passage too many for the evidence budget',
  }));
  assert.ok('rejected' in over);
  assert.equal(over.rejected.reason, 'evidence limit reached');
});

test('recordQuery caps count and bytes; snapshot stays bounded', async () => {
  const { MAX_QUERIES, MAX_QUERY_BYTES } = await import('../../../src/web/agent/agent-state.js');
  const state = createAgentState({ goal: 'g' });
  const big = state.recordQuery({ query: 'x'.repeat(MAX_QUERY_BYTES + 1), route: 'search' });
  assert.ok('rejected' in big);
  assert.equal(big.rejected.reason, 'query exceeds maximum bytes');
  for (let i = 0; i < MAX_QUERIES; i += 1) {
    const admitted = state.recordQuery({ query: `distinct bounded query number ${i} about zebra herds`, route: 'search' });
    assert.ok(!('rejected' in admitted), `insert ${i} must admit`);
  }
  const over = state.recordQuery({ query: 'one query too many for the budget', route: 'search' });
  assert.ok('rejected' in over);
  assert.equal(over.rejected.reason, 'query limit reached');
  assert.equal(state.queries.length, MAX_QUERIES);
  assert.ok(Buffer.byteLength(state.snapshot(), 'utf8') < 1024 * 1024, 'snapshot stays bounded');
});

test('addQuestion rejects overlong questions; createAgentState rejects overlong goals', async () => {
  const { MAX_GOAL_BYTES, MAX_QUESTION_BYTES } = await import('../../../src/web/agent/agent-state.js');
  const state = createAgentState({ goal: 'g' });
  const big = state.addQuestion({ question: 'q'.repeat(MAX_QUESTION_BYTES + 1) });
  assert.ok('rejected' in big);
  assert.equal(big.rejected.reason, 'question exceeds maximum bytes');
  const ok = state.addQuestion({ question: 'q'.repeat(MAX_QUESTION_BYTES) });
  assert.ok(!('rejected' in ok));
  assert.throws(() => createAgentState({ goal: 'g'.repeat(MAX_GOAL_BYTES + 1) }), {
    name: 'RangeError',
    message: 'goal exceeds maximum bytes',
  });
  assert.doesNotThrow(() => createAgentState({ goal: 'g'.repeat(MAX_GOAL_BYTES) }));
});

test('addQuestion rejects past the cap; snapshot stays bounded', async () => {
  const { MAX_QUESTIONS } = await import('../../../src/web/agent/agent-state.js');
  const state = createAgentState({ goal: 'g' });
  const empty = state.addQuestion({ question: '   ' });
  assert.ok('rejected' in empty);
  assert.equal(empty.rejected.reason, 'question is required');
  for (let i = 0; i < MAX_QUESTIONS; i += 1) {
    const admitted = state.addQuestion({ question: `bounded question number ${i} about pricing tiers?` });
    assert.ok(!('rejected' in admitted), `insert ${i} must admit`);
  }
  const over = state.addQuestion({ question: 'one question too many for the budget?' });
  assert.ok('rejected' in over);
  assert.equal(over.rejected.reason, 'question limit reached');
  assert.equal(state.questions.length, MAX_QUESTIONS);
});

test('unknown top-level keys are ignored via allowlist construction', () => {
  const state = createAgentState({ goal: 'g' });
  const result = state.addEvidence({ ...baseInput(), injected: 'evil' } as unknown as AgentEvidenceInput);
  assert.ok(!('rejected' in result));
  assert.ok(!('injected' in result));
  assert.deepEqual(Object.keys(result).sort(), ['corroboratingFingerprint', 'documentHash', 'excerpt', 'excerptHash', 'id', 'locator', 'questionIds', 'round', 'sourceRef', 'status']);
});

test('route normalization dedupes case/whitespace variants', () => {
  const state = createAgentState({ goal: 'g' });
  const first = state.recordQuery({ query: 'zebra migration', route: 'search' });
  assert.ok(!('rejected' in first));
  const variant = state.recordQuery({ query: 'zebra migration', route: ' Search ' });
  assert.ok('rejected' in variant);
  assert.equal(variant.rejected.reason, 'exact duplicate query');
});

test('promoteToGrounded records groundedBy linkage', () => {
  const state = createAgentState({ goal: 'g' });
  state.questions.push({ id: questionId('pricing'), question: 'pricing', priority: 1, required: true, status: 'open' });
  const admitted = state.addEvidence(baseInput());
  assert.ok(!('rejected' in admitted));
  assert.equal(state.promoteToGrounded(questionId('pricing'), [admitted.id]), true);
  assert.deepEqual(state.questions[0]!.groundedBy, [admitted.id]);
});

test('admitFromFetch admits chunks; truncates overlong content within the evidence cap', async () => {
  const { admitFromFetch, MAX_FETCH_CONTENT_BYTES } = await import('../../../src/web/agent/agent-acquisition.js');
  const { MAX_EVIDENCE } = await import('../../../src/web/agent/agent-state.js');
  const state = createAgentState({ goal: 'g' });
  const content = 'Alpha evidence sentence about pricing tiers and plan details. '.repeat(40);
  const normal = admitFromFetch(state, { kind: 'fetch', url: 'https://example.com/page', canonicalUrl: 'https://example.com/page', content });
  assert.equal(normal.truncated, false);
  assert.ok(normal.evidence.length > 0);
  assert.equal(normal.rejectedCount, 0);
  assert.deepEqual(normal.rejectionReasons, []);
  assert.equal(normal.mergedCount, 0);
  const crowded = createAgentState({ goal: 'g' });
  const overlong = 'zebra herd migration sentence with ample filler words. '.repeat(6000);
  assert.ok(Buffer.byteLength(overlong, 'utf8') > MAX_FETCH_CONTENT_BYTES);
  const clipped = admitFromFetch(crowded, { kind: 'fetch', url: 'https://example.com/big', canonicalUrl: 'https://example.com/big', content: overlong });
  assert.equal(clipped.truncated, true);
  assert.ok(clipped.evidence.length > 0);
  assert.ok(clipped.evidence.length <= MAX_EVIDENCE, 'overlong pages stay within the evidence cap');
  assert.equal(typeof clipped.rejectedCount, 'number');
  assert.ok(Array.isArray(clipped.rejectionReasons));
  assert.ok(clipped.rejectionReasons.length <= 3, 'rejection reasons stay bounded');
});

test('admitFromFetch surfaces merged count on refetch for a new question', async () => {
  const { admitFromFetch } = await import('../../../src/web/agent/agent-acquisition.js');
  const state = createAgentState({ goal: 'g' });
  const content = 'Alpha evidence sentence about pricing tiers and plan details. '.repeat(40);
  const fetch = { kind: 'fetch' as const, url: 'https://example.com/page', canonicalUrl: 'https://example.com/page', content };
  const first = admitFromFetch(state, fetch, ['q-1']);
  assert.ok(first.evidence.length > 0);
  assert.equal(first.mergedCount, 0);
  const refetch = admitFromFetch(state, fetch, ['q-2']);
  assert.equal(refetch.evidence.length, 0, 'no new entries on identical refetch');
  assert.equal(refetch.rejectedCount, 0, 'unions are not rejections');
  assert.equal(refetch.mergedCount, first.evidence.length);
  const linked = state.admittedEvidence.filter((e) => e.questionIds.includes('q-2'));
  assert.equal(linked.length, first.evidence.length, 'refetch links every chunk to the new question');
});
