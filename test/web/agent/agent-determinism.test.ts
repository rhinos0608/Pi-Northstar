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
import { snapshotForJob } from '../../../src/web/agent/agent-capabilities.js';
import { questionId } from '../../../src/web/agent/agent-state.js';
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


const planner = async () => ({
  questions: [{ question: 'Acme Pro pricing overview details?', priority: 3, required: true }],
  scopeNotes: [],
});

/** Evaluator: round 1 proposes the 3 legs, later rounds stop. Fresh closure per run. */
const legsEvaluator = () => {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === 1)
      return {
        questionUpdates: [],
        nextActions: [...LEG_QUERIES].map((query) => ({
          questionId: questionId('Acme Pro pricing overview details?'),
          intent: { kind: 'web_search', query },
        })),
        shouldContinue: true,
      };
    return { questionUpdates: [], nextActions: [], shouldContinue: false };
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

// --- Task 8 width schedule (code-owned profiles, "up to" semantics) ---

const WIDTH_QUERIES = [
  'Acme Pro alpha leg details',
  'Acme Pro beta leg details',
  'Acme Pro gamma leg details',
  'Acme Pro delta leg details',
  'Acme Pro epsilon leg details',
] as const;

/** Evaluator: round 1 proposes the given gaps, later rounds stop. */
const widthEvaluator = (queries: readonly string[]) => {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === 1)
      return {
        questionUpdates: [],
        nextActions: queries.map((query) => ({
          questionId: questionId('Acme Pro pricing overview details?'),
          intent: { kind: 'web_search', query },
        })),
        shouldContinue: true,
      };
    return { questionUpdates: [], nextActions: [], shouldContinue: false };
  };
};

/** Deps with a search-call counter; one distinct URL per search call. */
function widthDeps(queries: readonly string[], options: {
  profile?: 'balanced' | 'deep' | 'narrow';
  snapshot?: ReturnType<typeof snapshotForJob>;
  planner?: Parameters<typeof runAdaptiveCore>[1]['planner'];
} = {}) {
  let searches = 0;
  const deps: Parameters<typeof runAdaptiveCore>[1] = {
    search: async () => {
      searches += 1;
      return [{ title: `Page ${searches}`, url: `https://example.com/width-${searches}` }];
    },
    fetchText: async (url: string) =>
      `Acme Pro launch pricing background details with partner quotes from ${url} included here.${FILLER}`,
    planner: options.planner ?? planner,
    evaluator: widthEvaluator(queries),
    budgets: { maxRounds: 3, maxSearches: 8, maxFetches: 16 },
    ...(options.profile === undefined ? {} : { gatherProfile: options.profile }),
    ...(options.snapshot === undefined ? {} : { capabilitiesSnapshot: options.snapshot }),
  };
  return { deps, searchCount: () => searches };
}

/** Wave 7: balanced holds because the plan carries a servable specialist
 *  intent — never because specialist lanes merely exist (lanes alone narrow). */
const specialistSnapshot = () =>
  snapshotForJob({ DIFFBOT_TOKEN: 'token', YOUTUBE_API_KEY: 'key', OPENCLI_PRESENT: '1' });

/** Single-question plan with a genuine specialist intent (the research lane
 *  is servable on the specialist snapshot, so the profile stays balanced). */
const specialistPlanner = async () => ({
  questions: [
    {
      question: 'Acme Pro pricing overview details?',
      priority: 3,
      required: true,
      intent: { kind: 'research_search', query: 'Acme Pro pricing overview details' },
    },
  ],
  scopeNotes: [],
});

test('width: first dispatch round binds schedule head (balanced 3)', async () => {
  const { deps, searchCount } = widthDeps(WIDTH_QUERIES, {
    profile: 'balanced',
    snapshot: specialistSnapshot(),
    planner: specialistPlanner,
  });
  const result = await runAdaptiveCore('Acme Pro pricing overview', deps);
  assert.ok(validateAgentResult(result).ok);
  // Evaluator validation caps gaps at 2 (Task 5 MAX_NEXT_ACTIONS, out of
  // scope), so dispatch = min(2 gaps, width 3): 1 root seed + 2 follow-ups.
  // The width-3 table value itself pins at the policy unit level.
  assert.equal(searchCount(), 3, '1 root seed + min(gaps, width-3) follow-ups');
});

test('width: narrow binds 1 with 5 gaps', async () => {
  const { deps, searchCount } = widthDeps(WIDTH_QUERIES, { profile: 'narrow' });
  const result = await runAdaptiveCore('Acme Pro pricing overview', deps);
  assert.ok(validateAgentResult(result).ok);
  assert.equal(searchCount(), 2, '1 root seed + 1 narrow follow-up');
});

test('width: deep dispatches like balanced (same schedule head)', async () => {
  const { deps, searchCount } = widthDeps(WIDTH_QUERIES, { profile: 'deep', snapshot: specialistSnapshot() });
  const result = await runAdaptiveCore('Acme Pro pricing overview', deps);
  assert.ok(validateAgentResult(result).ok);
  assert.equal(searchCount(), 3, '1 root seed + min(gaps, width-3) follow-ups');
});

test('width: "up to" semantics — 1 gap dispatches 1 task, never pads', async () => {
  const { deps, searchCount } = widthDeps([WIDTH_QUERIES[0] as string], {
    profile: 'balanced',
    snapshot: specialistSnapshot(),
  });
  const result = await runAdaptiveCore('Acme Pro pricing overview', deps);
  assert.ok(validateAgentResult(result).ok);
  assert.equal(searchCount(), 2, '1 root seed + 1 follow-up; width never pads');
});

test('width: explicit balanced refines to narrow on single question with no specialist need', async () => {
  const { deps, searchCount } = widthDeps(WIDTH_QUERIES, { profile: 'balanced' });
  const result = await runAdaptiveCore('Acme Pro pricing overview', deps);
  assert.ok(validateAgentResult(result).ok);
  assert.equal(searchCount(), 2, 'refined narrow: 1 root seed + 1 follow-up');
});

test('width: absent profile keeps the unscheduled legacy full set', async () => {
  const { deps, searchCount } = widthDeps(WIDTH_QUERIES.slice(0, 3));
  const result = await runAdaptiveCore('Acme Pro pricing overview', deps);
  assert.ok(validateAgentResult(result).ok);
  assert.equal(searchCount(), 3, 'legacy: 1 root seed + evaluator-kept follow-ups');
});

test('fetch-aware stop: searches-exhausted round still dispatches a pending web_fetch', async () => {
  const { gatherExecutor } = await import('../../../src/web/agent/agent-gather.js');
  const FETCH_URL = 'https://example.com/fetch-target';
  const fetched: string[] = [];
  let calls = 0;
  const result = await runAdaptiveCore('Acme Pro pricing overview', {
    search: async () => [{ title: 'Search hit', url: 'https://example.com/search-hit', snippet: 'launch pricing snippet words' }],
    fetchText: async (url: string) => {
      fetched.push(url);
      return `Acme Pro launch pricing background details with partner quotes from ${url} included here.${FILLER}`;
    },
    planner,
    evaluator: async () => {
      calls += 1;
      if (calls === 1)
        return {
          questionUpdates: [],
          nextActions: [
            {
              questionId: questionId('Acme Pro pricing overview details?'),
              intent: { kind: 'web_fetch', url: FETCH_URL },
            },
          ],
          shouldContinue: true,
        };
      return { questionUpdates: [], nextActions: [], shouldContinue: false };
    },
    // Round 1 spends the single search; the pending web_fetch must still run.
    budgets: { maxRounds: 3, maxSearches: 1, maxFetches: 12, maxGatherActions: 6, maxUtilityCalls: 8 },
    gatherProfile: 'balanced',
    gatherExecutor: async (intents, round, ctx) => {
      const outcome = await gatherExecutor(intents, round, ctx);
      // Provenance seed: the follow-up fetch url enters round 1 as a bounded
      // research-source candidate so round-2 validation admits it.
      if (round === 1) outcome.candidates.push({ kind: 'research-source', route: 'research', source: 'test', title: 'Fetch target', url: FETCH_URL });
      return outcome;
    },
  });
  assert.ok(validateAgentResult(result).ok);
  assert.ok(fetched.includes(FETCH_URL), 'round-2 dispatch executes the pending web_fetch (fetchText called)');
  assert.ok(
    result.warnings.some((warning) => warning.includes('round 2:') && warning.includes('fetches=1')),
    `round 2 admits the fetch leg: ${JSON.stringify(result.warnings)}`,
  );
});

test('fetch-aware stop (lane-aware): searches-exhausted round still dispatches a pending web_fetch', async () => {
  const { gatherExecutor } = await import('../../../src/web/agent/agent-gather.js');
  const FETCH_URL = 'https://example.com/fetch-target';
  const fetched: string[] = [];
  let calls = 0;
  const result = await runAdaptiveCore('Acme Pro pricing overview', {
    search: async () => [{ title: 'Search hit', url: 'https://example.com/search-hit', snippet: 'launch pricing snippet words' }],
    fetchText: async (url: string) => {
      fetched.push(url);
      return `Acme Pro launch pricing background details with partner quotes from ${url} included here.${FILLER}`;
    },
    planner,
    evaluator: async () => {
      calls += 1;
      if (calls === 1)
        return {
          questionUpdates: [],
          nextActions: [
            {
              questionId: questionId('Acme Pro pricing overview details?'),
              intent: { kind: 'web_fetch', url: FETCH_URL },
            },
          ],
          shouldContinue: true,
        };
      return { questionUpdates: [], nextActions: [], shouldContinue: false };
    },
    // Round 1 spends the single search; the pending web_fetch must still run.
    budgets: { maxRounds: 3, maxSearches: 1, maxFetches: 12, maxGatherActions: 6, maxUtilityCalls: 8 },
    gatherProfile: 'balanced',
    gatherExecutor: async (intents, round, ctx) => {
      const outcome = await gatherExecutor(intents, round, ctx);
      // Provenance seed: the follow-up fetch url enters round 1 as a bounded
      // research-source candidate so round-2 validation admits it.
      if (round === 1) outcome.candidates.push({ kind: 'research-source', route: 'research', source: 'test', title: 'Fetch target', url: FETCH_URL });
      return outcome;
    },
    capabilitiesSnapshot: snapshotForJob({}),
  });
  assert.ok(validateAgentResult(result).ok);
  assert.ok(fetched.includes(FETCH_URL), 'round-2 dispatch executes the pending web_fetch (fetchText called)');
  assert.ok(
    result.warnings.some((warning) => warning.includes('round 2:') && warning.includes('fetches=1')),
    `round 2 admits the fetch leg: ${JSON.stringify(result.warnings)}`,
  );
  assert.ok(
    !result.warnings.some((warning) => warning.includes('budget_exhausted')),
    `no early budget_exhausted stop: ${JSON.stringify(result.warnings)}`,
  );
});
