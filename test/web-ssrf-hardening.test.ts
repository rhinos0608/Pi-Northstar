import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchReadablePage } from '../src/web.js';

// Evidence-boundary validation: Scrapling (Python) may already have followed a
// redirect before Node sees the result, so this cannot prevent the Python-side
// request. It withholds the unsafe final URL from evidence at the first Node
// trust boundary instead.

function publicLookup(host: string) {
  if (host === 'evil.example') return Promise.resolve([{ address: '10.0.0.1', family: 4 as const }]);
  return Promise.resolve([{ address: '93.184.216.34', family: 4 as const }]);
}

async function withMockFetch<T>(fn: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  (globalThis as Record<string, unknown>).fetch = async () => new Response('', { status: 200 });
  try {
    return await fn();
  } finally {
    (globalThis as Record<string, unknown>).fetch = originalFetch;
  }
}

test('fetchReadablePage withholds Scrapling final URL resolving to private DNS', async () => {
  const bridge = {
    fetch: async () => ({
      url: 'https://evil.example/loot',
      title: 'evil',
      content: '<p>stolen</p>',
    }),
  };
  const page = await withMockFetch(() =>
    fetchReadablePage(
      'https://example.com/page',
      undefined,
      bridge as never,
      publicLookup as never,
      { env: {} },
    ),
  );
  assert.notEqual(page.url, 'https://evil.example/loot');
  assert.ok(!page.content.includes('stolen'), 'bridge content for unsafe final URL must not surface');
});

test('fetchReadablePage withholds Scrapling private-literal final URL', async () => {
  const bridge = {
    fetch: async () => ({
      url: 'http://169.254.169.254/latest/meta-data/',
      title: 'metadata',
      content: '<p>secret</p>',
    }),
  };
  const page = await withMockFetch(() =>
    fetchReadablePage(
      'https://example.com/page',
      undefined,
      bridge as never,
      publicLookup as never,
      { env: {} },
    ),
  );
  assert.notEqual(page.url, 'http://169.254.169.254/latest/meta-data/');
  assert.ok(!page.content.includes('secret'), 'bridge content for unsafe final URL must not surface');
});
