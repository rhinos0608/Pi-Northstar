import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  validateWebEntity,
  validateWebPage,
  WEB_ENTITY_CONTENT_MAX,
  WEB_PAGE_CONTENT_MAX,
} from '../../src/web/web-contract.js';
import { truncateUtf8Bytes } from '../../src/native-fetch.js';
import { truncateUtf8Bytes as truncateAgent } from '../../src/web/agent/agent-report-route.js';

function article(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    kind: 'article',
    id: 'a1',
    url: 'https://example.com/a',
    source: 'web',
    backend: 'native-fetch',
    ...overrides,
  };
}

test('entity admission accounts UTF-8 bytes, not chars', () => {
  // 8000 ASCII chars = 8000 bytes: admitted.
  assert.equal(validateWebEntity(article({ content: 'x'.repeat(WEB_ENTITY_CONTENT_MAX) })).ok, true);
  // 8001 ASCII chars: rejected.
  const over = validateWebEntity(article({ content: 'x'.repeat(WEB_ENTITY_CONTENT_MAX + 1) }));
  assert.equal(over.ok, false);
  assert.ok(over.issues.some((issue) => /bytes \(UTF-8\)/.test(issue)));
  // Multibyte: 4001 'é' = 8002 bytes > 8000: rejected while char count passes.
  const multi = validateWebEntity(article({ content: 'é'.repeat(4001) }));
  assert.equal(multi.ok, false);
  // Same for snippets.
  const snip = validateWebEntity(article({ snippet: 'é'.repeat(4001) }));
  assert.equal(snip.ok, false);
});

test('page admission sums UTF-8 bytes across entities', () => {
  const big = 'é'.repeat(Math.floor(WEB_PAGE_CONTENT_MAX / 2) + 1);
  const page = {
    entities: [article({ id: 'a', content: big }), article({ id: 'b', content: big })],
    pagination: { supported: false, limit: 2, returned: 2, hasMore: false },
    partial: false,
    warnings: [],
  };
  const check = validateWebPage(page);
  assert.equal(check.ok, false);
  assert.ok(check.issues.some((issue) => /bytes \(UTF-8\)/.test(issue)));
});

test('byte truncation never splits a code point', () => {
  assert.equal(truncateUtf8Bytes('héllo', 100), 'héllo');
  const cut = truncateUtf8Bytes('é'.repeat(10), 7);
  assert.equal(Buffer.byteLength(cut, 'utf8') <= 7, true);
  assert.equal(cut, 'é'.repeat(3));
  assert.equal(truncateAgent('abc', 100), 'abc');
});
