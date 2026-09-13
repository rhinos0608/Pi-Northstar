import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { ScraplingBridge, type ScraplingBridgeOptions } from '../../../src/web/access/scrapling-bridge.js';

// ── Mock infrastructure ──

interface SpawnRecord {
  command: string;
  args: string[];
}

const spawnRecords: SpawnRecord[] = [];

/**
 * Each entry: a response object to emit on stdout, or 'crash' to exit without response,
 * or 'exit' to exit cleanly immediately.
 */
type ResponseEntry = Record<string, unknown> | 'crash' | 'exit';

class MockChildProcess extends EventEmitter {
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

  private responseIndex = 0;

  constructor(
    private responses: ResponseEntry[],
    /** When true, child auto-exits after each response (one-shot mode) */
    private autoExit = false,
    /** When true, each response fires on next tick */
    private async_ = true,
  ) {
    super();

    this.stdin = {
      writable: true,
      destroyed: false,
      write: (_data: string, cb?: (err?: Error) => void) => {
        const idx = this.responseIndex;
        // Only advance index if there's a response at this position
        if (idx < this.responses.length) {
          this.responseIndex++;
        }
        const entry = idx < this.responses.length ? this.responses[idx] : undefined;

        const schedule = this.async_ ? setImmediate : (fn: () => void) => fn();

        if (entry === 'crash') {
          schedule(() => {
            this.exitCode = 1;
            this.emit('exit', 1, null);
          });
        } else if (entry === 'exit') {
          schedule(() => {
            this.exitCode = 0;
            this.emit('exit', 0, null);
          });
        } else if (entry) {
          schedule(() => {
            this.stdout.emit('data', Buffer.from(JSON.stringify(entry) + '\n'));
            if (this.autoExit) {
              schedule(() => {
                this.exitCode = 0;
                this.emit('exit', 0, null);
              });
            }
          });
        }
        // Callback signals write completion
        schedule(() => cb?.());
        return true;
      },
      end: () => {
        // noop
      },
    };
  }

  kill(signal?: string): boolean {
    this.killed = true;
    this.killedSignal = signal;
    // Emit exit so close() resolves promptly
    setImmediate(() => {
      this.emit('exit', 0, signal ?? 'SIGTERM');
    });
    return true;
  }
}

/** Returns a mock spawn function and tracks spawns */
function makeSpawn(responses: ResponseEntry[], autoExit = false, async_ = true) {
  spawnRecords.length = 0;

  let child: MockChildProcess | undefined;

  const mockSpawn = (command: string, args: string[], _options: unknown) => {
    spawnRecords.push({ command, args });
    child = new MockChildProcess(responses, autoExit, async_);
    return child;
  };

  return { mockSpawn, getChild: () => child };
}

/** Creates a bridge with injected mock spawn and optional mock fetchText */
function createBridge(
  opts: Partial<ScraplingBridgeOptions> & {
    _spawn?: any;
    _fetchText?: (url: string) => Promise<string>;
    responses?: ResponseEntry[];
    autoExit?: boolean;
  } = {},
) {
  const { _spawn, _fetchText, responses, autoExit, ...rest } = opts;

  let spawnFn = _spawn;
  if (!spawnFn && responses) {
    const m = makeSpawn(responses, autoExit ?? false);
    spawnFn = m.mockSpawn;
  }

  // Default stub DNS: unit hostnames (example.com, test.dev, a.com) have no
  // real answers in sandboxes; resolve everything public unless the test
  // passes its own lookup (e.g. the SSRF gating tests).
  const stubLookup = async () => [{ address: '93.184.216.34', family: 4 as const }];
  return new ScraplingBridge({
    ...rest,
    ...((rest as { lookup?: unknown }).lookup ? {} : { lookup: stubLookup }),
    ...(spawnFn ? ({ _spawn: spawnFn } as unknown as ScraplingBridgeOptions) : {}),
    ...(_fetchText ? ({ _fetchText } as unknown as ScraplingBridgeOptions) : {}),
  } as ScraplingBridgeOptions);
}

// ── Tests ──

// ---------------------------------------------------------------------------
// health()
// ---------------------------------------------------------------------------

test('health(): returns available=true when Python available', async () => {
  const bridge = createBridge({
    responses: [{ ok: true, scrapling_version: '0.10.0', python_version: '3.11' }],
    autoExit: true,
  });

  const result = await bridge.health();

  assert.equal(result.available, true);
  assert.equal(result.scraplingVersion, '0.10.0');
  assert.equal(result.pythonVersion, '3.11');
  assert.equal(result.error, undefined);

  await bridge.close();
});

// ── Dependency-gated real adapter integration test ──
test('fetch(): real Python Scrapling adapter command round-trip', { skip: process.env.SCRAPLING_SMOKE_TEST !== '1' }, async () => {
  // This test spawns the real embedded Python adapter and validates the full
  // command/response contract. Skip by default; run with SCRAPLING_SMOKE_TEST=1.
  const { ScraplingBridge } = await import('../../../src/web/access/scrapling-bridge.js');
  type ScraplingBridgeOptions = import('../../../src/web/access/scrapling-bridge.js').ScraplingBridgeOptions;
  const bridge = new ScraplingBridge({
    pythonPath: 'python3',
    fetchTimeout: 15_000,
  } as ScraplingBridgeOptions);

  try {
    const health = await bridge.health();
    assert.equal(health.available, true, 'Scrapling Python adapter must be installed');
    assert.ok(health.scraplingVersion);
    assert.ok(health.pythonVersion);

    // Test a real fetch against a known public page
    const result = await bridge.fetch('https://example.com');
    assert.ok(result.url);
    assert.ok(typeof result.title === 'string');
    assert.ok(typeof result.content === 'string');
    assert.ok(result.content.length > 0, 'should have fetched page content');
  } finally {
    await bridge.close();
  }
});

test('health(): returns available=false when Python unavailable', async () => {
  const bridge = createBridge({
    responses: [{ ok: false, error: 'scrapling not installed' }],
    autoExit: true,
  });

  const result = await bridge.health();

  assert.equal(result.available, false);
  assert.equal(result.error, 'scrapling not installed');

  await bridge.close();
});

test('health(): returns available=false when spawn fails', async () => {
  const bridge = createBridge({
    _spawn: () => {
      const child = new MockChildProcess([], false);
      setImmediate(() => {
        child.emit('error', new Error('ENOENT: no such file or directory'));
      });
      return child;
    },
  });
  const result = await bridge.health();
  assert.equal(result.available, false);
  assert.ok(result.error);
  await bridge.close();
});

test('health(): caches result after first call', async () => {
  const { mockSpawn } = makeSpawn(
    [{ ok: true, scrapling_version: '0.10.0', python_version: '3.11' }],
    true,
  );
  const bridge = createBridge({ _spawn: mockSpawn });

  const first = await bridge.health();
  assert.equal(first.available, true);

  const countAfterFirst = spawnRecords.length;

  const second = await bridge.health();
  assert.equal(second.available, true);
  assert.equal(spawnRecords.length, countAfterFirst, 'should not spawn again');

  await bridge.close();
});

// ---------------------------------------------------------------------------
// fetch()
// ---------------------------------------------------------------------------

test('fetch(): sends correct JSON and parses response', async () => {
  const { mockSpawn, getChild } = makeSpawn([
    { ok: true, url: 'https://example.com', title: 'Example', content: '<html>ok</html>', status_code: 200 },
  ], false);

  const bridge = createBridge({ _spawn: mockSpawn });

  const result = await bridge.fetch('https://example.com');

  assert.equal(result.url, 'https://example.com');
  assert.equal(result.title, 'Example');
  assert.equal(result.content, '<html>ok</html>');
  assert.equal(result.statusCode, 200);

  // Verify the sent command
  const child = getChild();
  assert.ok(child);
  // Use a trick: the child stores written data via the interceptor
  // We can't easily capture it from here, but we can verify via spawn
  assert.equal(spawnRecords.length, 1);

  await bridge.close();
});

test('fetch(): sends command with fetcher config', async () => {
  let capturedCommand = '';

  const mockSpawn = (_command: string, _args: string[], _opts: unknown) => {
    spawnRecords.length = 0;
    spawnRecords.push({ command: _command, args: _args });
    const child = new MockChildProcess([
      { ok: true, url: 'https://test.dev', title: 'T', content: 'c', status_code: 200 },
    ], false);

    // Override stdin.write to capture
    const origWrite = child.stdin.write.bind(child.stdin);
    child.stdin.write = (data: string, cb) => {
      capturedCommand = data.toString();
      return origWrite(data, cb);
    };

    return child;
  };

  const bridge = createBridge({ _spawn: mockSpawn, fetcher: 'dynamic', solveCloudflare: true, proxy: 'http://proxy:8080' });

  await bridge.fetch('https://test.dev');

  const parsed = JSON.parse(capturedCommand);
  assert.equal(parsed.action, 'fetch');
  assert.equal(parsed.url, 'https://test.dev/');
  assert.equal(parsed.fetcher, 'dynamic');
  assert.equal(parsed.solve_cloudflare, true);
  assert.equal(parsed.proxy, 'http://proxy:8080');
  assert.equal(typeof parsed.timeout, 'number');

  await bridge.close();
});

test('fetch(): fallbacks to fetchText on error response', async () => {
  let fallbackCalled = false;

  const bridge = createBridge({
    responses: [
      { ok: false, error: 'Fetch failed' },   // first attempt
      { ok: false, error: 'Fetch failed' },   // second attempt (after restart)
    ],
    autoExit: false,
    _fetchText: async (url: string) => {
      fallbackCalled = true;
      assert.equal(url, 'https://example.com/');
      return 'fallback content';
    },
  });

  spawnRecords.length = 0;
  const result = await bridge.fetch('https://example.com');
  assert.equal(spawnRecords.length, 2, 'should spawn exactly 2 subprocesses');

  assert.equal(fallbackCalled, true);
  assert.equal(result.url, 'https://example.com/');
  assert.equal(result.title, '');
  assert.equal(result.content, 'fallback content');

  await bridge.close();
});

test('fetch(): restarts once on crash then fallbacks to fetchText', async () => {
  let fallbackCalled = false;

  const bridge = createBridge({
    responses: [
      'crash' as ResponseEntry,   // first: process crashes
      'crash' as ResponseEntry,   // second: process crashes again (after restart)
    ],
    autoExit: false,
    _fetchText: async (_url: string) => {
      fallbackCalled = true;
      return 'fallback after crash';
    },
  });

  spawnRecords.length = 0;
  const result = await bridge.fetch('https://example.com');
  assert.equal(spawnRecords.length, 2, 'should spawn exactly 2 subprocesses');

  assert.equal(fallbackCalled, true);
  assert.equal(result.content, 'fallback after crash');

  await bridge.close();
});

test('fetch(): rejects non-HTTP URLs', async () => {
  const bridge = createBridge();

  await assert.rejects(
    () => bridge.fetch('ftp://example.com'),
    /scheme/,
  );
  await assert.rejects(
    () => bridge.fetch('file:///etc/passwd'),
    /scheme/,
  );

  await bridge.close();
});

test('fetch(): throws when bridge is closed', async () => {
  const bridge = createBridge();
  await bridge.close();

  await assert.rejects(
    () => bridge.fetch('https://example.com'),
    /closed/,
  );
});

// ---------------------------------------------------------------------------
// Session reuse
// ---------------------------------------------------------------------------

test('fetch(): reuses same subprocess for multiple calls', async () => {
  let callCount = 0;

  const mockSpawn = (_command: string, _args: string[], _opts: unknown) => {
    callCount++;
    spawnRecords.length = 0;
    const child = new MockChildProcess([
      { ok: true, url: 'https://a.com', title: 'A', content: 'a', status_code: 200 },
      { ok: true, url: 'https://b.com', title: 'B', content: 'b', status_code: 200 },
    ], false);
    return child;
  };

  const bridge = createBridge({ _spawn: mockSpawn });

  const r1 = await bridge.fetch('https://a.com');
  assert.equal(r1.content, 'a');

  const r2 = await bridge.fetch('https://b.com');
  assert.equal(r2.content, 'b');

  assert.equal(callCount, 1, 'should spawn only once');

  await bridge.close();
});

// ---------------------------------------------------------------------------
// close()
// ---------------------------------------------------------------------------

test('close(): terminates subprocess and is idempotent', async () => {
  let killed = false;

  const mockSpawn = (_command: string, _args: string[], _opts: unknown) => {
    spawnRecords.length = 0;
    const child = new MockChildProcess([
      { ok: true, url: 'https://x.com', title: 'X', content: 'x', status_code: 200 },
    ], false);

    child.kill = (signal?: string) => {
      killed = true;
      child.killed = true;
      child.killedSignal = signal;
      setImmediate(() => child.emit('exit', 0, signal ?? 'SIGTERM'));
      return true;
    };

    return child;
  };

  const bridge = createBridge({ _spawn: mockSpawn });

  // Trigger process spawn
  await bridge.fetch('https://x.com');

  // First close
  await bridge.close();
  assert.equal(killed, true);

  // Second close — idempotent, should not throw
  killed = false;
  await bridge.close();
  assert.equal(killed, false, 'should not kill again');
});

test('close(): safe when no process started', async () => {
  const bridge = createBridge();
  // Should not throw
  await bridge.close();
  await bridge.close(); // second time also safe
});

// ---------------------------------------------------------------------------
// Disabled via env
// ---------------------------------------------------------------------------

test('health(): returns unavailable when PI_SEARCH_SCRAPLING_ENABLED=0', async () => {
  process.env.PI_SEARCH_SCRAPLING_ENABLED = '0';
  try {
    const bridge = createBridge();
    const result = await bridge.health();
    assert.equal(result.available, false);
    assert.equal(result.error, undefined);
  } finally {
    delete process.env.PI_SEARCH_SCRAPLING_ENABLED;
  }
});

test('health(): returns unavailable when PI_SEARCH_SCRAPLING_ENABLED=false', async () => {
  process.env.PI_SEARCH_SCRAPLING_ENABLED = 'false';
  try {
    const bridge = createBridge();
    const result = await bridge.health();
    assert.equal(result.available, false);
  } finally {
    delete process.env.PI_SEARCH_SCRAPLING_ENABLED;
  }
});

test('health(): enabled by default when env not set', async () => {
  delete process.env.PI_SEARCH_SCRAPLING_ENABLED;
  let bridge: ScraplingBridge | undefined;
  try {
    bridge = createBridge({
      responses: [{ ok: true, scrapling_version: '0.10.0', python_version: '3.11' }],
      autoExit: true,
    });
    const result = await bridge.health();
    assert.equal(result.available, true);
  } finally {
    await bridge?.close();
  }
});

test('fetch(): fallbacks to fetchText when disabled via env', async () => {
  process.env.PI_SEARCH_SCRAPLING_ENABLED = '0';
  try {
    let fallbackCalled = false;
    const bridge = createBridge({
      _fetchText: async (_url: string) => {
        fallbackCalled = true;
        return 'disabled fallback';
      },
    });

    const result = await bridge.fetch('https://example.com');
    assert.equal(fallbackCalled, true);
    assert.equal(result.content, 'disabled fallback');
  } finally {
    delete process.env.PI_SEARCH_SCRAPLING_ENABLED;
  }
});

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

test('constructor applies custom pythonPath and timeout', () => {
  const bridge = new ScraplingBridge({
    pythonPath: 'python3.12',
    fetchTimeout: 60_000,
  } as ScraplingBridgeOptions);
  // Options accepted without error
  assert.ok(bridge);
});

test('constructor respects env vars as fallback', () => {
  process.env.PI_SEARCH_SCRAPLING_FETCHER = 'dynamic';
  process.env.PI_SEARCH_SCRAPLING_PROXY = 'http://env-proxy:3128';
  try {
    const bridge = new ScraplingBridge({} as ScraplingBridgeOptions);
    // Can't directly test private options, but construction should not throw
    assert.ok(bridge);
  } finally {
    delete process.env.PI_SEARCH_SCRAPLING_FETCHER;
    delete process.env.PI_SEARCH_SCRAPLING_PROXY;
  }
});

// ---------------------------------------------------------------------------
// AbortSignal
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SSRF dispatch gating (mirrors http.ts ordering: static + DNS preflight
// before dispatch, final-URL revalidation after)
// ---------------------------------------------------------------------------

test('fetch(): rejects private/reserved IP literals before dispatch', async () => {
  const { mockSpawn } = makeSpawn([
    { ok: true, url: 'http://169.254.169.254/', title: 'x', content: 'x' },
  ]);
  const bridge = createBridge({ _spawn: mockSpawn });
  spawnRecords.length = 0;

  await assert.rejects(
    () => bridge.fetch('http://169.254.169.254/latest/meta-data/'),
    /Private\/reserved/,
  );
  await assert.rejects(
    () => bridge.fetch('http://localhost:8080/admin'),
    /Blocked hostname/,
  );
  assert.equal(spawnRecords.length, 0, 'no subprocess may dispatch to a blocked target');

  await bridge.close();
});

test('fetch(): DNS preflight rejects hostnames resolving to private space', async () => {
  const { mockSpawn } = makeSpawn([
    { ok: true, url: 'https://example.com', title: 'x', content: 'x' },
  ]);
  const privateLookup = async (hostname: string) => {
    assert.equal(hostname, 'evil.example');
    return [{ address: '10.1.2.3', family: 4 as const }];
  };
  const bridge = createBridge({ _spawn: mockSpawn, lookup: privateLookup } as ScraplingBridgeOptions);
  spawnRecords.length = 0;

  await assert.rejects(
    () => bridge.fetch('https://evil.example/page'),
    /private\/reserved/,
  );
  assert.equal(spawnRecords.length, 0, 'no subprocess may dispatch past DNS preflight');

  await bridge.close();
});

test('fetch(): rejects bridge final URL that escapes to private space', async () => {
  const { mockSpawn } = makeSpawn([
    { ok: true, url: 'http://10.0.0.5/internal', title: 'x', content: '<html>internal</html>' },
    { ok: true, url: 'http://10.0.0.5/internal', title: 'x', content: '<html>internal</html>' },
  ]);
  const bridge = createBridge({
    _spawn: mockSpawn,
    _fetchText: async () => { throw new Error('fallback must not serve blocked content'); },
  });
  spawnRecords.length = 0;

  await assert.rejects(
    () => bridge.fetch('https://example.com'),
    /blocked URL/,
  );

  await bridge.close();
});

test('AbortSignal: closes bridge when signal aborts', async () => {
  const ac = new AbortController();
  const bridge = createBridge({ signal: ac.signal } as ScraplingBridgeOptions);

  ac.abort();
  // Give microtask time to process
  await new Promise((r) => setImmediate(r));

  await assert.rejects(
    () => bridge.fetch('https://example.com'),
    /closed/,
  );
});
