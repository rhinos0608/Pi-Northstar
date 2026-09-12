import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  boundPageText,
  cleanText,
  fetchReadablePage,
  isDiffbotFallbackEligible,
  stripHtml,
} from '../src/web-page-reader.js';
import * as web from '../src/web.js';

test('stripHtml removes scripts, styles, comments, and tags', () => {
  const out = stripHtml(
    '<html><head><style>.x{color:red}</style><script>alert(1)</script></head>' +
      '<body><!-- hidden --><h1>Hello</h1><p>World&nbsp;&amp;&nbsp;friends</p></body></html>',
  );
  assert.ok(!out.includes('alert'), 'script body must not surface');
  assert.ok(!out.includes('color'), 'style body must not surface');
  assert.ok(!out.includes('hidden'), 'comments must not surface');
  assert.ok(out.includes('Hello'), 'headings must survive');
  assert.ok(out.includes('World & friends'), 'entities must decode');
});

test('cleanText collapses whitespace and decodes entities', () => {
  assert.equal(cleanText('  a&nbsp;&lt;b&gt;\n\nc  '), 'a <b> c');
  assert.equal(cleanText('&quot;q&#39;s&quot;'), '"q\'s"');
});

test('boundPageText passes short text through and marks truncation', () => {
  const short = boundPageText('hello world', 10_000);
  assert.equal(short.truncated, false);
  assert.equal(short.omittedChars, 0);
  const long = boundPageText(`<p>${'word '.repeat(500)}</p>`, 200);
  assert.equal(long.truncated, true);
  assert.ok(long.omittedChars > 0);
  assert.ok(long.text.length <= 200, `bounded text must fit budget, got ${long.text.length}`);
});

test('isDiffbotFallbackEligible fails closed on abort, Diffbot, policy, DNS', () => {
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(isDiffbotFallbackEligible(new Error('boom'), aborted.signal), false);
  const diffbot = Object.assign(new Error('analyze failed'), { name: 'DiffbotError' });
  assert.equal(isDiffbotFallbackEligible(diffbot), false);
  for (const msg of [
    'Blocked hostname: example.com',
    'DNS lookup aborted for example.com',
    'DNS resolved example.com to private/reserved 10.0.0.1',
    'Response too large: exceeds maximum',
    'contract_invalid_response: bad payload',
  ]) {
    assert.equal(isDiffbotFallbackEligible(new Error(msg)), false, msg);
  }
  assert.equal(isDiffbotFallbackEligible(new Error('fetch failed')), true);
  assert.equal(isDiffbotFallbackEligible(new Error('request timed out')), true);
  assert.equal(isDiffbotFallbackEligible(new Error('HTTP 503 for https://x')), true);
});

test('fetchReadablePage test seam serves HTML without network', async () => {
  const page = await fetchReadablePage('https://example.com/a', undefined, undefined, undefined, {
    fetchPageText: async () =>
      '<html><head><title> T </title></head><body><p>Seam content</p></body></html>',
  });
  assert.equal(page.url, 'https://example.com/a');
  assert.equal(page.title, 'T');
  assert.ok(page.content.includes('Seam content'));
});

test('web.ts re-exports the page-reader public symbols', () => {
  assert.equal(web.fetchReadablePage, fetchReadablePage);
  assert.equal(web.isDiffbotFallbackEligible, isDiffbotFallbackEligible);
  assert.equal(web.stripHtml, stripHtml);
  assert.equal(web.cleanText, cleanText);
  assert.equal(web.boundPageText, boundPageText);
  assert.ok(Array.isArray(web.ALL_FETCH_ADAPTERS));
});
