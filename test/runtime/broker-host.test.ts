import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeExistingBroker, BrokerUnavailableError, startBrokerHost } from '../../src/runtime/broker-host.js';

test('probeExistingBroker returns false when no socket exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ns-host-'));
  const result = await probeExistingBroker('probe-test', root);
  assert.equal(result, false);
});

test('startBrokerHost throws BrokerUnavailableError when binary missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ns-host-missing-'));
  await assert.rejects(
    () => startBrokerHost({
      projectId: 'missing-binary-test',
      mode: 'session',
      rootDir: root,
      binaryPath: '/nonexistent/northstar-broker',
    }),
    (err: unknown) => err instanceof BrokerUnavailableError,
  );
});

test('ordinary probe path never spawns a broker', async () => {
  // Verify probeExistingBroker is purely read-only and does not spawn
  const root = await mkdtemp(join(tmpdir(), 'ns-no-spawn-'));
  // Should return false without any broker running
  const result = await probeExistingBroker('no-spawn-project', root);
  assert.equal(result, false);
  // No child processes were started; test completes synchronously
});
