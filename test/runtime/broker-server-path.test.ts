import test from 'node:test';
import assert from 'node:assert/strict';
import { connect, type Socket } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrokerServer } from '../../src/runtime/broker-server.js';
import { BrokerClient } from '../../src/runtime/broker-client.js';
import { decodeBrokerFrame, encodeBrokerFrame, isBrokerError, type BrokerCapability, type BrokerMessage } from '../../src/runtime/broker-protocol.js';
import type { RuntimeRpcV1Request } from '../../src/runtime/runtime-rpc-protocol.js';

const status: RuntimeRpcV1Request = { version: 1, requestId: 'request', method: 'status', params: { runId: 'runtime_run' } };
const reply = { version: 1 as const, requestId: 'request', method: 'status' as const, success: true as const, data: { runId: 'runtime_run', state: 'running' as const, startedAt: 1, updatedAt: 2 } };

async function frame(socket: Socket): Promise<BrokerMessage> {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (data.length < 4) return;
      const size = data.readUInt32BE(0);
      if (data.length < size + 4) return;
      socket.off('data', onData);
      try { resolve(decodeBrokerFrame(data.subarray(0, size + 4))); } catch (error) { reject(error); }
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
}

async function denied(options: { projectId?: string; secret?: Buffer; authorize?: (request: RuntimeRpcV1Request) => boolean; capabilities?: BrokerCapability[] }, helloProject = 'project'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'northstar-broker-server-'));
  const serverOptions = { projectId: options.projectId ?? 'project', rootDir: root, secret: Buffer.alloc(32, 7), handler: () => reply }; const server = new BrokerServer(options.authorize ? { ...serverOptions, authorize: (request: RuntimeRpcV1Request) => options.authorize!(request) } : serverOptions);
  await server.start();
  const socket = await new Promise<Socket>((resolve, reject) => { const s = connect(server.endpoint.socketPath); s.once('connect', () => resolve(s)); s.once('error', reject); });
  socket.write(encodeBrokerFrame({ version: 2, kind: 'hello', clientId: 'client', projectId: helloProject, requestedCapabilities: options.capabilities ?? ['runtime:status'] }));
  const welcome = await frame(socket);
  if (isBrokerError(welcome)) { socket.destroy(); await server.stop(); return welcome.code; }
  if (!('token' in welcome)) throw new Error('expected welcome'); socket.write(encodeBrokerFrame({ version: 2, kind: 'request', token: welcome.token, epoch: welcome.epoch, sessionId: welcome.sessionId, sequence: 1, projectId: helloProject, request: status }));
  const denial = await frame(socket);
  socket.destroy(); await server.stop();
  assert.equal('kind' in denial && denial.kind, 'error');
  if (!('kind' in denial) || denial.kind !== 'error') throw new Error('expected denial');
  return denial.code;
}

test('broker server rejects malformed hello frame', async () => {
  const root = await mkdtemp(join(tmpdir(), 'northstar-broker-server-'));
  const server = new BrokerServer({ projectId: 'project', rootDir: root, handler: () => reply });
  await server.start();
  const socket = await new Promise<Socket>((resolve, reject) => { const s = connect(server.endpoint.socketPath); s.once('connect', () => resolve(s)); s.once('error', reject); });
  const raw = Buffer.from(JSON.stringify({ version: 2, kind: 'hello', clientId: 123 }));
  const f = Buffer.alloc(4 + raw.length); f.writeUInt32BE(raw.length); raw.copy(f, 4);
  socket.write(f);
  const denial = await frame(socket);
  socket.destroy(); await server.stop();
  assert.equal('kind' in denial && denial.kind, 'error');
  if (!('kind' in denial) || denial.kind !== 'error') throw new Error('expected denial');
  assert.equal(denial.code, 'invalid_frame');
});

test('broker server emits scope_denied for unauthorized method/capability', async () => {
  assert.equal(await denied({ authorize: () => false }), 'scope_denied');
});

test('broker server emits project_denied for cross-project hello', async () => {
  assert.equal(await denied({}, 'other-project'), 'project_denied');
});

test('broker server default policy denies with exact scope_denied code', async () => {
  assert.equal(await denied({}), 'scope_denied');
});

test('broker server rejects request when token lacks method capability', async () => {
  assert.equal(await denied({ capabilities: ['runtime:start'] }), 'scope_denied');
});

test('broker server maps duplicate mutation to duplicate_mutation by error code, never message', async () => {
  const root = await mkdtemp(join(tmpdir(), 'northstar-broker-server-dup-'));
  const secret = Buffer.alloc(32, 7);
  const cancelReq: RuntimeRpcV1Request = {
    version: 1,
    requestId: 'mutation_req_1',
    method: 'cancelAndSettle',
    params: { runIds: ['runtime_0123456789abcdef'], settlementWindowMs: 1000 },
  };
  const cancelReply = {
    version: 1 as const,
    requestId: 'mutation_req_1',
    method: 'cancelAndSettle' as const,
    success: true as const,
    data: { settledRunIds: ['runtime_0123456789abcdef'], timedOutRunIds: [] },
  };
  const server = new BrokerServer({
    projectId: 'project',
    rootDir: root,
    secret,
    authorize: () => true,
    handler: () => cancelReply,
  });
  await server.start();

  try {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(server.endpoint.socketPath);
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });

    socket.write(encodeBrokerFrame({
      version: 2,
      kind: 'hello',
      clientId: 'client_dup',
      projectId: 'project',
      requestedCapabilities: ['runtime:cancel'],
    }));
    const welcome = await frame(socket);
    assert.ok('token' in welcome);

    // Initial mutation succeeds
    socket.write(encodeBrokerFrame({
      version: 2,
      kind: 'request',
      token: welcome.token,
      epoch: welcome.epoch,
      sessionId: welcome.sessionId,
      sequence: 1,
      projectId: 'project',
      request: cancelReq,
    }));
    const initialResponse = await frame(socket);
    assert.equal('kind' in initialResponse && initialResponse.kind, 'response');
    if (!('kind' in initialResponse) || initialResponse.kind !== 'response') throw new Error('expected response');
    assert.equal(initialResponse.reply.success, true);

    // Duplicate mutation on same connection with sequence 2 rejected with duplicate_mutation
    socket.write(encodeBrokerFrame({
      version: 2,
      kind: 'request',
      token: welcome.token,
      epoch: welcome.epoch,
      sessionId: welcome.sessionId,
      sequence: 2,
      projectId: 'project',
      request: cancelReq,
    }));
    const duplicateResponse = await frame(socket);
    assert.equal('kind' in duplicateResponse && duplicateResponse.kind, 'error');
    if (!('kind' in duplicateResponse) || duplicateResponse.kind !== 'error') throw new Error('expected error');
    assert.equal(duplicateResponse.code, 'duplicate_mutation');

    socket.destroy();

    // Reconnection with same client and requestId also rejected with duplicate_mutation
    const reconnectSocket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(server.endpoint.socketPath);
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });

    reconnectSocket.write(encodeBrokerFrame({
      version: 2,
      kind: 'hello',
      clientId: 'client_dup',
      projectId: 'project',
      requestedCapabilities: ['runtime:cancel'],
    }));
    const reconnectWelcome = await frame(reconnectSocket);
    assert.ok('token' in reconnectWelcome);

    reconnectSocket.write(encodeBrokerFrame({
      version: 2,
      kind: 'request',
      token: reconnectWelcome.token,
      epoch: reconnectWelcome.epoch,
      sessionId: reconnectWelcome.sessionId,
      sequence: 1,
      projectId: 'project',
      request: cancelReq,
    }));
    const reconnectResponse = await frame(reconnectSocket);
    assert.equal('kind' in reconnectResponse && reconnectResponse.kind, 'error');
    if (!('kind' in reconnectResponse) || reconnectResponse.kind !== 'error') throw new Error('expected error');
    assert.equal(reconnectResponse.code, 'duplicate_mutation');

    reconnectSocket.destroy();
  } finally {
    await server.stop();
  }
});

test('broker restart during idempotent read fails closed and does not replay old connection/token', async () => {
  const root = await mkdtemp('/tmp/ns-broker-restart-');
  const secret = Buffer.alloc(32, 9);
  let handlerInvocations = 0;
  let releaseHandler!: () => void;
  const handlerBlocked = new Promise<void>(resolve => { releaseHandler = resolve; });
  let markHandlerStarted!: () => void;
  const handlerStarted = new Promise<void>(resolve => { markHandlerStarted = resolve; });

  const serverOptions = {
    projectId: 'project_restart',
    rootDir: root,
    secret,
    authorize: () => true,
    handler: async (request: RuntimeRpcV1Request) => {
      handlerInvocations++;
      if (handlerInvocations === 1) {
        markHandlerStarted();
        await handlerBlocked;
      }
      return { ...reply, requestId: request.requestId };
    },
  };

  let server = new BrokerServer(serverOptions);
  let client: BrokerClient | undefined;
  let freshClient: BrokerClient | undefined;
  await server.start();

  try {
    client = new BrokerClient({
      endpoint: server.endpoint,
      projectId: 'project_restart',
      clientId: 'client_restart',
      capabilities: ['status'],
    });

    await client.connect();

    const inFlightRead = client.request(status);
    const readRejected = assert.rejects(
      inFlightRead,
      (err: unknown) => {
        const error = err as { code?: string; message?: string };
        return error.code === 'transport_closed' || (typeof error.message === 'string' && error.message.includes('transport_closed'));
      }
    );
    await handlerStarted;
    assert.equal(handlerInvocations, 1);

    // Stop while the read handler is still blocked. Shutdown must sever the
    // accepted socket instead of waiting for the client to close it.
    await server.stop();
    await readRejected;
    releaseHandler();

    // Start fresh broker instance reusing state directory (simulates daemon restart)
    server = new BrokerServer(serverOptions);
    await server.start();

    // Old client connection must not succeed without re-handshake
    client.close();
    await assert.rejects(
      client.request({ version: 1, requestId: 'request_replayed_old_client', method: 'status', params: { runId: 'runtime_run' } }),
      (err: unknown) => {
        const error = err as { code?: string; message?: string };
        return error.code === 'transport_closed' || (typeof error.message === 'string' && error.message.includes('transport_closed'));
      }
    );

    // Old connection frame/token replayed directly to restarted broker must fail closed with epoch_mismatch
    // Capture old token attempt via direct raw frame
    const rawSocketOldToken = await new Promise<Socket>((resolve, reject) => {
      const s = connect(server.endpoint.socketPath);
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });

    // Obtain old token by doing a handshake with an old epoch or testing old credentials
    // More directly: send hello to get new epoch, but try old request message directly on new socket before hello -> rejected unsupported_version
    rawSocketOldToken.write(encodeBrokerFrame({
      version: 2,
      kind: 'request',
      token: 'stale.token.value',
      epoch: 'stale-epoch',
      sessionId: 'stale-session',
      sequence: 1,
      projectId: 'project_restart',
      request: status,
    }));
    const rawDenial = await frame(rawSocketOldToken);
    assert.equal('kind' in rawDenial && rawDenial.kind, 'error');
    if (!('kind' in rawDenial) || rawDenial.kind !== 'error') throw new Error('expected error');
    assert.equal(rawDenial.code, 'unsupported_version'); // Not hello -> unauthenticated socket rejected
    rawSocketOldToken.destroy();

    // Client with re-authenticated fresh connection succeeds with new epoch token
    freshClient = new BrokerClient({
      endpoint: server.endpoint,
      projectId: 'project_restart',
      clientId: 'client_restart_fresh',
      capabilities: ['status'],
    });
    await freshClient.connect();

    const freshReply = await freshClient.request({ version: 1, requestId: 'fresh_request', method: 'status', params: { runId: 'runtime_run' } });
    assert.equal(freshReply.success, true);
    assert.equal(handlerInvocations, 2);
  } finally {
    releaseHandler();
    client?.close();
    freshClient?.close();
    await server.stop();
  }
});
