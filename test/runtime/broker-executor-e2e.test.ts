import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, type Socket } from 'node:net';
import { ExecutorListener } from '../../src/runtime/broker-host.js';
import { decodeBrokerFrame, encodeBrokerFrame, type BrokerMessage } from '../../src/runtime/broker-protocol.js';

function execCommand(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const cp = spawn(cmd, args, { stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      cp.kill('SIGKILL');
    }, timeoutMs);

    cp.stdout?.on('data', (d) => { stdout += d.toString(); });
    cp.stderr?.on('data', (d) => { stderr += d.toString(); });

    cp.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    cp.once('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: err.message });
    });
  });
}

async function sendFrame(socket: Socket, message: BrokerMessage): Promise<void> {
  const frame = encodeBrokerFrame(message);
  return new Promise((resolve, reject) => {
    socket.write(frame, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function readNextFrame(socket: Socket, timeoutMs = 5000): Promise<BrokerMessage> {
  return new Promise((resolve, reject) => {
    let rxBuf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for frame (${timeoutMs}ms)`));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      rxBuf = Buffer.concat([rxBuf, chunk]);
      if (rxBuf.length >= 4) {
        const frameLen = rxBuf.readUInt32BE(0);
        if (rxBuf.length >= 4 + frameLen) {
          const frame = rxBuf.subarray(0, 4 + frameLen);
          cleanup();
          try {
            const decoded = decodeBrokerFrame(frame);
            resolve(decoded);
          } catch (e) {
            reject(e);
          }
        }
      }
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const onClose = () => {
      cleanup();
      reject(new Error('Socket closed prematurely while waiting for frame'));
    };

    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    };

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

test('broker-executor cross-language end-to-end integration', { timeout: 300_000, skip: process.platform === 'win32' }, async (t) => {
  // Ensure broker binary exists / build release binary if missing
  const manifestPath = join(process.cwd(), 'rust', 'Cargo.toml');
  const binaryPath = join(process.cwd(), 'rust', 'target', 'release', 'northstar-broker');

  const buildRes = await execCommand('cargo', ['build', '--release', '--manifest-path', manifestPath, '-p', 'northstar-broker'], 300_000);
  if (buildRes.code !== 0) {
    t.skip(`cargo build failed: ${buildRes.stderr}`);
    return;
  }

  const tmpDir = await mkdtemp(join(tmpdir(), 'northstar-e2e-'));
  const brokerSocketPath = join(tmpDir, 'broker.sock');
  const dbPath = join(tmpDir, 'broker.db');
  const executorSocketPath = join(tmpDir, 'executor.sock');
  const executorTokenPath = join(tmpDir, 'executor.token');
  const projectId = 'golden-project';

  const rawTokenHex = randomBytes(32).toString('hex');
  await writeFile(executorTokenPath, rawTokenHex, { mode: 0o600 });

  let listener: ExecutorListener | undefined;
  let brokerChild: ChildProcess | undefined;
  let clientSocket: Socket | undefined;

  try {
    listener = new ExecutorListener({
      socketPath: executorSocketPath,
      tokenPath: executorTokenPath,
      token: Buffer.from(rawTokenHex, 'utf8'),
      leafClient: {
        async request(method: string, params: Record<string, unknown>): Promise<unknown> {
          if (method === 'start' && params.modelId === 'provider/missing') {
            throw Object.assign(new Error('missing test model'), { code: 'model_unavailable' });
          }
          if (method === 'start') return { runId: 'runtime_e2e_1', state: 'running' };
          if (method === 'status') {
            return { runId: String(params.runId), state: 'completed', startedAt: 1, updatedAt: 2 };
          }
          if (method === 'result') {
            return {
              runId: String(params.runId),
              state: 'completed',
              output: 'local executor result',
              outputTokens: 4,
              truncated: false,
            };
          }
          if (method === 'cancelAndSettle') {
            const runIds = params.runIds as string[];
            return { settlements: runIds.map((runId) => ({ runId, state: 'cancelled' })) };
          }
          return { compatible: true, modelId: String(params.modelId), capabilities: {} };
        },
      },
    });
    await listener.listen();

    brokerChild = spawn(binaryPath, [
      '--project-id', projectId,
      '--socket', brokerSocketPath,
      '--db', dbPath,
      '--executor-socket', executorSocketPath,
      '--executor-token-file', executorTokenPath,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Wait for broker socket to be ready
    let connected = false;
    for (let i = 0; i < 50; i++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const s = createConnection(brokerSocketPath, () => {
            s.destroy();
            resolve();
          });
          s.once('error', reject);
        });
        connected = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    assert.equal(connected, true, 'Broker socket should be available');

    // Connect as client to broker socket
    clientSocket = createConnection(brokerSocketPath);
    await new Promise<void>((resolve, reject) => {
      clientSocket!.once('connect', resolve);
      clientSocket!.once('error', reject);
    });

    // Send golden hello fixture
    const goldenHelloRaw = await readFile(join(process.cwd(), 'test', 'fixtures', 'rpc-golden', 'broker-v2-hello.json'), 'utf8');
    const goldenHello = JSON.parse(goldenHelloRaw) as BrokerMessage;
    await sendFrame(clientSocket, goldenHello);

    const welcomeMsg = await readNextFrame(clientSocket);
    assert.equal(welcomeMsg.kind, 'welcome');
    if (welcomeMsg.kind !== 'welcome') return;
    assert.equal(welcomeMsg.projectId, projectId);
    assert.ok(welcomeMsg.expiresAt > Date.now(), 'Rust welcome expiry must be epoch milliseconds');
    assert.ok(welcomeMsg.expiresAt <= Date.now() + 61_000, 'welcome TTL should stay bounded near 60s');
    const { token, epoch, sessionId } = welcomeMsg;

    // Query unknown receipt -> queryResponse without receipt
    const queryMsg: BrokerMessage = {
      version: 2,
      kind: 'query',
      token,
      epoch,
      sessionId,
      sequence: 1,
      projectId,
      query: {
        method: 'submissionReceipt',
        requestId: 'unknown-run-req-999',
      },
    };
    await sendFrame(clientSocket, queryMsg);
    const queryResp = await readNextFrame(clientSocket);
    assert.equal(queryResp.kind, 'queryResponse');
    if (queryResp.kind !== 'queryResponse') return;
    assert.equal(queryResp.sequence, 1);
    assert.equal(queryResp.receipt, undefined);

    // Start a real job through the executor and persist its durable receipt.
    const startMsg: BrokerMessage = {
      version: 2,
      kind: 'request',
      token,
      epoch,
      sessionId,
      sequence: 2,
      projectId,
      request: {
        version: 1,
        requestId: 'start-run-req-1',
        method: 'start',
        params: {
          modelId: 'provider/model',
          prompt: 'run locally',
          maxOutputTokens: 16,
          timeoutMs: 1_000,
          correlation: {
            owner: 'northstar',
            correlationId: 'e2e-run',
            queryIndex: 0,
            role: 'researcher',
            stage: 'test',
            attempt: 0,
          },
        },
      },
    };
    await sendFrame(clientSocket, startMsg);
    const startResp = await readNextFrame(clientSocket);
    assert.equal(startResp.kind, 'response');
    if (startResp.kind !== 'response') return;
    assert.equal(startResp.reply.success, true);
    if (!startResp.reply.success) return;
    assert.deepEqual(startResp.reply.data, { runId: 'runtime_e2e_1', state: 'running' });

    const receiptMsg: BrokerMessage = {
      version: 2,
      kind: 'query',
      token,
      epoch,
      sessionId,
      sequence: 3,
      projectId,
      query: { method: 'submissionReceipt', requestId: 'start-run-req-1' },
    };
    await sendFrame(clientSocket, receiptMsg);
    const receiptResp = await readNextFrame(clientSocket);
    assert.equal(receiptResp.kind, 'queryResponse');
    if (receiptResp.kind !== 'queryResponse') return;
    assert.equal(receiptResp.receipt?.jobId, 'runtime_e2e_1');
    assert.equal(receiptResp.receipt?.state, 'dispatched');

    // Status reuses the same authenticated executor connection and a verified
    // terminal observation settles the durable receipt before result retrieval.
    for (const [sequence, method] of [[4, 'status']] as const) {
      const request: BrokerMessage = {
        version: 2,
        kind: 'request',
        token,
        epoch,
        sessionId,
        sequence,
        projectId,
        request: {
          version: 1,
          requestId: method + '-run-req-1',
          method,
          params: { runId: 'runtime_e2e_1' },
        },
      };
      await sendFrame(clientSocket, request);
      const response = await readNextFrame(clientSocket);
      assert.equal(response.kind, 'response');
      if (response.kind !== 'response') return;
      assert.equal(response.reply.success, true);
      if (!response.reply.success) return;
      assert.equal((response.reply.data as { runId: string }).runId, 'runtime_e2e_1');
    }

    const statusSettledReceiptMsg: BrokerMessage = {
      version: 2,
      kind: 'query',
      token,
      epoch,
      sessionId,
      sequence: 5,
      projectId,
      query: { method: 'submissionReceipt', requestId: 'start-run-req-1' },
    };
    await sendFrame(clientSocket, statusSettledReceiptMsg);
    const statusSettledReceiptResp = await readNextFrame(clientSocket);
    assert.equal(statusSettledReceiptResp.kind, 'queryResponse');
    if (statusSettledReceiptResp.kind !== 'queryResponse') return;
    assert.equal(statusSettledReceiptResp.receipt?.state, 'completed');

    const resultRequest: BrokerMessage = {
      version: 2,
      kind: 'request',
      token,
      epoch,
      sessionId,
      sequence: 6,
      projectId,
      request: {
        version: 1,
        requestId: 'result-run-req-1',
        method: 'result',
        params: { runId: 'runtime_e2e_1' },
      },
    };
    await sendFrame(clientSocket, resultRequest);
    const resultResponse = await readNextFrame(clientSocket);
    assert.equal(resultResponse.kind, 'response');
    if (resultResponse.kind !== 'response') return;
    assert.equal(resultResponse.reply.success, true);

    const completedReceiptMsg: BrokerMessage = {
      version: 2,
      kind: 'query',
      token,
      epoch,
      sessionId,
      sequence: 7,
      projectId,
      query: { method: 'submissionReceipt', requestId: 'start-run-req-1' },
    };
    await sendFrame(clientSocket, completedReceiptMsg);
    const completedReceiptResp = await readNextFrame(clientSocket);
    assert.equal(completedReceiptResp.kind, 'queryResponse');
    if (completedReceiptResp.kind !== 'queryResponse') return;
    assert.equal(completedReceiptResp.receipt?.state, 'completed');

    // Cancellation is client-bound and forwarded unchanged to the local executor.
    const cancelMsg: BrokerMessage = {
      version: 2,
      kind: 'request',
      token,
      epoch,
      sessionId,
      sequence: 8,
      projectId,
      request: {
        version: 1,
        requestId: 'cancel-run-req-1',
        method: 'cancelAndSettle',
        params: {
          runIds: ['runtime_e2e_1'],
          settlementWindowMs: 100,
        },
      },
    };
    await sendFrame(clientSocket, cancelMsg);
    const cancelResp = await readNextFrame(clientSocket);
    assert.equal(cancelResp.kind, 'response');
    if (cancelResp.kind !== 'response') return;
    assert.equal(cancelResp.sequence, 8);
    assert.equal(cancelResp.reply.success, true);
    if (cancelResp.reply.success) {
      assert.deepEqual(cancelResp.reply.data, {
        settlements: [{ runId: 'runtime_e2e_1', state: 'cancelled' }],
      });
    }

    // A definitive failed start remains durably settled internally, but must
    // never surface its provisional journal id as a submitted runtime job.
    const failedStartMsg: BrokerMessage = {
      version: 2,
      kind: 'request',
      token,
      epoch,
      sessionId,
      sequence: 9,
      projectId,
      request: {
        version: 1,
        requestId: 'start-run-req-failed',
        method: 'start',
        params: {
          modelId: 'provider/missing',
          prompt: 'fail before job creation',
          maxOutputTokens: 16,
          timeoutMs: 1_000,
          correlation: {
            owner: 'northstar',
            correlationId: 'e2e-failed-run',
            queryIndex: 0,
            role: 'researcher',
            stage: 'test',
            attempt: 0,
          },
        },
      },
    };
    await sendFrame(clientSocket, failedStartMsg);
    const failedStartResp = await readNextFrame(clientSocket);
    assert.equal(failedStartResp.kind, 'response');
    if (failedStartResp.kind !== 'response') return;
    assert.equal(failedStartResp.reply.success, false);
    if (failedStartResp.reply.success) return;
    assert.equal(failedStartResp.reply.error.code, 'model_unavailable');

    const failedReceiptMsg: BrokerMessage = {
      version: 2,
      kind: 'query',
      token,
      epoch,
      sessionId,
      sequence: 10,
      projectId,
      query: { method: 'submissionReceipt', requestId: 'start-run-req-failed' },
    };
    await sendFrame(clientSocket, failedReceiptMsg);
    const failedReceiptResp = await readNextFrame(clientSocket);
    assert.equal(failedReceiptResp.kind, 'queryResponse');
    if (failedReceiptResp.kind !== 'queryResponse') return;
    assert.equal(failedReceiptResp.receipt, undefined);

  } finally {
    // Teardown: close client socket, SIGTERM broker, close listener, remove tmpdir
    if (clientSocket && !clientSocket.destroyed) {
      clientSocket.destroy();
    }
    if (brokerChild && brokerChild.exitCode === null) {
      brokerChild.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          brokerChild?.kill('SIGKILL');
          resolve();
        }, 3000);
        brokerChild?.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (listener) {
      await listener.close().catch(() => {});
    }
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
