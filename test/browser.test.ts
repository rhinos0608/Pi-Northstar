import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CdpSession,
  cdpNavigate,
  cdpEvaluate,
  cdpScreenshot,
} from '../src/cdp.js';
import { browser } from '../src/browser-tools.js';

// ── helpers ──

class MockWs {
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    setTimeout(() => this.onopen?.(), 0);
  }

  send(raw: string): void {
    const msg = JSON.parse(raw) as { id: number; method: string };
    const result = mockResponseForMethod(msg.method);
    if (result !== undefined) {
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: msg.id, result }) } as MessageEvent), 0);
    }
  }

  close(): void {
    this.onclose?.();
  }
}

function mockResponseForMethod(method: string): Record<string, unknown> | undefined {
  if (method === 'Target.createTarget') return { targetId: 'target-1' };
  if (method === 'Target.attachToTarget') return { sessionId: 'session-1' };
  if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'target-1', type: 'page', title: 'Test', url: 'about:blank' }] };
  if (method === 'Network.getCookies') return { cookies: [{ name: 'test', value: 'val', domain: '.example.com' }] };
  if (method === 'Network.setCookies') return {};
  if (method === 'Runtime.evaluate') return { result: { type: 'string', value: 'test content' } };
  if (method === 'Page.captureScreenshot') return { data: 'base64screenshotdata' };
  if (method === 'Target.closeTarget') return {};
  return undefined;
}

function mockFetch(): () => void {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/mock' }) }) as unknown as Response;
  return () => { globalThis.fetch = saved; };
}

// ── CdpSession tests ──

test('CdpSession.send multiplexes commands and resolves by id', async () => {
  const saved = globalThis.WebSocket;
  const sentIds: number[] = [];

  class TestWs {
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;

    constructor(readonly url: string) {
      setTimeout(() => this.onopen?.(), 0);
    }

    send(raw: string): void {
      const msg = JSON.parse(raw) as { id: number; method: string };
      sentIds.push(msg.id);
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: msg.id, result: { method: msg.method } }) } as MessageEvent), 0);
    }

    close(): void {}
  }

  try {
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = TestWs as unknown as typeof WebSocket;

    const session = new CdpSession('ws://127.0.0.1:9222/devtools/page/test');
    await session.ready();

    const [r1, r2] = await Promise.all([
      session.send('Method.one'),
      session.send('Method.two'),
    ]);

    assert.equal(sentIds.length, 2);
    assert.equal(sentIds[1]! - sentIds[0]!, 1, 'IDs must be sequential');
    assert.equal((r1.result as Record<string, unknown>)?.method, 'Method.one');
    assert.equal((r2.result as Record<string, unknown>)?.method, 'Method.two');
  } finally {
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = saved;
  }
});

test('CdpSession.addEventListener captures events (messages without id)', async () => {
  const saved = globalThis.WebSocket;

  class TestWs {
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;

    constructor(readonly url: string) {
      setTimeout(() => this.onopen?.(), 0);
    }

    send(): void {}
    close(): void {}
  }

  try {
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = TestWs as unknown as typeof WebSocket;

    const session = new CdpSession('ws://127.0.0.1:9222/devtools/page/test');
    await session.ready();

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    const unsub = session.addEventListener('Network.requestWillBeSent', (params) => {
      events.push({ method: 'Network.requestWillBeSent', params });
    });

    // Simulate incoming event (no id field)
    const sessionWs = (session as unknown as { ws: TestWs }).ws;
    sessionWs.onmessage?.({ data: JSON.stringify({ method: 'Network.requestWillBeSent', params: { requestId: '1' } }) } as MessageEvent);

    assert.equal(events.length, 1);
    assert.equal(events[0]!.method, 'Network.requestWillBeSent');
    assert.equal((events[0]!.params as Record<string, unknown>).requestId, '1');

    // Unsubscribe and verify no more events
    unsub();
    sessionWs.onmessage?.({ data: JSON.stringify({ method: 'Network.requestWillBeSent', params: { requestId: '2' } }) } as MessageEvent);
    assert.equal(events.length, 1, 'After unsubscribe, handler should not be called');
  } finally {
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = saved;
  }
});

// ── High-level CDP primitive tests ──

test('cdpNavigate rejects localhost/private/hostnames and non-http schemes', async () => {
  // localhost rejected by public URL validator
  await assert.rejects(
    () => cdpNavigate({ send: async () => ({}) } as never, 'http://localhost:3000'),
    /Blocked hostname/,
  );
  await assert.rejects(
    () => cdpNavigate({ send: async () => ({}) } as never, 'http://10.0.0.1/'),
    /Private\/reserved/,
  );
  await assert.rejects(
    () => cdpNavigate({ send: async () => ({}) } as never, 'http://169.254.169.254/'),
    /Private\/reserved/,
  );
  await assert.rejects(
    () => cdpNavigate({ send: async () => ({}) } as never, 'ftp://example.com'),
    /Disallowed URL scheme/,
  );
});

test('cdpEvaluate returns value and handles exceptionDetails', async () => {
  const saved = globalThis.WebSocket;

  class EvalWs {
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;

    constructor(readonly url: string) {
      setTimeout(() => this.onopen?.(), 0);
    }

    send(raw: string): void {
      const msg = JSON.parse(raw) as { id: number; params: { expression: string } };
      let payload: Record<string, unknown>;
      if (msg.params?.expression === 'throw') {
        payload = { id: msg.id, result: { result: { type: 'object', subtype: 'error', description: 'Error: bad' }, exceptionDetails: { text: 'Error: bad' } } };
      } else {
        payload = { id: msg.id, result: { result: { type: 'number', value: 42 } } };
      }
      setTimeout(() => this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent), 0);
    }

    close(): void {}
  }

  try {
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = EvalWs as unknown as typeof WebSocket;

    const session = new CdpSession('ws://127.0.0.1:9222/devtools/page/test');
    await session.ready();

    const value = await cdpEvaluate(session, '1+1');
    assert.equal(value, 42);

    await assert.rejects(() => cdpEvaluate(session, 'throw'), /Evaluation error/);
  } finally {
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = saved;
  }
});

test('cdpScreenshot returns base64', async () => {
  const saved = globalThis.WebSocket;

  class ScreenWs {
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;

    constructor(readonly url: string) {
      setTimeout(() => this.onopen?.(), 0);
    }

    send(raw: string): void {
      const msg = JSON.parse(raw) as { id: number };
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: msg.id, result: { data: 'base64encodedpngdata' } }) } as MessageEvent), 0);
    }

    close(): void {}
  }

  try {
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = ScreenWs as unknown as typeof WebSocket;

    const session = new CdpSession('ws://127.0.0.1:9222/devtools/page/test');
    await session.ready();

    const data = await cdpScreenshot(session);
    assert.equal(data, 'base64encodedpngdata');
  } finally {
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = saved;
  }
});

// ── browser action dispatch tests ──

test('browser action dispatch: status (agent-browser default)', async () => {
  const result = await browser({ action: 'status' }, { env: {} });
  const details = result.details as Record<string, unknown>;
  assert.equal(details.backend, 'agent-browser');
  assert.ok(typeof details.version === 'string');
  assert.ok(typeof details.executable === 'string');
});

test('browser action dispatch: tabs (mocked WS, CDP backend)', async () => {
  const savedFetch = globalThis.fetch;
  const savedWs = globalThis.WebSocket;

  globalThis.fetch = async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/mock' }) }) as unknown as Response;
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = MockWs as unknown as typeof WebSocket;

  try {
    const result = await browser({ action: 'tabs', endpoint: 'ws://127.0.0.1:9222' }, { env: { PI_SEARCH_BROWSER_BACKEND: 'cdp' } });
    const details = result.details as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(details));
    assert.equal(details.length, 1);
    assert.equal(details[0]?.targetId, 'target-1');
  } finally {
    globalThis.fetch = savedFetch;
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = savedWs;
  }
});

test('browser action dispatch: navigate (mocked WS, CDP backend)', async () => {
  const savedFetch = globalThis.fetch;
  const savedWs = globalThis.WebSocket;

  class NavWs {
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;

    constructor(readonly url: string) {
      setTimeout(() => this.onopen?.(), 0);
    }

    send(raw: string): void {
      const msg = JSON.parse(raw) as { id: number; method: string };
      let result: Record<string, unknown> = {};
      if (msg.method === 'Target.createTarget') result = { targetId: 'target-1' };
      else if (msg.method === 'Target.attachToTarget') result = { sessionId: 'session-1' };
      else if (msg.method === 'Page.navigate') result = { frameId: 'frame-1' };
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: msg.id, result }) } as MessageEvent), 0);
    }

    close(): void {}
  }

  globalThis.fetch = async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/mock' }) }) as unknown as Response;
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = NavWs as unknown as typeof WebSocket;

  try {
    const result = await browser({ action: 'navigate', url: 'https://example.com', endpoint: 'ws://127.0.0.1:9222' }, { env: { PI_SEARCH_BROWSER_BACKEND: 'cdp' } });
    assert.ok(result.details != null);
  } finally {
    globalThis.fetch = savedFetch;
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = savedWs;
  }
});

test('browser action dispatch: evaluate (mocked WS, CDP backend)', async () => {
  const savedFetch = globalThis.fetch;
  const savedWs = globalThis.WebSocket;

  class EvalWs {
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;

    constructor(readonly url: string) {
      setTimeout(() => this.onopen?.(), 0);
    }

    send(raw: string): void {
      const msg = JSON.parse(raw) as { id: number; method: string };
      let result: Record<string, unknown> = {};
      if (msg.method === 'Target.createTarget') result = { targetId: 'target-1' };
      else if (msg.method === 'Target.attachToTarget') result = { sessionId: 'session-1' };
      else if (msg.method === 'Runtime.evaluate') result = { result: { type: 'number', value: 42 } };
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: msg.id, result }) } as MessageEvent), 0);
    }

    close(): void {}
  }

  globalThis.fetch = async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/mock' }) }) as unknown as Response;
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = EvalWs as unknown as typeof WebSocket;

  try {
    const result = await browser({ action: 'evaluate', expression: '1+1', endpoint: 'ws://127.0.0.1:9222' }, { env: { PI_SEARCH_BROWSER_BACKEND: 'cdp', PI_SEARCH_BROWSER_ALLOW_SENSITIVE: '1' } });
    assert.equal(result.details, 42);
  } finally {
    globalThis.fetch = savedFetch;
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = savedWs;
  }
});

test('browser unknown action throws', async () => {
  const restore = mockFetch();
  const savedWs = globalThis.WebSocket;
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = MockWs as unknown as typeof WebSocket;

  try {
    await assert.rejects(
      () => browser({ action: 'nonexistent', endpoint: 'ws://127.0.0.1:9222' }, { env: { PI_SEARCH_BROWSER_BACKEND: 'cdp' } }),
      /Unsupported browser action/,
    );
  } finally {
    restore();
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = savedWs;
  }
});

// ── browser opt-out and validation tests ──

test('browser respects PI_SEARCH_BROWSER_AUTOMATION=0 opt-out', async () => {
  const result = await browser({ endpoint: 'ws://127.0.0.1:9222' }, { env: { PI_SEARCH_BROWSER_AUTOMATION: '0' } });
  assert.match(JSON.stringify(result.details), /disabled/);
});

test('browser navigate rejects credentialed URL (user:pass@host)', async () => {
  const result = await browser(
    { action: 'navigate', url: 'http://user:pass@localhost:3000/' },
    { env: {} },
  );
  const text = JSON.stringify(result.content);
  assert.match(text, /credentials/);
});

test('browser requires endpoint (CDP backend)', async () => {
  await assert.rejects(
    () => browser({}, { env: { PI_SEARCH_BROWSER_BACKEND: 'cdp' } }),
    /CDP endpoint is required/,
  );
});

test('browser navigate rejects non-http URLs (CDP backend)', async () => {
  const restore = mockFetch();
  const savedWs = globalThis.WebSocket;
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = MockWs as unknown as typeof WebSocket;

  try {
    await assert.rejects(
      () => browser({ action: 'navigate', url: 'ftp://example.com', endpoint: 'ws://127.0.0.1:9222' }, { env: { PI_SEARCH_BROWSER_BACKEND: 'cdp' } }),
      /Disallowed URL scheme/,
    );
  } finally {
    restore();
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = savedWs;
  }
});

test('browser click requires selector (CDP backend)', async () => {
  const restore = mockFetch();
  const savedWs = globalThis.WebSocket;
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = MockWs as unknown as typeof WebSocket;

  try {
    await assert.rejects(
      () => browser({ action: 'click', endpoint: 'ws://127.0.0.1:9222' }, { env: { PI_SEARCH_BROWSER_BACKEND: 'cdp' } }),
      /selector is required/,
    );
  } finally {
    restore();
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = savedWs;
  }
});

test('browser type requires selector and text (CDP backend)', async () => {
  const restore = mockFetch();
  const savedWs = globalThis.WebSocket;
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = MockWs as unknown as typeof WebSocket;

  try {
    await assert.rejects(
      () => browser({ action: 'type', endpoint: 'ws://127.0.0.1:9222' }, { env: { PI_SEARCH_BROWSER_BACKEND: 'cdp' } }),
      /selector is required/,
    );
  } finally {
    restore();
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = savedWs;
  }
});

test('browser scroll uses defaults', async () => {
  const savedFetch = globalThis.fetch;
  const savedWs = globalThis.WebSocket;

  class ScrollWs {
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;

    constructor(readonly url: string) {
      setTimeout(() => this.onopen?.(), 0);
    }

    send(raw: string): void {
      const msg = JSON.parse(raw) as { id: number; method: string };
      let result: Record<string, unknown> = {};
      if (msg.method === 'Target.createTarget') result = { targetId: 'target-1' };
      else if (msg.method === 'Target.attachToTarget') result = { sessionId: 'session-1' };
      else if (msg.method === 'Runtime.evaluate') result = { result: { type: 'undefined' } };
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: msg.id, result }) } as MessageEvent), 0);
    }

    close(): void {}
  }

  globalThis.fetch = async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/mock' }) }) as unknown as Response;
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = ScrollWs as unknown as typeof WebSocket;

  try {
    const result = await browser({ action: 'scroll', endpoint: 'ws://127.0.0.1:9222' }, { env: { PI_SEARCH_BROWSER_BACKEND: 'cdp' } });
    assert.ok(result.content !== undefined);
  } finally {
    globalThis.fetch = savedFetch;
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = savedWs;
  }
});

test('browser action dispatch: text (mocked WS, CDP backend)', async () => {
  const savedFetch = globalThis.fetch;
  const savedWs = globalThis.WebSocket;

  class TextWs {
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;

    constructor(readonly url: string) {
      setTimeout(() => this.onopen?.(), 0);
    }

    send(raw: string): void {
      const msg = JSON.parse(raw) as { id: number; method: string };
      let result: Record<string, unknown> = {};
      if (msg.method === 'Target.createTarget') result = { targetId: 'target-1' };
      else if (msg.method === 'Target.attachToTarget') result = { sessionId: 'session-1' };
      else if (msg.method === 'Runtime.evaluate') result = { result: { type: 'string', value: 'Hello World' } };
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: msg.id, result }) } as MessageEvent), 0);
    }

    close(): void {}
  }

  globalThis.fetch = async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/mock' }) }) as unknown as Response;
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = TextWs as unknown as typeof WebSocket;

  try {
    const result = await browser({ action: 'text', endpoint: 'ws://127.0.0.1:9222' }, { env: { PI_SEARCH_BROWSER_BACKEND: 'cdp' } });
    assert.equal(result.details, 'Hello World');
  } finally {
    globalThis.fetch = savedFetch;
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = savedWs;
  }
});

test('browser action dispatch: html (mocked WS, CDP backend)', async () => {
  const savedFetch = globalThis.fetch;
  const savedWs = globalThis.WebSocket;

  class HtmlWs {
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;

    constructor(readonly url: string) {
      setTimeout(() => this.onopen?.(), 0);
    }

    send(raw: string): void {
      const msg = JSON.parse(raw) as { id: number; method: string };
      let result: Record<string, unknown> = {};
      if (msg.method === 'Target.createTarget') result = { targetId: 'target-1' };
      else if (msg.method === 'Target.attachToTarget') result = { sessionId: 'session-1' };
      else if (msg.method === 'Runtime.evaluate') result = { result: { type: 'string', value: '<html><body>hi</body></html>' } };
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: msg.id, result }) } as MessageEvent), 0);
    }

    close(): void {}
  }

  globalThis.fetch = async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/mock' }) }) as unknown as Response;
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = HtmlWs as unknown as typeof WebSocket;

  try {
    const result = await browser({ action: 'html', endpoint: 'ws://127.0.0.1:9222' }, { env: { PI_SEARCH_BROWSER_BACKEND: 'cdp' } });
    assert.equal(result.details, '<html><body>hi</body></html>');
  } finally {
    globalThis.fetch = savedFetch;
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = savedWs;
  }
});

test('browser action dispatch: screenshot (mocked WS, CDP backend)', async () => {
  const savedFetch = globalThis.fetch;
  const savedWs = globalThis.WebSocket;

  class ScreenWs {
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;

    constructor(readonly url: string) {
      setTimeout(() => this.onopen?.(), 0);
    }

    send(raw: string): void {
      const msg = JSON.parse(raw) as { id: number; method: string };
      let result: Record<string, unknown> = {};
      if (msg.method === 'Target.createTarget') result = { targetId: 'target-1' };
      else if (msg.method === 'Target.attachToTarget') result = { sessionId: 'session-1' };
      else if (msg.method === 'Page.captureScreenshot') result = { data: 'base64png' };
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: msg.id, result }) } as MessageEvent), 0);
    }

    close(): void {}
  }

  globalThis.fetch = async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/mock' }) }) as unknown as Response;
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = ScreenWs as unknown as typeof WebSocket;

  try {
    const result = await browser({ action: 'screenshot', endpoint: 'ws://127.0.0.1:9222' }, { env: { PI_SEARCH_BROWSER_BACKEND: 'cdp' } });
    assert.equal(result.details, 'base64png');
  } finally {
    globalThis.fetch = savedFetch;
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = savedWs;
  }
});

test('browser action dispatch: click (mocked WS, CDP backend)', async () => {
  const savedFetch = globalThis.fetch;
  const savedWs = globalThis.WebSocket;

  class ClickWs {
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;

    constructor(readonly url: string) {
      setTimeout(() => this.onopen?.(), 0);
    }

    send(raw: string): void {
      const msg = JSON.parse(raw) as { id: number; method: string };
      let result: Record<string, unknown> = {};
      if (msg.method === 'Target.createTarget') result = { targetId: 'target-1' };
      else if (msg.method === 'Target.attachToTarget') result = { sessionId: 'session-1' };
      else if (msg.method === 'Runtime.evaluate') result = { result: { type: 'undefined' } };
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: msg.id, result }) } as MessageEvent), 0);
    }

    close(): void {}
  }

  globalThis.fetch = async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/mock' }) }) as unknown as Response;
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = ClickWs as unknown as typeof WebSocket;

  try {
    const result = await browser({ action: 'click', selector: '#btn', endpoint: 'ws://127.0.0.1:9222' }, { env: { PI_SEARCH_BROWSER_BACKEND: 'cdp' } });
    assert.ok(result.content !== undefined);
  } finally {
    globalThis.fetch = savedFetch;
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = savedWs;
  }
});

test('browser action dispatch: type (mocked WS, CDP backend)', async () => {
  const savedFetch = globalThis.fetch;
  const savedWs = globalThis.WebSocket;

  class TypeWs {
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;

    constructor(readonly url: string) {
      setTimeout(() => this.onopen?.(), 0);
    }

    send(raw: string): void {
      const msg = JSON.parse(raw) as { id: number; method: string };
      let result: Record<string, unknown> = {};
      if (msg.method === 'Target.createTarget') result = { targetId: 'target-1' };
      else if (msg.method === 'Target.attachToTarget') result = { sessionId: 'session-1' };
      else if (msg.method === 'Runtime.evaluate') result = { result: { type: 'undefined' } };
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: msg.id, result }) } as MessageEvent), 0);
    }

    close(): void {}
  }

  globalThis.fetch = async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/mock' }) }) as unknown as Response;
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = TypeWs as unknown as typeof WebSocket;

  try {
    const result = await browser({ action: 'type', selector: '#input', text: 'hello', endpoint: 'ws://127.0.0.1:9222' }, { env: { PI_SEARCH_BROWSER_BACKEND: 'cdp' } });
    assert.ok(result.content !== undefined);
  } finally {
    globalThis.fetch = savedFetch;
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = savedWs;
  }
});

test('browser action dispatch: close (mocked WS, CDP backend)', async () => {
  const savedFetch = globalThis.fetch;
  const savedWs = globalThis.WebSocket;

  class CloseWs {
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;

    constructor(readonly url: string) {
      setTimeout(() => this.onopen?.(), 0);
    }

    send(raw: string): void {
      const msg = JSON.parse(raw) as { id: number; method: string };
      let result: Record<string, unknown> = {};
      if (msg.method === 'Target.createTarget') result = { targetId: 'target-1' };
      else if (msg.method === 'Target.attachToTarget') result = { sessionId: 'session-1' };
      else if (msg.method === 'Target.closeTarget') result = {};
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: msg.id, result }) } as MessageEvent), 0);
    }

    close(): void {}
  }

  globalThis.fetch = async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/mock' }) }) as unknown as Response;
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = CloseWs as unknown as typeof WebSocket;

  try {
    const result = await browser({ action: 'close', endpoint: 'ws://127.0.0.1:9222' }, { env: { PI_SEARCH_BROWSER_BACKEND: 'cdp' } });
    assert.ok(result.content !== undefined);
  } finally {
    globalThis.fetch = savedFetch;
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = savedWs;
  }
});

test('browser action dispatch: cookies (mocked WS, CDP backend)', async () => {
  const savedFetch = globalThis.fetch;
  const savedWs = globalThis.WebSocket;

  class CookiesWs {
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;

    constructor(readonly url: string) {
      setTimeout(() => this.onopen?.(), 0);
    }

    send(raw: string): void {
      const msg = JSON.parse(raw) as { id: number; method: string };
      let result: Record<string, unknown> = {};
      if (msg.method === 'Target.createTarget') result = { targetId: 'target-1' };
      else if (msg.method === 'Target.attachToTarget') result = { sessionId: 'session-1' };
      else if (msg.method === 'Network.getCookies') result = { cookies: [{ name: 'sess', value: 'abc', domain: '.example.com' }] };
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: msg.id, result }) } as MessageEvent), 0);
    }

    close(): void {}
  }

  globalThis.fetch = async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/mock' }) }) as unknown as Response;
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = CookiesWs as unknown as typeof WebSocket;

  try {
    const result = await browser({ action: 'cookies', endpoint: 'ws://127.0.0.1:9222' }, { env: { PI_SEARCH_BROWSER_BACKEND: 'cdp' } });
    const details = result.details as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(details));
    assert.equal(details.length, 1);
    assert.equal(details[0]?.name, 'sess');
  } finally {
    globalThis.fetch = savedFetch;
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = savedWs;
  }
});

test('browser action dispatch: set_cookies (mocked WS, CDP backend)', async () => {
  const savedFetch = globalThis.fetch;
  const savedWs = globalThis.WebSocket;

  class SetCookiesWs {
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;

    constructor(readonly url: string) {
      setTimeout(() => this.onopen?.(), 0);
    }

    send(raw: string): void {
      const msg = JSON.parse(raw) as { id: number; method: string };
      let result: Record<string, unknown> = {};
      if (msg.method === 'Target.createTarget') result = { targetId: 'target-1' };
      else if (msg.method === 'Target.attachToTarget') result = { sessionId: 'session-1' };
      else if (msg.method === 'Network.setCookies') result = {};
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: msg.id, result }) } as MessageEvent), 0);
    }

    close(): void {}
  }

  globalThis.fetch = async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/mock' }) }) as unknown as Response;
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = SetCookiesWs as unknown as typeof WebSocket;

  try {
    const result = await browser({ action: 'set_cookies', cookies: [{ name: 'sess', value: 'abc', domain: '.example.com' }], endpoint: 'ws://127.0.0.1:9222' }, { env: { PI_SEARCH_BROWSER_BACKEND: 'cdp', PI_SEARCH_BROWSER_ALLOW_SENSITIVE: '1' } });
    assert.ok(result.content !== undefined);
  } finally {
    globalThis.fetch = savedFetch;
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = savedWs;
  }
});

// ── validation tests ──

test('browser type requires text (CDP backend)', async () => {
  const restore = mockFetch();
  const savedWs = globalThis.WebSocket;
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = MockWs as unknown as typeof WebSocket;

  try {
    await assert.rejects(
      () => browser({ action: 'type', selector: '#x', endpoint: 'ws://127.0.0.1:9222' }, { env: { PI_SEARCH_BROWSER_BACKEND: 'cdp' } }),
      /text is required/,
    );
  } finally {
    restore();
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = savedWs;
  }
});

test('browser set_cookies rejects non-array (CDP backend)', async () => {
  const restore = mockFetch();
  const savedWs = globalThis.WebSocket;
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = MockWs as unknown as typeof WebSocket;

  try {
    await assert.rejects(
      () => browser({ action: 'set_cookies', cookies: 'notarray', endpoint: 'ws://127.0.0.1:9222' }, { env: { PI_SEARCH_BROWSER_BACKEND: 'cdp', PI_SEARCH_BROWSER_ALLOW_SENSITIVE: '1' } }),
      /cookies is required and must be an array/,
    );
  } finally {
    restore();
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = savedWs;
  }
});

test('browser set_cookies rejects cookie without name (CDP backend)', async () => {
  const restore = mockFetch();
  const savedWs = globalThis.WebSocket;
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = MockWs as unknown as typeof WebSocket;

  try {
    await assert.rejects(
      () => browser({ action: 'set_cookies', cookies: [{ value: 'x' }], endpoint: 'ws://127.0.0.1:9222' }, { env: { PI_SEARCH_BROWSER_BACKEND: 'cdp', PI_SEARCH_BROWSER_ALLOW_SENSITIVE: '1' } }),
      /each cookie must be an object with a non-empty string name/,
    );
  } finally {
    restore();
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = savedWs;
  }
});

test('openCdpSession closes WebSocket on setup failure (CDP backend)', async () => {
  const savedFetch = globalThis.fetch;
  const savedWs = globalThis.WebSocket;

  let closeCalled = false;

  class FailWs {
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;

    constructor(readonly url: string) {
      setTimeout(() => this.onopen?.(), 0);
    }

    send(raw: string): void {
      const msg = JSON.parse(raw) as { id: number; method: string };
      let result: Record<string, unknown> = {};
      if (msg.method === 'Target.createTarget') result = {};
      else if (msg.method === 'Target.attachToTarget') result = { sessionId: 'session-1' };
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: msg.id, result }) } as MessageEvent), 0);
    }

    close(): void {
      closeCalled = true;
    }
  }

  globalThis.fetch = async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/mock' }) }) as unknown as Response;
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = FailWs as unknown as typeof WebSocket;

  try {
    await assert.rejects(
      () => browser({ action: 'tabs', endpoint: 'ws://127.0.0.1:9222' }, { env: { PI_SEARCH_BROWSER_BACKEND: 'cdp' } }),
      /CDP did not return a target id/,
    );
    assert.ok(closeCalled, 'WebSocket must be closed on setup failure');
  } finally {
    globalThis.fetch = savedFetch;
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = savedWs;
  }
});

// ── CdpSession close() cleanup tests ──

test('CdpSession.send sets pending before ws.send (no race)', async () => {
  const saved = globalThis.WebSocket;

  class SyncWs {
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;

    constructor(readonly url: string) {
      setTimeout(() => this.onopen?.(), 0);
    }

    send(raw: string): void {
      const msg = JSON.parse(raw) as { id: number; method: string };
      // Synchronously fire onmessage — would race if pending.set is after send
      this.onmessage?.({ data: JSON.stringify({ id: msg.id, result: { ok: true } }) } as MessageEvent);
    }

    close(): void {}
  }

  try {
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = SyncWs as unknown as typeof WebSocket;

    const session = new CdpSession('ws://127.0.0.1:9222/devtools/page/test');
    await session.ready();

    const result = await session.send('Test.method');
    assert.equal((result.result as Record<string, unknown>)?.ok, true);
  } finally {
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = saved;
  }
});

test('CdpSession.close clears event listeners', async () => {
  const saved = globalThis.WebSocket;

  class TestWs {
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;

    constructor(readonly url: string) {
      setTimeout(() => this.onopen?.(), 0);
    }

    send(): void {}
    close(): void {}
  }

  try {
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = TestWs as unknown as typeof WebSocket;

    const session = new CdpSession('ws://127.0.0.1:9222/devtools/page/test');
    await session.ready();

    let called = false;
    session.addEventListener('Test.event', () => { called = true; });
    session.close();

    // Simulate event after close — handler must not fire
    const sessionWs = (session as unknown as { ws: TestWs }).ws;
    sessionWs.onmessage?.({ data: JSON.stringify({ method: 'Test.event', params: {} }) } as MessageEvent);
    assert.equal(called, false, 'Event listener must not fire after close');
  } finally {
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = saved;
  }
});

test('CdpSession.close is idempotent', async () => {
  const saved = globalThis.WebSocket;

  let closeCount = 0;

  class TestWs {
    onopen: (() => void) | null = null;

    constructor(readonly url: string) {
      setTimeout(() => this.onopen?.(), 0);
    }

    send(): void {}
    close(): void { closeCount++; }
  }

  try {
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = TestWs as unknown as typeof WebSocket;

    const session = new CdpSession('ws://127.0.0.1:9222/devtools/page/test');
    await session.ready();

    session.close();
    session.close();
    assert.equal(closeCount, 1, 'ws.close must be called exactly once');
  } finally {
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = saved;
  }
});

test('CdpSession.close nulls ws handlers', async () => {
  const saved = globalThis.WebSocket;

  class TestWs {
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(readonly url: string) {
      setTimeout(() => this.onopen?.(), 0);
    }

    send(): void {}
    close(): void {}
  }

  try {
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = TestWs as unknown as typeof WebSocket;

    const session = new CdpSession('ws://127.0.0.1:9222/devtools/page/test');
    await session.ready();

    session.close();

    const ws = (session as unknown as { ws: TestWs }).ws;
    assert.equal(ws.onmessage, null, 'onmessage must be null after close');
    assert.equal(ws.onclose, null, 'onclose must be null after close');
    assert.equal(ws.onerror, null, 'onerror must be null after close');
  } finally {
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = saved;
  }
});
