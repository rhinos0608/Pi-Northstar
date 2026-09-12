import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TAVILY_SEARCH_ENDPOINT, tavilySearchAdapter } from '../src/web-tavily.js';
import type { WebProviderSearchInput } from '../src/web-search-types.js';

const SECRET = 'tavily-secret-key-1';

function input(overrides?: Partial<WebProviderSearchInput>): WebProviderSearchInput {
  return {
    query: 'transformer interpretability',
    limit: 8,
    env: { TAVILY_API_KEY: SECRET },
    nativeAi: { summaries: true, answers: true },
    ...overrides,
  };
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  calls: Array<{ url: string; init: RequestInit | undefined }>;
  restore: () => void;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const saved = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = saved; } };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('tavily configured: key present, blank and absent rejected', () => {
  assert.equal(tavilySearchAdapter.id, 'tavily');
  assert.equal(tavilySearchAdapter.configured({ TAVILY_API_KEY: 'k' }), true);
  assert.equal(tavilySearchAdapter.configured({ TAVILY_API_KEY: '  ' }), false);
  assert.equal(tavilySearchAdapter.configured({}), false);
});

test('tavily unconfigured returns empty output without a call', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ results: [] }));
  try {
    const out = await tavilySearchAdapter.search(input({ env: {} }));
    assert.deepEqual(out, { backend: 'tavily', hits: [], generatedText: [] });
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('tavily exact endpoint, method, headers, payload; max_results capped at 20', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ results: [] }));
  try {
    await tavilySearchAdapter.search(input({ limit: 50 }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, TAVILY_SEARCH_ENDPOINT);
    assert.equal(new URL(calls[0]!.url).origin, 'https://api.tavily.com');
    assert.equal(calls[0]!.init?.method, 'POST');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${SECRET}`);
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    assert.equal(body.query, 'transformer interpretability');
    assert.equal(body.max_results, 20);
    assert.equal(body.search_depth, 'advanced');
    assert.equal(body.include_answer, 'basic');
    assert.equal(body.include_raw_content, false);
    assert.equal(body.include_images, false);
  } finally {
    restore();
  }
});

test('tavily answers opt-out sends include_answer false and emits no answer item', async () => {
  const { calls, restore } = mockFetch(async () =>
    jsonResponse({
      answer: 'generated answer',
      results: [{ title: 'T', url: 'https://example.com/a', content: 'original excerpt' }],
    }),
  );
  try {
    const out = await tavilySearchAdapter.search(input({ nativeAi: { summaries: true, answers: false } }));
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    assert.equal(body.include_answer, false);
    assert.equal(out.hits[0]!.snippet, 'original excerpt');
    assert.deepEqual(out.generatedText, []);
  } finally {
    restore();
  }
});

test('tavily content stays snippet; answer separate with supporting-result-set provenance', async () => {
  const { restore } = mockFetch(async () =>
    jsonResponse({
      answer: 'generated answer',
      results: [
        { title: 'A', url: 'https://example.com/a', content: 'excerpt a' },
        { title: 'B', url: 'https://example.com/b', content: 'excerpt b' },
      ],
    }),
  );
  try {
    const out = await tavilySearchAdapter.search(input());
    assert.equal(out.hits.length, 2);
    assert.equal(out.hits[0]!.snippet, 'excerpt a');
    assert.ok(!out.hits[0]!.snippet.includes('generated answer'));
    assert.equal(out.generatedText.length, 1);
    const item = out.generatedText[0]!;
    assert.equal(item.kind, 'answer');
    assert.equal(item.backend, 'tavily');
    if (item.kind !== 'answer') return;
    assert.equal(item.text, 'generated answer');
    assert.deepEqual(item.provenance, {
      kind: 'supporting_result_set',
      urls: ['https://example.com/a', 'https://example.com/b'],
    });
    assert.equal(item.claimCitations, false);
  } finally {
    restore();
  }
});

test('tavily empty answer or answer without supporting urls omitted', async () => {
  const m1 = mockFetch(async () =>
    jsonResponse({ answer: '  ', results: [{ title: 'A', url: 'https://example.com/a', content: 'x' }] }),
  );
  try {
    assert.deepEqual((await tavilySearchAdapter.search(input())).generatedText, []);
  } finally {
    m1.restore();
  }
  const m2 = mockFetch(async () => jsonResponse({ answer: 'orphan', results: [] }));
  try {
    assert.deepEqual((await tavilySearchAdapter.search(input())).generatedText, []);
  } finally {
    m2.restore();
  }
});

test('tavily drops malformed rows, keeps valid siblings; invalid container rejects', async () => {
  const { restore } = mockFetch(async () =>
    jsonResponse({
      answer: 'ans',
      results: [{ title: 'G', url: 'https://example.com/g', content: 'ok' }, { title: 'Bad' }, 7],
    }),
  );
  try {
    const out = await tavilySearchAdapter.search(input());
    assert.equal(out.hits.length, 1);
    assert.equal(out.hits[0]!.url, 'https://example.com/g');
  } finally {
    restore();
  }
  const m2 = mockFetch(async () => jsonResponse({ results: 'not-an-array' }));
  try {
    await assert.rejects(tavilySearchAdapter.search(input()), /invalid response/);
  } finally {
    m2.restore();
  }
});

test('tavily no retry, redacted error, redirect rejected, oversize rejected', async () => {
  const key = 'tavily-redact-check-123';
  const m1 = mockFetch(async () => new Response('boom', { status: 429 }));
  try {
    await assert.rejects(tavilySearchAdapter.search(input({ env: { TAVILY_API_KEY: key } })), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(key), 'key leaked into error');
      return true;
    });
    assert.equal(m1.calls.length, 1);
  } finally {
    m1.restore();
  }
  const m2 = mockFetch(async () => new Response('', { status: 307, headers: { location: 'https://evil.example/' } }));
  try {
    await assert.rejects(tavilySearchAdapter.search(input()), /Redirect rejected/);
  } finally {
    m2.restore();
  }
  const big = 'x'.repeat(1_000_005);
  const m3 = mockFetch(async () => new Response(JSON.stringify({ results: [], pad: big }), { status: 200 }));
  try {
    await assert.rejects(tavilySearchAdapter.search(input()), /size limit|too large/i);
  } finally {
    m3.restore();
  }
});

test('tavily passes composed policy signal through with no governing 15s cap', async () => {
  const origTimeout = AbortSignal.timeout;
  const delays: number[] = [];
  AbortSignal.timeout = ((ms: number) => {
    delays.push(ms);
    return origTimeout.call(AbortSignal, ms);
  }) as typeof AbortSignal.timeout;
  let seenSignal: AbortSignal | undefined;
  const { calls, restore } = mockFetch((_url, init) => {
    seenSignal = init?.signal as AbortSignal | undefined;
    return jsonResponse({ results: [] });
  });
  try {
    const controller = new AbortController();
    const out = await tavilySearchAdapter.search(input({ signal: controller.signal }));
    assert.equal(calls.length, 1);
    assert.equal(out.backend, 'tavily');
    assert.equal(seenSignal, controller.signal);
    // fetchInit(headers, undefined) mints one discarded 15s validation signal;
    // its timer is unrefd and listener-free, so the request follows only the
    // composed policy signal. Identity above is the no-premature-cap proof.
    assert.deepEqual(delays, [15_000]);
  } finally {
    restore();
    AbortSignal.timeout = origTimeout;
  }
});

test('tavily without signal still applies bounded 15s standalone default', async () => {
  const origTimeout = AbortSignal.timeout;
  const delays: number[] = [];
  AbortSignal.timeout = ((ms: number) => {
    delays.push(ms);
    return origTimeout.call(AbortSignal, ms);
  }) as typeof AbortSignal.timeout;
  const { restore } = mockFetch(async () => jsonResponse({ results: [] }));
  try {
    const out = await tavilySearchAdapter.search(input({}));
    assert.equal(out.backend, 'tavily');
    // fetchInit standalone default
    assert.deepEqual(delays, [15_000]);
  } finally {
    restore();
    AbortSignal.timeout = origTimeout;
  }
});

test('tavily abort propagates', async () => {
  const { restore } = mockFetch(async () => {
    throw new DOMException('This operation was aborted', 'AbortError');
  });
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(tavilySearchAdapter.search(input({ signal: controller.signal })));
  } finally {
    restore();
  }
});

test('tavily pushes recency/domains/freshness to time_range/dates/domain lists', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ results: [] }));
  try {
    await tavilySearchAdapter.search(
      input({
        recency: 'week',
        domains: ['example.com', '-blocked.example'],
        freshnessLowerBoundMs: Date.UTC(2024, 0, 10),
      }),
    );
    assert.equal(calls.length, 1);
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    assert.equal(body.time_range, 'week');
    assert.equal(body.start_date, '2024-01-10');
    assert.equal('end_date' in body, false);
    assert.deepEqual(body.include_domains, ['example.com']);
    assert.deepEqual(body.exclude_domains, ['blocked.example']);
  } finally {
    restore();
  }
});

test('tavily omits freshness keys when no recency/domains/bound given', async () => {
  const { calls, restore } = mockFetch(async () => jsonResponse({ results: [] }));
  try {
    await tavilySearchAdapter.search(input());
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    assert.equal('time_range' in body, false);
    assert.equal('start_date' in body, false);
    assert.equal('end_date' in body, false);
    assert.equal('include_domains' in body, false);
    assert.equal('exclude_domains' in body, false);
  } finally {
    restore();
  }
});

test('tavily preserves publishedDate from published_date, omits when absent', async () => {
  const { restore } = mockFetch(async () =>
    jsonResponse({
      results: [
        { title: 'A', url: 'https://example.com/a', content: 'x', published_date: '2024-02-20T00:00:00Z' },
        { title: 'B', url: 'https://example.com/b', content: 'y' },
      ],
    }),
  );
  try {
    const out = await tavilySearchAdapter.search(input());
    assert.equal(out.hits.length, 2);
    assert.equal(out.hits[0]!.publishedDate, '2024-02-20T00:00:00Z');
    assert.equal(out.hits[1]!.publishedDate, undefined);
  } finally {
    restore();
  }
});

function sseResponse(chunks: Array<string | Uint8Array>, status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}

const sseEvent = (data: string, event?: string): string =>
  `${event !== undefined ? `event: ${event}\n` : ''}data: ${data}\n\n`;

const chunkPayload = (content: string, sources?: unknown): string =>
  JSON.stringify({ choices: [{ delta: { content, ...(sources !== undefined ? { sources } : {}) } }] });

async function runStream(body: Array<string | Uint8Array>, env?: Record<string, string | undefined>): Promise<{ text: string; sources: Array<{ url: string; title: string }> }> {
  const { runTavilyResearch } = await import('../src/web-tavily.js');
  const { restore } = mockFetch(async () => sseResponse(body));
  try {
    const result = await runTavilyResearch('deep query', env ?? { TAVILY_API_KEY: SECRET });
    assert.equal(result.provider, 'tavily');
    return result;
  } finally {
    restore();
  }
}

test('tavily research model defaults to pro on absent/blank, accepts mini|pro|auto', async () => {
  const { resolveTavilyResearchModel, DEFAULT_TAVILY_RESEARCH_MODEL } = await import('../src/web-tavily.js');
  assert.equal(DEFAULT_TAVILY_RESEARCH_MODEL, 'pro');
  assert.equal(resolveTavilyResearchModel({}), 'pro');
  assert.equal(resolveTavilyResearchModel({ TAVILY_RESEARCH_MODEL: '' }), 'pro');
  assert.equal(resolveTavilyResearchModel({ TAVILY_RESEARCH_MODEL: '   ' }), 'pro');
  assert.equal(resolveTavilyResearchModel({ TAVILY_RESEARCH_MODEL: 'mini' }), 'mini');
  assert.equal(resolveTavilyResearchModel({ TAVILY_RESEARCH_MODEL: 'pro' }), 'pro');
  assert.equal(resolveTavilyResearchModel({ TAVILY_RESEARCH_MODEL: 'auto' }), 'auto');
});

test('tavily research invalid model rejects before fetch', async () => {
  const { runTavilyResearch } = await import('../src/web-tavily.js');
  const { calls, restore } = mockFetch(async () => sseResponse([]));
  try {
    await assert.rejects(
      () => runTavilyResearch('q', { TAVILY_API_KEY: SECRET, TAVILY_RESEARCH_MODEL: 'ultra' }),
      /TAVILY_RESEARCH_MODEL.*mini\|pro\|auto/,
    );
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('tavily research exact request: endpoint, method, headers, stream:true with default model', async () => {
  const { TAVILY_RESEARCH_ENDPOINT } = await import('../src/web-tavily.js');
  assert.ok(TAVILY_RESEARCH_ENDPOINT.endsWith('/research'));
  const { calls, restore } = mockFetch(async () =>
    sseResponse([sseEvent(chunkPayload('Hello')), sseEvent('', 'done')]),
  );
  try {
    const { runTavilyResearch } = await import('../src/web-tavily.js');
    const result = await runTavilyResearch('deep query', { TAVILY_API_KEY: SECRET });
    assert.equal(result.text, 'Hello');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, TAVILY_RESEARCH_ENDPOINT);
    assert.equal(calls[0]?.init?.method, 'POST');
    const headers = new Headers(calls[0]?.init?.headers);
    assert.equal(headers.get('authorization'), `Bearer ${SECRET}`);
    assert.ok((headers.get('accept') ?? '').includes('text/event-stream'));
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { input: 'deep query', model: 'pro', stream: true });
    assert.equal(calls[0]?.init?.redirect, 'manual');
  } finally {
    restore();
  }
});

test('tavily research env model override reaches the request body', async () => {
  for (const model of ['mini', 'pro', 'auto'] as const) {
    const { calls, restore } = mockFetch(async () =>
      sseResponse([sseEvent(chunkPayload('R')), sseEvent('', 'done')]),
    );
    try {
      const { runTavilyResearch } = await import('../src/web-tavily.js');
      await runTavilyResearch('q', { TAVILY_API_KEY: SECRET, TAVILY_RESEARCH_MODEL: model });
      assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { input: 'q', model, stream: true });
    } finally {
      restore();
    }
  }
});

test('tavily research stream aggregates fragmented content across arbitrary byte splits', async () => {
  const full =
    sseEvent(chunkPayload('## Report\n\nFirst héllo ')) +
    sseEvent(chunkPayload('second **chunk**')) +
    ': heartbeat comment\n\n' +
    sseEvent(chunkPayload(' tail'), 'message');
  const bytes = new TextEncoder().encode(full);
  // Split mid-line, mid-JSON, and inside the multi-byte héllo sequence.
  const cuts = [1, 7, 23, 64, 65, 129];
  let offset = 0;
  const chunks: Uint8Array[] = [];
  for (const cut of cuts) {
    chunks.push(bytes.slice(offset, cut));
    offset = cut;
  }
  chunks.push(bytes.slice(offset));
  const result = await runStream([...chunks, sseEvent('', 'done')]);
  assert.equal(result.text, '## Report\n\nFirst héllo second **chunk** tail');
});

test('tavily research stream handles CRLF framing and multiple data lines', async () => {
  const frame = `data: ${chunkPayload('A')}\r\n\r\n` +
    `: comment\r\n` +
    `data: {"choices": [{"delta": {"content": "B"}}]}\r\n\r\n` +
    `event: done\r\ndata: {}\r\n\r\n`;
  const result = await runStream([frame]);
  assert.equal(result.text, 'AB');
});

test('tavily research stream normalizes sources: dedupe, http-only, title fallback', async () => {
  const result = await runStream([
    sseEvent(chunkPayload('Report body', [
      { url: 'https://a.example/x', title: 'A' },
      { url: 'https://a.example/x', title: 'A dup' },
      { url: 'ftp://bad.example/file', title: 'Bad' },
      { url: 'https://b.example/y' },
      { title: 'no url' },
      7,
    ])),
    sseEvent('', 'done'),
  ]);
  assert.equal(result.text, 'Report body');
  assert.deepEqual(result.sources, [
    { url: 'https://a.example/x', title: 'A' },
    { url: 'https://b.example/y', title: 'Untitled' },
  ]);
});

test('tavily research stream ignores tool-call and progress events, never exposes them', async () => {
  const toolCall = JSON.stringify({
    choices: [{ delta: { tool_calls: [{ id: 'call-1', function: { name: 'browse', arguments: 'SECRET-PAYLOAD' } }], role: 'assistant' } }],
  });
  const progress = JSON.stringify({ type: 'progress', message: 'PROGRESS-TEXT searching the web' });
  const result = await runStream([
    sseEvent(toolCall),
    sseEvent(progress),
    sseEvent(chunkPayload('Final answer')),
    sseEvent('', 'done'),
  ]);
  assert.equal(result.text, 'Final answer');
  assert.ok(!result.text.includes('SECRET-PAYLOAD'));
  assert.ok(!result.text.includes('PROGRESS-TEXT'));
});

test('tavily research stream skips malformed JSON data and completes', async () => {
  const result = await runStream([
    'data: {not json\n\n',
    'data: "just a string"\n\n',
    `data: ${chunkPayload('Recovered')}\n\n`,
    sseEvent('', 'done'),
  ]);
  assert.equal(result.text, 'Recovered');
});

test('tavily research stream [DONE] data also ends the stream', async () => {
  const result = await runStream([sseEvent(chunkPayload('Hi')), 'data: [DONE]\n\n']);
  assert.equal(result.text, 'Hi');
});

test('tavily research stream exact-size report passes, oversized terminally rejects', async () => {
  const { TAVILY_RESEARCH_TEXT_MAX_CHARS } = await import('../src/web-tavily.js');
  assert.equal(TAVILY_RESEARCH_TEXT_MAX_CHARS, 50_000);
  const exact = await runStream([sseEvent(chunkPayload('x'.repeat(50_000))), sseEvent('', 'done')]);
  assert.equal(exact.text.length, 50_000);
  const { runTavilyResearch } = await import('../src/web-tavily.js');
  const big = mockFetch(async () =>
    sseResponse([sseEvent(chunkPayload('x'.repeat(50_001))), sseEvent('', 'done')]),
  );
  try {
    await assert.rejects(() => runTavilyResearch('q', { TAVILY_API_KEY: SECRET }), /too large/);
  } finally {
    big.restore();
  }
});

test('tavily research stream caps sources at 20', async () => {
  const sources = Array.from({ length: 30 }, (_, i) => ({ url: `https://s${i}.example/`, title: `S${i}` }));
  const result = await runStream([sseEvent(chunkPayload('R', sources)), sseEvent('', 'done')]);
  assert.equal(result.sources.length, 20);
});

test('tavily research stream transport bound rejects oversized streams', async () => {
  const { runTavilyResearch, TAVILY_RESEARCH_STREAM_MAX_BYTES } = await import('../src/web-tavily.js');
  assert.equal(TAVILY_RESEARCH_STREAM_MAX_BYTES, 1_000_000);
  const pad = `data: ${JSON.stringify({ filler: 'y'.repeat(100_000) })}\n\n`;
  const { restore } = mockFetch(async () => sseResponse(Array.from({ length: 12 }, () => pad)));
  try {
    await assert.rejects(() => runTavilyResearch('q', { TAVILY_API_KEY: SECRET }), /too large/);
  } finally {
    restore();
  }
});

test('tavily research stream error object fails terminally without payload echo', async () => {
  const { runTavilyResearch } = await import('../src/web-tavily.js');
  const { restore } = mockFetch(async () =>
    sseResponse([sseEvent(JSON.stringify({ object: 'error', error: 'UPSTREAM-BOOM-SECRET' }))]),
  );
  try {
    await assert.rejects(() => runTavilyResearch('q', { TAVILY_API_KEY: SECRET }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { terminal?: unknown }).terminal, true);
      assert.ok(!error.message.includes('UPSTREAM-BOOM-SECRET'), 'upstream payload leaked');
      assert.ok(!error.message.includes(SECRET), 'key leaked into error');
      return true;
    });
  } finally {
    restore();
  }
});

test('tavily research stream missing done and empty content terminally reject', async () => {
  const { runTavilyResearch } = await import('../src/web-tavily.js');
  const eof = mockFetch(async () => sseResponse([sseEvent(chunkPayload('orphan content'))]));
  try {
    await assert.rejects(() => runTavilyResearch('q', { TAVILY_API_KEY: SECRET }), /invalid response/);
  } finally {
    eof.restore();
  }
  const empty = mockFetch(async () => sseResponse([sseEvent(chunkPayload('   ')), sseEvent('', 'done')]));
  try {
    await assert.rejects(() => runTavilyResearch('q', { TAVILY_API_KEY: SECRET }), /invalid response/);
  } finally {
    empty.restore();
  }
});

test('tavily research rejects redirects, non-2xx, and non-SSE content type', async () => {
  const { runTavilyResearch } = await import('../src/web-tavily.js');
  const redirect = mockFetch(async () => new Response('', { status: 307, headers: { location: 'https://evil.example/' } }));
  try {
    await assert.rejects(() => runTavilyResearch('q', { TAVILY_API_KEY: SECRET }), /Redirect rejected/);
  } finally {
    redirect.restore();
  }
  for (const status of [401, 500]) {
    const m = mockFetch(async () => jsonResponse({ error: 'x' }, status));
    try {
      await assert.rejects(() => runTavilyResearch('q', { TAVILY_API_KEY: SECRET }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(`HTTP ${status}`));
        assert.equal((error as { terminal?: unknown }).terminal, true);
        assert.ok(!error.message.includes(SECRET), 'key leaked into error');
        return true;
      });
    } finally {
      m.restore();
    }
  }
  const wrongType = mockFetch(async () => jsonResponse({ choices: [] }));
  try {
    await assert.rejects(() => runTavilyResearch('q', { TAVILY_API_KEY: SECRET }), /invalid response/);
  } finally {
    wrongType.restore();
  }
});

test('tavily research missing key rejects terminally without fetch', async () => {
  const { runTavilyResearch } = await import('../src/web-tavily.js');
  const { calls, restore } = mockFetch(async () => sseResponse([]));
  try {
    await assert.rejects(() => runTavilyResearch('q', {}), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { terminal?: unknown }).terminal, true);
      return true;
    });
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('tavily research caller abort propagates', async () => {
  const { runTavilyResearch } = await import('../src/web-tavily.js');
  const hanging = new ReadableStream<Uint8Array>({ start() {} });
  const { restore } = mockFetch(async () =>
    new Response(hanging, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  );
  try {
    const controller = new AbortController();
    const pending = assert.rejects(() =>
      runTavilyResearch('q', { TAVILY_API_KEY: SECRET }, controller.signal),
    );
    controller.abort(new DOMException('aborted', 'AbortError'));
    await pending;
  } finally {
    restore();
  }
});

test('tavily research abort during pending read propagates abort reason, not terminal invalid response', async () => {
  const { runTavilyResearch } = await import('../src/web-tavily.js');
  const hanging = new ReadableStream<Uint8Array>({ start() {} });
  const { restore } = mockFetch(async () =>
    new Response(hanging, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  );
  try {
    const controller = new AbortController();
    const reason = new DOMException('race-abort', 'AbortError');
    const pending = runTavilyResearch('q', { TAVILY_API_KEY: SECRET }, controller.signal);
    // Let consumption reach the pending reader.read() before aborting, so the
    // abort races the read and the winner (cancel -> done:true) must not mask it.
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(reason);
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof DOMException);
      assert.equal((error as DOMException).name, 'AbortError');
      assert.ok(!String((error as Error).message).includes('invalid response'));
      return true;
    });
  } finally {
    restore();
  }
});

test('tavily research early done cancels remaining body', async () => {
  const { runTavilyResearch } = await import('../src/web-tavily.js');
  let cancelled = false;
  const encoder = new TextEncoder();
  const payload = sseEvent(chunkPayload('Hi')) + sseEvent('', 'done');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
    },
    cancel() {
      cancelled = true;
    },
  });
  const { restore } = mockFetch(async () =>
    new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  );
  try {
    const result = await runTavilyResearch('q', { TAVILY_API_KEY: SECRET });
    assert.equal(result.text, 'Hi');
    assert.equal(cancelled, true);
  } finally {
    restore();
  }
});
