import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getLeafRuntimeProvider, negotiateAgentRpc, setLeafRuntimeProvider, shutdownLeafRuntime } from '../../../src/web/agent/agent-rpc.js';
import { runAgentCore } from '../../../src/web/agent/agent-core.js';
import { validateAgentResult } from '../../../src/web/agent/agent-contract.js';

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
    fetchText: async () =>
      'words about the probe topic with plenty of detail here for the passage. Additional background context about the product lineup and release notes follows here for completeness and extra length.',
  });
  assert.equal(result.query, 'standalone probe');
  assert.ok(validateAgentResult(result).ok, JSON.stringify(validateAgentResult(result).issues));
  assert.ok(result.sources.length > 0, 'evidence-only floor composes sources from the admitted ledger');
  assert.ok(result.warnings.some((warning) => /^round 1:/.test(warning)), 'adaptive loop ran');
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
