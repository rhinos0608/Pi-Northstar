import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateCdpEndpoint, resolveCdpEndpoint, requireWebSocket, importCookiesFromCdp, loginViaCdp, BROWSER_ENV_ALLOWLIST, CdpSession, openCdpSession, cdpScreenshot } from '../src/cdp.js';
import { PROVIDER_DESCRIPTORS } from '../src/providers.js';

// ── validateCdpEndpoint ──

test('validateCdpEndpoint accepts ws://127.0.0.1:9222', () => {
  const info = validateCdpEndpoint('ws://127.0.0.1:9222');
  assert.equal(info.host, '127.0.0.1');
  assert.equal(info.port, 9222);
  assert.equal(info.protocol, 'ws');
  assert.equal(typeof info.path, 'string');
});

test('validateCdpEndpoint accepts ws://localhost:9222', () => {
  const info = validateCdpEndpoint('ws://localhost:9222');
  assert.equal(info.host, 'localhost');
  assert.equal(info.port, 9222);
  assert.equal(info.protocol, 'ws');
});

test('validateCdpEndpoint accepts IPv6 loopback', () => {
  const info = validateCdpEndpoint('ws://[::1]:9222/devtools/browser/abc');
  assert.equal(info.host, '::1');
  assert.equal(info.port, 9222);
  assert.equal(info.protocol, 'ws');
});

test('validateCdpEndpoint accepts http://127.0.0.1:9222', () => {
  const info = validateCdpEndpoint('http://127.0.0.1:9222');
  assert.equal(info.host, '127.0.0.1');
  assert.equal(info.port, 9222);
  assert.equal(info.protocol, 'http');
});

test('validateCdpEndpoint accepts ws://127.0.0.1:30000 (high port)', () => {
  const info = validateCdpEndpoint('ws://127.0.0.1:30000');
  assert.equal(info.port, 30000);
});

test('validateCdpEndpoint rejects non-loopback host', () => {
  assert.throws(() => validateCdpEndpoint('ws://192.168.1.1:9222'), /loopback/);
  assert.throws(() => validateCdpEndpoint('ws://example.com:9222'), /loopback/);
  assert.throws(() => validateCdpEndpoint('ws://10.0.0.1:9222'), /loopback/);
});

test('validateCdpEndpoint rejects port below 1024', () => {
  assert.throws(() => validateCdpEndpoint('ws://127.0.0.1:80'), /1024-65535/);
  assert.throws(() => validateCdpEndpoint('ws://127.0.0.1:1023'), /1024-65535/);
});

test('validateCdpEndpoint rejects port above 65535', () => {
  assert.throws(() => validateCdpEndpoint('ws://127.0.0.1:99999'), /1024-65535/);
});

test('validateCdpEndpoint rejects invalid URL', () => {
  assert.throws(() => validateCdpEndpoint('not-a-url'), /Invalid CDP endpoint URL/);
});

test('validateCdpEndpoint rejects non-ws/http scheme', () => {
  assert.throws(() => validateCdpEndpoint('wss://127.0.0.1:9222'), /ws:\/\/ or http:\/\//);
  assert.throws(() => validateCdpEndpoint('https://127.0.0.1:9222'), /ws:\/\/ or http:\/\//);
});

// ── resolveCdpEndpoint ──

test('resolveCdpEndpoint returns ws URL directly for devtools path', async () => {
  const info = validateCdpEndpoint('ws://127.0.0.1:9222/devtools/browser/abc123');
  const result = await resolveCdpEndpoint(info);
  assert.equal(result, 'ws://127.0.0.1:9222/devtools/browser/abc123');
});

test('resolveCdpEndpoint returns IPv6 devtools path', async () => {
  const info = validateCdpEndpoint('ws://[::1]:9222/devtools/browser/abc123');
  const result = await resolveCdpEndpoint(info);
  assert.equal(result, 'ws://[::1]:9222/devtools/browser/abc123');
});

test('resolveCdpEndpoint discovers ws URL from http endpoint (mocked fetch)', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/test123' }) }) as unknown as Response;
  try {
    const info = validateCdpEndpoint('http://127.0.0.1:9222');
    const result = await resolveCdpEndpoint(info);
    assert.equal(result, 'ws://127.0.0.1:9222/devtools/browser/test123');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('resolveCdpEndpoint discovers ws URL from bare ws endpoint (mocked fetch)', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/discovered' }) }) as unknown as Response;
  try {
    const info = validateCdpEndpoint('ws://127.0.0.1:9222');
    const result = await resolveCdpEndpoint(info);
    assert.equal(result, 'ws://127.0.0.1:9222/devtools/browser/discovered');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('resolveCdpEndpoint throws when discovery fails (mocked fetch 500)', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500 } as unknown as Response);
  try {
    const info = validateCdpEndpoint('ws://127.0.0.1:9222');
    await assert.rejects(() => resolveCdpEndpoint(info), /Cannot discover/);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('resolveCdpEndpoint rejects discovered non-loopback ws URL', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://192.168.1.10:9222/devtools/browser/bad' }) }) as unknown as Response;
  try {
    const info = validateCdpEndpoint('http://127.0.0.1:9222');
    await assert.rejects(() => resolveCdpEndpoint(info), /Cannot discover/);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

// ── requireWebSocket ──

test('requireWebSocket does not throw when WebSocket is available', () => {
  requireWebSocket();
});

test('requireWebSocket throws when WebSocket is missing', () => {
  const saved = globalThis.WebSocket;
  (globalThis as any).WebSocket = undefined;
  try {
    assert.throws(() => requireWebSocket(), /WebSocket is not available/);
  } finally {
    (globalThis as any).WebSocket = saved;
  }
});

// ── importCookiesFromCdp (validation paths only, no network) ──

test('importCookiesFromCdp rejects unknown provider', async () => {
  const result = await importCookiesFromCdp('nonexistent_provider', 'ws://127.0.0.1:9222', {});
  assert.equal(result.ok, false);
  assert.match(result.message ?? '', /Unknown provider/);
});

test('importCookiesFromCdp rejects provider without cookieDomains', async () => {
  const result = await importCookiesFromCdp('v2ex', 'ws://127.0.0.1:9222', {});
  assert.equal(result.ok, false);
  assert.match(result.message ?? '', /does not use cookies/);
});

test('importCookiesFromCdp returns opt-out when PI_SEARCH_BROWSER_AUTOMATION=0', async () => {
  const result = await importCookiesFromCdp('facebook', 'ws://127.0.0.1:9222', { PI_SEARCH_BROWSER_AUTOMATION: '0' });
  assert.equal(result.ok, false);
  assert.match(result.message ?? '', /Browser automation disabled/);
});

test('importCookiesFromCdp returns opt-out when PI_SEARCH_BROWSER_AUTOMATION=false', async () => {
  const result = await importCookiesFromCdp('facebook', 'ws://127.0.0.1:9222', { PI_SEARCH_BROWSER_AUTOMATION: 'false' });
  assert.equal(result.ok, false);
  assert.match(result.message ?? '', /Browser automation disabled/);
});

test('importCookiesFromCdp imports provider cookies from browser-level CDP endpoint into isolated state dir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-state-'));
  const savedFetch = globalThis.fetch;
  const savedWebSocket = globalThis.WebSocket;

  class MockWebSocket {
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(readonly url: string) {
      setTimeout(() => this.onopen?.(), 0);
    }

    send(raw: string): void {
      const message = JSON.parse(raw) as { id: number; method: string };
      const result = responseForMethod(message.method);
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: message.id, result }) } as MessageEvent), 0);
    }

    close(): void {}
  }

  function responseForMethod(method: string): Record<string, unknown> {
    if (method === 'Target.createTarget') return { targetId: 'target-1' };
    if (method === 'Target.attachToTarget') return { sessionId: 'session-1' };
    if (method === 'Network.enable') return {};
    if (method === 'Network.getAllCookies') throw new Error('Network.getAllCookies should not be used for provider-scoped import');
    if (method === 'Network.getCookies') {
      return {
        cookies: [
          { name: 'c_user', value: 'facebook_secret', domain: '.facebook.com', path: '/', expires: 1_900_000_000, httpOnly: true, secure: true, sameSite: 'Lax' },
          { name: 'ignored', value: 'other_secret', domain: '.example.com', path: '/', expires: 1_900_000_000, httpOnly: true, secure: true, sameSite: 'Lax' },
        ],
      };
    }
    return {};
  }

  globalThis.fetch = async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/mock' }) }) as unknown as Response;
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = MockWebSocket as unknown as typeof WebSocket;

  try {
    const result = await importCookiesFromCdp('facebook', 'http://127.0.0.1:9222', { PI_SEARCH_STATE_DIR: dir });
    assert.equal(result.ok, true);
    assert.equal(result.count, 1);
    assert.equal(result.storagePath, join(dir, 'cookies', 'facebook.storageState.json'));

    const storage = JSON.parse(await readFile(join(dir, 'cookies', 'facebook.storageState.json'), 'utf8')) as { cookies: Array<Record<string, unknown>> };
    assert.equal(storage.cookies.length, 1);
    assert.equal(storage.cookies[0]?.name, 'c_user');
    assert.equal(storage.cookies[0]?.value, 'facebook_secret');
  } finally {
    globalThis.fetch = savedFetch;
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = savedWebSocket;
    await rm(dir, { recursive: true, force: true });
  }
});

// ── loginViaCdp (validation paths only, no browser spawn) ──

test('loginViaCdp rejects unknown provider', async () => {
  const result = await loginViaCdp('nonexistent', 9222, {});
  assert.equal(result.ok, false);
  assert.match(result.message ?? '', /Unknown provider/);
});

test('loginViaCdp rejects provider without cookieDomains', async () => {
  const result = await loginViaCdp('rss', 9222, {});
  assert.equal(result.ok, false);
  assert.match(result.message ?? '', /does not use cookies/);
});

test('loginViaCdp rejects provider without loginUrl', async () => {
  const result = await loginViaCdp('web', 9222, {});
  assert.equal(result.ok, false);
  assert.match(result.message ?? '', /does not use cookies/);
});

test('loginViaCdp rejects port below 1024', async () => {
  const result = await loginViaCdp('facebook', 80, {});
  assert.equal(result.ok, false);
  assert.match(result.message ?? '', /CDP port must be in range 1024-65535/);
});

test('loginViaCdp rejects port above 65535', async () => {
  const result = await loginViaCdp('facebook', 99999, {});
  assert.equal(result.ok, false);
  assert.match(result.message ?? '', /CDP port must be in range 1024-65535/);
});

test('loginViaCdp rejects NaN port', async () => {
  const result = await loginViaCdp('facebook', Number.NaN, {});
  assert.equal(result.ok, false);
  assert.match(result.message ?? '', /CDP port must be in range 1024-65535/);
});

test('loginViaCdp returns opt-out when PI_SEARCH_BROWSER_AUTOMATION=0', async () => {
  const result = await loginViaCdp('facebook', 9222, { PI_SEARCH_BROWSER_AUTOMATION: '0' });
  assert.equal(result.ok, false);
  assert.match(result.message ?? '', /Browser automation disabled/);
});

// ── loginUrl coverage via provider descriptors (no browser spawn needed) ──

test('all cookie-domain providers have loginUrl defined', () => {
  const cookieProviders = PROVIDER_DESCRIPTORS.filter(d => d.cookieDomains.length > 0);
  for (const desc of cookieProviders) {
    assert.ok(desc.loginUrl, `Provider ${desc.provider} has cookieDomains but no loginUrl`);
  }
});

test('loginUrl values are https URLs', () => {
  const withUrl = PROVIDER_DESCRIPTORS.filter(d => d.loginUrl);
  for (const desc of withUrl) {
    assert.ok(desc.loginUrl!.startsWith('https://'), `Provider ${desc.provider} loginUrl must be https: ${desc.loginUrl}`);
  }
});

test('github provider has loginUrl', () => {
  const desc = PROVIDER_DESCRIPTORS.find(d => d.provider === 'github')!;
  assert.ok(desc.loginUrl);
  assert.equal(desc.loginUrl, 'https://github.com/login');
});

test('twitter provider has loginUrl', () => {
  const desc = PROVIDER_DESCRIPTORS.find(d => d.provider === 'twitter')!;
  assert.ok(desc.loginUrl);
  assert.equal(desc.loginUrl, 'https://x.com/login');
});

test('reddit provider has loginUrl', () => {
  const desc = PROVIDER_DESCRIPTORS.find(d => d.provider === 'reddit')!;
  assert.ok(desc.loginUrl);
  assert.equal(desc.loginUrl, 'https://www.reddit.com/login');
});

test('bilibili provider has loginUrl', () => {
  const desc = PROVIDER_DESCRIPTORS.find(d => d.provider === 'bilibili')!;
  assert.ok(desc.loginUrl);
  assert.equal(desc.loginUrl, 'https://www.bilibili.com/');
});

// ── BROWSER_ENV_ALLOWLIST ──

test('BROWSER_ENV_ALLOWLIST does not contain API keys or tokens', () => {
  // Specific secrets that MUST be excluded
  assert.equal(BROWSER_ENV_ALLOWLIST.includes('GITHUB_TOKEN'), false);
  assert.equal(BROWSER_ENV_ALLOWLIST.includes('GH_TOKEN'), false);
  assert.equal(BROWSER_ENV_ALLOWLIST.includes('TWITTER_AUTH_TOKEN'), false);
  assert.equal(BROWSER_ENV_ALLOWLIST.includes('TWITTER_CT0'), false);
  assert.equal(BROWSER_ENV_ALLOWLIST.includes('OPENAI_API_KEY'), false);
  assert.equal(BROWSER_ENV_ALLOWLIST.includes('GROQ_API_KEY'), false);
  assert.equal(BROWSER_ENV_ALLOWLIST.includes('BRAVE_API_KEY'), false);
  assert.equal(BROWSER_ENV_ALLOWLIST.includes('EXA_API_KEY'), false);
  assert.equal(BROWSER_ENV_ALLOWLIST.includes('TAVILY_API_KEY'), false);
  assert.equal(BROWSER_ENV_ALLOWLIST.includes('REDDIT_CLIENT_SECRET'), false);
  assert.equal(BROWSER_ENV_ALLOWLIST.includes('OPENCLI_TOKEN'), false);
  assert.equal(BROWSER_ENV_ALLOWLIST.includes('DEEP_RESEARCH_API_TOKEN'), false);
  // Allowlist is small — these are safe system env vars
  assert.ok(BROWSER_ENV_ALLOWLIST.length <= 14, 'BROWSER_ENV_ALLOWLIST should be small');
});

// ── CDP failure paths (fake WebSocket + controlled timers) ──

/** Fake WebSocket: captures handlers, lets tests trigger events synchronously. */
class FakeWs {
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  sent: string[] = [];

  constructor(_url: string) {}
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; }
}

function installFakeWs(): typeof FakeWs {
  const saved = globalThis.WebSocket;
  (globalThis as unknown as { WebSocket: typeof FakeWs }).WebSocket = FakeWs;
  return saved as unknown as typeof FakeWs;
}

function restoreFakeWs(saved: typeof FakeWs): void {
  (globalThis as unknown as { WebSocket: typeof FakeWs }).WebSocket = saved;
}

test('connectAndGetCookies: WebSocket error rejects promise and cleans up', async () => {
  const savedWs = installFakeWs();
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/mock' }) }) as unknown as Response;

  try {
    let wsResolve!: (ws: FakeWs) => void;
    const wsReady = new Promise<FakeWs>((r) => { wsResolve = r; });
    (globalThis as unknown as { WebSocket: typeof FakeWs }).WebSocket = class extends FakeWs {
      constructor(url: string) { super(url); wsResolve(this); }
    };

    const resultPromise = importCookiesFromCdp('facebook', 'http://127.0.0.1:9222', {});
    const ws = await wsReady;
    ws.onerror?.();

    const result = await resultPromise;
    assert.equal(result.ok, false);
    assert.match(result.message ?? '', /WebSocket connection failed/);
    assert.equal(ws.closed, true);
  } finally {
    restoreFakeWs(savedWs);
    globalThis.fetch = savedFetch;
  }
});

test('connectAndGetCookies: command timeout rejects promise and cleans up', async () => {
  const savedWs = installFakeWs();
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/mock' }) }) as unknown as Response;

  // Intercept setTimeout to capture the CDP_TIMEOUT_MS callback
  let timeoutCallback: (() => void) | null = null;
  const origSetTimeout = globalThis.setTimeout as typeof globalThis.setTimeout;
  const origClearTimeout = globalThis.clearTimeout;
  const realSetTimeout = origSetTimeout.bind(globalThis) as typeof globalThis.setTimeout;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let leakedTimer: any;
  (globalThis as any).setTimeout = (fn: (...a: unknown[]) => void, ms: number, ...rest: unknown[]) => {
    if (ms === 30_000) { timeoutCallback = fn as () => void; leakedTimer = realSetTimeout(() => {}, 10_000_000, ...rest); return leakedTimer; }
    return realSetTimeout(fn, ms, ...rest);
  };

  try {
    let wsResolve!: (ws: FakeWs) => void;
    const wsReady = new Promise<FakeWs>((r) => { wsResolve = r; });
    (globalThis as unknown as { WebSocket: typeof FakeWs }).WebSocket = class extends FakeWs {
      constructor(url: string) { super(url); wsResolve(this); }
    };

    const resultPromise = importCookiesFromCdp('facebook', 'http://127.0.0.1:9222', {});
    const ws = await wsReady;
    // Fire onopen but never respond to commands
    ws.onopen?.();
    assert.ok(timeoutCallback, 'CDP timeout callback should have been registered');
    // Fire the timeout — simulates CDP_TIMEOUT_MS expiry
    (timeoutCallback as () => void)();

    const result = await resultPromise;
    assert.equal(result.ok, false);
    assert.match(result.message ?? '', /timed out/);
    assert.equal(ws.closed, true);
  } finally {
    // Always clear the leaked long timer so it can't hang later test runs
    if (leakedTimer !== undefined) origClearTimeout(leakedTimer as any);
    (globalThis as any).setTimeout = origSetTimeout;
    globalThis.clearTimeout = origClearTimeout;
    restoreFakeWs(savedWs);
    globalThis.fetch = savedFetch;
  }
});

test('CdpSession: mid-command disconnect rejects pending command with WebSocket closed', async () => {
  const savedWs = installFakeWs();
  let capturedWs!: FakeWs;
  (globalThis as unknown as { WebSocket: typeof FakeWs }).WebSocket = class extends FakeWs {
    constructor(url: string) { super(url); capturedWs = this; }
  };

  try {
    const session = new CdpSession('ws://127.0.0.1:9222/devtools/browser/test');
    capturedWs.onopen?.();
    await session.ready();

    // Send a command that won't get a response
    const cmdPromise = session.send('Network.getCookies', { urls: ['https://example.com'] });

    // Simulate WebSocket close
    capturedWs.onclose?.();

    // Pending command must reject with 'WebSocket closed'
    await assert.rejects(cmdPromise, { message: 'WebSocket closed' });

    // Session is closed — further sends throw
    await assert.rejects(() => session.send('ping'), { message: 'WebSocket closed' });
  } finally {
    restoreFakeWs(savedWs);
  }
});

test('CdpSession: onclose rejects all pending commands', async () => {
  const savedWs = installFakeWs();
  let capturedWs: FakeWs | null = null;
  (globalThis as unknown as { WebSocket: typeof FakeWs }).WebSocket = class extends FakeWs {
    constructor(url: string) {
      super(url);
      capturedWs = this;
    }
  };

  try {
    const session = new CdpSession('ws://127.0.0.1:9222/devtools/browser/test');
    const ws = capturedWs!;
    ws.onopen?.();
    await session.ready();

    // Send two commands that will never get responses
    const p1 = session.send('Network.enable');
    const p2 = session.send('Runtime.evaluate', { expression: '1+1' });

    // Disconnect
    ws.onclose?.();

    // Both must reject with 'WebSocket closed'
    await assert.rejects(p1, { message: 'WebSocket closed' });
    await assert.rejects(p2, { message: 'WebSocket closed' });

    // Further sends must throw immediately
    await assert.rejects(() => session.send('ping'), { message: 'WebSocket closed' });
  } finally {
    restoreFakeWs(savedWs);
  }
});

test('CdpSession: CDP protocol error response surfaces error field', async () => {
  const savedWs = installFakeWs();
  let capturedWs: FakeWs | null = null;
  (globalThis as unknown as { WebSocket: typeof FakeWs }).WebSocket = class extends FakeWs {
    constructor(url: string) { super(url); capturedWs = this; }
  };

  try {
    const session = new CdpSession('ws://127.0.0.1:9222/devtools/browser/test');
    const ws = capturedWs!;
    ws.onopen?.();
    await session.ready();

    // Send a command and respond with a CDP error
    const resultPromise = session.send('Network.getCookies', { urls: ['https://example.com/'] });
    const cmd = JSON.parse(ws.sent[0]!);
    ws.onmessage?.({ data: JSON.stringify({ id: cmd.id, error: { message: 'Protocol error: target closed' } }) } as MessageEvent);

    const result = await resultPromise;
    assert.ok(result.error, 'result should have error field');
    assert.equal(result.error!.message, 'Protocol error: target closed');
  } finally {
    restoreFakeWs(savedWs);
  }
});

test('cdpScreenshot: throws on CDP error response', async () => {
  const savedWs = installFakeWs();
  let capturedWs: FakeWs | null = null;
  (globalThis as unknown as { WebSocket: typeof FakeWs }).WebSocket = class extends FakeWs {
    constructor(url: string) { super(url); capturedWs = this; }
  };

  try {
    const session = new CdpSession('ws://127.0.0.1:9222/devtools/browser/test');
    const ws = capturedWs!;
    ws.onopen?.();
    await session.ready();

    const screenshotPromise = cdpScreenshot(session);
    // Respond to Page.captureScreenshot with a protocol error
    const cmd = JSON.parse(ws.sent[0]!);
    ws.onmessage?.({ data: JSON.stringify({ id: cmd.id, error: { message: 'CDP error: screenshot failed' } }) } as MessageEvent);

    await assert.rejects(screenshotPromise, /CDP error: screenshot failed/);
  } finally {
    restoreFakeWs(savedWs);
  }
});

test('openCdpSession: missing targetId from createTarget throws', async () => {
  const savedWs = installFakeWs();
  let wsResolve!: (ws: FakeWs) => void;
  const wsReady = new Promise<FakeWs>((r) => { wsResolve = r; });
  (globalThis as unknown as { WebSocket: typeof FakeWs }).WebSocket = class extends FakeWs {
    constructor(url: string) { super(url); wsResolve(this); }
  };
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/mock' }) }) as unknown as Response;

  try {
    const sessionPromise = openCdpSession('http://127.0.0.1:9222');
    const ws = await wsReady;
    ws.onopen?.();
    // Yield so session.ready() resolves and Target.createTarget command is sent
    await new Promise<void>(r => setTimeout(r, 0));
    assert.ok(ws.sent.length > 0, 'session should have sent Target.createTarget');
    const cmd = JSON.parse(ws.sent[0]!);
    // Respond with NO targetId
    ws.onmessage?.({ data: JSON.stringify({ id: cmd.id, result: {} }) } as MessageEvent);
    await assert.rejects(sessionPromise, /CDP did not return a target id/);
  } finally {
    restoreFakeWs(savedWs);
    globalThis.fetch = savedFetch;
  }
});

test('openCdpSession: missing sessionId from attachToTarget throws', async () => {
  const savedWs = installFakeWs();
  let wsResolve!: (ws: FakeWs) => void;
  const wsReady = new Promise<FakeWs>((r) => { wsResolve = r; });
  (globalThis as unknown as { WebSocket: typeof FakeWs }).WebSocket = class extends FakeWs {
    constructor(url: string) { super(url); wsResolve(this); }
  };
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/mock' }) }) as unknown as Response;

  try {
    const sessionPromise = openCdpSession('http://127.0.0.1:9222');
    const ws = await wsReady;
    ws.onopen?.();
    // Yield so session.ready() resolves and Target.createTarget command is sent
    await new Promise<void>(r => setTimeout(r, 0));
    assert.ok(ws.sent.length > 0, 'session should have sent Target.createTarget');
    const cmd0 = JSON.parse(ws.sent[0]!);
    // Respond with a valid targetId so session proceeds to attachToTarget
    ws.onmessage?.({ data: JSON.stringify({ id: cmd0.id, result: { targetId: 't1' } }) } as MessageEvent);
    // Yield so session sends Target.attachToTarget
    await new Promise<void>(r => setTimeout(r, 0));
    assert.ok(ws.sent.length >= 2, 'session should have sent Target.attachToTarget');
    const cmd1 = JSON.parse(ws.sent[1]!);
    // Respond with NO sessionId
    ws.onmessage?.({ data: JSON.stringify({ id: cmd1.id, result: {} }) } as MessageEvent);
    await assert.rejects(sessionPromise, /CDP did not return a session id/);
  } finally {
    restoreFakeWs(savedWs);
    globalThis.fetch = savedFetch;
  }
});
