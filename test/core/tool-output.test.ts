import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_MAX_TOOL_OUTPUT_CHARS,
  dedupeBy,
  dedupeByUrl,
  guardResult,
  guardText,
  jsonTextResult,
  maxToolOutputChars,
  northstarTextResult,
  textResult,
  withNorthstarDetails,
} from '../../src/core/tool-output.js';
import { buildNorthstarResult, validateNorthstarResult } from '../../src/result-contract.js';
import { callNativeTool } from '../../src/native-tools.js';

test('guardText returns text under the limit unchanged', () => {
  assert.equal(guardText('short output', { maxChars: 2000 }), 'short output');
});

test('guardText truncates oversized text with head, tail, and marker', () => {
  const text = 'a'.repeat(1600) + 'b'.repeat(3000) + 'c'.repeat(400);
  const guarded = guardText(text, { maxChars: 2000 });

  assert.ok(guarded.startsWith('a'.repeat(1600)));
  assert.ok(guarded.endsWith('c'.repeat(400)));
  assert.match(guarded, /\[context guard: output truncated, 3000 of 5000 chars omitted\]/);
  assert.ok(guarded.length < 2200);
});

test('guardText respects PI_SEARCH_MAX_TOOL_OUTPUT_CHARS env override', () => {
  const text = 'x'.repeat(2000);
  const guarded = guardText(text, { env: { PI_SEARCH_MAX_TOOL_OUTPUT_CHARS: '1500' } });

  assert.match(guarded, /500 of 2000 chars omitted/);
  assert.equal(guardText(text, { env: {} }), text);
});

test('maxToolOutputChars falls back on defaults and clamps to a floor', () => {
  assert.equal(maxToolOutputChars({}), DEFAULT_MAX_TOOL_OUTPUT_CHARS);
  assert.equal(maxToolOutputChars({ PI_SEARCH_MAX_TOOL_OUTPUT_CHARS: 'garbage' }), DEFAULT_MAX_TOOL_OUTPUT_CHARS);
  assert.equal(maxToolOutputChars({ PI_SEARCH_MAX_TOOL_OUTPUT_CHARS: '10' }), 1000);
  assert.equal(maxToolOutputChars({ PI_SEARCH_MAX_TOOL_OUTPUT_CHARS: '25000' }), 25000);
});

test('dedupeBy keeps first occurrence, preserves order, and keeps empty-key items', () => {
  const items = [
    { key: 'x', value: 1 },
    { key: '', value: 2 },
    { key: 'x', value: 3 },
    { key: '', value: 4 },
    { key: 'y', value: 5 },
  ];

  assert.deepEqual(dedupeBy(items, (item) => item.key).map((item) => item.value), [1, 2, 4, 5]);
});

test('dedupeByUrl collapses normalized URL variants', () => {
  const items = [
    { url: 'https://www.example.com/page/?utm_source=x', title: 'first' },
    { url: 'https://example.com/page', title: 'duplicate' },
    { url: 'https://example.com/other', title: 'other' },
  ];

  assert.deepEqual(dedupeByUrl(items).map((item) => item.title), ['first', 'other']);
});

test('dedupeByUrl merges duplicate representations via mergeFn', () => {
  const items = [
    { url: 'https://example.com/page', title: 'terse' },
    { url: 'https://example.com/page/', title: 'a richer, longer title' },
  ];
  const merged = dedupeByUrl(items, (current, candidate) =>
    candidate.title.length > current.title.length ? candidate : current,
  );
  assert.deepEqual(merged.map((item) => item.title), ['a richer, longer title']);
});

test('textResult and jsonTextResult guard text but preserve details', () => {
  const data = { blob: 'z'.repeat(5000) };
  const result = jsonTextResult(data, { maxChars: 1000 });
  const content = result.content as Array<{ type: string; text: string }>;

  assert.match(content[0]?.text ?? '', /context guard: output truncated/);
  assert.equal(result.details, data);

  const plain = textResult('ok', { detail: true }, { maxChars: 1000 });
  assert.equal((plain.content as Array<{ text: string }>)[0]?.text, 'ok');
});

test('guardResult truncates text content items and leaves other content alone', () => {
  const result = guardResult({
    content: [
      { type: 'text', text: 'q'.repeat(3000) },
      { type: 'image', data: 'raw' },
    ],
    details: { keep: true },
  }, { maxChars: 1000 });
  const content = result.content as Array<Record<string, unknown>>;

  assert.match(String(content[0]?.text), /context guard: output truncated/);
  assert.deepEqual(content[1], { type: 'image', data: 'raw' });
  assert.deepEqual(result.details, { keep: true });

  const passthrough = guardResult({ content: 'not-an-array', details: null }, { maxChars: 1000 });
  assert.equal(passthrough.content, 'not-an-array');
});

test('native research dedupes identical URLs returned by multiple sources', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith('https://en.wikipedia.org/')) {
      return new Response(JSON.stringify(['q', ['Shared paper'], ['snippet'], ['https://example.com/paper']]), { status: 200 });
    }
    if (url.startsWith('https://export.arxiv.org/')) {
      return new Response('<feed></feed>', { status: 200 });
    }
    if (url.startsWith('https://api.crossref.org/')) {
      return new Response(JSON.stringify({ message: { items: [{ title: ['Shared paper'], DOI: '10.1/x', URL: 'https://example.com/paper/' }] } }), { status: 200 });
    }
    if (url.startsWith('https://hn.algolia.com/')) {
      return new Response(JSON.stringify({ hits: [] }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const result = await callNativeTool('research', { query: 'shared paper', source: 'all' });
    const details = result.details as { results: Array<{ url: string }> };

    assert.equal(details.results.length, 1);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('native feeds dedupes entries with identical links', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    `<rss><channel>
      <item><title>A</title><link>https://example.com/post-1</link></item>
      <item><title>A repeat</title><link>https://example.com/post-1</link></item>
      <item><title>B</title><link>https://example.com/post-2</link></item>
    </channel></rss>`,
    { status: 200 },
  );

  try {
    // Offline DNS stub: the fetch helpers preflight DNS before the mocked
    // fetch, and example.com does not resolve in sandboxes without public DNS.
    const result = await callNativeTool('feeds', { url: 'https://example.com/feed.xml' }, {
      env: {},
      lookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
    });
    const details = result.details as { items: Array<{ title: string; url: string }> };

    assert.deepEqual(details.items.map((item) => item.title), ['A', 'B']);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('withNorthstarDetails attaches northstar while preserving legacy detail fields', () => {
  const northstar = buildNorthstarResult({
    request: { tool: 'web_search', channel: 'research', action: 'search', source: 'openalex' },
    outcomes: [],
  });
  const details = withNorthstarDetails({ platform: 'reddit', action: 'hot', items: [1, 2] }, northstar);

  // Legacy observable fields keep their requested values.
  assert.equal(details.platform, 'reddit');
  assert.equal(details.action, 'hot');
  assert.deepEqual(details.items, [1, 2]);
  assert.equal(details.northstar, northstar);
  // Canonical envelope records the canonical action, not the legacy alias.
  assert.equal(northstar.request.action, 'search');

  assert.deepEqual(withNorthstarDetails(undefined, northstar), { northstar });
});

test('northstarTextResult guards text and carries legacy plus northstar details', () => {
  const northstar = buildNorthstarResult({
    request: { tool: 'media', channel: 'youtube', action: 'details', requestedAction: 'details' },
    outcomes: [{ source: 'youtube', backend: 'youtube-oembed', entities: [], degraded: true }],
  });
  const result = northstarTextResult('ok', { platform: 'youtube', action: 'details', backend: 'youtube-oembed' }, northstar, { maxChars: 1000 });
  const details = result.details as Record<string, unknown>;

  assert.equal(details.platform, 'youtube');
  assert.equal(details.action, 'details');
  assert.equal(details.backend, 'youtube-oembed');
  assert.equal(details.northstar, northstar);
  const content = result.content as Array<{ text: string }>;
  assert.equal(content[0]?.text, 'ok');
});

test('callNativeTool applies the context guard to oversized tool text', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    `<html><title>Big page</title><body>${'word '.repeat(20000)}</body></html>`,
    { status: 200 },
  );

  try {
    const result = await callNativeTool(
      'browse',
      { action: 'read', url: 'https://example.com/big', maxChars: 50000 },
      { env: { PI_SEARCH_MAX_TOOL_OUTPUT_CHARS: '2000' }, lookup: async () => [{ address: '8.8.8.8', family: 4 }] },
    );
    const content = result.content as Array<{ type: string; text: string }>;
    const details = result.details as { content: string; truncated: boolean };

    assert.match(content[0]?.text ?? '', /context guard: output truncated/);
    assert.ok((content[0]?.text.length ?? 0) < 2500);
    assert.ok(details.content.length > 40000);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

// ── northstarTextResult fail-closed envelope validation ──

test('northstarTextResult attaches a valid envelope unchanged', () => {
  const northstar = buildNorthstarResult({
    request: { tool: 'web_search', channel: 'research', action: 'search', requestedAction: 'search' },
    outcomes: [{ source: 'wikipedia', backend: 'wikipedia-api', entities: [], }],
  });
  const result = northstarTextResult('text', undefined, northstar, { maxChars: 1000 });
  const details = result.details as Record<string, unknown>;
  assert.equal(details.northstar, northstar);
});

test('northstarTextResult fails closed on a malformed envelope', () => {
  const malformed = buildNorthstarResult({
    request: { tool: 'web_search', channel: 'research', action: 'search', requestedAction: 'search' },
    outcomes: [{ source: 'wikipedia', backend: 'wikipedia-api', entities: [], }],
  });
  // Corrupt one entity row (empty required url) so semantic validation fails.
  malformed.data = { kind: 'entities', entities: [{ entityVersion: 1, kind: 'article', id: 'x', source: 'wikipedia', title: 'x', url: '' } as never] };
  const result = northstarTextResult('text', { legacy: true }, malformed, { maxChars: 1000 });
  const details = result.details as Record<string, unknown>;
  // BackendCallResult shape unchanged: content plus details.
  assert.ok(Array.isArray(result.content));
  assert.ok(details.legacy);
  const northstar = details.northstar as { status: string; errors: Array<{ code: string }>; data: { entities?: unknown[] } };
  assert.equal(northstar.status, 'error');
  assert.equal(northstar.errors[0]?.code, 'invalid_backend_response');
  // Malformed rows are withheld, not surfaced.
  assert.equal(northstar.data.entities?.length ?? 0, 0);
});

test('northstarTextResult fails closed on non-object cast data (null envelope)', () => {
  const result = northstarTextResult('text', { legacy: true }, undefined as never, { maxChars: 1000 });
  const details = result.details as Record<string, unknown>;
  assert.ok(Array.isArray(result.content));
  assert.ok(details.legacy);
  const northstar = details.northstar as { status: string; request: Record<string, unknown> };
  assert.equal(northstar.status, 'error');
  // Sanitized request: missing fields become 'unknown', not the cast garbage.
  assert.equal(northstar.request.tool, 'unknown');
  assert.equal(northstar.request.channel, 'unknown');
  assert.equal(northstar.request.action, 'unknown');
  // The replacement envelope itself passes runtime validation.
  assert.equal(validateNorthstarResult(details.northstar).ok, true);
});

test('northstarTextResult fail-closed errors are secret-safe and the replacement validates', () => {
  const malformed = buildNorthstarResult({
    request: { tool: 'web_search', channel: 'research', action: 'search', requestedAction: 'search' },
    outcomes: [],
  });
  // Tainted cast data: a request object carrying secret-shaped fields, plus a
  // request.source that fails validation semantics.
  const tainted = malformed as unknown as Record<string, unknown>;
  tainted.request = { tool: 'web_search', channel: 'research', action: 'search', apiKey: 'sk-super-secret-token', source: '' };
  tainted.errors = 'not-an-array' as never;

  const result = northstarTextResult('text', undefined, tainted as never, { maxChars: 1000 });
  const details = result.details as Record<string, unknown>;
  const northstar = details.northstar as { status: string; request: Record<string, unknown>; errors: Array<{ code: string; message: string }> };

  assert.equal(northstar.status, 'error');
  assert.equal(northstar.errors[0]?.code, 'invalid_backend_response');
  assert.equal(northstar.errors[0]?.message, 'Canonical result envelope failed validation; malformed data withheld.');
  // Sanitized request: unknown extra fields and empty source are dropped.
  assert.equal(northstar.request.apiKey, undefined);
  assert.equal(northstar.request.source, undefined);
  // The secret never reaches the serialized output.
  assert.ok(!JSON.stringify(details).includes('sk-super-secret-token'));
  // Replacement envelope passes full runtime validation.
  const check = validateNorthstarResult(details.northstar);
  assert.equal(check.ok, true, check.issues.join('; '));
});
