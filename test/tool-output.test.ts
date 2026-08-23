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
  textResult,
} from '../src/tool-output.js';
import { callNativeTool } from '../src/native-tools.js';

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
    const result = await callNativeTool('feeds', { url: 'https://example.com/feed.xml' });
    const details = result.details as { items: Array<{ title: string; url: string }> };

    assert.deepEqual(details.items.map((item) => item.title), ['A', 'B']);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('callNativeTool applies the context guard to oversized tool text', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    `<html><title>Big page</title><body>${'word '.repeat(20000)}</body></html>`,
    { status: 200 },
  );

  try {
    const result = await callNativeTool(
      'agentic_browse',
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
