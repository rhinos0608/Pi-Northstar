import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snapshotForJob } from '../../../src/web/agent/agent-capabilities.js';
import { intentRoute } from '../../../src/web/agent/agent-gather-intents.js';
import { normalizePlan } from '../../../src/web/agent/agent-planner.js';
import {
  admissibleGatherLanes,
  deriveGatherProfile,
  deriveProfileForPlan,
  planHasServableSpecialistNeed,
} from '../../../src/web/agent/agent-policy.js';

/** Wave 7: narrow reachable in production. The real production snapshot is
 *  specialist-capable (research/github always usable), so the old
 *  capability-only gate could never narrow. These tests pin the plan-driven
 *  gate against snapshotForJob({}) — the real baseline, not a synthetic one. */

test('production snapshot is specialist-capable (narrow must survive it)', () => {
  const snapshot = snapshotForJob({});
  const lanes = admissibleGatherLanes(snapshot);
  assert.ok(lanes.some((lane) => lane !== 'web'), 'production snapshot must carry a specialist lane');
});

test('production snapshot: single web-only question narrows', () => {
  const snapshot = snapshotForJob({});
  const normalized = normalizePlan({
    questions: [{ question: 'What is the capital of France?', intent: { kind: 'web_search', query: 'capital of France country' } }],
  });
  assert.equal(normalized.ok, true);
  if (!normalized.ok) return;
  const routes = normalized.plan.questions.map((q) => (q.intent === undefined ? 'web' : intentRoute(q.intent)));
  assert.deepEqual(routes, ['web']);
  assert.equal(
    deriveProfileForPlan({ requiredQuestionCount: 1, routes, snapshot, planValid: true }),
    'narrow',
  );
});

test('production snapshot: github/research intent stays balanced', () => {
  const snapshot = snapshotForJob({});
  for (const intent of [
    { kind: 'github_search', scope: 'code', query: 'agent planner intent routing' },
    { kind: 'research_search', query: 'evidence-first agent orchestration study' },
  ]) {
    const normalized = normalizePlan({ questions: [{ question: 'How is agent error handling implemented?', intent }] });
    assert.equal(normalized.ok, true);
    if (!normalized.ok) continue;
    const routes = normalized.plan.questions.map((q) => (q.intent === undefined ? 'web' : intentRoute(q.intent)));
    assert.ok(routes.some((route) => route !== 'web'));
    assert.equal(
      deriveProfileForPlan({ requiredQuestionCount: 1, routes, snapshot, planValid: true }),
      'balanced',
    );
  }
});

test('profile derivation matrix', () => {
  // 0 questions cannot narrow (normalizePlan rejects empty; gate stays balanced).
  assert.equal(normalizePlan({ questions: [] }).ok, false);
  assert.equal(deriveGatherProfile({ requiredQuestionCount: 0, specialistNeeded: false }), 'balanced');
  // 1 web-only narrows; 1 + specialist stays balanced.
  assert.equal(deriveGatherProfile({ requiredQuestionCount: 1, specialistNeeded: false }), 'narrow');
  assert.equal(deriveGatherProfile({ requiredQuestionCount: 1, specialistNeeded: true }), 'balanced');
  // Multi-question never narrows.
  assert.equal(deriveGatherProfile({ requiredQuestionCount: 3, specialistNeeded: false }), 'balanced');
  // Explicit deep wins regardless.
  assert.equal(deriveGatherProfile({ depth: 'deep', requiredQuestionCount: 1, specialistNeeded: false }), 'deep');
  // Invalid/absent plan stays balanced (fail toward more capacity).
  assert.equal(
    deriveProfileForPlan({ requiredQuestionCount: 1, routes: ['web'], planValid: false }),
    'balanced',
  );
  assert.equal(
    deriveProfileForPlan({ requiredQuestionCount: 1, routes: [], planValid: false }),
    'balanced',
  );
});

test('planHasServableSpecialistNeed: degraded-to-web intent narrows', () => {
  const snapshot = snapshotForJob({});
  // No specialist route, no need — regardless of snapshot.
  assert.equal(planHasServableSpecialistNeed({ routes: ['web'], snapshot }), false);
  assert.equal(planHasServableSpecialistNeed({ routes: [] }), false);
  // Specialist route without a snapshot to prove the degrade: conservative true.
  assert.equal(planHasServableSpecialistNeed({ routes: ['github'] }), true);
  // kg is unavailable in the production snapshot: intent degrades to web, no need.
  assert.equal(admissibleGatherLanes(snapshot).includes('kg'), false);
  assert.equal(planHasServableSpecialistNeed({ routes: ['kg'], snapshot }), false);
  // Servable specialist lanes hold balanced on the real snapshot.
  assert.equal(planHasServableSpecialistNeed({ routes: ['github'], snapshot }), true);
  assert.equal(planHasServableSpecialistNeed({ routes: ['research'], snapshot }), true);
});
