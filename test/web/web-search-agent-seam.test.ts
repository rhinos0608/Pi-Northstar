import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSearchRoute } from '../../src/web/web-search-route.js';
import { __setAgentJobCreator, createAgentJob } from '../../src/web/agent/agent-job-seam.js';
import { __resetAgentJobs } from '../../src/web/agent/agent-jobs.js';
import { DEFAULT_WEB_AGENT_TIMEOUT_MS } from '../../src/web/web-agent-report.js';

test('agent mode returns a job-pointer route, never an inline report', () => {
  __setAgentJobCreator(() => ({ jobId: 'job-seam-1' }));
  try {
    const route = buildSearchRoute({ query: 'deep topic', mode: 'agent' });
    assert.equal(route.tool, 'agent_job');
    assert.deepEqual(route.args, { jobId: 'job-seam-1' });
    assert.equal(route.timeout, DEFAULT_WEB_AGENT_TIMEOUT_MS);
  } finally {
    __setAgentJobCreator(undefined);
  }
});

test('agent mode still rejects research category and knowledge', () => {
  assert.throws(() => buildSearchRoute({ query: 'q', mode: 'agent', category: 'research' }), /not supported with category/);
  assert.throws(() => buildSearchRoute({ query: 'q', mode: 'agent', knowledge: { entities: true } }), /not supported with mode/);
});

test('non-agent paths untouched by the seam', () => {
  const single = buildSearchRoute({ query: 'plain topic' });
  assert.equal(single.tool, 'web_search');
  assert.equal(single.timeout, 120_000);
  const batch = buildSearchRoute({ queries: ['a', 'b'] });
  assert.equal(batch.tool, 'web_search');
  const research = buildSearchRoute({ query: 'papers', category: 'research' });
  assert.equal(research.tool, 'research');
});

test('agent mode forwards depth to the seam; absent means balanced default', () => {
  const seen: Array<Record<string, unknown>> = [];
  __setAgentJobCreator((params) => {
    seen.push({ ...params });
    return { jobId: 'job-depth-1' };
  });
  try {
    buildSearchRoute({ query: 'deep topic', mode: 'agent', depth: 'deep' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.query, 'deep topic');
    assert.equal(seen[0]!.depth, 'deep');
    buildSearchRoute({ query: 'plain topic', mode: 'agent' });
    assert.equal(seen.length, 2);
    assert.equal(seen[1]!.depth, 'balanced');
  } finally {
    __setAgentJobCreator(undefined);
  }
});

test('agent mode rejects unknown depth; depth is not in the constraint rejection list', () => {
  // Unknown depth rejects (contract validation, static reason, no value echo).
  assert.throws(
    () => buildSearchRoute({ query: 'q', mode: 'agent', depth: 'ultra' } as Record<string, unknown>),
    /depth must be/, // contract static reason; must not echo 'ultra'
  );
  try {
    buildSearchRoute({ query: 'q', mode: 'agent', depth: 'ultra' } as Record<string, unknown>);
    assert.fail('unknown depth must throw');
  } catch (error) {
    assert.ok(!(error as Error).message.includes('ultra'), 'rejection must not echo the value');
  }
  // Depth with non-agent mode fails closed (never silently ignored).
  assert.throws(
    () => buildSearchRoute({ query: 'q', depth: 'deep' } as Record<string, unknown>),
    /depth is only supported with mode/,
  );
  // Supported end-to-end: depth passes the five-field agent rejection list.
  __setAgentJobCreator(() => ({ jobId: 'job-depth-2' }));
  try {
    const route = buildSearchRoute({ query: 'q', mode: 'agent', depth: 'deep' });
    assert.equal(route.tool, 'agent_job');
  } finally {
    __setAgentJobCreator(undefined);
  }
});

test('seam creators forward depth: custom seam observes it, default path validates it', () => {
  // Custom creator (test seam) receives depth untouched.
  let observed: unknown;
  __setAgentJobCreator((params) => {
    observed = params.depth;
    return { jobId: 'job-depth-3' };
  });
  try {
    createAgentJob({ query: 'seam probe', depth: 'deep' });
    assert.equal(observed, 'deep');
    createAgentJob({ query: 'seam probe' });
    assert.equal(observed, undefined);
  } finally {
    __setAgentJobCreator(undefined);
  }
  // Default creator (registry path) forwards depth to entry validation:
  // invalid rejects (RangeError, no registration), valid registers.
  __resetAgentJobs();
  try {
    assert.throws(
      () => createAgentJob({ query: 'seam probe', depth: 'ultra' as unknown as never }),
      /depth must be/,
    );
    const pointer = createAgentJob({ query: 'seam probe', depth: 'deep' });
    assert.ok(typeof pointer.jobId === 'string' && pointer.jobId !== '');
  } finally {
    __resetAgentJobs();
  }
});
