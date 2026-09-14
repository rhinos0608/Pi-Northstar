import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getLeafRuntimeProvider, negotiateAgentRpc, setLeafRuntimeProvider, shutdownLeafRuntime } from '../../../src/web/agent/agent-rpc.js';
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
  assert.equal(shaped.transport, 'standalone');
  // Static reason: caller-supplied endpoint content never flows into snapshots.
  assert.equal(shaped.reason, 'unrecognized RPC endpoint shape; core runs standalone');
  assert.ok(!shaped.reason.includes('bogus'));
  // Standalone execution needs no RPC: core completes on injected legs.
  const result = await runAgentCore('standalone probe', {
    search: async () => [{ title: 'S', url: 'https://example.com/s', snippet: 'words' }],
    fetchText: async () => 'words about the probe topic',
    report: async () => { throw new Error('no transport'); },
  });
  assert.equal(result.query, 'standalone probe');
  assert.ok(result.warnings.some((warning) => /local evidence only/.test(warning)));
});

test('shutdown clears the seam even when dispose throws', () => {
  try {
    const provider = { refreshReady: async () => true, runLeaf: async () => ({ text: 'x' }) };
    setLeafRuntimeProvider(provider);
    assert.equal(getLeafRuntimeProvider(), provider);
    shutdownLeafRuntime({ dispose: () => { throw new Error('dispose boom'); } });
    assert.equal(getLeafRuntimeProvider(), undefined);
    // No-client shutdown also clears.
    setLeafRuntimeProvider(provider);
    shutdownLeafRuntime(undefined);
    assert.equal(getLeafRuntimeProvider(), undefined);
  } finally {
    setLeafRuntimeProvider(undefined);
  }
});
test('leaf provider seam registers and clears', () => {
  try {
    assert.equal(getLeafRuntimeProvider(), undefined);
    const provider = { refreshReady: async () => true, runLeaf: async () => ({ text: 'x' }) };
    setLeafRuntimeProvider(provider);
    assert.equal(getLeafRuntimeProvider(), provider);
  } finally {
    setLeafRuntimeProvider(undefined);
  }
  assert.equal(getLeafRuntimeProvider(), undefined);
});
