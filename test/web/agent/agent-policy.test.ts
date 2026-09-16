import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  admissibleGatherLanes,
  AGENT_DEFAULT_BUDGETS,
  canDispatchAnyAction,
  corroboratingFingerprint,
  DEFAULT_LANE_CAPS,
  DEFAULT_ROUND_FETCH_CAPS,
  DEEP_LANE_CAPS,
  deriveEvidenceConfidence,
  deriveGatherProfile,
  detectConflicts,
  effectiveLaneCaps,
  evaluatorUtilityHeadroom,
  MAX_FETCHES,
  MAX_GATHER_ACTIONS,
  MAX_LANE_ACTIONS,
  MAX_ROUNDS,
  MAX_SEARCHES,
  MAX_UTILITY_CALLS,
  resolveBudgets,
  semanticGrowth,
  snapshotHasSpecialistNeed,
  stopPolicy,
  utilityBudgetSplit,
  verifyUtilityHeadroom,
  widthForRound,
  WIDTH_SCHEDULES,
  type AgentBudgets,
  type GatherLane,
  type StopPolicyContext,
} from '../../../src/web/agent/agent-policy.js';
import type { AgentEvidence } from '../../../src/web/agent/agent-state.js';

let seq = 0;
const evidence = (overrides: Partial<AgentEvidence> = {}): AgentEvidence => {
  const excerpt = overrides.excerpt ?? 'Neutral evidence excerpt text';
  seq += 1;
  return {
    id: overrides.id ?? `ev-test-${seq}`,
    sourceRef: {
      canonicalUrl: 'https://example.com/page',
      sourceClass: 'unknown',
      acquisitionRoute: 'fetch',
    },
    documentHash: 'doc-hash',
    locator: { start: 0, end: excerpt.length },
    excerpt,
    excerptHash: 'excerpt-hash',
    questionIds: ['q-1'],
    round: 1,
    status: 'admitted',
    corroboratingFingerprint: corroboratingFingerprint(excerpt),
    ...overrides,
  };
};

const baseCtx = (overrides: Partial<StopPolicyContext> = {}): StopPolicyContext => ({
  clockMs: 1000,
  round: 1,
  roundsCompleted: 1,
  searchesUsed: 1,
  fetchesUsed: 1,
  utilityCallsUsed: 1,
  budgets: resolveBudgets(),
  allRequiredGrounded: false,
  growthLastTwoRounds: [1, 1],
  remainingNextQueries: ['follow-up query'],
  evaluatorRequestedContinue: true,
  ...overrides,
});

// --- resolveBudgets ---

test('resolveBudgets fills defaults', () => {
  assert.deepEqual(resolveBudgets(), {
    maxRounds: 3,
    maxSearches: 4,
    maxFetches: 12,
    maxUtilityCalls: 8,
    maxGatherActions: AGENT_DEFAULT_BUDGETS.maxGatherActions,
    laneCaps: { ...DEFAULT_LANE_CAPS },
    roundFetchCaps: [...DEFAULT_ROUND_FETCH_CAPS],
  });
  assert.deepEqual(resolveBudgets({ maxRounds: 2 }), {
    maxRounds: 2,
    maxSearches: 4,
    maxFetches: 12,
    maxUtilityCalls: 8,
    maxGatherActions: AGENT_DEFAULT_BUDGETS.maxGatherActions,
    laneCaps: { ...DEFAULT_LANE_CAPS },
    roundFetchCaps: [...DEFAULT_ROUND_FETCH_CAPS],
  });
});

test('resolveBudgets rejects non-positive-integer budgets', () => {
  for (const field of ['maxRounds', 'maxSearches', 'maxFetches', 'maxUtilityCalls', 'maxGatherActions'] as const) {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => resolveBudgets({ [field]: bad } as Partial<AgentBudgets>), {
        name: 'RangeError',
        message: `${field} must be a positive integer`,
      });
    }
  }
});

test('resolveBudgets rejects values past hard caps', () => {
  assert.throws(() => resolveBudgets({ maxRounds: MAX_ROUNDS + 1 }), {
    name: 'RangeError',
    message: `maxRounds exceeds maximum of ${MAX_ROUNDS}`,
  });
  assert.throws(() => resolveBudgets({ maxSearches: MAX_SEARCHES + 1 }), {
    name: 'RangeError',
    message: `maxSearches exceeds maximum of ${MAX_SEARCHES}`,
  });
  assert.throws(() => resolveBudgets({ maxFetches: MAX_FETCHES + 1 }), {
    name: 'RangeError',
    message: `maxFetches exceeds maximum of ${MAX_FETCHES}`,
  });
  assert.throws(() => resolveBudgets({ maxUtilityCalls: MAX_UTILITY_CALLS + 1 }), {
    name: 'RangeError',
    message: `maxUtilityCalls exceeds maximum of ${MAX_UTILITY_CALLS}`,
  });
  assert.throws(() => resolveBudgets({ maxGatherActions: MAX_GATHER_ACTIONS + 1 }), {
    name: 'RangeError',
    message: `maxGatherActions exceeds maximum of ${MAX_GATHER_ACTIONS}`,
  });
});

test('resolveBudgets accepts cap values and rejects bad deadlineMs', () => {
  assert.equal(resolveBudgets({ maxRounds: MAX_ROUNDS }).maxRounds, MAX_ROUNDS);
  assert.equal(resolveBudgets({ deadlineMs: 5000 }).deadlineMs, 5000);
  for (const bad of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => resolveBudgets({ deadlineMs: bad }), {
      name: 'RangeError',
      message: 'deadlineMs must be greater than 0',
    });
  }
});

// --- stopPolicy ---

test('stopPolicy stops on deadline', () => {
  assert.deepEqual(stopPolicy(baseCtx({ clockMs: 5000, deadlineMs: 5000 })), { stop: true, reason: 'deadline' });
  assert.equal(stopPolicy(baseCtx({ clockMs: 6000, deadlineMs: 5000 })).reason, 'deadline');
});

test('stopPolicy stops when all required questions grounded', () => {
  assert.deepEqual(stopPolicy(baseCtx({ allRequiredGrounded: true })), { stop: true, reason: 'all_required_grounded' });
});

test('stopPolicy stops at round cap', () => {
  assert.deepEqual(stopPolicy(baseCtx({ roundsCompleted: 3 })), { stop: true, reason: 'round_cap' });
});

test('stopPolicy stops when any budget dimension exhausted', () => {
  assert.deepEqual(stopPolicy(baseCtx({ searchesUsed: 4 })), { stop: true, reason: 'budget_exhausted' });
  assert.deepEqual(stopPolicy(baseCtx({ fetchesUsed: 12 })), { stop: true, reason: 'budget_exhausted' });
  assert.deepEqual(stopPolicy(baseCtx({ utilityCallsUsed: 8 })), { stop: true, reason: 'budget_exhausted' });
});

test('stopPolicy stops on two zero-growth rounds, not one', () => {
  assert.deepEqual(stopPolicy(baseCtx({ growthLastTwoRounds: [0, 0] })), { stop: true, reason: 'no_progress' });
  assert.deepEqual(stopPolicy(baseCtx({ growthLastTwoRounds: [0, 1] })), { stop: false, reason: 'continue' });
  assert.deepEqual(stopPolicy(baseCtx({ growthLastTwoRounds: [1, 0] })), { stop: false, reason: 'continue' });
});

test('stopPolicy stops when no queries remain', () => {
  assert.deepEqual(stopPolicy(baseCtx({ remainingNextQueries: [] })), { stop: true, reason: 'no_queries' });
});

test('stopPolicy fallback: evaluator stop is advisory', () => {
  assert.deepEqual(stopPolicy(baseCtx({ evaluatorRequestedContinue: true })), { stop: false, reason: 'continue' });
  assert.deepEqual(stopPolicy(baseCtx({ evaluatorRequestedContinue: false })), {
    stop: false,
    reason: 'evaluator_stop_advisory',
  });
});

test('stopPolicy priority: deadline beats grounded, grounded beats caps', () => {
  const budgets = resolveBudgets();
  assert.equal(
    stopPolicy(baseCtx({ clockMs: 9, deadlineMs: 9, allRequiredGrounded: true, roundsCompleted: 99 })).reason,
    'deadline',
  );
  assert.equal(
    stopPolicy(baseCtx({ allRequiredGrounded: true, roundsCompleted: 99, searchesUsed: 99 })).reason,
    'all_required_grounded',
  );
  assert.ok(budgets);
});

// --- semanticGrowth ---

test('semanticGrowth counts evidence covering an open required question', () => {
  const item = evidence({ excerpt: 'The launch price is forty two dollars total', questionIds: ['q-price'] });
  const result = semanticGrowth([item], [], ['q-price']);
  assert.equal(result.growthCount, 1);
  assert.deepEqual(result.growthEvidence.map((e) => e.id), [item.id]);
});

test('semanticGrowth counts a distinct corroboration fingerprint for a covered question', () => {
  const prior = evidence({
    id: 'ev-prior',
    excerpt: 'Acme analytics dashboard ships with role based access control enabled',
    questionIds: ['q-feat'],
  });
  const corroboration = evidence({
    id: 'ev-corroborate',
    excerpt: 'Independent review confirms the Acme dashboard includes audit log streaming export',
    questionIds: ['q-feat'],
  });
  const result = semanticGrowth([corroboration], [prior], []);
  assert.equal(result.growthCount, 1);
});

test('semanticGrowth counts items in a conflict pair', () => {
  const a = evidence({ id: 'ev-a', excerpt: 'Pro plan costs $99 per month billed annually', questionIds: ['q-x'] });
  const b = evidence({ id: 'ev-b', excerpt: 'Pro plan costs $199 per month billed annually', questionIds: ['q-x'] });
  const result = semanticGrowth([a, b], [], []);
  assert.equal(result.growthCount, 2);
  assert.equal(result.conflictEvidence.length, 2);
});

test('semanticGrowth ignores near-duplicates and chunk-only additions', () => {
  const prior = evidence({
    id: 'ev-orig',
    excerpt: 'The quarterly report shows revenue growth across every segment this year',
    questionIds: ['q-rev'],
  });
  const nearDup = evidence({
    id: 'ev-dup',
    excerpt: 'The quarterly report shows revenue growth across every segment this year',
    questionIds: ['q-rev'],
  });
  const chunkOnly = evidence({
    id: 'ev-chunk',
    excerpt: 'The quarterly report shows revenue growth across every segment this year, with appendix tables',
    questionIds: ['q-rev'],
  });
  assert.equal(semanticGrowth([nearDup], [prior], []).growthCount, 0);
  // Same fingerprint as prior for an already-covered question: duplicate corroboration, no growth.
  const sameFingerprint = { ...chunkOnly, corroboratingFingerprint: prior.corroboratingFingerprint };
  assert.equal(semanticGrowth([sameFingerprint], [prior], []).growthCount, 0);
});

test('semanticGrowth ignores non-admitted evidence', () => {
  const rejected = evidence({ excerpt: 'Fresh rejected finding about launch pricing tiers', status: 'rejected' });
  assert.equal(semanticGrowth([rejected], [], ['q-1']).growthCount, 0);
});

// --- detectConflicts ---

test('detectConflicts flags contradictory prices on the same question', () => {
  const a = evidence({ id: 'ev-cheap', excerpt: 'The starter tier is priced at $99 per month', questionIds: ['q-p'] });
  const b = evidence({ id: 'ev-pricey', excerpt: 'The starter tier is priced at $199 per month', questionIds: ['q-p'] });
  const conflicts = detectConflicts([a, b]);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0]?.conflictBetween, ['ev-cheap', 'ev-pricey']);
  assert.equal(conflicts[0]?.questionId, 'q-p');
  assert.deepEqual(conflicts[0]?.values, ['99', '199']);
});

test('detectConflicts stays silent on compatible values', () => {
  const a = evidence({ excerpt: 'The starter tier is priced at $99 per month', questionIds: ['q-p'] });
  const b = evidence({ excerpt: 'Starter costs $99 per month with annual billing', questionIds: ['q-p'] });
  assert.deepEqual(detectConflicts([a, b]), []);
});

test('detectConflicts keeps disjoint question groups independent', () => {
  const a = evidence({ id: 'ev-a', excerpt: 'The starter tier is priced at $99 per month', questionIds: ['q-p'] });
  const b = evidence({ id: 'ev-b', excerpt: 'The starter tier is priced at $199 per month', questionIds: ['q-p'] });
  const c = evidence({ id: 'ev-c', excerpt: 'The team plan supports 50 users total', questionIds: ['q-t'] });
  const d = evidence({ id: 'ev-d', excerpt: 'Team plan includes 50 users with SSO login', questionIds: ['q-t'] });
  const conflicts = detectConflicts([a, b, c, d]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.questionId, 'q-p');
});

test('detectConflicts stays silent when value tokens overlap across slots', () => {
  // Documented recall limit: $99+500cr vs $199+500cr share 500/500credits,
  // so the disjoint-sets rule never fires despite the price contradiction.
  const a = evidence({ id: 'ev-a', excerpt: 'Pro plan costs $99 per month with 500 credits included', questionIds: ['q-p'] });
  const b = evidence({ id: 'ev-b', excerpt: 'Pro plan costs $199 per month with 500 credits included', questionIds: ['q-p'] });
  assert.deepEqual(detectConflicts([a, b]), []);
});

test('detectConflicts fires on fully disjoint values', () => {
  const a = evidence({ id: 'ev-a', excerpt: 'Acme Pro costs $49 per seat with plan details for comparison', questionIds: ['q-p'] });
  const b = evidence({ id: 'ev-b', excerpt: 'Acme Pro costs $99 per month with plan details for comparison', questionIds: ['q-p'] });
  const conflicts = detectConflicts([a, b]);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0]?.conflictBetween, ['ev-a', 'ev-b']);
});

test('detectConflicts ignores non-admitted and value-free evidence', () => {
  const a = evidence({ excerpt: 'Pricing announced at the spring keynote event', questionIds: ['q-p'] });
  const b = evidence({ excerpt: 'Pricing announced at the spring keynote event again', questionIds: ['q-p'] });
  assert.deepEqual(detectConflicts([a, b]), []);
  const rejected = evidence({
    excerpt: 'Rejected draft claims the price is $500 per month',
    questionIds: ['q-p'],
    status: 'rejected',
  });
  const live = evidence({ excerpt: 'The starter tier is priced at $99 per month', questionIds: ['q-p'] });
  assert.deepEqual(detectConflicts([rejected, live]), []);
});

// --- deriveEvidenceConfidence (Phase 9: derived, never LLM-stated) ---

const closeTo = (actual: number, expected: number): void => {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `expected ${actual} to be close to ${expected}`,
  );
};

test('deriveEvidenceConfidence scores one fingerprint at 0.35', () => {
  const item = evidence({ id: 'ev-c1', excerpt: 'Acme Pro costs $49 per seat for teams' });
  const result = deriveEvidenceConfidence([item]);
  closeTo(result.breakdown.independentFingerprints, 0.35);
  closeTo(result.breakdown.sourceClassBoost, 0);
  closeTo(result.breakdown.conflictPenalty, 0);
  closeTo(result.breakdown.verifiedBoost, 0);
  closeTo(result.score, 0.35);
});

test('deriveEvidenceConfidence caps independence at two fingerprints', () => {
  const items = [
    evidence({ id: 'ev-c2a', excerpt: 'Acme Pro costs $49 per seat for teams' }),
    evidence({ id: 'ev-c2b', excerpt: 'Independent review confirms the Acme dashboard includes audit log streaming export' }),
    evidence({ id: 'ev-c2c', excerpt: 'Contoso API quota resets at midnight coordinated universal time daily' }),
  ];
  const result = deriveEvidenceConfidence(items);
  closeTo(result.breakdown.independentFingerprints, 0.7);
  closeTo(result.score, 0.7);
});

test('deriveEvidenceConfidence boosts distinct authority classes, capped at 0.2', () => {
  const cls = (sourceClass: 'official' | 'repo' | 'academic') => ({
    sourceRef: { canonicalUrl: 'https://example.com/page', sourceClass, acquisitionRoute: 'fetch' as const },
  });
  const items = [
    evidence({ id: 'ev-c3a', excerpt: 'Acme Pro costs $49 per seat for teams', ...cls('official') }),
    evidence({ id: 'ev-c3b', excerpt: 'Independent review confirms the Acme dashboard includes audit log streaming export', ...cls('repo') }),
    evidence({ id: 'ev-c3c', excerpt: 'Contoso API quota resets at midnight coordinated universal time daily', ...cls('academic') }),
  ];
  const result = deriveEvidenceConfidence(items);
  closeTo(result.breakdown.independentFingerprints, 0.7);
  closeTo(result.breakdown.sourceClassBoost, 0.2);
  closeTo(result.score, 0.9);
});

test('deriveEvidenceConfidence ignores community/unknown source classes', () => {
  const item = evidence({
    id: 'ev-c4',
    excerpt: 'Acme Pro costs $49 per seat for teams',
    sourceRef: { canonicalUrl: 'https://example.com/page', sourceClass: 'community', acquisitionRoute: 'fetch' },
  });
  const result = deriveEvidenceConfidence([item]);
  closeTo(result.breakdown.sourceClassBoost, 0);
  closeTo(result.score, 0.35);
});

test('deriveEvidenceConfidence penalizes conflict pairs recomputed internally', () => {
  const a = evidence({ id: 'ev-c5a', excerpt: 'The starter tier is priced at $99 per month', questionIds: ['q-p'] });
  const b = evidence({ id: 'ev-c5b', excerpt: 'The starter tier is priced at $199 per month', questionIds: ['q-p'] });
  const result = deriveEvidenceConfidence([a, b]);
  closeTo(result.breakdown.independentFingerprints, 0.7);
  closeTo(result.breakdown.conflictPenalty, -0.15);
  closeTo(result.score, 0.55);
});

test('deriveEvidenceConfidence credits verified fingerprints, capped at 0.3', () => {
  const a = evidence({ id: 'ev-c6a', excerpt: 'Acme Pro costs $49 per seat for teams' });
  const b = evidence({
    id: 'ev-c6b',
    excerpt: 'Independent review confirms the Acme dashboard includes audit log streaming export',
  });
  const one = deriveEvidenceConfidence([a, b], [a.id]);
  closeTo(one.breakdown.verifiedBoost, 0.15);
  closeTo(one.score, 0.85);
  const c = evidence({
    id: 'ev-c6c',
    excerpt: 'Contoso API quota resets at midnight coordinated universal time daily',
  });
  const capped = deriveEvidenceConfidence([a, b, c], [a.id, b.id, c.id]);
  closeTo(capped.breakdown.verifiedBoost, 0.3);
  closeTo(capped.score, 1);
  const unknown = deriveEvidenceConfidence([a], ['ev-nope']);
  closeTo(unknown.breakdown.verifiedBoost, 0);
});

test('deriveEvidenceConfidence excludes non-admitted evidence', () => {
  const live = evidence({
    id: 'ev-c7a',
    excerpt: 'Acme Pro costs $49 per seat for teams',
    sourceRef: { canonicalUrl: 'https://example.com/page', sourceClass: 'official', acquisitionRoute: 'fetch' },
  });
  const rejected = evidence({
    id: 'ev-c7b',
    excerpt: 'Independent review confirms the Acme dashboard includes audit log streaming export',
    sourceRef: { canonicalUrl: 'https://example.com/page', sourceClass: 'repo', acquisitionRoute: 'fetch' },
    status: 'rejected',
  });
  const result = deriveEvidenceConfidence([live, rejected], [rejected.id]);
  closeTo(result.breakdown.independentFingerprints, 0.35);
  closeTo(result.breakdown.sourceClassBoost, 0.1);
  closeTo(result.breakdown.verifiedBoost, 0);
  closeTo(result.score, 0.45);
});

test('deriveEvidenceConfidence clamps heavy conflict load to zero', () => {
  const items: AgentEvidence[] = [];
  for (let i = 0; i < 8; i++) {
    const cheap = 100 + i * 10;
    const pricey = 200 + i * 10;
    items.push(
      evidence({ id: `ev-c8-${i}a`, excerpt: `Alpha service bills $${cheap} per month`, questionIds: [`q-${i}`] }),
      evidence({ id: `ev-c8-${i}b`, excerpt: `Alpha service bills $${pricey} per month`, questionIds: [`q-${i}`] }),
    );
  }
  const result = deriveEvidenceConfidence(items);
  assert.ok(result.breakdown.conflictPenalty <= -0.3);
  assert.equal(result.score, 0);
});

test('deriveEvidenceConfidence is deterministic and empty-safe', () => {
  const items = [
    evidence({ id: 'ev-c9a', excerpt: 'Acme Pro costs $49 per seat for teams' }),
    evidence({ id: 'ev-c9b', excerpt: 'The starter tier is priced at $99 per month', questionIds: ['q-p'] }),
  ];
  assert.deepEqual(deriveEvidenceConfidence(items), deriveEvidenceConfidence(items));
  assert.deepEqual(deriveEvidenceConfidence([]), {
    score: 0,
    breakdown: { independentFingerprints: 0, sourceClassBoost: 0, conflictPenalty: 0, verifiedBoost: 0 },
  });
});

// --- Task 8 BudgetEnvelope ---

test('resolveBudgets validates lane caps with reject-not-clamp', () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => resolveBudgets({ laneCaps: { web: bad } }), {
      name: 'RangeError',
      message: 'laneCaps.web must be a positive integer',
    });
  }
  assert.throws(() => resolveBudgets({ laneCaps: { github: MAX_LANE_ACTIONS + 1 } }), {
    name: 'RangeError',
    message: `laneCaps.github exceeds maximum of ${MAX_LANE_ACTIONS}`,
  });
  assert.equal(resolveBudgets({ laneCaps: { web: 2 } }).laneCaps.web, 2);
  assert.deepEqual(resolveBudgets({ laneCaps: { web: 2 } }).laneCaps.research, DEFAULT_LANE_CAPS.research);
});

test('resolveBudgets roundFetchCaps are operator-lower-only', () => {
  assert.deepEqual(resolveBudgets().roundFetchCaps, [7, 4, 1]);
  assert.deepEqual(resolveBudgets({ roundFetchCaps: [5, 2, 1] }).roundFetchCaps, [5, 2, 1]);
  assert.throws(() => resolveBudgets({ roundFetchCaps: [8, 4, 1] }), {
    name: 'RangeError',
    message: 'roundFetchCaps[0] exceeds maximum of 7',
  });
  assert.throws(() => resolveBudgets({ roundFetchCaps: [7, 5, 1] }), {
    name: 'RangeError',
    message: 'roundFetchCaps[1] exceeds maximum of 4',
  });
  assert.throws(() => resolveBudgets({ roundFetchCaps: [7, 4, 2] }), {
    name: 'RangeError',
    message: 'roundFetchCaps[2] exceeds maximum of 1',
  });
  for (const bad of [[0, 4, 1], [7, 4, 1.5]] as Array<[number, number, number]>) {
    assert.throws(() => resolveBudgets({ roundFetchCaps: bad }), {
      name: 'RangeError',
      message: 'roundFetchCaps must be a 3-tuple of positive integers',
    });
  }
});

test('width schedules pinned per profile: 3-2-1, narrow 1', () => {
  assert.deepEqual(WIDTH_SCHEDULES.balanced, [3, 2, 1]);
  assert.deepEqual(WIDTH_SCHEDULES.deep, [3, 2, 1]);
  assert.deepEqual(WIDTH_SCHEDULES.narrow, [1, 1, 1]);
  assert.deepEqual([1, 2, 3, 4].map((round) => widthForRound('balanced', round)), [3, 2, 1, 1]);
  assert.deepEqual([1, 2, 3].map((round) => widthForRound('narrow', round)), [1, 1, 1]);
  assert.deepEqual([1, 2, 3].map((round) => widthForRound('deep', round)), [3, 2, 1]);
});

test('deriveGatherProfile is code-owned: deep/narrow/balanced', () => {
  assert.equal(deriveGatherProfile({ depth: 'deep', requiredQuestionCount: 5, specialistNeeded: true }), 'deep');
  assert.equal(deriveGatherProfile({ requiredQuestionCount: 1, specialistNeeded: false }), 'narrow');
  assert.equal(deriveGatherProfile({ requiredQuestionCount: 1, specialistNeeded: true }), 'balanced');
  assert.equal(deriveGatherProfile({ requiredQuestionCount: 3, specialistNeeded: false }), 'balanced');
  assert.equal(deriveGatherProfile({ depth: 'balanced', requiredQuestionCount: 1, specialistNeeded: false }), 'narrow');
});

test('effectiveLaneCaps: deep raises specialists, balanced untouched', () => {
  const balanced = effectiveLaneCaps(resolveBudgets(), 'balanced');
  assert.deepEqual(balanced, { ...DEFAULT_LANE_CAPS });
  const deep = effectiveLaneCaps(resolveBudgets(), 'deep');
  assert.equal(deep.web, DEFAULT_LANE_CAPS.web);
  for (const lane of ['research', 'github', 'social', 'video', 'kg'] as const) {
    assert.equal(deep[lane], DEEP_LANE_CAPS[lane]);
  }
  const raised = effectiveLaneCaps(resolveBudgets({ laneCaps: { research: 10 } }), 'deep');
  assert.equal(raised.research, 10);
});

test('utilityBudgetSplit reserves synthesis+verify before evaluator spend', () => {
  assert.deepEqual(utilityBudgetSplit(8), { planner: 1, synthesis: 1, verifyRepair: 2, evaluator: 4 });
  assert.deepEqual(utilityBudgetSplit(4), { planner: 1, synthesis: 1, verifyRepair: 2, evaluator: 0 });
  assert.equal(evaluatorUtilityHeadroom({ maxUtilityCalls: 8, utilityCallsUsed: 4, synthesizerPresent: true, verifierPresent: true }), 1);
  assert.equal(evaluatorUtilityHeadroom({ maxUtilityCalls: 8, utilityCallsUsed: 5, synthesizerPresent: true, verifierPresent: true }), 0);
  assert.equal(evaluatorUtilityHeadroom({ maxUtilityCalls: 8, utilityCallsUsed: 7, synthesizerPresent: false, verifierPresent: false }), 1);
});

test('verifyUtilityHeadroom holds the repair reserve out of initial verification', () => {
  // Repairer present: 2 calls walled off for repair+reverify.
  assert.equal(verifyUtilityHeadroom({ maxUtilityCalls: 8, utilityCallsUsed: 3, repairerPresent: true }), 3);
  assert.equal(verifyUtilityHeadroom({ maxUtilityCalls: 8, utilityCallsUsed: 6, repairerPresent: true }), 0);
  assert.equal(verifyUtilityHeadroom({ maxUtilityCalls: 8, utilityCallsUsed: 7, repairerPresent: true }), 0);
  // No repairer: no repair stage, full headroom spends on verification.
  assert.equal(verifyUtilityHeadroom({ maxUtilityCalls: 8, utilityCallsUsed: 7, repairerPresent: false }), 1);
  assert.equal(verifyUtilityHeadroom({ maxUtilityCalls: 8, utilityCallsUsed: 8, repairerPresent: false }), 0);
});

const laneCtx = (overrides: Record<string, unknown> = {}) => {
  const budgets = resolveBudgets();
  return baseCtx({
    budgets,
    admissibleLanes: ['web', 'research', 'github', 'social', 'video', 'kg'] as GatherLane[],
    gatherActionsUsed: 0,
    laneActionsUsed: {},
    ...overrides,
  });
};

test('stopPolicy lane-aware: search cap is web-lane scope, fetch cap is global', () => {
  const budgets = resolveBudgets();
  // maxSearches is web-lane scope, never a job-wide kill: exhausted web
  // searches with github headroom keeps the job alive (the executor web-gate
  // + canDispatchAnyAction own web exhaustion; specialist follow-ups route).
  assert.deepEqual(
    stopPolicy(
      laneCtx({
        budgets,
        searchesUsed: budgets.maxSearches,
        fetchesUsed: 0,
        gatherActionsUsed: 2,
        laneActionsUsed: { web: budgets.laneCaps.web },
        admissibleLanes: ['web', 'github'] as GatherLane[],
      }),
    ),
    { stop: false, reason: 'continue' },
  );
  assert.deepEqual(
    stopPolicy(
      laneCtx({
        budgets,
        searchesUsed: 0,
        fetchesUsed: budgets.maxFetches,
        gatherActionsUsed: 2,
        laneActionsUsed: { web: budgets.laneCaps.web },
        admissibleLanes: ['web', 'github'] as GatherLane[],
      }),
    ),
    { stop: true, reason: 'budget_exhausted' },
  );
});

test('stopPolicy lane-aware: envelope + all lanes exhausted stops', () => {
  const budgets = resolveBudgets();
  const result = stopPolicy(
    laneCtx({
      budgets,
      gatherActionsUsed: budgets.maxGatherActions,
      laneActionsUsed: {
        web: budgets.laneCaps.web,
        research: budgets.laneCaps.research,
        github: budgets.laneCaps.github,
        social: budgets.laneCaps.social,
        video: budgets.laneCaps.video,
        kg: budgets.laneCaps.kg,
      },
    }),
  );
  assert.deepEqual(result, { stop: true, reason: 'budget_exhausted' });
});

test('stopPolicy lane-aware: envelope exhausted stops even with lane headroom', () => {
  // Wave 5 budget unification (D3): executor planning refuses at the envelope,
  // so stopPolicy agrees — envelope-exhausted stops even with lane headroom.
  // Previously this continued; the two paths disagreed on envelope semantics.
  const budgets = resolveBudgets();
  const result = stopPolicy(
    laneCtx({
      budgets,
      gatherActionsUsed: budgets.maxGatherActions,
      laneActionsUsed: { web: budgets.laneCaps.web },
    }),
  );
  assert.deepEqual(result, { stop: true, reason: 'budget_exhausted' });
});

test('stopPolicy legacy: gather envelope stops when counters exist in context', () => {
  const budgets = resolveBudgets();
  assert.deepEqual(
    stopPolicy(baseCtx({ budgets, gatherActionsUsed: budgets.maxGatherActions ?? 6 })),
    { stop: true, reason: 'budget_exhausted' },
  );
  assert.deepEqual(stopPolicy(baseCtx({ budgets, gatherActionsUsed: 0 })).stop, false);
});

test('follow-up width binding is min(evaluator gap cap 2, widthForRound)', () => {
  // The evaluator caps proposals at MAX_NEXT_ACTIONS=2 (agent-evaluator.ts
  // owns the cap; the core never raises it), so the descending schedule
  // binds round-1 seeding (wide-first) while follow-up rounds resolve to
  // min(2, widthForRound). Balanced/deep round 2+: min(2, 2)=2; round 3+:
  // min(2, 1)=1; narrow stays 1 throughout.
  const gapCap = 2;
  assert.deepEqual(
    [1, 2, 3].map((round) => Math.min(gapCap, widthForRound('balanced', round))),
    [2, 2, 1],
  );
  assert.deepEqual(
    [1, 2, 3].map((round) => Math.min(gapCap, widthForRound('deep', round))),
    [2, 2, 1],
  );
  assert.deepEqual(
    [1, 2, 3].map((round) => Math.min(gapCap, widthForRound('narrow', round))),
    [1, 1, 1],
  );
});

test('stopPolicy lane-aware: utility exhaustion still stops', () => {
  const budgets = resolveBudgets();
  assert.deepEqual(
    stopPolicy(laneCtx({ budgets, utilityCallsUsed: budgets.maxUtilityCalls })).reason,
    'budget_exhausted',
  );
});

test('fetch-aware web lane: pending web_fetch survives exhausted maxSearches', () => {
  const budgets = resolveBudgets();
  const envelope = budgets.maxGatherActions ?? 6;
  const dispatchBudgets = {
    maxSearches: budgets.maxSearches,
    maxGatherActions: envelope,
    laneCaps: budgets.laneCaps,
    maxFetches: budgets.maxFetches,
  };
  assert.equal(
    canDispatchAnyAction(
      {
        gatherActionsUsed: 0,
        searchesUsed: budgets.maxSearches,
        pendingWebFetches: 1,
        fetchesUsed: 0,
        admissibleLanes: ['web'],
      },
      dispatchBudgets,
    ),
    true,
  );
  // Lane-aware branch: no budget stop (growth/queries/evaluator all allow continue).
  assert.deepEqual(
    stopPolicy(
      laneCtx({
        budgets,
        searchesUsed: budgets.maxSearches,
        fetchesUsed: 0,
        pendingWebFetches: 1,
        gatherActionsUsed: 0,
        laneActionsUsed: {},
        admissibleLanes: ['web'],
      }),
    ),
    { stop: false, reason: 'continue' },
  );
  // Legacy branch (no snapshot): scalar search gate waived for the pending fetch.
  assert.deepEqual(
    stopPolicy(baseCtx({ budgets, searchesUsed: budgets.maxSearches, fetchesUsed: 0, pendingWebFetches: 1 })),
    { stop: false, reason: 'continue' },
  );
});

test('fetch-aware web lane: fetch exhaustion still stops despite pending web_fetch', () => {
  const budgets = resolveBudgets();
  const envelope = budgets.maxGatherActions ?? 6;
  const dispatchBudgets = {
    maxSearches: budgets.maxSearches,
    maxGatherActions: envelope,
    laneCaps: budgets.laneCaps,
    maxFetches: budgets.maxFetches,
  };
  assert.equal(
    canDispatchAnyAction(
      {
        gatherActionsUsed: 0,
        searchesUsed: budgets.maxSearches,
        pendingWebFetches: 2,
        fetchesUsed: budgets.maxFetches,
        admissibleLanes: ['web'],
      },
      dispatchBudgets,
    ),
    false,
  );
  assert.deepEqual(
    stopPolicy(
      laneCtx({
        budgets,
        searchesUsed: budgets.maxSearches,
        fetchesUsed: budgets.maxFetches,
        pendingWebFetches: 2,
        gatherActionsUsed: 0,
        laneActionsUsed: {},
        admissibleLanes: ['web'],
      }),
    ),
    { stop: true, reason: 'budget_exhausted' },
  );
  assert.deepEqual(
    stopPolicy(
      baseCtx({
        budgets,
        searchesUsed: budgets.maxSearches,
        fetchesUsed: budgets.maxFetches,
        pendingWebFetches: 2,
      }),
    ),
    { stop: true, reason: 'budget_exhausted' },
  );
});

test('fetch-aware web lane: absent/zero pending keeps current exhausted behavior', () => {
  const budgets = resolveBudgets();
  const envelope = budgets.maxGatherActions ?? 6;
  const dispatchBudgets = {
    maxSearches: budgets.maxSearches,
    maxGatherActions: envelope,
    laneCaps: budgets.laneCaps,
    maxFetches: budgets.maxFetches,
  };
  const base = { gatherActionsUsed: 0, searchesUsed: budgets.maxSearches, admissibleLanes: ['web'] as const };
  assert.equal(canDispatchAnyAction({ ...base, fetchesUsed: 0 }, dispatchBudgets), false);
  assert.equal(canDispatchAnyAction({ ...base, pendingWebFetches: 0, fetchesUsed: 0 }, dispatchBudgets), false);
  // Fetch headroom alone (no pending fetch) does not waive search exhaustion.
  assert.equal(canDispatchAnyAction({ ...base, fetchesUsed: 0 }, { ...dispatchBudgets, maxFetches: 99 }), false);
  assert.deepEqual(
    stopPolicy(
      laneCtx({
        budgets,
        searchesUsed: budgets.maxSearches,
        fetchesUsed: 0,
        gatherActionsUsed: 0,
        laneActionsUsed: {},
        admissibleLanes: ['web'],
      }),
    ),
    { stop: true, reason: 'budget_exhausted' },
  );
  assert.deepEqual(
    stopPolicy(baseCtx({ budgets, searchesUsed: budgets.maxSearches, fetchesUsed: 0 })),
    { stop: true, reason: 'budget_exhausted' },
  );
});

test('fetch-aware web lane: envelope exhaustion still stops despite pending web_fetch', () => {
  const budgets = resolveBudgets();
  const envelope = budgets.maxGatherActions ?? 6;
  assert.equal(
    canDispatchAnyAction(
      {
        gatherActionsUsed: envelope,
        searchesUsed: budgets.maxSearches,
        pendingWebFetches: 1,
        fetchesUsed: 0,
        admissibleLanes: ['web'],
      },
      {
        maxSearches: budgets.maxSearches,
        maxGatherActions: envelope,
        laneCaps: budgets.laneCaps,
        maxFetches: budgets.maxFetches,
      },
    ),
    false,
  );
  assert.deepEqual(
    stopPolicy(
      laneCtx({
        budgets,
        searchesUsed: budgets.maxSearches,
        fetchesUsed: 0,
        pendingWebFetches: 1,
        gatherActionsUsed: envelope,
        laneActionsUsed: {},
        admissibleLanes: ['web'],
      }),
    ),
    { stop: true, reason: 'budget_exhausted' },
  );
  assert.deepEqual(
    stopPolicy(baseCtx({ budgets, gatherActionsUsed: envelope, pendingWebFetches: 1 })),
    { stop: true, reason: 'budget_exhausted' },
  );
});

test('admissibleGatherLanes gates social/video/kg on live surfaces', () => {
  const off = {
    research: { usable: true },
    github: { usable: true },
    kg: { usable: false },
    video: { youtube: { usable: false }, bilibili: { usable: false } },
    social: [{ usable: false }],
  };
  assert.deepEqual(admissibleGatherLanes(off), ['web', 'research', 'github']);
  assert.equal(snapshotHasSpecialistNeed(off), true);
  const webOnly = {
    research: { usable: false },
    github: { usable: false },
    kg: { usable: false },
    video: { youtube: { usable: false }, bilibili: { usable: false } },
    social: [{ usable: false }],
  };
  assert.deepEqual(admissibleGatherLanes(webOnly), ['web', 'research', 'github']);
  const live = {
    research: { usable: true },
    github: { usable: true },
    kg: { usable: true },
    video: { youtube: { usable: true }, bilibili: { usable: false } },
    social: [{ usable: true }],
  };
  assert.deepEqual(admissibleGatherLanes(live), ['web', 'research', 'github', 'social', 'video', 'kg']);
});
