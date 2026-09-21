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
          if (method === 'cancelAndSettle') {
            return {
              settledRunIds: [],
              timedOutRunIds: [],
            };
          }
          return { method, params, handled: true };
        },
      } as any,
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

    // Cancel unknown run -> forwards to executor -> returns success response with empty settled
    const cancelMsg: BrokerMessage = {
      version: 2,
      kind: 'request',
      token,
      epoch,
      sessionId,
      sequence: 2,
      projectId,
      request: {
        version: 1,
        requestId: 'cancel-run-req-1',
        method: 'cancelAndSettle',
        params: {
          runIds: ['unknown-run-123'],
          settlementWindowMs: 100,
        },
      },
    };
    await sendFrame(clientSocket, cancelMsg);
    const cancelResp = await readNextFrame(clientSocket);
    assert.equal(cancelResp.kind, 'response');
    if (cancelResp.kind !== 'response') return;
    assert.equal(cancelResp.sequence, 2);
    assert.equal(cancelResp.reply.requestId, 'cancel-run-req-1');
    assert.equal(cancelResp.reply.method, 'cancelAndSettle');
    assert.equal(cancelResp.reply.success, true);
    if (cancelResp.reply.success) {
      assert.deepEqual(cancelResp.reply.data, {
        settledRunIds: [],
        timedOutRunIds: [],
        unknownRunIds: ['unknown-run-123'],
      });
    }

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
