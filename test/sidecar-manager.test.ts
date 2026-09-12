import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { isAbsolute, join } from 'node:path';
import { SidecarManager } from '../src/sidecar-manager.js';
import type { SidecarManagerOptions } from '../src/sidecar-manager.js';

// ── Fetch mock auto-restore ──
const _mocks: Array<{ orig: typeof globalThis.fetch | undefined; mock: typeof globalThis.fetch | undefined }> = [];
afterEach(() => {
  for (const entry of _mocks) {
    if (globalThis.fetch === entry.mock) {
      globalThis.fetch = entry.orig ?? globalThis.fetch;
    }
  }
  _mocks.length = 0;
});

// ── Constants ──

const TEST_PORT = 23456;

// Clear external sidecar URL so tests exercise the spawn path
delete process.env.EMBEDDING_SIDECAR_BASE_URL;

// ── Mock infrastructure ──

interface SpawnRecord {
  command: string;
  args: string[];
  options: unknown;
}

const spawnRecords: SpawnRecord[] = [];

class MockChildProcess extends EventEmitter {
  public pid = 98765;
  public killed = false;
  public killedSignal: string | undefined;
  public readonly stdout = new EventEmitter();
  public readonly stderr = new EventEmitter();

  kill(signal?: string): boolean {
    this.killed = true;
    this.killedSignal = signal;
    return true;
  }
}

class MockNetServer {
  on(_event: string, _cb: (...args: unknown[]) => void): this {
    return this;
  }

  listen(_port: number, cb?: () => void): this {
    cb?.();
    return this;
  }

  address() {
    return { port: TEST_PORT, family: 'IPv4' as const, address: '127.0.0.1' as const };
  }

  close(cb?: () => void): this {
    cb?.();
    return this;
  }
}

let currentChild: MockChildProcess | undefined;
let spawnShouldFail = false;

function makeMocks() {
  spawnRecords.length = 0;
  currentChild = undefined;
  spawnShouldFail = false;

  const mockSpawn = (command: string, args: string[], options: unknown) => {
    const record: SpawnRecord = { command, args, options };
    spawnRecords.push(record);
    const child = new MockChildProcess();
    currentChild = child;

    if (spawnShouldFail) {
      setImmediate(() => {
        child.emit('error', new Error('ENOENT: python3 not found'));
      });
    } else {
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(`SIDECAR_PORT=${TEST_PORT}\n`));
      });
    }

    return child;
  };

  const mockCreateServer = () => new MockNetServer();

  return { mockSpawn, mockCreateServer };
}

function okFetch(): typeof globalThis.fetch {
  return async (_url: any) =>
    new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
}

function loadingFetch(): typeof globalThis.fetch {
  return async (_url: any) =>
    new Response(JSON.stringify({ status: 'loading' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
}

function failFetch(): typeof globalThis.fetch {
  return async () => {
    throw new Error('Connection refused');
  };
}

function createManager(
  opts?: Partial<SidecarManagerOptions> & { _fetch?: typeof globalThis.fetch },
) {
  const { _fetch, ...rest } = opts ?? {};
  const { mockSpawn, mockCreateServer } = makeMocks();

  const mgr = new SidecarManager({
    startupTimeout: 5000,
    initialBackoffMs: 100,
    maxBackoffMs: 5000,
    _spawn: mockSpawn as any,
    _createServer: mockCreateServer as any,
    ...rest,
  }) as any;

  // Replace fetch globally for this test
  if (_fetch) {
    _mocks.push({ orig: globalThis.fetch, mock: _fetch });
    globalThis.fetch = _fetch;
  }

  return mgr as InstanceType<typeof SidecarManager> & {
    __spawnRecords: typeof spawnRecords;
    __currentChild: typeof currentChild;
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('waitFor timed out');
}

// ── Tests ──

// ---------------------------------------------------------------------------
// Constructor & health()
// ---------------------------------------------------------------------------

test('constructor sets stopped status', () => {
  const mgr = new SidecarManager();
  const h = (mgr as any).health();
  assert.equal(h.status, 'stopped');
  // Optional fields are omitted when undefined (exactOptionalPropertyTypes)
  assert.equal('port' in h, false);
  assert.equal('error' in h, false);
});

test('constructor applies custom options', () => {
  const mgr = new SidecarManager({
    scriptPath: 'custom/app.py',
    pythonPath: 'python3.11',
    model: 'custom-model',
    device: 'cpu',
    startupTimeout: 9999,
  });
  assert.equal((mgr as any).health().status, 'stopped');
});

// ---------------------------------------------------------------------------
// start()
// ---------------------------------------------------------------------------

test('start spawns python3 with correct args and transitions to running', async () => {
  const mgr = createManager({
    model: 'my-model',
    device: 'cuda',
    _fetch: okFetch(),
  });

  await mgr.start();

  assert.equal(mgr.health().status, 'running');
  assert.equal(mgr.health().port, TEST_PORT);
  assert.equal(mgr.getBaseUrl(), `http://127.0.0.1:${TEST_PORT}`);

  assert.equal(spawnRecords.length, 1);
  const rec = spawnRecords[0]!;
  assert.equal(rec.command, 'python3');
  // Package-root resolution: absolute path, no cwd dependence.
  assert.ok(rec.args.some((arg) => arg.endsWith(join('sidecar', 'app.py')) && isAbsolute(arg)));
  assert.ok(rec.args.includes('--port'));
  assert.ok(rec.args.includes(String(TEST_PORT)));
  assert.ok(rec.args.includes('--model'));
  assert.ok(rec.args.includes('my-model'));
  assert.ok(rec.args.includes('--device'));
  assert.ok(rec.args.includes('cuda'));
});

test('default scriptPath resolves under the package root (no cwd dependence)', async () => {
  const mgr = createManager({ _fetch: okFetch() });
  await mgr.start();
  assert.equal(spawnRecords.length, 1);
  const scriptArg = spawnRecords[0]!.args[0]!;
  assert.ok(isAbsolute(scriptArg), `default script must be absolute, got ${scriptArg}`);
  assert.ok(scriptArg.endsWith(join('sidecar', 'app.py')), `unexpected script path ${scriptArg}`);
  await mgr.stop();
});

test('start uses default model when not specified', async () => {
  const mgr = createManager({ _fetch: okFetch() });
  await mgr.start();

  const rec = spawnRecords[0]!;
  assert.ok(rec.args.includes('--model'));
  assert.ok(rec.args.includes('all-MiniLM-L6-v2'));
});

test('start skips --device when device is empty string', async () => {
  const mgr = createManager({ device: '', _fetch: okFetch() });
  await mgr.start();

  const rec = spawnRecords[0]!;
  assert.ok(!rec.args.includes('--device'));
});

test('start is no-op if already running', async () => {
  const mgr = createManager({ _fetch: okFetch() });
  await mgr.start();

  const countAfterFirst = spawnRecords.length;
  await mgr.start();

  assert.equal(spawnRecords.length, countAfterFirst);
  assert.equal(mgr.health().status, 'running');
});

test('start throws if spawn fails (ENOENT)', async () => {
  const mgr = createManager({ startupTimeout: 100, initialBackoffMs: 50 });
  spawnShouldFail = true; // set AFTER createManager (which resets it)

  await assert.rejects(() => mgr.start(), /ENOENT/);
  assert.equal(mgr.health().status, 'error');
  assert.ok(mgr.health().error?.includes('ENOENT'));
  spawnShouldFail = false;
});

// ---------------------------------------------------------------------------
// ensureRunning()
// ---------------------------------------------------------------------------

test('ensureRunning no-op when already running', async () => {
  const mgr = createManager({ _fetch: okFetch() });
  await mgr.start();

  spawnRecords.length = 0;
  await mgr.ensureRunning();

  assert.equal(spawnRecords.length, 0);
  assert.equal(mgr.health().status, 'running');
});

test('ensureRunning calls start when stopped', async () => {
  const mgr = createManager({ _fetch: okFetch() });
  spawnRecords.length = 0;

  await mgr.ensureRunning();

  assert.equal(spawnRecords.length, 1);
  assert.equal(mgr.health().status, 'running');
});

test('ensureRunning throws when start fails', async () => {
  const mgr = createManager({ startupTimeout: 300, _fetch: failFetch() });

  await assert.rejects(() => mgr.ensureRunning(), /timed out/i);
  assert.equal(mgr.health().status, 'error');
});

test('ensureRunning waits for in-progress start', async () => {
  const mgr = createManager({ _fetch: okFetch() });

  const startPromise = mgr.start();
  const ensurePromise = mgr.ensureRunning();

  await Promise.all([startPromise, ensurePromise]);
  assert.equal(mgr.health().status, 'running');
});

// ---------------------------------------------------------------------------
// stop()
// ---------------------------------------------------------------------------

test('stop sends SIGTERM and cleans up', async () => {
  const mgr = createManager({ _fetch: okFetch() });
  await mgr.start();

  const child = currentChild!;
  assert.ok(child);

  const stopPromise = mgr.stop();
  assert.equal(child.killedSignal, 'SIGTERM', 'should have sent SIGTERM');

  child.emit('exit', 0, 'SIGTERM');
  await stopPromise;

  assert.equal(mgr.health().status, 'stopped');
  assert.equal(mgr.health().port, undefined);
});

test('stop is safe when not started', async () => {
  const mgr = new SidecarManager();
  await (mgr as any).stop();
  assert.equal((mgr as any).health().status, 'stopped');
});

test('stop is safe when process already exited', async () => {
  const mgr = createManager({ _fetch: okFetch() });
  await mgr.start();

  const child = currentChild!;
  child.emit('exit', 0, null);
  await new Promise((r) => setImmediate(r));

  await mgr.stop();
  assert.equal(mgr.health().status, 'stopped');
});

// ---------------------------------------------------------------------------
// getBaseUrl()
// ---------------------------------------------------------------------------

test('getBaseUrl throws if not started', () => {
  const mgr = new SidecarManager();
  assert.throws(() => (mgr as any).getBaseUrl(), /not started/);
});

test('getBaseUrl returns correct URL after start', async () => {
  const mgr = createManager({ _fetch: okFetch() });
  await mgr.start();

  assert.equal(mgr.getBaseUrl(), `http://127.0.0.1:${TEST_PORT}`);
});

// ---------------------------------------------------------------------------
// Crash recovery
// ---------------------------------------------------------------------------

test('auto-restarts on unexpected process exit', async () => {
  const mgr = createManager({ initialBackoffMs: 50, _fetch: okFetch() });
  await mgr.start();
  assert.equal(spawnRecords.length, 1);
  currentChild!.emit('exit', 1, null);
  await waitFor(() => spawnRecords.length >= 2);
  assert.equal(mgr.health().status, 'running');
});

// ---------------------------------------------------------------------------
// Max retries
// ---------------------------------------------------------------------------

test('gives up after 5 consecutive crashes', async () => {
  const mgr = createManager({ initialBackoffMs: 20, maxBackoffMs: 500, _fetch: okFetch() });
  await mgr.start();
  for (let i = 0; i < 5; i++) {
    await waitFor(() => mgr.health().status === 'running' || mgr.health().status === 'error');
    if (mgr.health().status === 'error') break;
    if (currentChild) currentChild.emit('exit', 1, null);
  }
  await waitFor(() => mgr.health().status === 'error');
  assert.ok((mgr.health().error ?? '').toLowerCase().includes('crash'));
  const spawnCountAfter = spawnRecords.length;
  await new Promise(r => setTimeout(r, 100));
  assert.equal(spawnRecords.length, spawnCountAfter);
});

// ---------------------------------------------------------------------------
// Startup timeout
// ---------------------------------------------------------------------------

test('start throws on startup timeout', async () => {
  const mgr = createManager({ startupTimeout: 300, _fetch: loadingFetch() });

  await assert.rejects(() => mgr.start(), /timed out/i);
  assert.equal(mgr.health().status, 'error');
  assert.ok(
    (mgr.health().error ?? '').toLowerCase().includes('timed out'),
    'error should mention timeout',
  );
});
