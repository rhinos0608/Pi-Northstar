import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AGENT_JOB_TTL_MS,
  AGENT_LOCAL_MAX_SOURCES,
  AGENT_MAX_FETCH_ROUNDS,
  AGENT_MAX_SOURCES,
  AGENT_REPORT_MAX_BYTES,
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
  assert.equal(AGENT_JOB_TTL_MS, 3_600_000);
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
