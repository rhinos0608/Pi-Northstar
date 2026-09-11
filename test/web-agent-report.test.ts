import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  REPORT_PROVIDERS,
  resolveReportProvider,
  runAgentReport,
  tavilyReportProvider,
} from '../src/web-agent-report.js';
import type { WebReportResult } from '../src/web-search-types.js';

const ENV = { TAVILY_API_KEY: 'k' };

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): () => void {
  const saved = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init)) as typeof fetch;
  return () => {
    globalThis.fetch = saved;
  };
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const reportStream = (): Response => sseResponse([
  'data: {"choices": [{"delta": {"content": "Report!"}}]}\n\n',
  'data: {"choices": [{"delta": {"sources": [{"url": "https://a.example/", "title": "A"}]}}]}\n\n',
  'event: done\ndata: {}\n\n',
]);

test('report registry: tavily first, configured check, none configured throws', () => {
  assert.equal(REPORT_PROVIDERS[0]?.id, 'tavily');
  assert.equal(tavilyReportProvider.configured(ENV), true);
  assert.equal(tavilyReportProvider.configured({}), false);
  assert.throws(() => resolveReportProvider({}), /No report-capable web search providers configured/);
  assert.equal(resolveReportProvider(ENV).id, 'tavily');
});

test('runAgentReport: single streaming POST assembles the final report', async () => {
  let posts = 0;
  const restore = mockFetch(async (url, init) => {
    assert.equal(url, 'https://api.tavily.com/research');
    assert.equal(init?.method, 'POST');
    posts += 1;
    return reportStream();
  });
  try {
    const result: WebReportResult = await runAgentReport('q', ENV);
    assert.equal(result.provider, 'tavily');
    assert.equal(result.text, 'Report!');
    assert.deepEqual(result.sources, [{ url: 'https://a.example/', title: 'A' }]);
    assert.equal(posts, 1);
  } finally {
    restore();
  }
});

test('runAgentReport: exact streaming body carries stream:true and the default model', async () => {
  let body: unknown;
  const restore = mockFetch(async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return reportStream();
  });
  try {
    await runAgentReport('deep query', ENV);
    assert.deepEqual(body, { input: 'deep query', model: 'pro', stream: true });
  } finally {
    restore();
  }
});

test('runAgentReport: invalid research model rejects before fetch', async () => {
  let calls = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error('must not fetch');
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => runAgentReport('q', { ...ENV, TAVILY_RESEARCH_MODEL: 'bogus' }),
      /TAVILY_RESEARCH_MODEL/,
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = saved;
  }
});

test('runAgentReport: terminal stream failure throws neutral provider-attributed message', async () => {
  const restore = mockFetch(async () =>
    sseResponse(['data: {"object": "error", "error": "UPSTREAM-BOOM"}\n\n']),
  );
  try {
    let caught: unknown;
    try {
      await runAgentReport('q', ENV);
      assert.fail('expected terminal failure');
    } catch (error) {
      caught = error;
    }
    assert.match(String(caught), /Web report provider "tavily" terminally failed/);
    assert.ok(!/Tavily/.test(String(caught)));
    assert.ok(!String(caught).includes('UPSTREAM-BOOM'));
  } finally {
    restore();
  }
});

test('runAgentReport: invalid agent timeout env rejects before fetch', async () => {
  let calls = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error('must not fetch');
  }) as typeof fetch;
  try {
    await assert.rejects(() => runAgentReport('q', { ...ENV, PI_SEARCH_WEB_AGENT_TIMEOUT_MS: 'nope' }), /PI_SEARCH_WEB_AGENT_TIMEOUT_MS/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = saved;
  }
});

test('runAgentReport: operator deadline aborts a hanging stream', async () => {
  const hanging = new ReadableStream<Uint8Array>({ start() {} });
  const restore = mockFetch(async () =>
    new Response(hanging, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  );
  try {
    await assert.rejects(() => runAgentReport('q', { ...ENV, PI_SEARCH_WEB_AGENT_TIMEOUT_MS: '200' }));
  } finally {
    restore();
  }
});

test('runAgentReport: caller abort propagates', async () => {
  const restore = mockFetch(async () => reportStream());
  try {
    const controller = new AbortController();
    controller.abort(new DOMException('aborted', 'AbortError'));
    await assert.rejects(() => runAgentReport('q', ENV, controller.signal));
  } finally {
    restore();
  }
});

test('runAgentReport: caller abort mid-stream rejects without waiting out the deadline', async () => {
  const hanging = new ReadableStream<Uint8Array>({ start() {} });
  const restore = mockFetch(async () =>
    new Response(hanging, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  );
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException('aborted', 'AbortError')), 50);
  const started = Date.now();
  try {
    await assert.rejects(() => runAgentReport('q', ENV, controller.signal));
    assert.ok(Date.now() - started < 1500, `abort took ${Date.now() - started}ms`);
  } finally {
    restore();
  }
});

test('agent timeout resolves default and clamps to the 300s route ceiling', async () => {
  const mod = await import('../src/web-agent-report.js') as unknown as {
    resolveAgentTimeoutMs: (env: Record<string, string | undefined>) => number;
  };
  assert.equal(mod.resolveAgentTimeoutMs({}), 300_000);
  assert.equal(mod.resolveAgentTimeoutMs({ PI_SEARCH_WEB_AGENT_TIMEOUT_MS: '60000' }), 60000);
  assert.equal(mod.resolveAgentTimeoutMs({ PI_SEARCH_WEB_AGENT_TIMEOUT_MS: '600000' }), 300_000);
});
