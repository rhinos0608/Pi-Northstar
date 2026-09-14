import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSearchRoute } from '../../src/web/web-search-route.js';
import { __setAgentJobCreator } from '../../src/web/agent/agent-job-seam.js';
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
