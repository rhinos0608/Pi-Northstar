import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, createServer, type Socket } from 'node:net';
import { BrokerStateStore, queryJobSubmission } from '../../src/runtime/broker-state-store.js';
import { encodeBrokerFrame, decodeBrokerFrame, isBrokerQuery } from '../../src/runtime/broker-protocol.js';
import { readBrokerFrames } from '../../src/runtime/broker-transport.js';

test('transport close reports closed to pending-frame reader', async () => {
  const server = createServer(socket => { readBrokerFrames(socket, () => {}, error => assert.equal(error.code, 'transport_closed')); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const socket = await new Promise<Socket>((resolve, reject) => { const client = connect(address.port, '127.0.0.1'); client.once('connect', () => resolve(client)); client.once('error', reject); });
  socket.destroy();
  await new Promise(resolve => setTimeout(resolve, 10));
  await new Promise<void>(resolve => server.close(() => resolve()));
});

test('mutation claim persists before handler and rejects after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'northstar-state-')); const path = join(root, 'state.json');
  const first = new BrokerStateStore(path); await first.open(); await first.claimMutation('client:req');
  const second = new BrokerStateStore(path); await second.open(); await assert.rejects(second.claimMutation('client:req'), /Duplicate mutation/);
});

test('restart preserves duplicate mutation rejection and job receipt lookup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'northstar-state-')); const path = join(root, 'state.json');
  const first = new BrokerStateStore(path); await first.open(); await first.claimMutation('client:mutation');
  await first.recordJobSubmission({ jobId: 'runtime_job', clientId: 'client', requestId: 'req', submittedAt: 1 });
  const restarted = new BrokerStateStore(path); await restarted.open();
  await assert.rejects(restarted.claimMutation('client:mutation'), /Duplicate mutation/);
  assert.deepEqual(await restarted.getReceiptReadOnly('client', 'req'), { jobId: 'runtime_job', clientId: 'client', requestId: 'req', submittedAt: 1 });
});

test('mutation ledger retains only bounded duplicate protection window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'northstar-state-')); const path = join(root, 'state.json');
  const store = new BrokerStateStore(path, 2); await store.open(); await store.claimMutation('one'); await store.claimMutation('two'); await store.claimMutation('three');
  await assert.rejects(store.claimMutation('three'), /Duplicate mutation/); await assert.doesNotReject(store.claimMutation('one'));
  const persisted = JSON.parse(await readFile(path, 'utf8')) as { mutationIds: string[] }; assert.deepEqual(persisted.mutationIds, ['three', 'one']);
});

test('submission receipt query reads without rotating epoch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'northstar-state-')); const path = join(root, 'state.json');
  const store = new BrokerStateStore(path); const opened = await store.open(); await store.recordJobSubmission({ jobId: 'runtime_job', clientId: 'client', requestId: 'req', submittedAt: 1 });
  const receipt = await queryJobSubmission(path, 'client', 'req'); assert.equal(receipt?.jobId, 'runtime_job');
  const persisted = JSON.parse(await readFile(path, 'utf8')) as { epoch: string }; assert.equal(persisted.epoch, opened.epoch);
  const query = { version: 2 as const, kind: 'query' as const, token: 't', epoch: opened.epoch, sessionId: 's', sequence: 1, projectId: 'p', query: { method: 'submissionReceipt' as const, requestId: 'req' } };
  assert.equal(isBrokerQuery(decodeBrokerFrame(encodeBrokerFrame(query))), true);
});
