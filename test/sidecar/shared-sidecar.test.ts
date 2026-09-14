import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { SidecarManager } from '../../src/sidecar/sidecar-manager.js';
import {
  __peekSharedSidecarForTests,
  __resetSharedSidecarForTests,
  __setSharedSidecarFactoryForTests,
  __sharedSidecarRefCountForTests,
  acquireEmbeddingSidecar,
  shutdownSharedSidecar,
} from '../../src/sidecar/shared-sidecar.js';

// ── Mock infrastructure (mirrors test/sidecar-manager.test.ts) ──

const TEST_PORT = 34567;

class MockChildProcess extends EventEmitter {
  public killedSignal: string | undefined;
  public readonly stdout = new EventEmitter();
  public readonly stdin = {
    write: (_chunk: string, cb?: (err?: Error | null) => void): boolean => {
      setImmediate(() => cb?.(null));
      return true;
    },
  };
  public kill(signal?: string): boolean {
    this.killedSignal = signal;
    return true;
  }
}

class MockNetServer {
  on(): this { return this; }
  listen(_port: number, cb?: () => void): this { cb?.(); return this; }
  address() {
    return { port: TEST_PORT, family: 'IPv4' as const, address: '127.0.0.1' as const };
  }
  close(cb?: () => void): this { cb?.(); return this; }
}

let spawnCount = 0;
let currentChild: MockChildProcess | undefined;
let spawnShouldFail = false;

function mockSpawn(): unknown {
  spawnCount += 1;
  const child = new MockChildProcess();
  currentChild = child;
  if (spawnShouldFail) {
    setImmediate(() => child.emit('error', new Error('ENOENT: python3 not found')));
  } else {
    setImmediate(() => child.stdout.emit('data', Buffer.from(`SIDECAR_PORT=${TEST_PORT}\n`)));
  }
  return child;
}

function okFetch(): typeof globalThis.fetch {
  return async () =>
    new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
}

const realFetch = globalThis.fetch;
const realExternalUrl = process.env.EMBEDDING_SIDECAR_BASE_URL;

beforeEach(() => {
  // Isolate from developer shells that export an external sidecar URL.
  delete process.env.EMBEDDING_SIDECAR_BASE_URL;
  __resetSharedSidecarForTests();
  spawnCount = 0;
  currentChild = undefined;
  spawnShouldFail = false;
  globalThis.fetch = okFetch();
  __setSharedSidecarFactoryForTests(
    () =>
      new SidecarManager({
        startupTimeout: 5000,
        initialBackoffMs: 50,
        maxBackoffMs: 500,
        _spawn: mockSpawn as never,
        _createServer: (() => new MockNetServer()) as never,
      }),
  );
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  if (realExternalUrl !== undefined) process.env.EMBEDDING_SIDECAR_BASE_URL = realExternalUrl;
  else delete process.env.EMBEDDING_SIDECAR_BASE_URL;
  const child = currentChild;
  const shutdown = shutdownSharedSidecar();
  // Let stop()'s SIGTERM land, then complete the exit handshake.
  await new Promise((r) => setImmediate(r));
  child?.emit('exit', 0, 'SIGTERM');
  await shutdown;
  __resetSharedSidecarForTests();
});

// ── Tests ──

test('reuses one sidecar across sequential acquires (single spawn)', async () => {
  const first = await acquireEmbeddingSidecar({});
  assert.equal(spawnCount, 1);
  assert.equal(first.external, false);
  assert.equal(first.baseUrl, `http://127.0.0.1:${TEST_PORT}`);
  first.release();

  const second = await acquireEmbeddingSidecar({});
  assert.equal(spawnCount, 1);
  assert.equal(second.baseUrl, first.baseUrl);
  second.release();
});

test('concurrent acquires share the singleton', async () => {
  const [a, b] = await Promise.all([acquireEmbeddingSidecar({}), acquireEmbeddingSidecar({})]);
  assert.equal(spawnCount, 1);
  assert.equal(__sharedSidecarRefCountForTests(), 2);
  a.release();
  b.release();
  assert.equal(__sharedSidecarRefCountForTests(), 0);
});

test('release is idempotent and never stops the process', async () => {
  const acquired = await acquireEmbeddingSidecar({});
  acquired.release();
  acquired.release();
  assert.equal(__sharedSidecarRefCountForTests(), 0);
  // Singleton stays running for the next caller.
  assert.equal(__peekSharedSidecarForTests()?.health().status, 'running');
});

test('external EMBEDDING_SIDECAR_BASE_URL bypasses local lifecycle', async () => {
  const acquired = await acquireEmbeddingSidecar({ EMBEDDING_SIDECAR_BASE_URL: 'http://external:9000/' });
  assert.equal(acquired.external, true);
  assert.equal(acquired.baseUrl, 'http://external:9000');
  assert.equal(spawnCount, 0);
  assert.equal(__peekSharedSidecarForTests(), undefined);
  acquired.release(); // no-op, must not throw
});

test('local acquire returns the singleton auth token', async () => {
  const acquired = await acquireEmbeddingSidecar({});
  try {
    const manager = __peekSharedSidecarForTests();
    assert.ok(manager);
    assert.equal(typeof acquired.apiToken, 'string');
    assert.match(acquired.apiToken!, /^[0-9a-f]{64}$/);
    assert.equal(acquired.apiToken, manager.getAuthToken());
  } finally {
    acquired.release();
  }
});

test('local acquire returns a provider that tracks the live manager token', async () => {
  const acquired = await acquireEmbeddingSidecar({});
  try {
    const manager = __peekSharedSidecarForTests();
    assert.ok(manager);
    assert.equal(typeof acquired.apiTokenProvider, 'function');
    // Provider matches the live token at acquisition time.
    assert.equal(acquired.apiTokenProvider!(), manager.getAuthToken());
    // Provider is dynamic: after stop() clears the manager token the
    // provider reflects undefined while the apiToken snapshot is stale.
    // (stop() here targets the singleton directly; the handle stays open.)
    const stopping = manager.stop();
    currentChild?.emit('exit', 0, 'SIGTERM');
    await stopping;
    assert.equal(manager.getAuthToken(), undefined);
    assert.equal(acquired.apiTokenProvider!(), undefined);
    assert.match(acquired.apiToken ?? '', /^[0-9a-f]{64}$/);
  } finally {
    acquired.release();
  }
});

test('external path returns undefined apiToken (env fallback unchanged)', async () => {
  const acquired = await acquireEmbeddingSidecar({ EMBEDDING_SIDECAR_BASE_URL: 'http://external:9000/' });
  assert.equal(acquired.external, true);
  assert.equal(acquired.apiToken, undefined);
  acquired.release(); // no-op, must not throw
});

test('acquire failure propagates so callers fall back to BM25', async () => {
  spawnShouldFail = true;
  await assert.rejects(() => acquireEmbeddingSidecar({}), /ENOENT/);
  assert.equal(__sharedSidecarRefCountForTests(), 0);
});

test('shutdownSharedSidecar stops the singleton', async () => {
  const acquired = await acquireEmbeddingSidecar({});
  acquired.release();
  const child = currentChild;
  assert.ok(child);
  const shutdown = shutdownSharedSidecar();
  await new Promise((r) => setImmediate(r));
  assert.equal(child.killedSignal, 'SIGTERM');
  child.emit('exit', 0, 'SIGTERM');
  await shutdown;
  assert.equal(__peekSharedSidecarForTests(), undefined);
  assert.equal(__sharedSidecarRefCountForTests(), 0);
});
