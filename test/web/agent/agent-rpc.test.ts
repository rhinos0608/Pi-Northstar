import assert from 'node:assert/strict';
import { test } from 'node:test';
import { negotiateAgentRpc } from '../../../src/web/agent/agent-rpc.js';
import { runAgentCore } from '../../../src/web/agent/agent-core.js';

test('no-RPC path records negotiated:false and runs standalone', async () => {
  const record = negotiateAgentRpc();
  assert.equal(record.attempted, true);
  assert.equal(record.negotiated, false);
  assert.equal(record.transport, 'standalone');
  assert.ok(record.reason.length > 0);
  const shaped = negotiateAgentRpc({ endpoint: 'bogus://shape' });
  assert.equal(shaped.negotiated, false);
  assert.equal(shaped.attempted, true);
  // Standalone execution needs no RPC: core completes on injected legs.
  const result = await runAgentCore('standalone probe', {
    search: async () => [{ title: 'S', url: 'https://example.com/s', snippet: 'words' }],
    fetchText: async () => 'words about the probe topic',
    report: async () => { throw new Error('no transport'); },
  });
  assert.equal(result.query, 'standalone probe');
  assert.ok(result.warnings.some((warning) => /local evidence only/.test(warning)));
});
