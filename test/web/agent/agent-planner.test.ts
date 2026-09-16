import assert from 'node:assert/strict';
import { test } from 'node:test';
import { questionId } from '../../../src/web/agent/agent-state.js';
import { buildPlannerPrompt, fallbackPlan, normalizePlan } from '../../../src/web/agent/agent-planner.js';

test('normalizePlan accepts a valid plan and recomputes ids', () => {
  const raw = {
    questions: [
      { id: 'caller-lies', question: 'What drives savanna zebra migration patterns?', priority: 1, required: false },
      { question: 'How do seasonal corridors shift herd movement yearly?', priority: 2 },
    ],
    scopeNotes: ['cover migration drivers'],
    extraTopLevel: 'ignored',
  };
  const result = normalizePlan(raw);
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  const q0 = result.plan.questions[0];
  const q1 = result.plan.questions[1];
  assert.ok(q0);
  assert.ok(q1);
  assert.deepEqual(q0.id, questionId('What drives savanna zebra migration patterns?'));
  assert.deepEqual(q1.id, questionId('How do seasonal corridors shift herd movement yearly?'));
  assert.equal(q1.required, true);
  assert.deepEqual(result.plan.scopeNotes, ['cover migration drivers']);
});

test('normalizePlan truncates beyond 5 questions but stays ok', () => {
  const raw = {
    questions: Array.from({ length: 7 }, (_, i) => ({ question: `Research question number ${i} covering distinct scope?` })),
  };
  const result = normalizePlan(raw);
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.equal(result.plan.questions.length, 5);
  assert.ok(result.issues.includes('plan truncated to 5 questions'));
});

test('normalizePlan rejects duplicate questions after id recompute', () => {
  const raw = { questions: [{ question: 'What drives savanna zebra migration patterns?' }, { question: '  WHAT DRIVES savanna zebra migration patterns? ' }] };
  const result = normalizePlan(raw);
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.issues.some((issue) => issue.includes('duplicate question')));
});

test('normalizePlan rejects byte-bound violations and non-objects', () => {
  assert.equal(normalizePlan(null).ok, false);
  assert.equal(normalizePlan([]).ok, false);
  assert.equal(normalizePlan({}).ok, false);
  assert.equal(normalizePlan({ questions: [] }).ok, false);
  assert.equal(normalizePlan({ questions: [{ question: 'tiny' }] }).ok, false);
  assert.equal(normalizePlan({ questions: [{ question: 'x'.repeat(513) }] }).ok, false);
  assert.equal(normalizePlan({ questions: [{ question: 42 }] }).ok, false);
});

test('normalizePlan single-lines questions: newline-fold, control strip, then byte check', () => {
  const folded = normalizePlan({ questions: [{ question: 'What drives\n savanna\r\n zebra\tmigration patterns yearly?' }] });
  assert.ok(folded.ok);
  const q = folded.ok ? folded.plan.questions[0] : undefined;
  assert.ok(q);
  assert.ok(!q.question.includes('\n') && !q.question.includes('\r'));
  assert.equal(q.question, 'What drives savanna zebra migration patterns yearly?');
  assert.deepEqual(q.id, questionId(q.question));
  const controlled = normalizePlan({ questions: [{ question: 'What drives savanna zebra\u0007 migration patterns yearly?' }] });
  assert.ok(controlled.ok);
  const cq = controlled.ok ? controlled.plan.questions[0] : undefined;
  assert.ok(cq && !cq.question.includes('\u0007'));
});

test('normalizePlan coerces and clamps priority', () => {
  const high = normalizePlan({ questions: [{ question: 'What drives savanna zebra migration patterns?', priority: 99 }] });
  assert.ok(high.ok);
  const hp = high.ok ? high.plan.questions[0] : undefined;
  assert.ok(hp);
  assert.equal(hp.priority, 3);
  assert.ok(high.ok && high.issues.length > 0);
  const low = normalizePlan({ questions: [{ question: 'What drives savanna zebra migration patterns?', priority: -5 }] });
  const lp = low.ok ? low.plan.questions[0] : undefined;
  assert.ok(lp);
  assert.equal(lp.priority, 1);
  const missing = normalizePlan({ questions: [{ question: 'What drives savanna zebra migration patterns?' }] });
  const mp = missing.ok ? missing.plan.questions[0] : undefined;
  assert.ok(mp);
  assert.equal(mp.priority, 2);
});

test('fallbackPlan uses root goal as single required question', () => {
  const goal = 'Explain zebra migration corridors';
  const plan = fallbackPlan(goal);
  assert.equal(plan.questions.length, 1);
  const fp = plan.questions[0];
  assert.ok(fp);
  assert.deepEqual(fp, { id: questionId(goal), question: goal, priority: 3, required: true });
  assert.deepEqual(plan.scopeNotes, ['planner fallback: root goal as single required question']);
});

test('buildPlannerPrompt is deterministic', () => {
  const a = buildPlannerPrompt('zebra migration', { maxRounds: 3, maxSearches: 10 });
  const b = buildPlannerPrompt('zebra migration', { maxRounds: 3, maxSearches: 10 });
  assert.equal(a, b);
  assert.ok(a.includes('zebra migration'));
  assert.ok(a.includes('"questions"'));
});

test('buildPlannerPrompt clamps overlong goals and collapses newlines', async () => {
  const { MAX_GOAL_BYTES, sanitizeGoal } = await import('../../../src/web/agent/agent-planner.js');
  const overlong = 'g'.repeat(MAX_GOAL_BYTES + 100);
  const prompt = buildPlannerPrompt(`line one\n${overlong}\nline three`, { maxRounds: 3, maxSearches: 10 });
  const goalLine = prompt.split('\n').find((line) => line.startsWith('Goal: '));
  assert.ok(goalLine);
  assert.ok(Buffer.byteLength(goalLine, 'utf8') <= 'Goal: '.length + MAX_GOAL_BYTES);
  assert.ok(!goalLine.includes('\n'));
  assert.equal(sanitizeGoal('a\nb\r\nc'), 'a b c');
});

test('sanitizeGoal strips invisible/control formatting before folding', async () => {
  const { sanitizeGoal } = await import('../../../src/web/agent/agent-planner.js');
  assert.equal(sanitizeGoal('a\u200b\u200eb\u0007c'), 'abc');
  assert.equal(sanitizeGoal('goal\u2028line'), 'goalline');
  assert.equal(sanitizeGoal('a\nb\r\nc'), 'a b c');
});

test('fallbackPlan truncates overlong goals to the byte cap', async () => {
  const { MAX_GOAL_BYTES } = await import('../../../src/web/agent/agent-planner.js');
  const plan = fallbackPlan('g'.repeat(MAX_GOAL_BYTES + 500));
  const q = plan.questions[0];
  assert.ok(q);
  assert.ok(Buffer.byteLength(q.question, 'utf8') <= MAX_GOAL_BYTES);
  assert.deepEqual(q.id, questionId(q.question));
});

test('normalizePlan accepts nested intent per question', async () => {
  const { questionId } = await import('../../../src/web/agent/agent-state.js');
  const raw = {
    questions: [
      {
        question: 'What drives savanna zebra migration patterns?',
        intent: { kind: 'web_search', query: 'savanna zebra migration drivers' },
      },
      {
        question: 'Which papers model corridor shifts yearly?',
        intent: { kind: 'research_search', query: 'zebra corridor shift models', source: 'openalex', yearFrom: 2010 },
      },
    ],
  };
  const result = normalizePlan(raw);
  assert.ok(result.ok);
  const q0 = result.ok ? result.plan.questions[0] : undefined;
  const q1 = result.ok ? result.plan.questions[1] : undefined;
  assert.ok(q0 && q1);
  assert.deepEqual(q0.intent, { kind: 'web_search', query: 'savanna zebra migration drivers' });
  assert.deepEqual(q1.intent, {
    kind: 'research_search',
    query: 'zebra corridor shift models',
    source: 'openalex',
    yearFrom: 2010,
  });
  assert.deepEqual(q0.id, questionId('What drives savanna zebra migration patterns?'));
});

test('normalizePlan drops invalid intent with warning, question still stands', () => {
  const raw = {
    questions: [{ question: 'What drives savanna zebra migration patterns?', intent: { kind: 'graph_search', query: 'zebras' } }],
  };
  const result = normalizePlan(raw);
  assert.ok(result.ok);
  const q = result.ok ? result.plan.questions[0] : undefined;
  assert.ok(q);
  assert.equal(q.intent, undefined);
  assert.ok(result.ok && result.issues.some((issue) => issue.includes('intent dropped')));
});

test('normalizePlan rejects planner-supplied questionId with warning, recomputes id', async () => {
  const { questionId } = await import('../../../src/web/agent/agent-state.js');
  const raw = {
    questions: [{ id: 'caller-lies', questionId: 'also-lies', question: 'What drives savanna zebra migration patterns?' }],
  };
  const result = normalizePlan(raw);
  assert.ok(result.ok);
  const q = result.ok ? result.plan.questions[0] : undefined;
  assert.ok(q);
  assert.deepEqual(q.id, questionId('What drives savanna zebra migration patterns?'));
  assert.ok(result.ok && result.issues.some((issue) => issue.includes('questionId ignored')));
});

test('buildPlannerPrompt asks for per-question intent and forbids questionId', () => {
  const prompt = buildPlannerPrompt('zebra migration', { maxRounds: 3, maxSearches: 10 });
  assert.ok(prompt.includes('"intent"'));
  assert.ok(prompt.includes('Never emit questionId'));
});

test('buildPlannerPrompt never advertises deferred video/social lanes', () => {
  // Wave 9/D4: video/social lanes have no executor tool surface, so the
  // planner prompt must not teach them (the intent union keeps the kinds for
  // back-compat, but prompts must not advertise dead lanes).
  const prompt = buildPlannerPrompt('zebra migration', { maxRounds: 3, maxSearches: 10 });
  assert.ok(!prompt.includes('video_transcript'), 'planner prompt must not grammar video_transcript');
  assert.ok(!prompt.includes('social_search'), 'planner prompt must not grammar social_search');
  assert.ok(prompt.includes('kg_lookup'), 'live lanes stay advertised');
});

test('normalizePlan keeps a web_fetch nested intent through to seeds', () => {
  const raw = {
    questions: [
      {
        question: 'What does the launch pricing effects paper conclude?',
        intent: { kind: 'web_fetch', url: 'https://example.com/paper-1' },
      },
    ],
  };
  const candidates = [{ kind: 'research-source', route: 'research', source: 'arxiv', title: 'Paper 1', url: 'https://example.com/paper-1' }] as const;
  const result = normalizePlan(raw, [...candidates]);
  assert.ok(result.ok);
  const q = result.ok ? result.plan.questions[0] : undefined;
  assert.ok(q);
  assert.deepEqual(q.intent, { kind: 'web_fetch', url: 'https://example.com/paper-1' });
});

test('normalizePlan drops a web_fetch intent without candidate provenance, question still stands', () => {
  const rawProvenance = {
    questions: [{ question: 'What does the launch pricing effects paper conclude?', intent: { kind: 'web_fetch', url: 'https://example.com/paper-1' } }],
  };
  const noProvenance = normalizePlan(rawProvenance, []);
  assert.ok(noProvenance.ok);
  const qp = noProvenance.ok ? noProvenance.plan.questions[0] : undefined;
  assert.ok(qp);
  assert.equal(qp.intent, undefined);
  assert.ok(noProvenance.ok && noProvenance.issues.some((issue) => issue.includes('not a research-source candidate')));
});

test('normalizePlan drops a host-less web_fetch intent with warning, question still stands', () => {
  const raw = {
    questions: [{ question: 'What does the launch pricing effects paper conclude?', intent: { kind: 'web_fetch', url: 'https://?q=1' } }],
  };
  const result = normalizePlan(raw);
  assert.ok(result.ok);
  const q = result.ok ? result.plan.questions[0] : undefined;
  assert.ok(q);
  assert.equal(q.intent, undefined);
  assert.ok(result.ok && result.issues.some((issue) => issue.includes('intent dropped')));
});
