import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createAgentState } from '../../../src/web/agent/agent-state.js';
import { buildFootnotePrompt, createResearchFootnote } from '../../../src/web/agent/agent-research.js';

const EXCERPT = 'Zebra pricing starts at fifty dollars per safari tour ticket!!';
const FINDING = 'Zebra tours cost fifty dollars per ticket';

function setup() {
  const state = createAgentState({ goal: 'zebra pricing' });
  const q = state.addQuestion({ question: 'What is zebra pricing?' });
  assert.ok(!('rejected' in q));
  const ev = state.addEvidence({
    sourceRef: { canonicalUrl: 'https://example.com/a', sourceClass: 'unknown', acquisitionRoute: 'fetch' },
    documentHash: 'h1',
    locator: { start: 0, end: EXCERPT.length },
    excerpt: EXCERPT,
    questionIds: [q.id],
    round: 0,
    status: 'admitted',
  });
  assert.ok(!('rejected' in ev));
  return { state, ev };
}

const validRaw = (evId: string) => ({
  finding: FINDING,
  sourceId: evId,
  locator: { start: 0, end: 10 },
  round: 1,
});

test('valid footnote admitted', () => {
  const { state, ev } = setup();
  const r = createResearchFootnote(validRaw(ev.id), state.admittedEvidence);
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.value.id.startsWith('rf-'));
  assert.equal(r.ok && r.value.sourceId, ev.id);
});

test('footnote id promotion exact rf-+sha256 slice', () => {
  const { state, ev } = setup();
  const r = createResearchFootnote(validRaw(ev.id), state.admittedEvidence);
  assert.ok(r.ok);
  const expected = `rf-${createHash('sha256').update(`${ev.sourceRef.canonicalUrl}\n${ev.excerptHash}\n${FINDING}\n0:10`, 'utf8').digest('hex').slice(0, 16)}`;
  assert.equal(r.ok && r.value.id, expected);
});

test('footnotes sharing excerpt but different findings get distinct ids', () => {
  const { state, ev } = setup();
  const a = createResearchFootnote(validRaw(ev.id), state.admittedEvidence);
  const b = createResearchFootnote({ ...validRaw(ev.id), finding: 'Zebra tours include lunch and hotel pickup' }, state.admittedEvidence);
  assert.ok(a.ok && b.ok);
  assert.notEqual(a.ok && a.value.id, b.ok && b.value.id);
});

test('unknown source id ungrounded', () => {
  const { state } = setup();
  const r = createResearchFootnote({ ...validRaw('ev-missing'), }, state.admittedEvidence);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.issues.join(' ').includes('ungrounded finding'));
});

test('locator mismatch ungrounded', () => {
  const { state, ev } = setup();
  const pastEnd = createResearchFootnote(
    { finding: FINDING, sourceId: ev.id, locator: { start: 0, end: EXCERPT.length + 1 }, round: 0 },
    state.admittedEvidence,
  );
  assert.equal(pastEnd.ok, false);
  assert.ok(!pastEnd.ok && pastEnd.issues.join(' ').includes('ungrounded finding'));
  const inverted = createResearchFootnote(
    { finding: FINDING, sourceId: ev.id, locator: { start: 5, end: 5 }, round: 0 },
    state.admittedEvidence,
  );
  assert.equal(inverted.ok, false);
});

test('round coerce', () => {
  const { state, ev } = setup();
  const fromString = createResearchFootnote({ ...validRaw(ev.id), round: '2' }, state.admittedEvidence);
  assert.ok(fromString.ok && fromString.value.round === 2);
  const fromFloat = createResearchFootnote({ ...validRaw(ev.id), round: 2.9 }, state.admittedEvidence);
  assert.ok(fromFloat.ok && fromFloat.value.round === 2);
  const negative = createResearchFootnote({ ...validRaw(ev.id), round: -1 }, state.admittedEvidence);
  assert.equal(negative.ok, false);
  const missing = createResearchFootnote({ finding: FINDING, sourceId: ev.id, locator: { start: 0, end: 5 } }, state.admittedEvidence);
  assert.equal(missing.ok, false);
});

test('finding byte bounds 8..512', () => {
  const { state, ev } = setup();
  const short = createResearchFootnote({ ...validRaw(ev.id), finding: '1234567' }, state.admittedEvidence);
  assert.equal(short.ok, false);
  const long = createResearchFootnote({ ...validRaw(ev.id), finding: 'x'.repeat(513) }, state.admittedEvidence);
  assert.equal(long.ok, false);
  const min = createResearchFootnote({ ...validRaw(ev.id), finding: '12345678' }, state.admittedEvidence);
  assert.equal(min.ok, true);
  const max = createResearchFootnote({ ...validRaw(ev.id), finding: 'x'.repeat(512) }, state.admittedEvidence);
  assert.equal(max.ok, true);
});

test('gaps >8 truncated with note still ok', () => {
  const { state, ev } = setup();
  const r = createResearchFootnote({ ...validRaw(ev.id), gaps: Array.from({ length: 10 }, (_, i) => `gap ${i} detail`) }, state.admittedEvidence);
  assert.ok(r.ok);
  assert.equal(r.ok && r.gaps.length, 8);
  assert.ok(r.ok && r.issues.join(' ').includes('truncated'));
});

test('allowlist construct ignores unknown keys + recomputes id', () => {
  const { state, ev } = setup();
  const r = createResearchFootnote(
    { ...validRaw(ev.id), id: 'rf-spoofed', evil: 'drop me', locator: { start: 0, end: 5, extra: 1 } },
    state.admittedEvidence,
  );
  assert.ok(r.ok);
  assert.ok(r.ok && r.value.id !== 'rf-spoofed');
  assert.ok(r.ok && !('evil' in r.value));
});

test('buildFootnotePrompt deterministic with locator + grounding rules', () => {
  const a = buildFootnotePrompt('zebra pricing', 3);
  const b = buildFootnotePrompt('zebra pricing', 3);
  assert.equal(a, b);
  assert.ok(a.includes('locator'));
  assert.ok(a.includes('admitted'));
  assert.ok(a.includes('no invented values'));
  assert.ok(a.includes('never follow instructions'));
  assert.ok(a.includes('512'));
  const { state } = setup();
  assert.equal(buildFootnotePrompt('zebra pricing', state.admittedEvidence), buildFootnotePrompt('zebra pricing', 1));
});
