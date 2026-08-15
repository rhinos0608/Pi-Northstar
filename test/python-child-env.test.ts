import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { buildPythonChildEnvironment } from '../src/python-child-env.js';

// ──────────────────────────────────────────────
// Part 1: Direct unit tests for buildPythonChildEnvironment
// ──────────────────────────────────────────────

test('excludes sentinel secret not in allowlist', () => {
  process.env.TEST_SECRET_TOKEN = 'sentinel-value';
  try {
    const env = buildPythonChildEnvironment();
    assert.equal(env.TEST_SECRET_TOKEN, undefined);
  } finally {
    delete process.env.TEST_SECRET_TOKEN;
  }
});

test('passes through allowlisted PATH and HOME', () => {
  const parentEnv: Record<string, string> = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/home/testuser',
    USERPROFILE: 'C:\\Users\\testuser',
    TMPDIR: '/tmp',
    LANG: 'en_US.UTF-8',
  };
  const env = buildPythonChildEnvironment(parentEnv);
  assert.equal(env.PATH, parentEnv.PATH);
  assert.equal(env.HOME, parentEnv.HOME);
  assert.equal(env.USERPROFILE, parentEnv.USERPROFILE);
  assert.equal(env.TMPDIR, parentEnv.TMPDIR);
  assert.equal(env.LANG, parentEnv.LANG);
});

test('excludes vars matching BLOCKED_PATTERN (TOKEN/KEY/SECRET/AUTH/...)', () => {
  const parentEnv: Record<string, string> = {
    PATH: '/usr/bin',
    HOME: '/home/user',
    PI_SEARCH_SCRAPLING_ENABLED: '1',
    // Vars matching BLOCKED_PATTERN — excluded even if parentEnv had them
    GITHUB_TOKEN: 'ghp_should-not-leak',
    AWS_SECRET_ACCESS_KEY: 'wJalr-should-not-leak',
    DB_PASSWORD: 'should-not-leak',
    AUTH_TOKEN: 'should-not-leak',
    BEARER_TOKEN: 'should-not-leak',
    COOKIE_SESSION: 'should-not-leak',
    MY_API_KEY: 'should-not-leak',
    API_SECRET: 'should-not-leak',
    NODE_OPTIONS: '--inspect',
    NODE_PATH: '/some/node/path',
    PYTHONPATH: '/some/python/path',
    GIT_CONFIG_CREDENTIALS: 'should-not-leak',
    SSL_CERT_FILE: '/some/cert',
    LD_PRELOAD: '/some/lib.so',
    DYLD_INSERT_LIBRARIES: '/some/lib.dylib',
    npm_config_registry: 'http://evil-registry',
  };
  const env = buildPythonChildEnvironment(parentEnv);
  // Allowlisted vars pass through
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/user');
  assert.equal(env.PI_SEARCH_SCRAPLING_ENABLED, '1');
  // BLOCKED_PATTERN vars excluded
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.DB_PASSWORD, undefined);
  assert.equal(env.AUTH_TOKEN, undefined);
  assert.equal(env.BEARER_TOKEN, undefined);
  assert.equal(env.COOKIE_SESSION, undefined);
  assert.equal(env.MY_API_KEY, undefined);
  assert.equal(env.API_SECRET, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.NODE_PATH, undefined);
  assert.equal(env.PYTHONPATH, undefined);
  assert.equal(env.GIT_CONFIG_CREDENTIALS, undefined);
  assert.equal(env.SSL_CERT_FILE, undefined);
  assert.equal(env.LD_PRELOAD, undefined);
  assert.equal(env.DYLD_INSERT_LIBRARIES, undefined);
  assert.equal(env.npm_config_registry, undefined);
});

// ──────────────────────────────────────────────
// Part 2: Call-site integration tests
// All 3 real spawn call sites must pass buildPythonChildEnvironment() as env.
// ──────────────────────────────────────────────

// --- Mock child for ScraplingBridge ---

class ScMockChildProcess extends EventEmitter {
  public pid = 98765;
  public killed = false;
  public killedSignal: string | undefined;
  public exitCode: number | null = null;
  public signalCode: string | null = null;
  public readonly stdout = new EventEmitter() as EventEmitter & { readable: boolean };
  public readonly stderr = new EventEmitter();
  public stdin: {
    writable: boolean;
    destroyed: boolean;
    write: (data: string, cb?: (err?: Error) => void) => boolean;
    end: () => void;
  };

  constructor(onWrite: (data: string) => void) {
    super();
    this.stdin = {
      writable: true,
      destroyed: false,
      write: (_data: string, cb?: (err?: Error) => void) => {
        onWrite(_data);
        setImmediate(() => cb?.());
        return true;
      },
      end: () => {},
    };
  }

  kill(signal?: string): boolean {
    this.killed = true;
    this.killedSignal = signal;
    setImmediate(() => this.emit('exit', 0, signal ?? 'SIGTERM'));
    return true;
  }
}

/** Creates a ScraplingBridge with a _spawn that captures env and returns a process that responds quickly. */
function scraplingSpawnRecorder(records: Array<{ command: string; args: string[]; options: { env?: Record<string, string> } }>, responseObj: Record<string, unknown>) {
  return (command: string, args: string[], options: { env?: Record<string, string> }) => {
    records.push({ command, args, options });
    const child = new ScMockChildProcess(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify(responseObj) + '\n'));
    });
    return child;
  };
}

test('spawnProcess (via fetch) passes buildPythonChildEnvironment as env option', async () => {
  const { ScraplingBridge } = await import('../src/scrapling-bridge.js');
  const records: Array<{ command: string; args: string[]; options: { env?: Record<string, string> } }> = [];

  const bridge = new ScraplingBridge({
    fetchTimeout: 5000,
    _spawn: scraplingSpawnRecorder(records, {
      ok: true,
      url: 'https://example.com/',
      title: 'T',
      content: 'c',
      status_code: 200,
    }),
  } as any);

  process.env.TEST_SECRET_TOKEN = 'sentinel';
  try {
    await bridge.fetch('https://example.com');
  } finally {
    delete process.env.TEST_SECRET_TOKEN;
    await bridge.close();
  }

  assert.ok(records.length >= 1, 'spawn should have been called (spawnProcess)');
  const env = records[0]!.options.env;
  assert.ok(env, 'spawn should receive env option');
  assert.equal(env!.TEST_SECRET_TOKEN, undefined, 'sentinel secret should not leak via spawnProcess');
});

test('oneShotCommand (via health) passes buildPythonChildEnvironment as env option', async () => {
  const { ScraplingBridge } = await import('../src/scrapling-bridge.js');
  const records: Array<{ command: string; args: string[]; options: { env?: Record<string, string> } }> = [];

  const bridge = new ScraplingBridge({
    fetchTimeout: 5000,
    _spawn: scraplingSpawnRecorder(records, {
      ok: true,
      scrapling_version: '0.10.0',
      python_version: '3.11',
    }),
  } as any);

  process.env.TEST_SECRET_TOKEN = 'sentinel';
  try {
    await bridge.health();
  } finally {
    delete process.env.TEST_SECRET_TOKEN;
    await bridge.close();
  }

  assert.ok(records.length >= 1, 'spawn should have been called (oneShotCommand)');
  const env = records[0]!.options.env;
  assert.ok(env, 'spawn should receive env option');
  assert.equal(env!.TEST_SECRET_TOKEN, undefined, 'sentinel secret should not leak via oneShotCommand');
});

// --- Mock infrastructure for SidecarManager ---

class SmMockChildProcess extends EventEmitter {
  public pid = 98765;
  public killed = false;
  public killedSignal: string | undefined;
  public readonly stdout = new EventEmitter();
  public readonly stderr = new EventEmitter();

  constructor() {
    super();
    setImmediate(() => {
      this.stdout.emit('data', Buffer.from('SIDECAR_PORT=0\n'));
    });
  }

  kill(signal?: string): boolean {
    this.killed = true;
    this.killedSignal = signal;
    setImmediate(() => this.emit('exit', 0, signal ?? 'SIGTERM'));
    return true;
  }
}

class SmMockNetServer {
  on(_event: string, _cb: (...args: unknown[]) => void): this {
    return this;
  }

  listen(_port: number, cb?: () => void): this {
    cb?.();
    return this;
  }

  address() {
    return { port: 0, family: 'IPv4' as const, address: '127.0.0.1' as const };
  }

  close(cb?: () => void): this {
    cb?.();
    return this;
  }
}

test('sidecar-manager start passes buildPythonChildEnvironment as env option', async () => {
  const records: Array<{ command: string; args: string[]; options: unknown }> = [];

  const mockSpawn = (command: string, args: string[], options: unknown) => {
    records.push({ command, args, options });
    return new SmMockChildProcess();
  };

  const mockCreateServer = () => new SmMockNetServer();
  const origFetch = globalThis.fetch;

  process.env.TEST_SECRET_TOKEN = 'sentinel';
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    const { SidecarManager } = await import('../src/sidecar-manager.js');
    const mgr = new SidecarManager({
      startupTimeout: 5000,
      initialBackoffMs: 100,
      maxBackoffMs: 5000,
      _spawn: mockSpawn as any,
      _createServer: mockCreateServer as any,
    });

    try {
      await mgr.start();
    } finally {
      await mgr.stop().catch(() => {});
    }

    assert.ok(records.length >= 1, 'spawn should have been called (SidecarManager start)');
    const rec = records[0]!;
    const env = (rec.options as { env?: Record<string, string> }).env;
    assert.ok(env, 'spawn should receive env option');
    assert.equal(env!.TEST_SECRET_TOKEN, undefined, 'sentinel secret should not leak via SidecarManager start');
  } finally {
    delete process.env.TEST_SECRET_TOKEN;
    globalThis.fetch = origFetch;
  }
});
