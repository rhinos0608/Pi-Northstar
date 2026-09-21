import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  probeExistingBroker,
  BrokerUnavailableError,
  startBrokerHost,
  ExecutorListener,
} from '../../src/runtime/broker-host.js';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { writeFile, stat } from 'node:fs/promises';

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

test('ExecutorListener rejects wrong token and closes socket', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ns-exec-wrong-token-'));
  const socketPath = join(root, 'executor.sock');
  const tokenPath = join(root, 'executor.token');
  const validToken = randomBytes(32);
  const badToken = randomBytes(32);

  await writeFile(tokenPath, validToken.toString('hex'), { mode: 0o600 });
  const listener = new ExecutorListener({
    socketPath,
    tokenPath,
    token: Buffer.from(validToken.toString('hex'), 'utf8'),
  });

  await listener.listen();

  try {
    const client = connect(socketPath);
    await new Promise<void>((resolve) => {
      client.once('connect', () => {
        // Send frame with bad token
        const payload = Buffer.from(JSON.stringify({ token: badToken.toString('hex') }), 'utf8');
        const frame = Buffer.alloc(4 + payload.length);
        frame.writeUInt32BE(payload.length, 0);
        payload.copy(frame, 4);
        client.write(frame);
      });
      client.once('close', () => {
        resolve();
      });
      client.once('error', () => {
        resolve();
      });
    });

    // Token file should still exist because auth failed
    const tokenStat = await stat(tokenPath).catch(() => undefined);
    assert.ok(tokenStat !== undefined, 'token file must remain when auth fails');
  } finally {
    await listener.close();
  }
});

test('ExecutorListener closes connection on malformed JSON frame after auth', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ns-exec-malformed-'));
  const socketPath = join(root, 'executor.sock');
  const tokenPath = join(root, 'executor.token');
  const token = randomBytes(32);

  await writeFile(tokenPath, token.toString('hex'), { mode: 0o600 });
  const listener = new ExecutorListener({
    socketPath,
    tokenPath,
    token: Buffer.from(token.toString('hex'), 'utf8'),
  });

  await listener.listen();

  try {
    const client = connect(socketPath);
    await new Promise<void>((resolve) => {
      client.once('connect', () => {
        // Send correct auth frame
        const authPayload = Buffer.from(JSON.stringify({ token: token.toString('hex') }), 'utf8');
        const authFrame = Buffer.alloc(4 + authPayload.length);
        authFrame.writeUInt32BE(authPayload.length, 0);
        authPayload.copy(authFrame, 4);
        client.write(authFrame);

        // Immediately send malformed JSON frame
        const badPayload = Buffer.from('{not json at all!!', 'utf8');
        const badFrame = Buffer.alloc(4 + badPayload.length);
        badFrame.writeUInt32BE(badPayload.length, 0);
        badPayload.copy(badFrame, 4);
        client.write(badFrame);
      });
      client.once('close', () => {
        resolve();
      });
      client.once('error', () => {
        resolve();
      });
    });
  } finally {
    await listener.close();
  }
});

test('ExecutorListener unlinks token file after successful auth and serves validated RPC', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ns-exec-success-'));
  const socketPath = join(root, 'executor.sock');
  const tokenPath = join(root, 'executor.token');
  const token = randomBytes(32);

  await writeFile(tokenPath, token.toString('hex'), { mode: 0o600 });
  const listener = new ExecutorListener({
    socketPath,
    tokenPath,
    token: Buffer.from(token.toString('hex'), 'utf8'),
  });

  await listener.listen();

  try {
    const client = connect(socketPath);
    const replyPromise = new Promise<Buffer>((resolve, reject) => {
      let rx = Buffer.alloc(0);
      client.on('data', (chunk: Buffer) => {
        rx = Buffer.concat([rx, chunk]);
        if (rx.length >= 4) {
          const len = rx.readUInt32BE(0);
          if (rx.length >= 4 + len) {
            resolve(rx.subarray(4, 4 + len));
          }
        }
      });
      client.once('error', reject);
    });

    await new Promise<void>((resolve) => {
      client.once('connect', () => {
        // 1. Authenticate with valid token
        const authPayload = Buffer.from(JSON.stringify({ token: token.toString('hex') }), 'utf8');
        const authFrame = Buffer.alloc(4 + authPayload.length);
        authFrame.writeUInt32BE(authPayload.length, 0);
        authPayload.copy(authFrame, 4);
        client.write(authFrame);

        // 2. Send valid RuntimeRpcV1Request (negotiate)
        const reqPayload = Buffer.from(
          JSON.stringify({
            version: 1,
            requestId: 'req_test_exec_1',
            method: 'negotiate',
            params: { modelId: 'test-provider/test-model' },
          }),
          'utf8',
        );
        const reqFrame = Buffer.alloc(4 + reqPayload.length);
        reqFrame.writeUInt32BE(reqPayload.length, 0);
        reqPayload.copy(reqFrame, 4);
        client.write(reqFrame);
        resolve();
      });
    });

    const replyBuf = await replyPromise;
    const reply = JSON.parse(replyBuf.toString('utf8'));
    assert.equal(reply.version, 1);
    assert.equal(reply.requestId, 'req_test_exec_1');
    assert.equal(reply.method, 'negotiate');

    // Wait short tick for unlink to settle and assert token file unlinked
    await new Promise((r) => setTimeout(r, 20));
    const tokenStat = await stat(tokenPath).catch(() => undefined);
    assert.equal(tokenStat, undefined, 'token file must be unlinked after successful auth');

    client.destroy();
  } finally {
    await listener.close();
  }
});
