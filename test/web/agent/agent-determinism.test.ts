// Phase 5 completion-order-invariance harness (roadmap exit gate:
// 'Deterministic outputs despite completion ordering').
//
// These tests assert the same-result-across-orderings PROPERTY, not specific
// parallel internals, so they pass whether the gather legs run sequentially
// (current seam: agent-core.ts roundQueries for-loop) or concurrently
// (worker N: Promise.allSettled + task-order merge). Sources order must be
// ledger/task order, never completion order.
//
// Concurrency probe: each test records search start/end timestamps and checks
// overlap (maxStart < minEnd). If no overlap is detected the test asserts
// sequential determinism only (same assertions — no skip, no fail).
// If a future parallel seam merges in completion order, tests 1/3 fail
// transiently until the task-order merge lands — that is the expected signal.
//
// No randomness: all delays are FIXED arrays, permuted explicitly.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAdaptiveCore } from '../../../src/web/agent/agent-core.js';
import { validateAgentResult } from '../../../src/web/agent/agent-contract.js';

const FILLER =
  ' Additional background context about the product lineup and release notes follows here for completeness and extra length.';

const BODIES: Record<string, string> = {
  'https://example.com/leg-alpha': `Acme Pro alpha plan details with launch pricing background and partner quotes included here.${FILLER}`,
  'https://example.com/leg-beta': `Acme Pro beta plan details with launch pricing background and partner quotes included here.${FILLER}`,
  'https://example.com/leg-gamma': `Acme Pro gamma plan details with launch pricing background and partner quotes included here.${FILLER}`,
  'https://example.com/overview': `Acme Pro overview page with general marketing words and launch pricing background here today.${FILLER}`,
  'https://example.com/shared-one': `Acme Pro shared one plan details with launch pricing background and partner quotes here.${FILLER}`,
  'https://example.com/shared-two': `Acme Pro shared two plan details with launch pricing background and partner quotes here.${FILLER}`,
};

const LEG_QUERIES = [
  'Acme Pro alpha leg details',
  'Acme Pro beta leg details',
  'Acme Pro gamma leg details',
] as const;

const QUERY_URL: Record<string, string> = {
  'Acme Pro alpha leg details': 'https://example.com/leg-alpha',
  'Acme Pro beta leg details': 'https://example.com/leg-beta',
  'Acme Pro gamma leg details': 'https://example.com/leg-gamma',
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const emptyReport = () => async () => ({ text: '', sources: [] as Array<{ url: string; title: string }> });

const planner = async () => ({
  questions: [{ question: 'Acme Pro pricing overview details?', priority: 3, required: true }],
  scopeNotes: [],
});

/** Evaluator: round 1 proposes the 3 legs, later rounds stop. Fresh closure per run. */
const legsEvaluator = () => {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === 1) return { questionUpdates: [], nextQueries: [...LEG_QUERIES], shouldContinue: true };
    return { questionUpdates: [], nextQueries: [], shouldContinue: false };
  };
};

interface Interval {
  query: string;
  start: number;
  end: number;
}

/** True when at least two search calls overlapped in time (parallel legs). */
function overlapped(intervals: Interval[]): boolean {
  if (intervals.length < 2) return false;
  const maxStart = Math.max(...intervals.map((i) => i.start));
  const minEnd = Math.min(...intervals.map((i) => i.end));
  return maxStart < minEnd;
}

const canon = (value: unknown): string => JSON.stringify(value);

/** Build deps for one run; search delays keyed by leg query, fetch delays by URL. */
function legDeps(options: {
  searchDelayMs: (query: string) => number;
  fetchDelayMs?: (url: string) => number;
  failQuery?: string;
  searchHits?: (query: string) => Array<{ title: string; url: string }>;
  intervals: Interval[];
}) {
  const hitsFor =
    options.searchHits ??
    ((query: string) => {
      const url = QUERY_URL[query];
      if (url !== undefined) return [{ title: `Page ${url}`, url }];
      if (query === 'Acme Pro pricing overview') return [{ title: 'Overview', url: 'https://example.com/overview' }];
      return [];
    });
  return {
    search: async (query: string) => {
      const start = Date.now();
      await sleep(options.searchDelayMs(query));
      const end = Date.now();
      options.intervals.push({ query, start, end });
      if (options.failQuery !== undefined && query === options.failQuery) throw new Error('leg down');
      return hitsFor(query);
    },
    fetchText: async (url: string) => {
      await sleep(options.fetchDelayMs?.(url) ?? 0);
      const body = BODIES[url];
      if (body === undefined) throw new Error(`no fixture body for ${url}`);
      return body;
    },
    report: emptyReport(),
    planner,
    evaluator: legsEvaluator(),
    budgets: { maxRounds: 3, maxSearches: 8, maxFetches: 16 },
  };
}

async function runOnce(searchDelays: number[], fetchDelays: number[] = [0, 0, 0]) {
  const intervals: Interval[] = [];
  const delayByQuery = new Map<string, number>(LEG_QUERIES.map((q, i) => [q, searchDelays[i] as number]));
  const legUrls = LEG_QUERIES.map((q) => QUERY_URL[q] as string);
  const delayByUrl = new Map(legUrls.map((u, i) => [u, fetchDelays[i] as number]));
  const result = await runAdaptiveCore('Acme Pro pricing overview', legDeps({
    searchDelayMs: (q) => delayByQuery.get(q) ?? 0,
    fetchDelayMs: (u) => delayByUrl.get(u) ?? 0,
    intervals,
  }));
  return { result, parallel: overlapped(intervals) };
}

test('delay-order invariance: identical result across delay permutations', async () => {
  const perms = [
    [30, 5, 15],
    [5, 15, 30],
    [15, 30, 5],
  ];
  const runs = [];
  for (const perm of perms) runs.push(await runOnce(perm, [12, 3, 9]));
  for (const { result } of runs) assert.ok(validateAgentResult(result).ok);
  const [first, ...rest] = runs.map((r) => r.result);
  for (const other of rest) {
    assert.equal(canon(other), canon(first), 'delay permutation changed the composed result');
    assert.deepEqual(other.claims, first!.claims);
    assert.deepEqual(other.sources.map((s) => s.url), first!.sources.map((s) => s.url));
    assert.deepEqual(other.warnings, first!.warnings);
    assert.equal(other.reportText, first!.reportText);
  }
  // Ledger order, never completion order: source URL sequence stable across perms.
  const orders = runs.map((r) => r.result.sources.map((s) => s.url).join('|'));
  assert.ok(orders.every((o) => o === orders[0]), `sources order varied: ${JSON.stringify(orders)}`);
});

test('failure-order invariance: fixed failing leg is delay-invariant; failures contained', async () => {
  // (a) Same failed query under different delays → byte-identical result.
  const intervalsA: Interval[] = [];
  const intervalsB: Interval[] = [];
  const mkFail = (intervals: Interval[], delays: number[]) => {
    const byQuery = new Map<string, number>(LEG_QUERIES.map((q, i) => [q, delays[i] as number]));
    return legDeps({ searchDelayMs: (q) => byQuery.get(q) ?? 0, failQuery: LEG_QUERIES[1] as string, intervals });
  };
  const ra = await runAdaptiveCore('Acme Pro pricing overview', mkFail(intervalsA, [30, 5, 15]));
  const rb = await runAdaptiveCore('Acme Pro pricing overview', mkFail(intervalsB, [5, 30, 1]));
  assert.ok(validateAgentResult(ra).ok);
  assert.ok(validateAgentResult(rb).ok);
  assert.equal(canon(rb), canon(ra), 'same failing leg under different delays diverged');
  assert.ok(ra.warnings.includes('search failed; query skipped'), JSON.stringify(ra.warnings));

  // (b) Which leg fails varies → failure contained: both stay valid, both warn,
  // surviving sources stable in ledger order. (Results legitimately differ in
  // which URL is missing; the property is containment + determinism, and the
  // current seam warns generically so warnings are exact-equal too.)
  const intervalsC: Interval[] = [];
  const rc = await runAdaptiveCore(
    'Acme Pro pricing overview',
    legDeps({ searchDelayMs: () => 5, failQuery: LEG_QUERIES[0] as string, intervals: intervalsC }),
  );
  assert.ok(validateAgentResult(rc).ok);
  assert.ok(rc.warnings.includes('search failed; query skipped'));
  assert.deepEqual([...rc.warnings].sort(), [...ra.warnings].sort(), 'generic failure warnings differ by failing leg');
  assert.ok(!rc.sources.some((s) => s.url === QUERY_URL[LEG_QUERIES[0]]), 'failed leg source must be absent');
  assert.ok(ra.sources.some((s) => s.url === QUERY_URL[LEG_QUERIES[0]]), 'non-failed leg source present');
});

test('mixed content-order: overlapping URLs dedup deterministically across delays', async () => {
  const overlapping = (query: string) => {
    if (query.includes('alpha')) {
      return [{ title: 'One', url: 'https://example.com/shared-one' }, { title: 'Two', url: 'https://example.com/shared-two' }];
    }
    if (query.includes('beta')) {
      return [{ title: 'Two', url: 'https://example.com/shared-two' }, { title: 'Alpha', url: 'https://example.com/leg-alpha' }];
    }
    if (query.includes('gamma')) {
      return [{ title: 'One', url: 'https://example.com/shared-one' }, { title: 'Alpha', url: 'https://example.com/leg-alpha' }];
    }
    return [{ title: 'Overview', url: 'https://example.com/overview' }];
  };
  const runOverlap = async (delays: number[]) => {
    const intervals: Interval[] = [];
    const byQuery = new Map<string, number>(LEG_QUERIES.map((q, i) => [q, delays[i] as number]));
    const result = await runAdaptiveCore(
      'Acme Pro pricing overview',
      legDeps({ searchDelayMs: (q) => byQuery.get(q) ?? 0, searchHits: overlapping, intervals }),
    );
    return { result, parallel: overlapped(intervals) };
  };
  const a = await runOverlap([30, 5, 15]);
  const b = await runOverlap([5, 30, 1]);
  const c = await runOverlap([1, 1, 30]);
  assert.ok(validateAgentResult(a.result).ok);
  assert.equal(canon(b.result), canon(a.result), 'overlap run diverged under delay permutation');
  assert.equal(canon(c.result), canon(a.result), 'overlap run diverged under delay permutation');
  const urls = a.result.sources.map((s) => s.url);
  assert.equal(new Set(urls).size, urls.length, `duplicate source urls: ${JSON.stringify(urls)}`);
});

test('state snapshot: no state export — composition equality documents determinism', async () => {
  // runAgentCore/runAdaptiveCore expose no snapshot()/state accessor; the
  // observable state is the composed result (claims/sources/warnings). Two
  // identical runs must compose byte-identical results.
  const first = await runOnce([10, 10, 10]);
  const second = await runOnce([10, 10, 10]);
  assert.ok(validateAgentResult(first.result).ok);
  assert.equal(canon(second.result), canon(first.result), 'identical inputs composed different results');
  assert.deepEqual(second.result.claims, first.result.claims);
  assert.deepEqual(second.result.sources, first.result.sources);
  assert.deepEqual(second.result.warnings, first.result.warnings);
});

test('zero delays vs delays: identical composition', async () => {
  const idle = await runOnce([0, 0, 0], [0, 0, 0]);
  const delayed = await runOnce([30, 5, 15], [12, 3, 9]);
  assert.ok(validateAgentResult(idle.result).ok);
  assert.ok(validateAgentResult(delayed.result).ok);
  assert.equal(canon(delayed.result), canon(idle.result), 'delays changed the composed result');
});
