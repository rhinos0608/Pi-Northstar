import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AGENT_CLAIM_MAX_BYTES,
  AGENT_JOB_TTL_MS,
  AGENT_LOCAL_MAX_SOURCES,
  AGENT_MAX_FETCH_ROUNDS,
  AGENT_MAX_SOURCES,
  AGENT_POLL_VISIBILITY_TTL_MS,
  AGENT_REPORT_MAX_BYTES,
  AGENT_RESULT_RETENTION_TTL_MS,
  AGENT_RUN_DEADLINE_MAX_MS,
  AGENT_RUN_DEADLINE_MS,
  AGENT_WARNING_MAX_BYTES,
  canonicalJson,
  validateAgentResult,
} from '../../../src/web/agent/agent-contract.js';

function validResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    query: 'q',
    reportText: 'Findings here.',
    claims: [{ text: 'Findings here.', sourceIds: ['src-0'] }],
    sources: [{ id: 'src-0', url: 'https://example.com/a', title: 'A', sourceKind: 'extracted' }],
    warnings: [],
    ...overrides,
  };
}

test('evidence budgets are single-sourced proposed defaults', () => {
  assert.equal(AGENT_REPORT_MAX_BYTES, 50_000);
  assert.equal(AGENT_MAX_SOURCES, 20);
  assert.equal(AGENT_LOCAL_MAX_SOURCES, 30);
  assert.equal(AGENT_MAX_FETCH_ROUNDS, 8);
});

test('lifecycle split is single-sourced: AGENT_JOB_TTL_MS derives as the max', () => {
  assert.equal(AGENT_RUN_DEADLINE_MS, 30 * 60 * 1000);
  assert.equal(AGENT_RUN_DEADLINE_MAX_MS, 2 * 60 * 60 * 1000);
  assert.equal(AGENT_RESULT_RETENTION_TTL_MS, 24 * 60 * 60 * 1000);
  assert.equal(AGENT_POLL_VISIBILITY_TTL_MS, 5 * 60 * 1000);
  assert.equal(
    AGENT_JOB_TTL_MS,
    Math.max(AGENT_RUN_DEADLINE_MS, AGENT_RESULT_RETENTION_TTL_MS, AGENT_POLL_VISIBILITY_TTL_MS),
  );
});

test('canonical JSON is byte-stable under key reorder', () => {
  const a = canonicalJson({ z: 1, a: { d: [3, 2], b: 'x' } });
  const b = canonicalJson({ a: { b: 'x', d: [3, 2] }, z: 1 });
  assert.equal(a, b);
  assert.deepEqual(JSON.parse(a), { z: 1, a: { d: [3, 2], b: 'x' } });
});

test('citation contract: every claim cites a known sourceId', () => {
  assert.equal(validateAgentResult(validResult()).ok, true);
  const noCite = validateAgentResult(validResult({ claims: [{ text: 'x', sourceIds: [] }] }));
  assert.equal(noCite.ok, false);
  assert.ok(noCite.issues.some((issue) => /at least one sourceId/.test(issue)));
  const dangling = validateAgentResult(validResult({ claims: [{ text: 'x', sourceIds: ['nope'] }] }));
  assert.equal(dangling.ok, false);
  assert.ok(dangling.issues.some((issue) => /unknown sourceId/.test(issue)));
});

test('document contract: sources carry sourceKind; budgets reject', () => {
  const noKind = validateAgentResult(validResult({
    sources: [{ id: 'src-0', url: 'https://example.com/a', title: 'A' }],
  }));
  assert.equal(noKind.ok, false);
  assert.ok(noKind.issues.some((issue) => /sourceKind/.test(issue)));
  const badUrl = validateAgentResult(validResult({
    sources: [{ id: 'src-0', url: '/etc/passwd', title: 'A', sourceKind: 'derived' }],
  }));
  assert.equal(badUrl.ok, false);
  const tooMany = validateAgentResult(validResult({
    sources: Array.from({ length: 21 }, (_, i) => ({ id: `s-${i}`, url: `https://example.com/${i}`, title: 'T', sourceKind: 'extracted' })),
    claims: [{ text: 'x', sourceIds: ['s-0'] }],
  }));
  assert.equal(tooMany.ok, false);
  assert.ok(tooMany.issues.some((issue) => /sources exceed/.test(issue)));
  const big = validateAgentResult(validResult({ reportText: 'é'.repeat(50_001) }));
  assert.equal(big.ok, false);
  assert.ok(big.issues.some((issue) => /bytes \(UTF-8\)/.test(issue)));
});

test('derived locator rejects empty, unknown, and unbounded fields', () => {
  const derived = (locator: unknown) => validateAgentResult(validResult({
    sources: [{ id: 'src-0', url: 'https://example.com/a', title: 'A', sourceKind: 'derived', locator, warnings: ['t'] }],
  }));
  const empty = derived({});
  assert.equal(empty.ok, false);
  assert.ok(empty.issues.some((issue) => /at least one of page, timestamp, location/.test(issue)));
  const unknown = derived({ page: 1, chapter: 3 });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.issues.some((issue) => /unknown field "chapter"/.test(issue)));
  for (const bad of [{ page: -1 }, { page: 1.5 }, { page: '2' }, { timestamp: '' }, { location: '   ' }]) {
    const rejected = derived(bad);
    assert.equal(rejected.ok, false, JSON.stringify(bad));
  }
  for (const good of [{ page: 0 }, { page: 2 }, { timestamp: '00:01:00' }, { location: 'sec 3' }]) {
    const accepted = derived(good);
    assert.equal(accepted.ok, true, JSON.stringify(accepted.issues));
  }
});

test('derived warnings must be non-empty and byte-bounded', () => {
  const derived = (warnings: unknown) => validateAgentResult(validResult({
    sources: [{ id: 'src-0', url: 'https://example.com/a', title: 'A', sourceKind: 'derived', locator: { page: 1 }, warnings }],
  }));
  const empty = derived([]);
  assert.equal(empty.ok, false);
  assert.ok(empty.issues.some((issue) => /warnings must be an array of strings for derived sources/.test(issue)));
  const blank = derived(['  ']);
  assert.equal(blank.ok, false);
  const big = derived(['x'.repeat(AGENT_WARNING_MAX_BYTES + 1)]);
  assert.equal(big.ok, false);
  assert.ok(big.issues.some((issue) => /bytes \(UTF-8\)/.test(issue)));
});

test('extracted sources validate present locator/warnings and reject unknown fields', () => {
  const extracted = (extra: Record<string, unknown>) => validateAgentResult(validResult({
    sources: [{ id: 'src-0', url: 'https://example.com/a', title: 'A', sourceKind: 'extracted', ...extra }],
  }));
  assert.equal(extracted({}).ok, true);
  assert.equal(extracted({ locator: { page: 1 }, warnings: ['t'] }).ok, true);
  assert.equal(extracted({ locator: {} }).ok, false, 'present-but-empty locator validates, not passes');
  assert.equal(extracted({ warnings: [] }).ok, false, 'present-but-empty warnings validate, not pass');
  const unknown = extracted({ backend: 'tavily' });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.issues.some((issue) => /unknown field "backend"/.test(issue)));
});

test('claim text and top-level warnings enforce UTF-8 byte ceilings', () => {
  const bigClaim = validateAgentResult(validResult({
    claims: [{ text: 'é'.repeat(AGENT_CLAIM_MAX_BYTES), sourceIds: ['src-0'] }],
  }));
  assert.equal(bigClaim.ok, false);
  assert.ok(bigClaim.issues.some((issue) => /claims\[0\]\.text exceeds maximum/.test(issue)));
  const bigWarning = validateAgentResult(validResult({
    warnings: ['x'.repeat(AGENT_WARNING_MAX_BYTES + 1)],
  }));
  assert.equal(bigWarning.ok, false);
  assert.ok(bigWarning.issues.some((issue) => /warnings\[0\] exceeds maximum/.test(issue)));
  assert.equal(validResult.name, 'validResult');
});

test('duplicate source ids reject instead of merging silently', () => {
  const duped = validateAgentResult(validResult({
    sources: [
      { id: 'src-0', url: 'https://example.com/a', title: 'A', sourceKind: 'extracted' },
      { id: 'src-0', url: 'https://example.com/b', title: 'B', sourceKind: 'extracted' },
    ],
  }));
  assert.equal(duped.ok, false);
  assert.ok(duped.issues.some((issue) => /duplicate/.test(issue)));
});

test('derived sources require locator + warnings; extracted keeps them optional', () => {
  const bare = validateAgentResult(validResult({
    sources: [{ id: 'src-0', url: 'https://example.com/a', title: 'A', sourceKind: 'derived' }],
  }));
  assert.equal(bare.ok, false);
  assert.ok(bare.issues.some((issue) => /locator is required for derived/.test(issue)));
  assert.ok(bare.issues.some((issue) => /warnings must be an array of strings for derived/.test(issue)));
  const full = validateAgentResult(validResult({
    sources: [{
      id: 'src-0',
      url: 'https://example.com/a',
      title: 'A',
      sourceKind: 'derived',
      locator: { page: 2 },
      warnings: ['truncated'],
    }],
  }));
  assert.equal(full.ok, true, JSON.stringify(full.issues));
});
