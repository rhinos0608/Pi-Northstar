import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snapshotForJob } from '../../../src/web/agent/agent-capabilities.js';
import {
  buildNativeGatherTools,
  evidenceUrl,
  gatherExecutor,
  type GatherCounters,
  type GatherTools,
} from '../../../src/web/agent/agent-gather.js';
import type { GatherIntent } from '../../../src/web/agent/agent-gather-intents.js';
import { gatherLaneForAction } from '../../../src/web/agent/agent-core.js';
import { createAgentState, questionId } from '../../../src/web/agent/agent-state.js';

const FILLER = ' Additional background context about the product lineup and release notes follows here for completeness and extra length.';
const BODY = (text: string): string => `${text} ${FILLER}`;

function webTools(overrides?: Partial<GatherTools>): GatherTools {
  return {
    search: async (query: string) => [
      { title: `Hit for ${query}`, url: 'https://example.com/page-one', snippet: 'snippet words here' },
      { title: 'Second hit', url: 'https://example.com/page-two', snippet: 'more snippet words' },
    ],
    fetchText: async (url: string) => BODY(`Body text about the topic from ${url} with plenty of detail words for the passage.`),
    ...overrides,
  };
}

function ctxFor(tools: GatherTools, counters?: GatherCounters) {
  return {
    snapshot: snapshotForJob({}),
    state: createAgentState({ goal: 'test goal' }),
    counters: counters ?? { searchesUsed: 0, fetchesUsed: 0 },
    tools,
  };
}

const researchTools = (abstract = 'Study abstract showing the launch price effect with measured words and conclusions drawn here.') =>
  webTools({ research: async () => ({ abstracts: [{ abstract, canonicalUrl: 'https://example.com/paper' }] }) });

test('web_search admits fetched chunks with counters and web content', async () => {
  const ctx = ctxFor(webTools());
  const outcome = await gatherExecutor([{ kind: 'web_search', query: 'Acme Pro launch price details' }], 1, ctx);
  assert.ok(outcome.admitted.length > 0);
  assert.ok(outcome.admitted.every((entry) => entry.sourceRef.acquisitionRoute === 'fetch'));
  assert.equal(outcome.searchesUsed, 1);
  assert.equal(outcome.fetchesUsed, 2);
  assert.equal(outcome.webContent.length, 2);
  assert.deepEqual(outcome.queriesSearched, ['Acme Pro launch price details']);
  assert.deepEqual(outcome.warnings, []);
  assert.deepEqual(outcome.perAction, [{ route: 'web', degraded: false }]);
  assert.equal(ctx.state.queries.length, 1);
});

test('research_search admits the abstract only (metadata rows stay candidates)', async () => {
  const ctx = ctxFor(researchTools());
  const outcome = await gatherExecutor(
    [{ kind: 'research_search', query: 'Acme Pro pricing academic studies' }],
    1,
    ctx,
  );
  assert.equal(outcome.admitted.length, 1);
  assert.equal(outcome.admitted[0]!.sourceRef.acquisitionRoute, 'research');
  assert.ok(outcome.candidates.length >= 1);
  assert.ok(outcome.candidates.every((entry) => entry.route === 'research'));
  // Wave 5: maxSearches is strictly web-lane scope — a research success rides
  // gatherActionsUsed + the research lane cap and never consumes searchesUsed.
  assert.equal(outcome.searchesUsed, 0);
  assert.equal(outcome.fetchesUsed, 0);
});

test('github/kg routes admit per-route content; social/video degrade (no executor surface)', async () => {
  const githubBody = BODY('Repository file content describing the pricing config with many words and negatives.');
  const tools = webTools({
    github: async () => ({ contents: [{ content: githubBody, canonicalUrl: 'https://github.com/acme/pro/blob/main/price.md' }] }),
    social: async () => ({ posts: [{ body: BODY('Community post body about the launch price discussion.'), canonicalUrl: 'https://v2ex.example/t/123' }] }),
    video: async () => ({
      segments: [{ segment: BODY('Transcript segment covering the launch price announcement.'), timestamp: 42, canonicalUrl: 'https://example.com/watch?v=abc' }],
    }),
    kg: async () => ({ fields: [{ nodeId: 'n-1', field: 'price', value: 'Acme Pro launch price is 199 dollars per month about.' }] }),
  });
  const ctx = ctxFor(tools);
  const snapshot = snapshotForJob({ DIFFBOT_TOKEN: 'token', OPENCLI_PRESENT: '1', YOUTUBE_API_KEY: 'key' });
  const ctx2 = { ...ctx, snapshot };
  const outcome = await gatherExecutor(
    [
      { kind: 'github_search', scope: 'files', query: 'config/pricing.ts', repoHint: 'acme/pro' },
      { kind: 'social_search', platform: 'v2ex', query: 'Acme Pro launch price discussion' },
      { kind: 'video_transcript', videoHint: 'Acme Pro launch keynote recording' },
      { kind: 'kg_lookup', entityType: 'Organization', name: 'Acme Pro launch price' },
    ] as GatherIntent[],
    1,
    ctx2,
  );
  const routes = outcome.admitted.map((entry) => entry.sourceRef.acquisitionRoute);
  // Wave 9 (D4): github/kg ride the executor; social/video degrade to web even
  // with tools wired, because the snapshot advertises no social/video lane.
  for (const route of ['github', 'kg']) assert.ok(routes.includes(route as never), `missing ${route}`);
  assert.ok(!routes.includes('social' as never), 'social must not admit as a specialist lane');
  assert.ok(!routes.includes('video' as never), 'video must not admit as a specialist lane');
  assert.deepEqual(outcome.perAction, [
    { route: 'github', degraded: false },
    { route: 'social', degraded: true },
    { route: 'video', degraded: true },
    { route: 'kg', degraded: false },
  ]);
  assert.ok(outcome.warnings.every((warning) => !warning.includes('no tool surface')));
  // Wave 5: live-specialist successes never consume the web-search budget;
  // the two degraded legs execute as web_search and consume it.
  assert.equal(outcome.searchesUsed, 2);
  // KG entries use the canonicalUrl:'' sentinel — never a URL.
  const kgEntry = outcome.admitted.find((entry) => entry.sourceRef.acquisitionRoute === 'kg')!;
  assert.equal(kgEntry.sourceRef.canonicalUrl, '');
  assert.equal(evidenceUrl(kgEntry), undefined);
});

test('kg branch links via token-overlap fallback like sibling routes', async () => {
  const tools = webTools({
    kg: async () => ({ fields: [{ nodeId: 'n-9', field: 'price', value: 'Quartz release notes describe multi-region capacity.' }] }),
  });
  const snapshot = snapshotForJob({ DIFFBOT_TOKEN: 'token', OPENCLI_PRESENT: '1', YOUTUBE_API_KEY: 'key' });
  const state = createAgentState({ goal: 'test goal' });
  const added = state.addQuestion({ question: 'Which Quartz release notes describe multi-region capacity?', required: true });
  assert.ok(!('rejected' in added));
  const ctx = { snapshot, state, counters: { searchesUsed: 0, fetchesUsed: 0 }, tools };
  const outcome = await gatherExecutor([{ kind: 'kg_lookup', entityType: 'Organization', name: 'Quartz release notes' }], 1, ctx);
  assert.equal(outcome.admitted.length, 1);
  assert.deepEqual(outcome.admitted[0]!.questionIds, [added.id]);
});

test('research branch filters out-of-range years to candidates-only', async () => {
  const oldAbstract = '2019 study of legacy pricing models with measured survey words and conclusions drawn here fully.';
  const newAbstract = '2022 study of current pricing models with measured survey words and conclusions drawn here fully.';
  const tools = webTools({
    research: async () => ({
      abstracts: [
        { abstract: oldAbstract, year: 2019, canonicalUrl: 'https://example.com/old-paper' },
        { abstract: newAbstract, year: 2022, canonicalUrl: 'https://example.com/new-paper' },
      ],
    }),
  });
  const ctx = ctxFor(tools);
  const outcome = await gatherExecutor(
    [{ kind: 'research_search', query: 'Acme Pro pricing academic studies here', yearFrom: 2020, yearTo: 2023 }],
    1,
    ctx,
  );
  assert.equal(outcome.admitted.length, 1);
  assert.ok(outcome.admitted[0]!.excerpt.includes('2022 study'));
  // Both rows stay discoverable as candidates; only the in-range row is evidence.
  assert.equal(outcome.candidates.length, 2);
});

test('unavailable route degrades to web_search with a warning', async () => {
  const ctx = ctxFor(webTools());
  const outcome = await gatherExecutor([{ kind: 'kg_lookup', entityType: 'Organization', name: 'Acme Pro' }], 1, ctx);
  assert.ok(outcome.warnings.some((warning) => warning.startsWith('route degraded: kg unavailable')));
  assert.deepEqual(outcome.perAction, [{ route: 'kg', degraded: true }]);
  assert.equal(outcome.searchesUsed, 1);
  assert.ok(outcome.admitted.length > 0, 'degraded action still gathers via web');
  assert.equal(ctx.state.queries[0]!.route, 'web');
});

test('snapshot-unavailable specialist route degrades to web_search with a warning', async () => {
  // Wave 9 (D4): v2ex is never advertised (no executor surface), so the
  // degrade fires at the snapshot gate — the 'no tool surface' path is dead
  // for every advertised lane.
  const ctx = ctxFor(webTools());
  const outcome = await gatherExecutor(
    [{ kind: 'social_search', platform: 'v2ex', query: 'Acme Pro launch price discussion' }],
    1,
    ctx,
  );
  assert.ok(outcome.warnings.every((warning) => !warning.includes('no tool surface')));
  assert.ok(outcome.warnings.some((warning) => warning.startsWith('route degraded: social unavailable')));
  assert.deepEqual(outcome.perAction, [{ route: 'social', degraded: true }]);
  assert.ok(outcome.admitted.length > 0);
});

test('invalid intent skips with a warning and never touches tools', async () => {
  let calls = 0;
  const ctx = ctxFor(
    webTools({
      search: async () => {
        calls += 1;
        return [];
      },
    }),
  );
  const outcome = await gatherExecutor([{ kind: 'bogus' } as unknown as GatherIntent], 1, ctx);
  assert.equal(calls, 0);
  assert.equal(outcome.searchesUsed, 0);
  assert.ok(outcome.warnings.some((warning) => warning.includes('invalid')));
  assert.deepEqual(outcome.perAction, [{ route: 'web', degraded: false, skipped: 'unknown_intent_kind' }]);
});

test('parallel legs merge in ledger order, never completion order', async () => {
  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const tools = webTools({
    search: async (query: string) => {
      if (query.includes('first query here')) await delay(30);
      return [{ title: query, url: `https://example.com/${encodeURIComponent(query)}`, snippet: 'words' }];
    },
    fetchText: async (url: string) => BODY(`Fetched body for ${url} carrying distinct topic words for the test.`),
  });
  const ctx = ctxFor(tools);
  const outcome = await gatherExecutor(
    [
      { kind: 'web_search', query: 'slow first query here now' },
      { kind: 'web_search', query: 'fast second query here now' },
    ],
    2,
    ctx,
  );
  assert.deepEqual(outcome.queriesSearched, ['slow first query here now', 'fast second query here now']);
  assert.ok(outcome.webContent[0]!.url.includes('slow%20first'), 'ledger order preserved');
  assert.ok(outcome.webContent[1]!.url.includes('fast%20second'));
});

test('one failed lane never kills the round', async () => {
  const tools = webTools({
    search: async (query: string) => {
      if (query.includes('failing')) throw new Error('backend down');
      return [{ title: 'ok', url: 'https://example.com/ok-page', snippet: 'words' }];
    },
  });
  const ctx = ctxFor(tools);
  const outcome = await gatherExecutor(
    [
      { kind: 'web_search', query: 'failing query here please' },
      { kind: 'web_search', query: 'healthy query here please' },
    ],
    2,
    ctx,
  );
  assert.ok(outcome.warnings.some((warning) => warning.includes('search failed')));
  assert.equal(outcome.searchesUsed, 2, 'failed web attempts cost the search budget too');
  assert.ok(outcome.admitted.length > 0, 'healthy lane still admits');
  assert.deepEqual(outcome.queriesSearched, ['healthy query here please']);
});

test('search budget exhaustion skips the action with a warning', async () => {
  let calls = 0;
  const ctx = ctxFor(
    webTools({
      search: async () => {
        calls += 1;
        return [];
      },
    }),
    { searchesUsed: 4, fetchesUsed: 0 },
  );
  const outcome = await gatherExecutor([{ kind: 'web_search', query: 'over-budget query here now' }], 2, ctx);
  assert.equal(calls, 0);
  assert.ok(outcome.warnings.some((warning) => warning.includes('search budget exhausted')));
  assert.deepEqual(outcome.perAction, [{ route: 'web', degraded: false, skipped: 'budget_exhausted' }]);
});

test('question linkage rides explicit questionIds', async () => {
  const qid = questionId('What is the launch price of Acme Pro?');
  const ctx = { ...ctxFor(researchTools()), questionIds: [qid] };
  const outcome = await gatherExecutor(
    [{ kind: 'research_search', query: 'Acme Pro pricing academic studies' }],
    1,
    ctx,
  );
  assert.deepEqual(outcome.admitted[0]!.questionIds, [qid]);
});

test('buildNativeGatherTools maps research/github/kg to callNative names', async () => {
  const seen: Array<{ name: string; args: Record<string, unknown> }> = [];
  const tools = buildNativeGatherTools({
    search: async () => [],
    fetchText: async () => '',
    callNative: async (name, args) => {
      seen.push({ name, args });
      return {};
    },
  });
  await tools.research!({ action: 'academic' });
  await tools.github!({ action: 'search_repos' });
  await tools.kg!({ action: 'search' });
  assert.deepEqual(
    seen.map((entry) => entry.name),
    ['research', 'github', 'kg'],
  );
  assert.equal(tools.social, undefined);
  assert.equal(tools.video, undefined);
});

// --- Task 8 BudgetEnvelope enforcement ---

test('envelope exhaustion skips actions with a warning', async () => {
  let calls = 0;
  const tools = webTools({
    search: async (query: string) => {
      calls += 1;
      return [{ title: `Hit for ${query}`, url: 'https://example.com/page-one', snippet: 'snippet' }];
    },
  });
  const ctx = {
    ...ctxFor(tools, { searchesUsed: 0, fetchesUsed: 0, gatherActionsUsed: 6 }),
    budgets: { maxSearches: 8, maxFetches: 16, maxGatherActions: 6 },
  };
  const outcome = await gatherExecutor(
    [
      { kind: 'web_search', query: 'first over-envelope query here' },
      { kind: 'web_search', query: 'second over-envelope query here' },
    ],
    2,
    ctx,
  );
  assert.equal(calls, 0);
  assert.ok(outcome.warnings.some((warning) => warning.includes('gather envelope exhausted')));
  assert.deepEqual(outcome.perAction, [
    { route: 'web', degraded: false, skipped: 'budget_exhausted' },
    { route: 'web', degraded: false, skipped: 'budget_exhausted' },
  ]);
});

test('envelope counts across lanes: width N total, not per lane', async () => {
  let searches = 0;
  const tools = webTools({
    search: async (query: string) => {
      searches += 1;
      return [{ title: `Hit for ${query}`, url: 'https://example.com/page-one', snippet: 'snippet' }];
    },
  });
  const ctx = {
    ...ctxFor(tools, { searchesUsed: 0, fetchesUsed: 0, gatherActionsUsed: 4 }),
    budgets: { maxSearches: 8, maxFetches: 16, maxGatherActions: 6 },
  };
  const outcome = await gatherExecutor(
    [
      { kind: 'web_search', query: 'first envelope query here now' },
      { kind: 'web_search', query: 'second envelope query here now' },
      { kind: 'web_search', query: 'third envelope query here now' },
    ],
    2,
    ctx,
  );
  assert.equal(searches, 2, 'only envelope headroom (6-4) executes');
  assert.equal(outcome.perAction.filter((entry) => entry.skipped === undefined).length, 2);
  assert.equal(outcome.perAction[2]!.skipped, 'budget_exhausted');
});

test('lane cap exhaustion skips the lane with lane_exhausted', async () => {
  let searches = 0;
  const tools = webTools({
    search: async (query: string) => {
      searches += 1;
      return [{ title: `Hit for ${query}`, url: 'https://example.com/page-one', snippet: 'snippet' }];
    },
  });
  const ctx = {
    ...ctxFor(tools, { searchesUsed: 0, fetchesUsed: 0, gatherActionsUsed: 0, laneActionsUsed: { web: 6 } }),
    budgets: { maxSearches: 8, maxFetches: 16, maxGatherActions: 12 },
  };
  const outcome = await gatherExecutor([{ kind: 'web_search', query: 'lane-capped query here now' }], 2, ctx);
  assert.equal(searches, 0);
  assert.ok(outcome.warnings.some((warning) => warning.includes('lane budget exhausted (web)')));
  assert.deepEqual(outcome.perAction, [{ route: 'web', degraded: false, skipped: 'lane_exhausted' }]);
});

test('round fetch reserve caps round-1 web legs at 7', async () => {
  const tools = webTools({
    search: async (query: string) =>
      Array.from({ length: 10 }, (_, index) => ({
        title: `Hit ${index} for ${query}`,
        url: `https://example.com/many-${index}`,
        snippet: 'snippet',
      })),
  });
  const ctx = ctxFor(tools);
  const outcome = await gatherExecutor([{ kind: 'web_search', query: 'wide fetch reserve query here' }], 1, ctx);
  assert.equal(outcome.fetchesUsed, 7, 'round-1 reserve caps fetches at 7 despite 10 hits');
});

test('degraded specialist actions account to the web lane', async () => {
  // Degraded kg/social/video legs execute as web_search: the core tallies
  // them under laneActionsUsed.web (never their nominal lane).
  for (const route of ['kg', 'social', 'video'] as const) {
    assert.equal(gatherLaneForAction(route, true), 'web', `${route} degraded accounts to web`);
  }
  assert.equal(gatherLaneForAction('github', false), 'github');
  assert.equal(gatherLaneForAction('web', false), 'web');
  assert.equal(gatherLaneForAction('unknown-route', false), 'web');
  const laneActionsUsed: Record<string, number> = { web: 0 };
  const degraded = [
    { route: 'kg', degraded: true },
    { route: 'social', degraded: true },
    { route: 'video', degraded: true },
  ];
  for (const entry of degraded) {
    const lane = gatherLaneForAction(entry.route, entry.degraded);
    laneActionsUsed[lane] = (laneActionsUsed[lane] ?? 0) + 1;
  }
  assert.equal(laneActionsUsed.web, 3, 'three degraded actions increment laneActionsUsed.web');
});

test('allocateFetchBudgets: only fetch-capable legs split the reserve', async () => {
  const { allocateFetchBudgets } = await import('../../../src/web/agent/agent-gather.js');
  assert.deepEqual(allocateFetchBudgets(['none', 'search', 'none'], 7), [0, 7, 0]);
  assert.deepEqual(allocateFetchBudgets(['search', 'none', 'search'], 7), [4, 0, 3]);
  assert.deepEqual(allocateFetchBudgets(['single', 'search'], 7), [1, 6]);
  assert.deepEqual(allocateFetchBudgets(['single', 'single', 'search'], 7), [1, 1, 5]);
  assert.deepEqual(allocateFetchBudgets([], 7), []);
  assert.deepEqual(allocateFetchBudgets(['none', 'none'], 7), [0, 0]);
});

test('mixed [research, web, github] round cap 7: the lone web leg gets all 7 fetches', async () => {
  const { adaptResearchResult, adaptGithubResult } = await import('../../../src/web/agent/agent-gather-adapters.js');
  const tools = webTools({
    search: async (_query: string) =>
      Array.from({ length: 10 }, (_, index) => ({ title: `Hit ${index}`, url: `https://example.com/wide-${index}`, snippet: 'snippet' })),
    research: async () =>
      adaptResearchResult({ content: [], details: { results: [{ title: 'Pricing study', url: 'https://example.com/study', snippet: 'snippet', source: 'openalex', abstract: 'Genuine abstract text about launch pricing with measured words here.' }] } }),
    github: async () =>
      adaptGithubResult({ content: [], details: { action: 'search', entities: [{ version: 1, kind: 'repo', id: 'acme/pro', backend: 'github-api', url: 'https://github.com/acme/pro', name: 'pro', full_name: 'acme/pro', description: 'Repo description.' }] } }),
  });
  const ctx = ctxFor(tools);
  const outcome = await gatherExecutor(
    [
      { kind: 'research_search', query: 'Acme Pro pricing academic studies' },
      { kind: 'web_search', query: 'wide fetch reserve query here' },
      { kind: 'github_search', scope: 'repo', query: 'Acme Pro pricing repository' },
    ],
    1,
    ctx,
  );
  assert.equal(outcome.fetchesUsed, 7, 'specialist-native legs burn zero reserve');
  assert.equal(outcome.searchesUsed, 1, 'only the web leg consumes maxSearches');
});

test('mixed [web, research, web]: the two web legs split 7 as 4/3', async () => {
  const { adaptResearchResult } = await import('../../../src/web/agent/agent-gather-adapters.js');
  const tools = webTools({
    search: async (query: string) =>
      Array.from({ length: 10 }, (_, index) => ({ title: `Hit ${index}`, url: `https://example.com/${encodeURIComponent(query)}-${index}`, snippet: 'snippet' })),
    research: async () => adaptResearchResult({ content: [], details: { results: [] } }),
  });
  const ctx = ctxFor(tools);
  const outcome = await gatherExecutor(
    [
      { kind: 'web_search', query: 'first wide query here now' },
      { kind: 'research_search', query: 'Acme Pro pricing academic studies' },
      { kind: 'web_search', query: 'second wide query here now' },
    ],
    1,
    ctx,
  );
  assert.equal(outcome.fetchesUsed, 7);
  assert.deepEqual(outcome.queriesSearched, ['first wide query here now', 'Acme Pro pricing academic studies', 'second wide query here now']);
});

test('degraded specialist participates in fetch allocation as a web leg', async () => {
  const tools = webTools({
    search: async (query: string) =>
      Array.from({ length: 10 }, (_, index) => ({ title: `Hit ${index}`, url: `https://example.com/${encodeURIComponent(query)}-${index}`, snippet: 'snippet' })),
  });
  const ctx = ctxFor(tools);
  const outcome = await gatherExecutor(
    [
      { kind: 'kg_lookup', entityType: 'Organization', name: 'Acme Pro launch price' },
      { kind: 'web_search', query: 'wide fetch reserve query here' },
    ],
    1,
    ctx,
  );
  assert.deepEqual(outcome.perAction, [
    { route: 'kg', degraded: true },
    { route: 'web', degraded: false },
  ]);
  assert.equal(outcome.fetchesUsed, 7, 'degraded leg is fetch-capable: 4/3 split, nothing wasted');
  assert.equal(outcome.searchesUsed, 2);
});

test('web_fetch in the mix deducts exactly 1 fetch from the web_search pool', async () => {
  const paperUrl = 'https://example.com/paper-1';
  const tools = webTools({
    search: async (query: string) =>
      Array.from({ length: 10 }, (_, index) => ({ title: `Hit ${index}`, url: `https://example.com/${encodeURIComponent(query)}-${index}`, snippet: 'snippet' })),
    fetchText: async (url: string) => BODY(`Body text about the topic from ${url} with plenty of detail words for the passage.`),
  });
  const ctx = ctxFor(tools);
  const outcome = await gatherExecutor([{ kind: 'web_fetch', url: paperUrl }, { kind: 'web_search', query: 'wide fetch reserve query here' }], 1, ctx);
  assert.equal(outcome.fetchesUsed, 7, '1 (web_fetch) + 6 (web_search share of 7)');
  assert.equal(outcome.searchesUsed, 1, 'web_fetch never consumes maxSearches');
  assert.deepEqual(outcome.queriesSearched, [paperUrl, 'wide fetch reserve query here']);
  assert.ok(outcome.admitted.some((entry) => entry.sourceRef.acquisitionRoute === 'fetch'));
});

test('web_fetch round trip: admits fetch evidence with counters and dedupes repeats', async () => {
  const paperUrl = 'https://example.com/paper-1';
  let fetchCalls: string[] = [];
  const tools = webTools({
    fetchText: async (url: string) => {
      fetchCalls.push(url);
      return BODY('Launch pricing effects paper showing price elasticity results with measured survey words.');
    },
  });
  const state = createAgentState({ goal: 'test goal' });
  const ctx = { snapshot: snapshotForJob({}), state, counters: { searchesUsed: 0, fetchesUsed: 0 }, tools };
  const outcome = await gatherExecutor([{ kind: 'web_fetch', url: paperUrl }], 1, ctx);
  assert.equal(outcome.admitted.length, 1);
  assert.equal(outcome.admitted[0]!.sourceRef.acquisitionRoute, 'fetch');
  assert.ok(outcome.admitted[0]!.excerpt.includes('price elasticity'));
  assert.equal(evidenceUrl(outcome.admitted[0]!), 'https://example.com/paper-1');
  assert.equal(outcome.searchesUsed, 0);
  assert.equal(outcome.fetchesUsed, 1);
  assert.deepEqual(outcome.perAction, [{ route: 'web', degraded: false }]);
  assert.equal(fetchCalls.length, 1);
  const repeat = await gatherExecutor(
    [{ kind: 'web_fetch', url: paperUrl }, { kind: 'web_fetch', url: paperUrl }],
    2,
    { snapshot: snapshotForJob({}), state, counters: { searchesUsed: 0, fetchesUsed: 1 }, tools },
  );
  assert.equal(fetchCalls.length, 1, 'repeat web_fetch of the same URL never refetches');
  assert.deepEqual(repeat.perAction, [
    { route: 'web', degraded: false, skipped: 'exact duplicate query' },
    { route: 'web', degraded: false, skipped: 'exact duplicate query' },
  ]);
});

test('failed web_fetch consumes exactly 1 fetch attempt and 0 searches', async () => {
  const tools = webTools({
    fetchText: async (url: string) => {
      throw new Error(`fetch failed: ${url}`);
    },
  });
  const ctx = ctxFor(tools);
  const outcome = await gatherExecutor([{ kind: 'web_fetch', url: 'https://example.com/paper-1' }], 1, ctx);
  assert.equal(outcome.fetchesUsed, 1);
  assert.equal(outcome.searchesUsed, 0);
  assert.equal(outcome.admitted.length, 0);
  assert.ok(outcome.warnings.some((warning) => warning.includes('fetch round 0 failed; passage skipped')));
  assert.deepEqual(outcome.perAction, [{ route: 'web', degraded: false }]);
});

test('maxSearches exhausted: web_search skips but pending web_fetch still dispatches', async () => {
  const tools = webTools();
  const ctx = {
    ...ctxFor(tools, { searchesUsed: 1, fetchesUsed: 0 }),
    budgets: { maxSearches: 1, maxFetches: 12, maxGatherActions: 6 },
  };
  const outcome = await gatherExecutor(
    [
      { kind: 'web_search', query: 'over-budget query here now' },
      { kind: 'web_fetch', url: 'https://example.com/paper-1' },
    ],
    2,
    ctx,
  );
  assert.deepEqual(outcome.perAction, [
    { route: 'web', degraded: false, skipped: 'budget_exhausted' },
    { route: 'web', degraded: false },
  ]);
  assert.equal(outcome.searchesUsed, 0);
  assert.equal(outcome.fetchesUsed, 1);
  assert.equal(outcome.admitted.length, 1);
});

test('e2e research-source: discovery candidate → web_fetch follow-up admits fetch evidence', async () => {
  const { adaptResearchResult } = await import('../../../src/web/agent/agent-gather-adapters.js');
  const paperUrl = 'https://example.com/paper-1';
  const paperBody = BODY('Launch pricing effects paper showing price elasticity results with measured survey words.');
  const state = createAgentState({ goal: 'Acme Pro launch pricing study' });
  const research = async () =>
    adaptResearchResult({
      content: [],
      details: {
        results: [
          { title: 'Launch pricing effects', url: paperUrl, snippet: 'Study snippet describing launch price effects.', source: 'semantic_scholar' },
        ],
      },
    });
  const tools = webTools({
    research,
    fetchText: async (url: string) => {
      assert.equal(url, paperUrl);
      return paperBody;
    },
  });
  const snapshot = snapshotForJob({});
  const r1 = await gatherExecutor([{ kind: 'research_search', query: 'Acme Pro launch pricing study' }], 1, {
    snapshot,
    state,
    counters: { searchesUsed: 0, fetchesUsed: 0 },
    tools,
  });
  assert.equal(r1.admitted.length, 0, 'candidate-only row (no abstract) admits nothing');
  const candidate = r1.candidates.find((entry) => entry.kind === 'research-source');
  assert.ok(candidate !== undefined);
  assert.equal((candidate as { source: string }).source, 'semantic_scholar');
  assert.equal((candidate as { title: string }).title, 'Launch pricing effects');
  assert.equal((candidate as { url: string }).url, paperUrl);
  const r2 = await gatherExecutor([{ kind: 'web_fetch', url: paperUrl }], 2, {
    snapshot,
    state,
    counters: { searchesUsed: r1.searchesUsed, fetchesUsed: r1.fetchesUsed },
    tools,
  });
  assert.equal(r2.fetchesUsed, 1);
  assert.equal(r2.searchesUsed, 0, 'web_fetch consumes a fetch attempt, never maxSearches');
  assert.equal(r2.admitted.length, 1);
  assert.equal(r2.admitted[0]!.sourceRef.acquisitionRoute, 'fetch');
  assert.ok(r2.admitted[0]!.excerpt.includes('price elasticity'));
  assert.equal(evidenceUrl(r2.admitted[0]!), paperUrl);
});

test('e2e kg candidate → enhance → evidence', async () => {
  const { adaptKgResult } = await import('../../../src/web/agent/agent-gather-adapters.js');
  const { buildKnowledgeResult } = await import('../../../src/knowledge/knowledge-contract.js');
  const searchEnvelope = () => ({
    content: [{ type: 'text', text: 'kg search: 1 entit(y|ies).' }],
    details: {
      action: 'search',
      knowledge: buildKnowledgeResult({
        request: { tool: 'kg', action: 'search' },
        outcomes: [{ provider: 'diffbot', entities: [{ entityVersion: 1, id: 'kg-acme', type: 'Organization', name: 'Acme' }] }],
      }),
    },
  });
  const enhanceEnvelope = () => ({
    content: [{ type: 'text', text: 'kg enhance: 1 entit(y|ies).' }],
    details: {
      action: 'enhance',
      knowledge: buildKnowledgeResult({
        request: { tool: 'kg', action: 'enhance', providers: ['diffbot'] },
        outcomes: [
          { provider: 'diffbot', entities: [{ entityVersion: 1, id: 'kg-acme', type: 'Organization', name: 'Acme', url: 'https://example.com/acme' }] },
        ],
        data: {
          kind: 'enhance',
          entities: [{ entityVersion: 1, id: 'kg-acme', type: 'Organization', name: 'Acme', url: 'https://example.com/acme' }],
          claims: [{ subjectId: 'kg-acme', predicate: 'founded', object: 'Acme was founded in 2019 with seed funding round.' }],
          conflicts: [],
          partitions: [{ provider: 'diffbot', status: 'ok' }],
          groups: [],
          evidence: [],
        },
      }),
    },
  });
  const snapshot = snapshotForJob({ DIFFBOT_TOKEN: 'token' });
  const state = createAgentState({ goal: 'Acme founding details' });
  const kg = async (args: Record<string, unknown>) =>
    adaptKgResult('id' in args && args['id'] !== undefined ? enhanceEnvelope() : searchEnvelope());
  const tools = webTools({ kg });
  const r1 = await gatherExecutor([{ kind: 'kg_lookup', entityType: 'Organization', name: 'Acme' }], 1, {
    snapshot,
    state,
    counters: { searchesUsed: 0, fetchesUsed: 0 },
    tools,
  });
  assert.equal(r1.admitted.length, 0, 'search entities are candidate-only');
  const candidate = r1.candidates.find((entry) => entry.kind === 'kg-entity');
  assert.ok(candidate !== undefined);
  assert.equal((candidate as { entityType: string }).entityType, 'Organization');
  assert.equal((candidate as { id: string }).id, 'kg-acme');
  const r2 = await gatherExecutor([{ kind: 'kg_lookup', entityType: 'Organization', id: 'kg-acme' }], 2, {
    snapshot,
    state,
    counters: { searchesUsed: r1.searchesUsed, fetchesUsed: r1.fetchesUsed },
    tools,
  });
  assert.ok(r2.admitted.length > 0);
  assert.ok(r2.admitted.every((entry) => entry.sourceRef.acquisitionRoute === 'kg'));
  const claim = r2.admitted.find((entry) => entry.excerpt.includes('founded in 2019'));
  assert.ok(claim !== undefined, 'claim value admits as kg evidence');
  assert.deepEqual(claim!.locator, { nodeId: 'kg-acme', field: 'founded' });
});

test('e2e github code → file read → evidence', async () => {
  const { adaptGithubResult } = await import('../../../src/web/agent/agent-gather-adapters.js');
  const fileUrl = 'https://github.com/acme/pro/blob/main/config/pricing.ts';
  const fileBody = BODY('Repository file content describing the pricing config with launch price 199 dollars.');
  const github = async (args: Record<string, unknown>) => {
    if (args['action'] === 'file') {
      return adaptGithubResult({
        content: [],
        details: {
          action: 'file',
          entities: [{ version: 1, kind: 'file', id: 'acme/pro:main:config/pricing.ts', backend: 'github-api', path: 'config/pricing.ts', url: fileUrl, content: fileBody }],
        },
      });
    }
    return adaptGithubResult({
      content: [],
      details: {
        action: 'search',
        entities: [
          { version: 1, kind: 'search_result', id: 'acme/pro:config/pricing.ts', backend: 'github-api', url: fileUrl, path: 'config/pricing.ts', repository: 'acme/pro', title: 'pricing.ts', snippet: 'Code snippet teaser without file content.' },
        ],
      },
    });
  };
  const snapshot = snapshotForJob({});
  const state = createAgentState({ goal: 'Acme Pro pricing config' });
  const tools = webTools({ github });
  const r1 = await gatherExecutor([{ kind: 'github_search', scope: 'code', query: 'pricing config', repoHint: 'acme/pro' }], 1, {
    snapshot,
    state,
    counters: { searchesUsed: 0, fetchesUsed: 0 },
    tools,
  });
  assert.equal(r1.admitted.length, 0, 'code snippets stay candidate-only');
  const candidate = r1.candidates.find((entry) => entry.kind === 'github-code');
  assert.ok(candidate !== undefined);
  assert.deepEqual([(candidate as { owner: string }).owner, (candidate as { repo: string }).repo, (candidate as { path: string }).path], ['acme', 'pro', 'config/pricing.ts']);
  assert.equal((candidate as { ref?: string }).ref, 'main');
  const r2 = await gatherExecutor([{ kind: 'github_search', scope: 'files', query: 'config/pricing.ts', repoHint: 'acme/pro' }], 2, {
    snapshot,
    state,
    counters: { searchesUsed: r1.searchesUsed, fetchesUsed: r1.fetchesUsed },
    tools,
  });
  assert.ok(r2.admitted.length > 0);
  assert.ok(r2.admitted.every((entry) => entry.sourceRef.acquisitionRoute === 'github'));
  assert.equal(evidenceUrl(r2.admitted[0]!), fileUrl);
});

test('e2e issues-listing follow-up: repo candidate → issues listing admits body evidence', async () => {
  const { adaptGithubResult } = await import('../../../src/web/agent/agent-gather-adapters.js');
  const issueUrl = 'https://github.com/acme/pro/issues/42';
  const github = async (args: Record<string, unknown>) => {
    if (args['action'] === 'issues') {
      return adaptGithubResult({
        content: [],
        details: {
          action: 'issues',
          entities: [
            { version: 1, kind: 'issue', id: 'github:issue:acme/pro#42', backend: 'github-api', number: 42, title: 'Launch price discussion', state: 'open', url: issueUrl, body: BODY('Issue body text describing the launch price debate with many words.') },
          ],
        },
      });
    }
    return adaptGithubResult({
      content: [],
      details: {
        action: 'search_repos',
        entities: [{ version: 1, kind: 'repo', id: 'acme/pro', backend: 'github-api', url: 'https://github.com/acme/pro', name: 'pro', full_name: 'acme/pro', description: 'Acme Pro repository.' }],
      },
    });
  };
  const snapshot = snapshotForJob({});
  const state = createAgentState({ goal: 'Acme Pro launch price debate' });
  const tools = webTools({ github });
  const r1 = await gatherExecutor([{ kind: 'github_search', scope: 'repo', query: 'Acme Pro pricing repository' }], 1, {
    snapshot,
    state,
    counters: { searchesUsed: 0, fetchesUsed: 0 },
    tools,
  });
  const candidate = r1.candidates.find((entry) => entry.kind === 'github-repo');
  assert.ok(candidate !== undefined, 'repo discovery yields a github-repo candidate');
  const r2 = await gatherExecutor([{ kind: 'github_search', scope: 'issues', repoHint: 'acme/pro', number: 42 }], 2, {
    snapshot,
    state,
    counters: { searchesUsed: r1.searchesUsed, fetchesUsed: r1.fetchesUsed },
    tools,
  });
  assert.ok(r2.admitted.length > 0);
  assert.ok(r2.admitted.every((entry) => entry.sourceRef.acquisitionRoute === 'github'));
  assert.ok(r2.admitted.some((entry) => entry.excerpt.includes('launch price debate')));
  assert.equal(evidenceUrl(r2.admitted[0]!), issueUrl);
});

test('native exception reads as failed gather; zero results reads as truthful empty', async () => {
  const query = 'Acme Pro pricing academic studies';
  const failing = {
    snapshot: snapshotForJob({}),
    state: createAgentState({ goal: 'test goal' }),
    counters: { searchesUsed: 0, fetchesUsed: 0 },
    tools: buildNativeGatherTools({
      search: async () => [],
      fetchText: async () => '',
      callNative: async () => {
        throw new Error('backend down');
      },
    }),
  };
  const failed = await gatherExecutor([{ kind: 'research_search', query }], 1, failing);
  assert.equal(failed.admitted.length, 0);
  assert.deepEqual(failed.candidates, []);
  assert.deepEqual(failed.queriesSearched, [], 'failed native call reports no searched query');
  assert.ok(failed.warnings.some((warning) => warning.includes('research gather failed; action skipped')), JSON.stringify(failed.warnings));
  assert.ok(!failed.warnings.some((warning) => warning.includes('unexpected native payload')), 'real failure never misreports as a shape problem');
  assert.deepEqual(failed.perAction, [{ route: 'research', degraded: false }], 'envelope spend counts the dispatched action');
  const emptying = {
    snapshot: snapshotForJob({}),
    state: createAgentState({ goal: 'test goal' }),
    counters: { searchesUsed: 0, fetchesUsed: 0 },
    tools: buildNativeGatherTools({
      search: async () => [],
      fetchText: async () => '',
      callNative: async () => ({ content: [], details: { query, results: [] } }),
    }),
  };
  const empty = await gatherExecutor([{ kind: 'research_search', query }], 1, emptying);
  assert.equal(empty.admitted.length, 0);
  assert.ok(empty.warnings.some((warning) => warning.includes('research adapter: zero results returned')), JSON.stringify(empty.warnings));
  assert.deepEqual(empty.queriesSearched, [query], 'legitimate zero results still report the searched query');
  assert.deepEqual(empty.perAction, [{ route: 'research', degraded: false }]);
});

test('allocateFetchBudgets caps singles at the round reserve (later singles get 0)', async () => {
  const { allocateFetchBudgets } = await import('../../../src/web/agent/agent-gather.js');
  assert.deepEqual(allocateFetchBudgets(['single', 'single'], 1), [1, 0]);
  assert.deepEqual(allocateFetchBudgets(['single', 'single', 'single'], 2), [1, 1, 0]);
  assert.deepEqual(allocateFetchBudgets(['single', 'single', 'search'], 2), [1, 1, 0]);
  assert.deepEqual(allocateFetchBudgets(['single', 'single', 'search'], 7), [1, 1, 5]);
});

test('round 3 [web_fetch, web_fetch]: second single zero-fetches past the round-1 cap', async () => {
  const fetched: string[] = [];
  const tools = webTools({
    fetchText: async (url: string) => {
      fetched.push(url);
      return BODY(`Body text about the topic from ${url} with plenty of detail words for the passage.`);
    },
  });
  const ctx = ctxFor(tools);
  const outcome = await gatherExecutor(
    [{ kind: 'web_fetch', url: 'https://example.com/paper-1' }, { kind: 'web_fetch', url: 'https://example.com/paper-2' }],
    3,
    ctx,
  );
  assert.equal(outcome.fetchesUsed, 1, 'round-3 cap 1 bounds the singles sum');
  assert.deepEqual(fetched, ['https://example.com/paper-1'], 'capped single never calls fetchText');
  assert.deepEqual(outcome.queriesSearched, ['https://example.com/paper-1', 'https://example.com/paper-2'], 'skipped single still dispatches (dispatched-but-unfetched)');
  assert.equal(outcome.perAction[1]!.skipped, undefined, 'fetch-skipped single keeps a non-skipped perAction entry');
  assert.ok(outcome.warnings.some((warning) => warning.includes('fetch budget exhausted; web_fetch skipped')), JSON.stringify(outcome.warnings));
  assert.equal(outcome.searchesUsed, 0);
});

test('[web_fetch, web_fetch, web_search] round 1: singles consume 2, web leg gets the remaining 5', async () => {
  const tools = webTools({
    search: async (query: string) =>
      Array.from({ length: 10 }, (_, index) => ({ title: `Hit ${index}`, url: `https://example.com/${encodeURIComponent(query)}-${index}`, snippet: 'snippet' })),
  });
  const ctx = ctxFor(tools);
  const outcome = await gatherExecutor(
    [
      { kind: 'web_fetch', url: 'https://example.com/paper-1' },
      { kind: 'web_fetch', url: 'https://example.com/paper-2' },
      { kind: 'web_search', query: 'wide fetch reserve query here' },
    ],
    1,
    ctx,
  );
  assert.equal(outcome.fetchesUsed, 7, '2 (singles) + 5 (web_search share of 7)');
  assert.equal(outcome.searchesUsed, 1);
  assert.equal(outcome.webContent.length, 7, '2 singles + 5 web_search share of 7');
  assert.equal(
    outcome.webContent.filter((entry) => entry.url.includes('wide%20fetch%20reserve%20query%20here')).length,
    5,
    'web_search leg gets the remaining 5 fetches',
  );
});

test('web_fetch dispatches when maxSearches is exhausted (fetch-aware predicate wiring)', async () => {
  const fetched: string[] = [];
  const tools = webTools({
    fetchText: async (url: string) => {
      fetched.push(url);
      return BODY(`Body text about the topic from ${url} with plenty of detail words for the passage.`);
    },
  });
  // Compat mode (no snapshot): web is the only admissible lane, so the
  // shared predicate can only pass via the fetch-aware web-lane headroom.
  const ctx = {
    state: createAgentState({ goal: 'test goal' }),
    counters: { searchesUsed: 1, fetchesUsed: 0 },
    budgets: { maxSearches: 1, maxFetches: 12 },
    tools,
  };
  const outcome = await gatherExecutor([{ kind: 'web_fetch', url: 'https://example.com/fetch-target' }], 1, ctx);
  assert.deepEqual(fetched, ['https://example.com/fetch-target'], 'exhausted searches never block a direct URL read');
  assert.equal(outcome.fetchesUsed, 1);
  assert.equal(outcome.searchesUsed, 0);
  assert.ok(outcome.admitted.length > 0, 'fetched body admits evidence');
});
