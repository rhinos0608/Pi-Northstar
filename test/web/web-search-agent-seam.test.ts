import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSearchRoute } from '../../src/web/web-search-route.js';
import { __setAgentJobCreator, createAgentJob } from '../../src/web/agent/agent-job-seam.js';
import { __resetAgentJobs } from '../../src/web/agent/agent-jobs.js';

test('web_search rejects removed agent fields', () => { assert.throws(() => buildSearchRoute({ query: 'q', mode: 'agent' } as Record<string, unknown>), /no longer supports agent mode or depth/); assert.throws(() => buildSearchRoute({ query: 'q', depth: 'deep' } as Record<string, unknown>), /no longer supports agent mode or depth/); });

test('ordinary web_search routes are unchanged', () => { const single = buildSearchRoute({ query: 'plain topic' }); assert.equal(single.tool, 'web_search'); assert.equal(single.timeout, 120_000); const research = buildSearchRoute({ query: 'papers', category: 'research' }); assert.equal(research.tool, 'research'); });

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
