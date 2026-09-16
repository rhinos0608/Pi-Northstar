// Wave 2 (D6) candidate routing: typed candidates → follow-up → evidence.
//
// Candidates are navigation hints only: they never carry evidence IDs and
// never enter the ledger. A github-code candidate compiles to a files intent
// whose retrieved content admits as evidence and grounds the question.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admitGithubContent } from '../../../src/web/agent/agent-acquisition.js';
import {
  addRoundCandidates,
  candidateIdentity,
  createCandidateStore,
  MAX_CANDIDATES_PER_JOB,
  MAX_CANDIDATES_PER_ROUND,
  type AgentCandidate,
} from '../../../src/web/agent/agent-candidates.js';
import { buildEvaluatorContext } from '../../../src/web/agent/agent-evaluator.js';
import { buildPlannerPrompt } from '../../../src/web/agent/agent-planner.js';
import { validateAgentResult } from '../../../src/web/agent/agent-contract.js';
import { runAdaptiveCore } from '../../../src/web/agent/agent-core.js';
import {
  adaptGithubResult,
  adaptKgResult,
  adaptResearchResult,
} from '../../../src/web/agent/agent-gather-adapters.js';
import type { GatherOutcome } from '../../../src/web/agent/agent-gather.js';
import { buildNativeGatherTools, gatherExecutor as runGatherExecutor } from '../../../src/web/agent/agent-gather.js';
import { snapshotForJob } from '../../../src/web/agent/agent-capabilities.js';
import type { GatherIntent } from '../../../src/web/agent/agent-gather-intents.js';
import { createAgentState, questionId } from '../../../src/web/agent/agent-state.js';

const CANDIDATE_HEADER = 'navigation hints only — cannot satisfy or ground questions';

function githubEnvelopeWith(entities: Array<Record<string, unknown>>): unknown {
  return {
    content: [{ type: 'text', text: `github search: ${entities.length} entit(ies).` }],
    details: { action: 'search', backend: 'github-api', entities },
  };
}

// ── Store: caps + cross-round dedupe ──

test('candidate store: ≤12/round and ≤24/job, deduped by kind+identity', () => {
  const store = createCandidateStore();
  const generic = (n: number): AgentCandidate => ({ kind: 'generic', route: 'search', title: `row ${n}` });
  const first = addRoundCandidates(
    store,
    Array.from({ length: MAX_CANDIDATES_PER_ROUND + 1 }, (_, i) => generic(i)),
  );
  assert.equal(first.added.length, MAX_CANDIDATES_PER_ROUND);
  assert.equal(first.dropped, 1);
  // Same identity across rounds dedupes (no new rows).
  const repeat = addRoundCandidates(store, [generic(0)]);
  assert.deepEqual(repeat.added, []);
  // Fill to the job cap, then the cap holds.
  const second = addRoundCandidates(
    store,
    Array.from({ length: MAX_CANDIDATES_PER_ROUND }, (_, i) => generic(100 + i)),
  );
  assert.equal(second.added.length, MAX_CANDIDATES_PER_JOB - MAX_CANDIDATES_PER_ROUND);
  const over = addRoundCandidates(store, [generic(999)]);
  assert.deepEqual(over.added, []);
  assert.equal(store.candidates.length, MAX_CANDIDATES_PER_JOB);
});

test('candidate identity: same file different ref are distinct; same repo dedupes', () => {
  const code = (ref?: string): AgentCandidate => ({
    kind: 'github-code',
    route: 'github',
    owner: 'acme',
    repo: 'pro',
    path: 'config/pricing.ts',
    ...(ref === undefined ? {} : { ref }),
    url: 'https://github.com/acme/pro/blob/main/config/pricing.ts',
  });
  assert.notEqual(candidateIdentity(code('main')), candidateIdentity(code('dev')));
  assert.equal(candidateIdentity(code('main')), candidateIdentity(code('main')));
  const repo = (owner: string): AgentCandidate => ({
    kind: 'github-repo',
    route: 'github',
    owner,
    repo: 'pro',
    url: `https://github.com/${owner}/pro`,
  });
  assert.notEqual(candidateIdentity(repo('acme')), candidateIdentity(repo('other')));
});

// ── Adapters: typed emission + generic fallback (never fabricated) ──

test('github adapter: code/repo/issue rows emit D6 typed candidates', () => {
  const adapted = adaptGithubResult(
    githubEnvelopeWith([
      {
        version: 1,
        kind: 'search_result',
        id: 'acme/pro:config/pricing.ts',
        backend: 'github-api',
        url: 'https://github.com/acme/pro/blob/main/config/pricing.ts',
        path: 'config/pricing.ts',
        repository: 'acme/pro',
        title: 'pricing.ts',
        snippet: 'Code search snippet showing a price constant.',
      },
      {
        version: 1,
        kind: 'repo',
        id: 'acme/pro',
        backend: 'github-api',
        url: 'https://github.com/acme/pro',
        name: 'pro',
        description: 'Repo description.',
      },
      {
        version: 1,
        kind: 'issue',
        id: 'github:issue:acme/pro#42',
        backend: 'github-api',
        number: 42,
        title: 'Launch price discussion',
        state: 'open',
        url: 'https://github.com/acme/pro/issues/42',
        body: 'Issue body text with debate details here for length.',
      },
    ]),
  );
  assert.equal(adapted.candidates.length, 3);
  const [code, repo, issue] = adapted.candidates as [
    Extract<AgentCandidate, { kind: 'github-code' }>,
    Extract<AgentCandidate, { kind: 'github-repo' }>,
    Extract<AgentCandidate, { kind: 'github-issue' }>,
  ];
  assert.equal(code.kind, 'github-code');
  assert.deepEqual([code.owner, code.repo, code.path, code.ref], ['acme', 'pro', 'config/pricing.ts', 'main']);
  assert.equal(repo.kind, 'github-repo');
  assert.deepEqual([repo.owner, repo.repo], ['acme', 'pro']);
  assert.equal(repo.description, 'Repo description.');
  assert.equal(issue.kind, 'github-issue');
  assert.deepEqual([issue.owner, issue.repo, issue.number], ['acme', 'pro', 42]);
  assert.equal(issue.title, 'Launch price discussion');
});

test('github adapter: repo identity derives from url when full_name is absent; poor rows stay generic', () => {
  const adapted = adaptGithubResult(
    githubEnvelopeWith([
      {
        version: 1,
        kind: 'repo',
        id: 'acme/pro',
        backend: 'github-api',
        url: 'https://github.com/acme/pro',
        name: 'pro',
      },
      {
        version: 1,
        kind: 'search_result',
        id: 'unknown:x.ts',
        backend: 'github-api',
        path: 'x.ts',
        snippet: 'Snippet with no repository identity attached.',
      },
    ]),
  );
  assert.equal(adapted.candidates.length, 2);
  const [repo, poor] = adapted.candidates;
  assert.equal(repo!.kind, 'github-repo');
  assert.deepEqual(
    [(repo as Extract<AgentCandidate, { kind: 'github-repo' }>).owner, (repo as Extract<AgentCandidate, { kind: 'github-repo' }>).repo],
    ['acme', 'pro'],
  );
  assert.equal(poor!.kind, 'generic', 'identity-poor rows list without a compilable shape');
});

test('research adapter: sourced rows emit research-source; sourceless rows stay generic', () => {
  const adapted = adaptResearchResult({
    content: [{ type: 'text', text: '1 result.' }],
    details: {
      results: [
        {
          title: 'Launch pricing effects',
          url: 'https://example.com/paper-pricing',
          snippet: 'Study snippet.',
          source: 'semantic_scholar',
        },
        { title: 'Untitled mirror', url: 'https://example.com/mirror', snippet: 'No source attached.' },
      ],
    },
  });
  assert.equal(adapted.candidates.length, 2);
  const [sourced, poor] = adapted.candidates;
  assert.equal(sourced!.kind, 'research-source');
  assert.equal((sourced as Extract<AgentCandidate, { kind: 'research-source' }>).source, 'semantic_scholar');
  assert.equal(poor!.kind, 'generic');
});

test('kg adapter: Person/Organization entities emit kg-entity; other types stay generic', () => {
  const entity = (id: string | undefined, type: string): Record<string, unknown> => ({
    entityVersion: 1,
    ...(id === undefined ? {} : { id }),
    type,
    name: `Name for ${type}`,
  });
  const adapted = adaptKgResult({
    content: [{ type: 'text', text: 'kg search.' }],
    details: {
      knowledge: {
        data: {
          kind: 'search',
          entities: [entity('kg-1', 'Organization'), entity('kg-2', 'Thing'), entity(undefined, 'Person')],
        },
      },
    },
  });
  assert.equal(adapted.candidates.length, 3);
  const [org, thing, noid] = adapted.candidates;
  assert.equal(org!.kind, 'kg-entity');
  assert.equal((org as Extract<AgentCandidate, { kind: 'kg-entity' }>).entityType, 'Organization');
  assert.equal((org as Extract<AgentCandidate, { kind: 'kg-entity' }>).id, 'kg-1');
  assert.equal(thing!.kind, 'generic', 'non-Person/Organization cannot compile kg_lookup');
  assert.equal(noid!.kind, 'generic', 'id-less entities cannot compile kg_lookup');
  assert.deepEqual(adapted.evidenceInputs, [], 'search entities stay candidate-only');
});

// ── Contexts: bounded candidates sections ──

const SAMPLE: AgentCandidate = {
  kind: 'github-code',
  route: 'github',
  owner: 'acme',
  repo: 'pro',
  path: 'config/pricing.ts',
  ref: 'main',
  url: 'https://github.com/acme/pro/blob/main/config/pricing.ts',
};

test('evaluator context: candidates section carries the verbatim header + typed fields', () => {
  const { prompt } = buildEvaluatorContext({
    goal: 'What is the launch price of Acme Pro?',
    round: 1,
    state: createAgentState({ goal: 'g' }),
    budgetRemaining: { rounds: 1, searches: 1, fetches: 1, utilityCalls: 1 },
    priorRounds: [],
    currentRoundEvidence: [],
    candidates: [SAMPLE],
    openRequiredQuestions: [],
    conflicts: 0,
  });
  assert.ok(prompt.includes(CANDIDATE_HEADER), 'verbatim D6 header');
  assert.ok(prompt.includes('acme/pro') && prompt.includes('config/pricing.ts') && prompt.includes('main'));
});

test('planner prompt: bounded candidates render with the header; absent when empty', () => {
  const withCandidates = buildPlannerPrompt(
    'What is the launch price of Acme Pro?',
    { maxRounds: 3, maxSearches: 10 },
    [SAMPLE],
  );
  assert.ok(withCandidates.includes(CANDIDATE_HEADER));
  assert.ok(withCandidates.includes('config/pricing.ts'));
  const without = buildPlannerPrompt('What is the launch price of Acme Pro?', { maxRounds: 3, maxSearches: 10 });
  assert.ok(!without.includes('CANDIDATES'));
});

// ── Integration: candidate → follow-up → evidence ──

const QUESTION = 'What is the launch price of Acme Pro?';
const FILE_URL = 'https://github.com/acme/pro/blob/main/config/pricing.ts';
const FILE_BODY =
  'Acme Pro launch price config sets the launch price at 199 dollars per month. ' +
  'Additional background context about the product lineup and release notes follows here for completeness and extra length.';
const SNIPPET_TEASER = 'SNIPPET TEASER price constant teaser without full file content.';

function emptyOutcome(): GatherOutcome {
  return {
    admitted: [],
    candidates: [],
    warnings: [],
    searchesUsed: 0,
    fetchesUsed: 0,
    queriesSearched: [],
    queryRejected: 0,
    webContent: [],
    perAction: [],
  };
}

function promptEvidenceIds(prompt: string): string[] {
  const ids: string[] = [];
  for (const line of prompt.split('\n')) {
    const match = /^-\s+(ev-\S+)\s+\[/.exec(line);
    if (match !== null) ids.push(match[1]!);
  }
  return ids;
}

test('candidate routes to a files follow-up whose content admits and grounds', async () => {
  const qid = questionId(QUESTION);
  const admittedExcerpts: string[] = [];
  const evaluatorPrompts: string[] = [];

  const gatherExecutor = async (
    intents: GatherIntent[],
    round: number,
    ctx: {
      state: ReturnType<typeof createAgentState>;
      questionIds?: Array<string | undefined>;
    },
  ): Promise<GatherOutcome> => {
    const outcome = emptyOutcome();
    for (let order = 0; order < intents.length; order += 1) {
      const intent = intents[order]!;
      if (intent.kind === 'github_search' && intent.scope === 'code') {
        outcome.perAction[order] = { route: 'github', degraded: false };
        outcome.searchesUsed += 1;
        outcome.queriesSearched.push('Acme Pro pricing config code');
        // Discovery only: snippet/path candidate, zero admitted evidence.
        outcome.candidates.push({
          kind: 'github-code',
          route: 'github',
          owner: 'acme',
          repo: 'pro',
          path: 'config/pricing.ts',
          ref: 'main',
          url: FILE_URL,
          title: 'pricing.ts',
          snippet: SNIPPET_TEASER,
        });
        continue;
      }
      if (intent.kind === 'github_search' && intent.scope === 'files') {
        // Follow-up compiled from candidate identity: exact path + owner/repo.
        assert.equal(intent.query, 'config/pricing.ts');
        assert.equal(intent.repoHint, 'acme/pro');
        outcome.perAction[order] = { route: 'github', degraded: false };
        outcome.searchesUsed += 1;
        outcome.queriesSearched.push('config/pricing.ts');
        const linked = ctx.questionIds?.[order] ?? qid;
        const admission = admitGithubContent(
          ctx.state,
          { content: FILE_BODY, canonicalUrl: FILE_URL },
          [linked],
          round,
        );
        outcome.admitted.push(...admission.evidence);
        admittedExcerpts.push(...admission.evidence.map((entry) => entry.excerpt));
        outcome.webContent.push({ url: FILE_URL, title: 'pricing.ts', body: FILE_BODY });
        continue;
      }
      outcome.perAction[order] = { route: 'github', degraded: false, skipped: 'unexpected_intent' };
    }
    return outcome;
  };

  let evalCalls = 0;
  const result = await runAdaptiveCore(QUESTION, {
    search: async () => [],
    fetchText: async () => '',
    planner: async () => ({
      questions: [
        {
          question: QUESTION,
          priority: 3,
          required: true,
          intent: { kind: 'github_search', scope: 'code', query: 'Acme Pro pricing config code', repoHint: 'acme/pro' },
        },
      ],
      scopeNotes: [],
    }),
    evaluator: async ({ prompt }: { prompt: string }) => {
      evalCalls += 1;
      evaluatorPrompts.push(prompt);
      if (evalCalls === 1) {
        // Round 1: candidate visible with typed fields, zero evidence IDs minted.
        assert.ok(prompt.includes(CANDIDATE_HEADER));
        assert.ok(prompt.includes('config/pricing.ts'));
        assert.deepEqual(promptEvidenceIds(prompt), [], 'no evidence ID minted for any candidate');
        // Compilation proof: the follow-up path+repo parse out of the candidate
        // line the evaluator actually saw — never a closed-over constant.
        const parsed = /\[github-code\]\s+(\S+)\s+(\S+)/.exec(prompt);
        assert.ok(parsed !== null, 'github-code candidate line visible to the evaluator');
        assert.equal(parsed![1]!, 'acme/pro');
        assert.equal(parsed![2]!, 'config/pricing.ts');
        return {
          questionUpdates: [],
          nextActions: [
            {
              questionId: qid,
              intent: { kind: 'github_search', scope: 'files', query: parsed![2]!, repoHint: parsed![1]! },
            },
          ],
          shouldContinue: true,
        };
      }
      const ids = promptEvidenceIds(prompt);
      assert.ok(ids.length > 0, 'file content admitted as evidence');
      return {
        questionUpdates: [{ questionId: qid, status: 'answered', evidenceIds: ids }],
        nextActions: [],
        shouldContinue: false,
      };
    },
    gatherExecutor: (intents, round, ctx) => gatherExecutor(intents, round, ctx),
    gatherProfile: 'balanced',
    budgets: { maxRounds: 3 },
  });

  assert.ok(validateAgentResult(result).ok, JSON.stringify(validateAgentResult(result).issues));
  assert.equal(evalCalls, 2);
  // File content became admitted evidence and grounded the question.
  assert.ok(admittedExcerpts.length > 0, 'files follow-up admitted evidence');
  assert.ok(
    admittedExcerpts.every((excerpt) => excerpt.includes('199 dollars')),
    'every admitted excerpt derives from retrieved file content',
  );
  assert.ok(
    admittedExcerpts.every((excerpt) => !excerpt.includes('TEASER')),
    'candidate snippet text never entered the ledger',
  );
  assert.ok(
    result.sources.some((source) => source.url === FILE_URL),
    'file source composed into the result',
  );
  assert.ok(
    result.claims.some((claim) => claim.text.includes('199')),
    `claims cover the file fact; got ${JSON.stringify(result.claims)}`,
  );
});

test('research-source routes to a web_fetch follow-up whose body admits and grounds', async () => {
  const PAPER_URL = 'https://example.com/paper-1';
  const PAPER_BODY =
    'Launch pricing effects paper: Acme Pro launch price is 199 dollars per month. ' +
    'Additional background context about the study methodology and survey design follows here for completeness and extra length.';
  const qid = questionId(QUESTION);
  const evaluatorPrompts: string[] = [];
  const fetchCalls: string[] = [];

  const tools = buildNativeGatherTools({
    search: async () => [],
    fetchText: async (url: string) => {
      fetchCalls.push(url);
      assert.equal(url, PAPER_URL);
      return PAPER_BODY;
    },
    callNative: async () => ({
      content: [{ type: 'text', text: '1 research result.' }],
      details: {
        query: 'Acme Pro launch pricing study',
        results: [{ title: 'Launch pricing effects', url: PAPER_URL, snippet: SNIPPET_TEASER, source: 'semantic_scholar' }],
      },
    }),
  });

  let evalCalls = 0;
  const result = await runAdaptiveCore(QUESTION, {
    search: async () => [],
    fetchText: async () => '',
    capabilitiesSnapshot: snapshotForJob({}),
    planner: async () => ({
      questions: [
        {
          question: QUESTION,
          priority: 3,
          required: true,
          intent: { kind: 'research_search', query: 'Acme Pro launch pricing study' },
        },
      ],
      scopeNotes: [],
    }),
    evaluator: async ({ prompt }: { prompt: string }) => {
      evalCalls += 1;
      evaluatorPrompts.push(prompt);
      if (evalCalls === 1) {
        // Round 1: research-source candidate visible with typed fields, zero evidence IDs minted.
        assert.ok(prompt.includes(CANDIDATE_HEADER));
        assert.ok(prompt.includes(PAPER_URL));
        assert.ok(prompt.includes('semantic_scholar'));
        assert.deepEqual(promptEvidenceIds(prompt), [], 'no evidence ID minted for any candidate');
        // Compilation proof: the follow-up url parses out of the candidate line
        // the evaluator actually saw — never a closed-over constant.
        const parsed = /\[research-source\][^\n]*?(https?:\/\/\S+)/.exec(prompt);
        assert.ok(parsed !== null, 'research-source candidate line visible to the evaluator');
        assert.equal(parsed![1]!, PAPER_URL);
        return {
          questionUpdates: [],
          nextActions: [{ questionId: qid, intent: { kind: 'web_fetch', url: parsed![1]! } }],
          shouldContinue: true,
        };
      }
      const ids = promptEvidenceIds(prompt);
      assert.ok(ids.length > 0, 'fetched paper body admitted as evidence');
      return {
        questionUpdates: [{ questionId: qid, status: 'answered', evidenceIds: ids }],
        nextActions: [],
        shouldContinue: false,
      };
    },
    gatherExecutor: (intents, round, ctx) => runGatherExecutor(intents, round, { ...ctx, tools }),
    gatherProfile: 'balanced',
    budgets: { maxRounds: 3 },
  });

  assert.ok(validateAgentResult(result).ok, JSON.stringify(validateAgentResult(result).issues));
  assert.equal(evalCalls, 2);
  assert.deepEqual(fetchCalls, [PAPER_URL], 'round 2 dispatched exactly one web_fetch read');
  assert.ok(
    result.sources.some((source) => source.url === PAPER_URL),
    'paper source composed into the result',
  );
  assert.ok(
    result.claims.some((claim) => claim.text.includes('199')),
    `claims cover the paper fact; got ${JSON.stringify(result.claims)}`,
  );
  assert.ok(
    !evaluatorPrompts[1]!.includes('TEASER'),
    'candidate snippet text never entered the ledger',
  );
});
