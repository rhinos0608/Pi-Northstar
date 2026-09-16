// Wave 1 contract tests: native-envelope → adapter → admission.
//
// Every envelope below copies the REAL native contract shapes (not fake
// top-level arrays):
// - research: details.results rows (src/native-tools.ts:154-159)
// - github: details.entities GithubEntityV1 rows (src/github/github-domain.ts:1562-1571)
// - kg: details.knowledge KgResult envelope (src/native-tools.ts:421,
//   src/knowledge/knowledge-contract.ts:38-45)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  adaptGithubResult,
  adaptKgResult,
  adaptResearchResult,
  isAdaptedGatherPayload,
} from '../../../src/web/agent/agent-gather-adapters.js';
import { buildNativeGatherTools, gatherExecutor } from '../../../src/web/agent/agent-gather.js';
import { snapshotForJob } from '../../../src/web/agent/agent-capabilities.js';
import { createAgentState } from '../../../src/web/agent/agent-state.js';
import { buildKnowledgeResult } from '../../../src/knowledge/knowledge-contract.js';
import type { BackendCallResult } from '../../../src/backend.js';

// ── REAL-shaped native envelopes ──

function researchEnvelope(): BackendCallResult {
  return {
    content: [{ type: 'text', text: '2 research result(s) from semantic_scholar.' }],
    details: {
      query: 'Acme Pro launch price academic studies',
      source: 'semantic_scholar',
      results: [
        {
          title: 'Launch pricing effects in consumer hardware',
          url: 'https://example.com/paper-pricing',
          snippet: 'Study snippet describing launch price effects with measured words here.',
          source: 'semantic_scholar',
          // Genuine upstream abstract (D5 provenance).
          abstract:
            'Genuine abstract text showing the launch price effect with measured survey words and conclusions drawn here fully.',
        },
        {
          title: 'Community thread on launch day chatter',
          url: 'https://example.com/hn-thread',
          snippet: 'Discussion snippet without any upstream abstract attached here.',
          source: 'hackernews',
          // No abstract: structurally candidate-only (correct per D5).
        },
      ],
    },
  };
}

function githubEnvelope(): BackendCallResult {
  const filler = ' Additional background context about the pricing config and release notes follows here for completeness and extra length.';
  return {
    content: [{ type: 'text', text: 'github search: 4 entit(ies).' }],
    details: {
      action: 'search',
      canonicalAction: 'search',
      backend: 'github-api',
      entities: [
        {
          version: 1,
          kind: 'file',
          id: 'acme/pro:main:config/pricing.ts',
          backend: 'github-api',
          path: 'config/pricing.ts',
          url: 'https://github.com/acme/pro/blob/main/config/pricing.ts',
          content: `Repository file content describing the pricing config with many words and negatives here for length. ${filler}`,
        },
        {
          version: 1,
          kind: 'issue',
          id: 'acme/pro#42',
          backend: 'github-api',
          number: 42,
          title: 'Launch price discussion',
          state: 'open',
          url: 'https://github.com/acme/pro/issues/42',
          body: `Issue body text describing the launch price debate with many words and details here for length. ${filler}`,
        },
        {
          version: 1,
          kind: 'repo',
          id: 'acme/pro',
          backend: 'github-api',
          url: 'https://github.com/acme/pro',
          name: 'pro',
          full_name: 'acme/pro',
          description: 'Repo description snippet without retrieved file content here.',
        },
        {
          version: 1,
          kind: 'search_result',
          id: 'acme/pro:config/pricing.ts',
          backend: 'github-api',
          url: 'https://github.com/acme/pro/blob/main/config/pricing.ts',
          path: 'config/pricing.ts',
          repository: 'acme/pro',
          title: 'pricing.ts',
          snippet: 'Code search snippet showing a price constant without full file content.',
        },
      ],
      pagination: { supported: false, limit: 10, hasMore: false },
      partial: false,
      warnings: [],
    },
  };
}

function kgEnvelope(): BackendCallResult {
  const knowledge = buildKnowledgeResult({
    request: { tool: 'kg', action: 'search' },
    outcomes: [
      {
        provider: 'diffbot',
        entities: [
          { entityVersion: 1, id: 'kg-acme-pro', type: 'Organization', name: 'Acme Pro', url: 'https://example.com/acme' },
          { entityVersion: 1, id: 'kg-acme-founding', type: 'Organization', name: 'Acme Founding Team' },
        ],
      },
    ],
  });
  return {
    content: [{ type: 'text', text: 'kg search: 2 entit(ies).' }],
    details: {
      action: 'search',
      query: 'type:Organization Acme Pro',
      providers: ['diffbot'],
      knowledge,
    },
  };
}

// ── Adapter unit contracts ──

test('research adapter: genuine-abstract rows yield evidence, abstract-less rows stay candidate-only', () => {
  const adapted = adaptResearchResult(researchEnvelope());
  assert.ok(isAdaptedGatherPayload(adapted));
  assert.equal(adapted.candidates.length, 2);
  assert.equal(adapted.evidenceInputs.length, 1);
  assert.ok((adapted.evidenceInputs[0]!['abstract'] as string).includes('Genuine abstract text'));
  // Abstract never backfilled from snippet.
  for (const input of adapted.evidenceInputs) {
    assert.notEqual(input['abstract'], input['snippet']);
  }
});

test('github adapter: content+url and body+url rows admit, repo/code snippets stay candidates', () => {
  const adapted = adaptGithubResult(githubEnvelope());
  assert.ok(isAdaptedGatherPayload(adapted));
  assert.equal(adapted.candidates.length, 4);
  assert.equal(adapted.evidenceInputs.length, 2);
  const keys = adapted.evidenceInputs.map((row) => ('content' in row ? 'content' : 'body'));
  assert.deepEqual(keys.sort(), ['body', 'content']);
});

test('kg adapter: search entities produce candidates and zero fabricated evidence', () => {
  const adapted = adaptKgResult(kgEnvelope());
  assert.ok(isAdaptedGatherPayload(adapted));
  assert.equal(adapted.candidates.length, 2);
  assert.deepEqual(adapted.evidenceInputs, []);
  assert.ok(adapted.candidates.every((candidate) => candidate.title !== undefined));
});

test('github adapter: present-but-empty entities is a truthful zero-result empty, missing list is unexpected', () => {
  // Production zero-result shape: github-domain.ts always sets
  // legacyDetails.entities ([] when no rows match).
  const zero = adaptGithubResult({ content: [], details: { action: 'search', entities: [] } });
  assert.ok(isAdaptedGatherPayload(zero));
  assert.deepEqual(zero.candidates, []);
  assert.deepEqual(zero.evidenceInputs, []);
  assert.ok(zero.warnings.some((warning) => warning.includes('zero entities returned')), JSON.stringify(zero.warnings));
  const missing = adaptGithubResult({ content: [], details: { action: 'search' } });
  assert.ok(missing.warnings.some((warning) => warning.includes('unexpected native payload')), JSON.stringify(missing.warnings));
});

test('github adapter: canonical-envelope entities fall back like the research adapter', () => {
  const viaEnvelope = adaptGithubResult({
    content: [],
    details: { action: 'search', northstar: { data: { entities: [{ kind: 'repo', url: 'https://example.com/acme/pro' }] } } },
  });
  assert.ok(isAdaptedGatherPayload(viaEnvelope));
  assert.ok(viaEnvelope.candidates.length >= 1, 'envelope entities surface as candidates, not bounded-empty');
});

test('adapters: unexpected native payloads yield bounded empty results, never throw', () => {
  for (const adapt of [adaptResearchResult, adaptGithubResult, adaptKgResult]) {
    for (const bad of [undefined, null, {}, { details: {} }, { details: { results: 'nope' } }]) {
      const adapted = adapt(bad);
      assert.ok(isAdaptedGatherPayload(adapted));
      assert.deepEqual(adapted.candidates, []);
      assert.deepEqual(adapted.evidenceInputs, []);
      assert.ok(adapted.warnings.length >= 1);
    }
  }
});

// ── End-to-end: adapted envelopes through the real admission gates ──

function executorCtx(callNative: (name: string, args: Record<string, unknown>) => Promise<BackendCallResult>) {
  return {
    snapshot: snapshotForJob({}),
    state: createAgentState({ goal: 'What is the launch price of Acme Pro?' }),
    counters: { searchesUsed: 0, fetchesUsed: 0 },
    tools: buildNativeGatherTools({
      search: async () => [],
      fetchText: async () => '',
      callNative,
    }),
  };
}

test('wired research tool: abstract row admits evidence, abstract-less row stays candidate', async () => {
  const ctx = executorCtx(async () => researchEnvelope());
  const outcome = await gatherExecutor(
    [{ kind: 'research_search', query: 'Acme Pro pricing academic studies' }],
    1,
    ctx,
  );
  assert.equal(outcome.admitted.length, 1);
  assert.equal(outcome.admitted[0]!.sourceRef.acquisitionRoute, 'research');
  assert.equal(outcome.candidates.length, 2);
  assert.deepEqual(outcome.warnings, []);
});

test('wired github tool: file + issue admit, repo + code snippet stay candidates', async () => {
  const ctx = executorCtx(async () => githubEnvelope());
  const outcome = await gatherExecutor(
    [{ kind: 'github_search', scope: 'files', query: 'config/pricing.ts', repoHint: 'acme/pro' }],
    1,
    ctx,
  );
  assert.equal(outcome.admitted.length, 2);
  assert.ok(outcome.admitted.every((entry) => entry.sourceRef.acquisitionRoute === 'github'));
  assert.equal(outcome.candidates.length, 4);
});

test('wired kg tool: search entities surface as candidates with no fabricated evidence', async () => {
  const snapshot = snapshotForJob({ DIFFBOT_TOKEN: 'token' });
  const ctx = { ...executorCtx(async () => kgEnvelope()), snapshot };
  const outcome = await gatherExecutor([{ kind: 'kg_lookup', entityType: 'Organization', name: 'Acme Pro' }], 1, ctx);
  assert.equal(outcome.admitted.length, 0);
  assert.equal(outcome.candidates.length, 2);
  assert.ok(outcome.candidates.every((entry) => entry.route === 'kg'));
});

test('wired tools: native exception surfaces as failed gather, never kills the round', async () => {
  const ctx = executorCtx(async () => {
    throw new Error('backend down');
  });
  const outcome = await gatherExecutor(
    [{ kind: 'research_search', query: 'Acme Pro pricing academic studies' }],
    1,
    ctx,
  );
  assert.equal(outcome.admitted.length, 0);
  assert.ok(outcome.warnings.some((warning) => warning.includes('research gather failed; action skipped')));
  assert.ok(!outcome.warnings.some((warning) => warning.includes('unexpected native payload')));
  assert.deepEqual(outcome.queriesSearched, []);
});

function kgEnhanceEnvelope(): BackendCallResult {
  // Real-shaped native enhance envelope (src/native-tools.ts:498-501):
  // claims carry post-alignment public group ids as subjectId.
  const entity = { entityVersion: 1 as const, id: 'kg-acme-pro', type: 'Organization', name: 'Acme Pro', url: 'https://example.com/acme' };
  const knowledge = buildKnowledgeResult({
    request: { tool: 'kg', action: 'enhance', providers: ['diffbot'] },
    outcomes: [{ provider: 'diffbot', entities: [entity] }],
    data: {
      kind: 'enhance',
      entities: [entity],
      claims: [
        { subjectId: 'alignment:1', predicate: 'ceo', object: 'Acme Pro chief executive is Jane Doe, appointed 2023.' },
        { subjectId: 'alignment:1', predicate: 'employeeCount', object: 'Acme Pro employs about 400 people worldwide.' },
        // Claim without an object carries no admittable value — skipped.
        { subjectId: 'alignment:1', predicate: 'founder' },
      ],
      conflicts: [],
      partitions: [{ provider: 'diffbot', status: 'ok' }],
      groups: [
        { id: 'alignment:1', basis: 'canonical_url', strength: 'exact', members: [{ entity, provider: 'diffbot' }] },
      ],
      evidence: [{ entityId: 'kg-acme-pro', evidence: { status: 'provided' } }],
    },
  });
  return {
    content: [{ type: 'text', text: 'kg enhance: 1 entit(y|ies).' }],
    details: {
      action: 'enhance',
      providers: ['diffbot'],
      knowledge,
    },
  };
}

test('kg adapter: enhance claims map to claim rows, identity fields to secondary rows', () => {
  const adapted = adaptKgResult(kgEnhanceEnvelope());
  assert.ok(isAdaptedGatherPayload(adapted));
  assert.equal(adapted.candidates.length, 1);
  const rows = adapted.evidenceInputs.map((row) => ({
    nodeId: row['nodeId'],
    field: row['field'],
    value: row['value'],
  }));
  // Primary: one row per valued claim, keyed by post-alignment group id.
  assert.ok(rows.some((row) => row.nodeId === 'alignment:1' && row.field === 'ceo' && typeof row.value === 'string' && (row.value as string).includes('Jane Doe')));
  assert.ok(rows.some((row) => row.nodeId === 'alignment:1' && row.field === 'employeeCount'));
  // Object-less claim produces no row.
  assert.ok(!rows.some((row) => row.field === 'founder'));
  // Secondary: entity identity fields only (name/url), never invented fields.
  assert.ok(rows.some((row) => row.nodeId === 'kg-acme-pro' && row.field === 'name' && row.value === 'Acme Pro'));
  assert.ok(rows.some((row) => row.nodeId === 'kg-acme-pro' && row.field === 'url' && row.value === 'https://example.com/acme'));
  for (const row of rows) {
    assert.ok(typeof row.nodeId === 'string' && typeof row.field === 'string' && typeof row.value === 'string');
  }
});

test('wired kg tool: enhance envelope admits claim evidence with nodeId+field locators', async () => {
  const snapshot = snapshotForJob({ DIFFBOT_TOKEN: 'token' });
  const ctx = { ...executorCtx(async () => kgEnhanceEnvelope()), snapshot };
  const outcome = await gatherExecutor([{ kind: 'kg_lookup', entityType: 'Organization', name: 'Acme Pro' }], 1, ctx);
  assert.ok(outcome.admitted.length >= 2, `expected claim evidence, got ${outcome.admitted.length}`);
  assert.ok(outcome.admitted.every((entry) => entry.sourceRef.acquisitionRoute === 'kg'));
  const ceo = outcome.admitted.find((entry) => entry.excerpt.includes('Jane Doe'));
  assert.ok(ceo !== undefined);
  assert.deepEqual((ceo!.locator as { nodeId: string; field: string }).nodeId, 'alignment:1');
  assert.deepEqual((ceo!.locator as { nodeId: string; field: string }).field, 'ceo');
  assert.equal(outcome.candidates.length, 1);
});

test('research adapter: present-but-empty results is a truthful zero-result empty, missing list is unexpected', () => {
  const zero = adaptResearchResult({ content: [], details: { query: 'Acme Pro pricing', results: [] } });
  assert.ok(isAdaptedGatherPayload(zero));
  assert.deepEqual(zero.candidates, []);
  assert.deepEqual(zero.evidenceInputs, []);
  assert.ok(zero.warnings.some((warning) => warning.includes('zero results returned')), JSON.stringify(zero.warnings));
  const missing = adaptResearchResult({ content: [], details: { query: 'Acme Pro pricing' } });
  assert.ok(missing.warnings.some((warning) => warning.includes('unexpected native payload')), JSON.stringify(missing.warnings));
});

test('kg adapter: valid empty search envelope is a truthful zero-result empty, missing envelope is unexpected', () => {
  const zero = adaptKgResult({ content: [], details: { knowledge: { data: { kind: 'search', entities: [] } } } });
  assert.ok(isAdaptedGatherPayload(zero));
  assert.deepEqual(zero.candidates, []);
  assert.deepEqual(zero.evidenceInputs, []);
  assert.ok(zero.warnings.some((warning) => warning.includes('zero entities returned')), JSON.stringify(zero.warnings));
  const missing = adaptKgResult({ content: [], details: { action: 'search' } });
  assert.ok(missing.warnings.some((warning) => warning.includes('unexpected native payload')), JSON.stringify(missing.warnings));
});
