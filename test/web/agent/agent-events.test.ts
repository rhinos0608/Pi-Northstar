import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AGENT_EVENT_QUERY_MAX_BYTES,
  AGENT_EVENT_URL_MAX_BYTES,
  MAX_JOURNAL_BYTES,
  createAgentEventJournal,
  projectAgentState,
  replayable,
  serializeJournal,
  validateAgentResearchEvent,
  type AgentEventJournal,
  type AgentResearchEvent,
} from '../../../src/web/agent/agent-events.js';
import { canonicalJson } from '../../../src/web/agent/agent-contract.js';

const JOB = 'job-abc123';
const Q1 = 'q-aaaabbbbcccc';
const Q2 = 'rf-0123456789abcdef';
const EV1 = 'ev-0123456789abcdef';
const HASH = 'abcdef0123456789';
const FP = '0123456789abcdef';

function validEvents(): AgentResearchEvent[] {
  return [
    { type: 'JobCreated', jobId: JOB, query: 'laptops', createdAtMs: 1000 },
    { type: 'PlanAccepted', jobId: JOB, questionsTotal: 2, questionIds: [Q1, Q2], scopeNoteCount: 1 },
    { type: 'SearchCompleted', jobId: JOB, round: 1, query: 'laptops price', hitCount: 5, searchesUsed: 1 },
    { type: 'FetchCompleted', jobId: JOB, round: 1, canonicalUrl: 'https://example.com/a', byteLength: 100, fetchesUsed: 1 },
    { type: 'EvidenceAdmitted', jobId: JOB, evidenceId: EV1, round: 1, questionIds: [Q1], excerptHash: HASH, fingerprint: FP },
    { type: 'EvaluationAccepted', jobId: JOB, round: 1, answeredCount: 1, nextQueryCount: 1, droppedNextQueries: 0 },
    { type: 'RoundClosed', jobId: JOB, round: 1, growthCount: 1, conflictsCount: 0 },
    { type: 'SynthesisCompleted', jobId: JOB, claimUnitCount: 2, blockCount: 1, orphanedCount: 0 },
    { type: 'VerificationCompleted', jobId: JOB, supportedCount: 2, refutedCount: 0, unsupportedCount: 0, repairApplied: 1, repairRejected: 0 },
    { type: 'CandidatesAccumulated', jobId: JOB, round: 1, added: 2, dropped: 1 },
    { type: 'JobReady', jobId: JOB, resultByteLength: 512, warningCount: 0 },
  ];
}

function journalOf(events: AgentResearchEvent[]): AgentEventJournal {
  const created = createAgentEventJournal(JOB);
  assert.ok(!('rejected' in created));
  const journal = created as AgentEventJournal;
  for (const event of events) {
    const appended = journal.append(event);
    assert.equal(appended.ok, true, JSON.stringify(appended));
  }
  return journal;
}

test('all eleven event types construct', () => {
  for (const event of validEvents()) {
    const checked = validateAgentResearchEvent(event);
    assert.equal(checked.ok, true, event.type);
  }
});

test('unknown type rejects', () => {
  const checked = validateAgentResearchEvent({ type: 'Nope', jobId: JOB });
  assert.equal(checked.ok, false);
  if (!checked.ok) assert.match(checked.reason, /unknown event type/);
});

test('exact-keys: missing and extra fields reject', () => {
  const missing = validateAgentResearchEvent({ type: 'JobCreated', jobId: JOB, query: 'x' });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.reason, /missing field/);
  const extra = validateAgentResearchEvent({ type: 'JobCreated', jobId: JOB, query: 'x', createdAtMs: 1, provider: 'p' });
  assert.equal(extra.ok, false);
  if (!extra.ok) assert.match(extra.reason, /unexpected field/);
  // Optional stopReason is the only allowed extra key, and only on RoundClosed.
  const withStop = validateAgentResearchEvent({ type: 'RoundClosed', jobId: JOB, round: 1, growthCount: 0, conflictsCount: 0, stopReason: 'done' });
  assert.equal(withStop.ok, true);
  const badStop = validateAgentResearchEvent({ type: 'RoundClosed', jobId: JOB, round: 1, growthCount: 0, conflictsCount: 0, stopReason: '' });
  assert.equal(badStop.ok, false);
});

test('byte caps: query 512 and canonicalUrl 2048', () => {
  const bigQuery = validateAgentResearchEvent({ type: 'SearchCompleted', jobId: JOB, round: 1, query: 'x'.repeat(AGENT_EVENT_QUERY_MAX_BYTES + 1), hitCount: 0, searchesUsed: 0 });
  assert.equal(bigQuery.ok, false);
  const bigCreated = validateAgentResearchEvent({ type: 'JobCreated', jobId: JOB, query: 'x'.repeat(AGENT_EVENT_QUERY_MAX_BYTES + 1), createdAtMs: 1 });
  assert.equal(bigCreated.ok, false);
  const bigUrl = validateAgentResearchEvent({ type: 'FetchCompleted', jobId: JOB, round: 1, canonicalUrl: `https://example.com/${'x'.repeat(AGENT_EVENT_URL_MAX_BYTES)}`, byteLength: 1, fetchesUsed: 1 });
  assert.equal(bigUrl.ok, false);
  const badUrl = validateAgentResearchEvent({ type: 'FetchCompleted', jobId: JOB, round: 1, canonicalUrl: '/etc/passwd', byteLength: 1, fetchesUsed: 1 });
  assert.equal(badUrl.ok, false);
});

test('bad ids reject: jobId, evidenceId, questionIds', () => {
  assert.equal(validateAgentResearchEvent({ type: 'JobCreated', jobId: 'BAD!!', query: 'x', createdAtMs: 1 }).ok, false);
  assert.equal(validateAgentResearchEvent({ type: 'JobCreated', jobId: '', query: 'x', createdAtMs: 1 }).ok, false);
  const badEv = validateAgentResearchEvent({ type: 'EvidenceAdmitted', jobId: JOB, evidenceId: 'nope', round: 1, questionIds: [Q1], excerptHash: HASH, fingerprint: FP });
  assert.equal(badEv.ok, false);
  const badQ = validateAgentResearchEvent({ type: 'PlanAccepted', jobId: JOB, questionsTotal: 1, questionIds: ['bad'], scopeNoteCount: 0 });
  assert.equal(badQ.ok, false);
  // questionsTotal must match questionIds length.
  const mismatch = validateAgentResearchEvent({ type: 'PlanAccepted', jobId: JOB, questionsTotal: 5, questionIds: [Q1], scopeNoteCount: 0 });
  assert.equal(mismatch.ok, false);
});

test('count violations reject: negatives, floats, wrong types', () => {
  const neg = validateAgentResearchEvent({ type: 'SearchCompleted', jobId: JOB, round: 1, query: 'x', hitCount: -1, searchesUsed: 0 });
  assert.equal(neg.ok, false);
  const float = validateAgentResearchEvent({ type: 'JobReady', jobId: JOB, resultByteLength: 1.5, warningCount: 0 });
  assert.equal(float.ok, false);
  const str = validateAgentResearchEvent({ type: 'EvaluationAccepted', jobId: JOB, round: 1, answeredCount: '1', nextQueryCount: 0, droppedNextQueries: 0 });
  assert.equal(str.ok, false);
  const badHash = validateAgentResearchEvent({ type: 'EvidenceAdmitted', jobId: JOB, evidenceId: EV1, round: 1, questionIds: [Q1], excerptHash: 'ZZZ', fingerprint: FP });
  assert.equal(badHash.ok, false);
});

test('journal rejects jobId mismatch and bad factory id', () => {
  const badFactory = createAgentEventJournal('BAD!!');
  assert.ok('rejected' in badFactory);
  const journal = journalOf(validEvents().slice(0, 2));
  const mismatch = journal.append({ type: 'SearchCompleted', jobId: 'other-job', round: 1, query: 'x', hitCount: 0, searchesUsed: 1 });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.match(mismatch.reason, /mismatch/);
});

test('journal byte cap rejects without truncating', () => {
  const created = createAgentEventJournal(JOB);
  assert.ok(!('rejected' in created));
  const journal = created as AgentEventJournal;
  assert.equal(journal.append({ type: 'JobCreated', jobId: JOB, query: 'x', createdAtMs: 1 }).ok, true);
  // Fill with max-size queries until the cap trips.
  const bigQuery = 'y'.repeat(AGENT_EVENT_QUERY_MAX_BYTES);
  let rejected = 0;
  for (let i = 0; i < 2000; i++) {
    const result = journal.append({ type: 'SearchCompleted', jobId: JOB, round: 1, query: `${bigQuery.slice(0, 400)}-${i}`, hitCount: 1, searchesUsed: i + 1 });
    if (!result.ok) {
      assert.match(result.reason, /journal byte limit reached/);
      rejected++;
      break;
    }
  }
  assert.equal(rejected, 1);
  // Drain remaining headroom with small events until the cap trips again.
  let drained = false;
  for (let i = 0; i < 5000; i++) {
    const result = journal.append({ type: 'SearchCompleted', jobId: JOB, round: 1, query: `d-${i}`, hitCount: 0, searchesUsed: 2000 + i });
    if (!result.ok) {
      assert.match(result.reason, /journal byte limit reached/);
      drained = true;
      break;
    }
  }
  assert.equal(drained, true);
  const before = journal.events.length;
  const over = journal.append({ type: 'SearchCompleted', jobId: JOB, round: 1, query: 'one-more', hitCount: 1, searchesUsed: 99999 });
  assert.equal(over.ok, false);
  assert.equal(journal.events.length, before, 'rejected append never truncates or mutates');
  assert.ok(Buffer.byteLength(serializeJournal(journal), 'utf8') <= MAX_JOURNAL_BYTES);
});

test('projection accumulates rounds/counters/answered from scripted sequence', () => {
  const journal = journalOf(validEvents());
  const projected = projectAgentState(journal, 'goal');
  assert.equal(projected.ok, true);
  if (!projected.ok) return;
  assert.equal(projected.state.rounds, 1);
  assert.equal(projected.state.searchesUsed, 1);
  assert.equal(projected.state.fetchesUsed, 1);
  assert.deepEqual(projected.state.evidenceIds, [EV1]);
  assert.deepEqual(projected.state.questionIds, [Q1, Q2]);
  assert.equal(projected.state.counts.answered, 1);
  assert.equal(projected.state.counts.grounded, 2);
});

test('projection fail-closed on unknown event type', () => {
  const journal = journalOf(validEvents().slice(0, 3));
  journal.events.push({ type: 'Bogus', jobId: JOB } as unknown as AgentResearchEvent);
  const projected = projectAgentState(journal, 'goal');
  assert.equal(projected.ok, false);
  if (!projected.ok) assert.match(projected.reason, /unknown event type/);
});

test('replay: complete journal passes, monotonicity violations fail', () => {
  assert.equal(replayable(JOB, journalOf(validEvents())), true);
  // Incomplete prefix (no JobReady) still replays.
  assert.equal(replayable(JOB, journalOf(validEvents().slice(0, 5))), true);
  // Round regression fails.
  const regress = journalOf(validEvents().slice(0, 4));
  regress.events.push({ type: 'SearchCompleted', jobId: JOB, round: 0, query: 'back', hitCount: 0, searchesUsed: 2 });
  assert.equal(replayable(JOB, regress), false);
  // Counter regression fails.
  const counterRegress = journalOf(validEvents().slice(0, 3));
  counterRegress.events.push({ type: 'SearchCompleted', jobId: JOB, round: 1, query: 'back', hitCount: 0, searchesUsed: 0 });
  assert.equal(replayable(JOB, counterRegress), false);
  // JobReady mid-journal fails; missing JobCreated fails.
  const midReady = journalOf(validEvents().slice(0, 2));
  midReady.events.push({ type: 'JobReady', jobId: JOB, resultByteLength: 1, warningCount: 0 });
  midReady.events.push({ type: 'SearchCompleted', jobId: JOB, round: 1, query: 'late', hitCount: 0, searchesUsed: 2 });
  assert.equal(replayable(JOB, midReady), false);
  assert.equal(replayable(JOB, { jobId: JOB, events: [{ type: 'SearchCompleted', jobId: JOB, round: 1, query: 'x', hitCount: 0, searchesUsed: 0 }] }), false);
  assert.equal(replayable('other-job', journalOf(validEvents())), false);
});

test('determinism: same events yield identical canonical bytes', () => {
  const a = journalOf(validEvents());
  const b = journalOf(validEvents());
  assert.equal(serializeJournal(a), serializeJournal(b));
  assert.equal(serializeJournal(a), canonicalJson({ jobId: JOB, events: validEvents() }));
  // Key order in input does not change bytes.
  const reordered = { jobId: JOB, query: 'laptops', createdAtMs: 1000, type: 'JobCreated' };
  assert.equal(validateAgentResearchEvent(reordered).ok, true);
});

test('EvidenceAdmitted accepts URL-less structured-identity anchors with typed locators', () => {
  // KG row: '' sentinel + identity + {nodeId, field} locator.
  const kg = {
    type: 'EvidenceAdmitted',
    jobId: JOB,
    evidenceId: EV1,
    round: 1,
    questionIds: [Q1],
    excerptHash: HASH,
    fingerprint: FP,
    canonicalUrl: '',
    identity: { provider: 'wikidata', query: 'Quartz release', nodeId: 'Q-quartz-9' },
    locator: { nodeId: 'Q-quartz-9', field: 'releaseNotes' },
  };
  assert.equal(validateAgentResearchEvent(kg).ok, true, JSON.stringify(validateAgentResearchEvent(kg)));
  // Research abstract: '' sentinel + provider/query identity + char-range locator.
  const abstract = {
    type: 'EvidenceAdmitted',
    jobId: JOB,
    evidenceId: EV1,
    round: 2,
    questionIds: [Q1],
    excerptHash: HASH,
    fingerprint: FP,
    canonicalUrl: '',
    identity: { provider: 'openalex', query: 'zebra migration corridors' },
    locator: { start: 0, end: 128 },
  };
  assert.equal(validateAgentResearchEvent(abstract).ok, true, JSON.stringify(validateAgentResearchEvent(abstract)));
  // URL-anchored evidence with a locator still validates (locator optional shape).
  const url = {
    type: 'EvidenceAdmitted',
    jobId: JOB,
    evidenceId: EV1,
    round: 1,
    questionIds: [Q1],
    excerptHash: HASH,
    fingerprint: FP,
    canonicalUrl: 'https://example.com/paper',
    locator: { page: 2 },
  };
  assert.equal(validateAgentResearchEvent(url).ok, true, JSON.stringify(validateAgentResearchEvent(url)));
});

test('EvidenceAdmitted rejects malformed anchors, identities, and locators', () => {
  const base = {
    type: 'EvidenceAdmitted',
    jobId: JOB,
    evidenceId: EV1,
    round: 1,
    questionIds: [Q1],
    excerptHash: HASH,
    fingerprint: FP,
  };
  const bad = [
    // '' sentinel without identity.
    { ...base, canonicalUrl: '' },
    // URL + identity together (XOR violation).
    { ...base, canonicalUrl: 'https://example.com/a', identity: { provider: 'kg', query: 'q' } },
    // Non-http URL.
    { ...base, canonicalUrl: 'ftp://example.com/a' },
    // Empty provider / oversized nodeId.
    { ...base, canonicalUrl: '', identity: { provider: '', query: 'q' } },
    { ...base, canonicalUrl: '', identity: { provider: 'kg', query: 'q', nodeId: `n-${'x'.repeat(300)}` } },
    // Split KG locator.
    { ...base, canonicalUrl: '', identity: { provider: 'kg', query: 'q' }, locator: { nodeId: 'n-1' } },
    // Unknown locator variant.
    { ...base, canonicalUrl: '', identity: { provider: 'kg', query: 'q' }, locator: { offset: 3 } },
  ];
  for (const event of bad) {
    assert.equal(validateAgentResearchEvent(event).ok, false, JSON.stringify(event));
  }
});

test('replay-compat: legacy EvidenceAdmitted validates byte-for-byte', () => {
  const legacy = { type: 'EvidenceAdmitted', jobId: JOB, evidenceId: EV1, round: 1, questionIds: [Q1], excerptHash: HASH, fingerprint: FP };
  assert.equal(validateAgentResearchEvent(legacy).ok, true);
  const journal = journalOf([validEvents()[0]!, legacy as never]);
  assert.equal(
    serializeJournal(journal),
    canonicalJson({ jobId: JOB, events: [validEvents()[0], legacy] }),
  );
});

test('CandidatesAccumulated validates count-only shape with exact keys', () => {
  const valid = { type: 'CandidatesAccumulated', jobId: JOB, round: 1, added: 3, dropped: 1 };
  assert.equal(validateAgentResearchEvent(valid).ok, true, JSON.stringify(validateAgentResearchEvent(valid)));
  const zero = { type: 'CandidatesAccumulated', jobId: JOB, round: 1, added: 0, dropped: 0 };
  assert.equal(validateAgentResearchEvent(zero).ok, true);
  const extra = { ...valid, titles: ['leaked title'] };
  assert.equal(validateAgentResearchEvent(extra).ok, false);
  if (!validateAgentResearchEvent(extra).ok) {
    assert.match((validateAgentResearchEvent(extra) as { ok: false; reason: string }).reason, /unexpected field/);
  }
  const missing = { type: 'CandidatesAccumulated', jobId: JOB, round: 1, added: 3 };
  assert.equal(validateAgentResearchEvent(missing).ok, false);
  const negative = { type: 'CandidatesAccumulated', jobId: JOB, round: 1, added: -1, dropped: 0 };
  assert.equal(validateAgentResearchEvent(negative).ok, false);
  const float = { type: 'CandidatesAccumulated', jobId: JOB, round: 1, added: 1.5, dropped: 0 };
  assert.equal(validateAgentResearchEvent(float).ok, false);
});

test('CandidatesAccumulated joins round monotonicity and projects as a no-op', () => {
  const acc = (round: number, added: number, dropped: number): AgentResearchEvent => ({
    type: 'CandidatesAccumulated', jobId: JOB, round, added, dropped,
  });
  // Multi-round journal replays cleanly with candidate events interleaved.
  const journal = journalOf([
    validEvents()[0]!,
    validEvents()[1]!,
    acc(1, 3, 1),
    { type: 'SearchCompleted', jobId: JOB, round: 1, query: 'laptops price', hitCount: 5, searchesUsed: 1 },
    acc(2, 0, 2),
    { type: 'SearchCompleted', jobId: JOB, round: 2, query: 'laptops warranty', hitCount: 2, searchesUsed: 2 },
  ]);
  assert.equal(replayable(JOB, journal), true);
  // Round regression through the candidate event fails replay: roundOf sees it.
  const regress = journalOf([validEvents()[0]!, validEvents()[1]!, acc(2, 1, 0)]);
  regress.events.push(acc(1, 0, 1));
  assert.equal(replayable(JOB, regress), false);
  // Projection ignores the counts: no state mutation, rounds untouched.
  const projected = projectAgentState(regress, 'goal');
  assert.equal(projected.ok, true);
  if (!projected.ok) return;
  assert.equal(projected.state.rounds, 0);
  assert.deepEqual(projected.state.evidenceIds, []);
});
