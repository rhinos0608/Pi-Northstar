import test from 'node:test';
import assert from 'node:assert/strict';
import { connect, type Socket } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrokerServer, type BrokerServerOptions } from '../../src/runtime/broker-server.js';
import {
  decodeBrokerFrame,
  encodeBrokerFrame,
  isBrokerError,
  type BrokerMessage,
} from '../../src/runtime/broker-protocol.js';
import { BrokerError } from '../../src/runtime/broker-errors.js';
import {
  acquireBrokerLock,
  releaseBrokerLock,
  BrokerLockError,
} from '../../src/runtime/broker-lock.js';
import {
  validateRequest,
  type RuntimeRpcV1Request,
} from '../../src/runtime/runtime-rpc-protocol.js';

// Helper: read a single frame from a raw socket
async function readFrame(socket: Socket): Promise<BrokerMessage> {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (data.length < 4) return;
      const size = data.readUInt32BE(0);
      if (data.length < size + 4) return;
      socket.off('data', onData);
      try {
        resolve(decodeBrokerFrame(data.subarray(0, size + 4)));
      } catch (error) {
        reject(error);
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.once('close', () => {
      if (data.length === 0) {
        reject(new BrokerError('transport_closed'));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// 1. decodeBrokerFrame rejects:
//    - truncated buffer
//    - v1-versioned hello object
//    - hello containing rootSecret
//    - request with unknown method
//    - frame with trailing bytes
// ---------------------------------------------------------------------------
test('decodeBrokerFrame hostile inputs fail closed', () => {
  // Truncated buffer (< 4 bytes)
  assert.throws(() => decodeBrokerFrame(Buffer.alloc(2)), (err: unknown) => {
    return err instanceof BrokerError && err.code === 'invalid_frame';
  });

  // Helper to pack raw JSON into frame
  const pack = (obj: unknown, extraTrailing = 0) => {
    const raw = Buffer.from(JSON.stringify(obj));
    const buf = Buffer.alloc(4 + raw.length + extraTrailing);
    buf.writeUInt32BE(raw.length, 0);
    raw.copy(buf, 4);
    if (extraTrailing > 0) {
      buf.fill(0xff, 4 + raw.length);
    }
    return buf;
  };

  // v1-versioned hello object
  const v1Hello = {
    version: 1,
    kind: 'hello',
    clientId: 'client-1',
    projectId: 'proj-1',
    requestedCapabilities: ['runtime:status'],
  };
  assert.throws(() => decodeBrokerFrame(pack(v1Hello)), (err: unknown) => {
    return err instanceof BrokerError && err.code === 'invalid_frame';
  });

  // Hello containing rootSecret (forbidden client secrets)
  const helloWithRootSecret = {
    version: 2,
    kind: 'hello',
    clientId: 'client-1',
    projectId: 'proj-1',
    requestedCapabilities: ['runtime:status'],
    rootSecret: 'super-secret',
  };
  assert.throws(() => decodeBrokerFrame(pack(helloWithRootSecret)), (err: unknown) => {
    return err instanceof BrokerError && err.code === 'invalid_frame';
  });

  // Request with unknown method
  const reqUnknownMethod = {
    version: 2,
    kind: 'request',
    token: 'valid.token',
    epoch: 'ep-1',
    sessionId: 'sess-1',
    sequence: 1,
    projectId: 'proj-1',
    request: {
      version: 1,
      requestId: 'req-1',
      method: 'unsupportedMethod',
      params: {},
    },
  };
  assert.throws(() => decodeBrokerFrame(pack(reqUnknownMethod)), (err: unknown) => {
    return err instanceof BrokerError && err.code === 'invalid_frame';
  });

  // Frame with trailing bytes (buffer longer than size + 4)
  const validHello = {
    version: 2,
    kind: 'hello',
    clientId: 'client-1',
    projectId: 'proj-1',
    requestedCapabilities: ['runtime:status'],
  };
  const trailingFrame = pack(validHello, 8);
  assert.throws(() => decodeBrokerFrame(trailingFrame), (err: unknown) => {
    return err instanceof BrokerError && err.code === 'invalid_frame';
  });
});

// ---------------------------------------------------------------------------
// 2. Malformed hello over a live socket (raw net connect to a test BrokerServer):
//    server responds with error kind (unsupported_version/unauthorized/invalid_frame)
//    and closes — assert error code, never a welcome.
// ---------------------------------------------------------------------------
test('malformed hello over live socket returns error code and closes (never welcome)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ns-hostile-hello-'));
  const reply = {
    version: 1 as const,
    requestId: 'req',
    method: 'status' as const,
    success: true as const,
    data: { runId: 'runtime_run', state: 'running' as const, startedAt: 1, updatedAt: 2 },
  };
  const server = new BrokerServer({ projectId: 'test-project', rootDir: root, handler: () => reply });
  await server.start();

  try {
    // Connect raw socket and send malformed hello: invalid version & bad payload
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(server.endpoint.socketPath);
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });

    // Send frame with JSON that does not match BrokerHello: { version: 1, kind: 'hello' }
    const malformed = Buffer.from(JSON.stringify({ version: 1, kind: 'hello', clientId: 'c' }));
    const frameBuf = Buffer.alloc(4 + malformed.length);
    frameBuf.writeUInt32BE(malformed.length, 0);
    malformed.copy(frameBuf, 4);
    socket.write(frameBuf);

    // Read response
    const res = await readFrame(socket);
    assert.equal(isBrokerError(res), true, 'Server must return error message');
    if (isBrokerError(res)) {
      assert.ok(
        ['unsupported_version', 'unauthorized', 'invalid_frame'].includes(res.code),
        `Unexpected error code: ${res.code}`,
      );
      assert.notEqual(res.kind, 'welcome');
    }

    // Socket should close
    await new Promise<void>((resolve) => {
      if (socket.destroyed) resolve();
      else socket.once('close', () => resolve());
    });
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Cross-project hello -> project_denied;
//    Token replay across restart -> epoch_mismatch or transport_closed
//    (start, connect, stop, restart, reconnect with old welcome must fail)
// ---------------------------------------------------------------------------
test('cross-project hello yields project_denied and token replay across restart fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ns-hostile-restart-'));
  const reply = {
    version: 1 as const,
    requestId: 'req',
    method: 'status' as const,
    success: true as const,
    data: { runId: 'runtime_run', state: 'running' as const, startedAt: 1, updatedAt: 2 },
  };
  const serverOptions: BrokerServerOptions = {
    projectId: 'p_auth',
    rootDir: root,
    handler: () => reply,
  };

  let server = new BrokerServer(serverOptions);
  await server.start();

  try {
    // 3a. Cross-project hello
    const socketCross = await new Promise<Socket>((resolve, reject) => {
      const s = connect(server.endpoint.socketPath);
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });

    const crossHello = {
      version: 2 as const,
      kind: 'hello' as const,
      clientId: 'client-1',
      projectId: 'other-project', // mismatch
      requestedCapabilities: ['runtime:status' as const],
    };
    socketCross.write(encodeBrokerFrame(crossHello));
    const crossRes = await readFrame(socketCross);
    assert.equal(isBrokerError(crossRes), true);
    if (isBrokerError(crossRes)) {
      assert.equal(crossRes.code, 'project_denied');
    }
    socketCross.destroy();

    // 3b. Legitimate hello to capture welcome & token
    const socketAuth = await new Promise<Socket>((resolve, reject) => {
      const s = connect(server.endpoint.socketPath);
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    const validHello = {
      version: 2 as const,
      kind: 'hello' as const,
      clientId: 'client-1',
      projectId: 'p_auth',
      requestedCapabilities: ['runtime:status' as const],
    };
    socketAuth.write(encodeBrokerFrame(validHello));
    const welcome = await readFrame(socketAuth);
    assert.equal('kind' in welcome && welcome.kind, 'welcome');
    if (!('token' in welcome)) throw new Error('Expected welcome');
    socketAuth.destroy();

    // Stop server
    await server.stop();

    // Restart server reusing rootDir (generates fresh epoch)
    server = new BrokerServer(serverOptions);
    await server.start();

    // Attempt to use captured old welcome token on restarted server
    const socketReplay = await new Promise<Socket>((resolve, reject) => {
      const s = connect(server.endpoint.socketPath);
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });

    // Send hello to negotiate on new socket first
    const replayedHello = {
      version: 2 as const,
      kind: 'hello' as const,
      clientId: 'client-1',
      projectId: 'p_auth',
      requestedCapabilities: ['runtime:status' as const],
    };
    socketReplay.write(encodeBrokerFrame(replayedHello));
    const freshWelcome = await readFrame(socketReplay);
    assert.equal('kind' in freshWelcome && freshWelcome.kind, 'welcome');
    if (!('sessionId' in freshWelcome)) throw new Error('Expected fresh welcome');

    // Now send request using OLD welcome token & OLD epoch
    const staleRequest = {
      version: 2 as const,
      kind: 'request' as const,
      token: welcome.token,
      epoch: welcome.epoch,
      sessionId: freshWelcome.sessionId,
      sequence: 1,
      projectId: 'p_auth',
      request: {
        version: 1 as const,
        requestId: 'req-stale',
        method: 'status' as const,
        params: { runId: 'runtime_run' },
      },
    };
    socketReplay.write(encodeBrokerFrame(staleRequest));

    try {
      const replayRes = await readFrame(socketReplay);
      assert.equal(isBrokerError(replayRes), true);
      if (isBrokerError(replayRes)) {
        assert.ok(
          replayRes.code === 'epoch_mismatch' || replayRes.code === 'transport_closed',
          `Expected epoch_mismatch or transport_closed, got: ${replayRes.code}`,
        );
      }
    } catch (err) {
      // transport_closed on stream close is also compliant
      const bErr = err as BrokerError;
      assert.ok(bErr.code === 'transport_closed' || (err as Error).message.includes('transport_closed'));
    } finally {
      socketReplay.destroy();
    }
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Lock contention:
//    acquireBrokerLock twice (different modes) -> second throws lock_held;
//    stale lock from dead pid is retaken
//    (write a lock file with dead pid e.g. 2^31-1 -> then acquire succeeds).
// ---------------------------------------------------------------------------
test('lock contention: double acquire throws lock_held; stale lock retaken', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ns-hostile-lock-'));
  const projectId = 'p_lock';
  try {

  // 4a. First acquire succeeds
  await acquireBrokerLock(projectId, 'serve', root);

  // Second acquire with different mode throws lock_held
  await assert.rejects(
    acquireBrokerLock(projectId, 'session', root),
    (err: unknown) => {
      return err instanceof BrokerLockError && err.code === 'lock_held';
    },
  );

  // Clean up live lock
  await releaseBrokerLock(projectId, root);

  // 4b. Stale lock from dead pid: write a lock file with non-existent PID (e.g. 2^31 - 1)
  const deadPid = 2147483647; // 2^31 - 1
  const lockFilePath = `${root}/${projectId}/broker.lock`;
  const staleRecord = {
    pid: deadPid,
    startedAt: Date.now() - 100000,
    mode: 'serve',
  };
  await writeFile(lockFilePath, JSON.stringify(staleRecord));

  // acquireBrokerLock must detect dead PID, remove stale lock, and succeed
  await acquireBrokerLock(projectId, 'serve', root);

  // Release lock
  await releaseBrokerLock(projectId, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. cancelAndSettle validation via golden path:
//    duplicate runIds and 65-entry runIds fail request validation (validateRequest)
//    before dispatch.
// ---------------------------------------------------------------------------
test('cancelAndSettle validation fails on duplicate runIds and 65-entry runIds', () => {
  // 5a. Duplicate runIds
  const reqDuplicate: RuntimeRpcV1Request = {
    version: 1,
    requestId: 'req-dup',
    method: 'cancelAndSettle',
    params: {
      runIds: ['runtime_0123456789abcdef', 'runtime_0123456789abcdef'],
      settlementWindowMs: 1000,
    },
  };
  const resDup = validateRequest(reqDuplicate);
  assert.equal(resDup.ok, false, 'Duplicate runIds must fail validation');
  if (!resDup.ok) {
    assert.equal(resDup.code, 'invalid_params');
  }

  // 5b. 65-entry runIds (limit is 64)
  const runIds65: string[] = [];
  for (let i = 0; i < 65; i++) {
    // Valid runtime_ ID format: runtime_ followed by lowercase hex
    const hex = i.toString(16).padStart(16, '0');
    runIds65.push(`runtime_${hex}`);
  }
  assert.equal(runIds65.length, 65);

  const req65: RuntimeRpcV1Request = {
    version: 1,
    requestId: 'req-65',
    method: 'cancelAndSettle',
    params: {
      runIds: runIds65,
      settlementWindowMs: 1000,
    },
  };
  const res65 = validateRequest(req65);
  assert.equal(res65.ok, false, '65-entry runIds must fail validation');
  if (!res65.ok) {
    assert.equal(res65.code, 'invalid_params');
  }
});
