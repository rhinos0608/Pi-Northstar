import assert from 'node:assert/strict';
import test from 'node:test';
import { runCommand } from '../../src/cli/cli.js';

function stubFetch(handler: (url: string) => Response | Promise<Response>): () => void {
  const saved = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => handler(String(input))) as typeof fetch;
  return () => { globalThis.fetch = saved; };
}

function openalexPage(id: string, nextCursor?: string): unknown {
  return {
    results: [
      {
        id: `https://openalex.org/${id}`,
        display_name: `Paper ${id}`,
        doi: `https://doi.org/10.1/${id.toLowerCase()}`,
        publication_year: 2017,
        cited_by_count: 1,
        authorships: [],
      },
    ],
    meta: { ...(nextCursor !== undefined ? { next_cursor: nextCursor } : {}) },
  };
}

async function issuedCursor(): Promise<string> {
  const { executeResearchSearch } = await import('../../src/commands/research-search-handler.js');
  const { createCommandContext } = await import('../../src/commands/command-context.js');
  const restore = stubFetch(() =>
    new Response(JSON.stringify(openalexPage('W1', 'IopXcm1jdg==')), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
  try {
    const result = await executeResearchSearch(
      { query: 'transformers', source: 'openalex', limit: 1 },
      createCommandContext({ surface: 'cli', env: {} }),
    );
    const envelope = (result.details as Record<string, unknown>).northstar as {
      pagination: { nextCursor?: string };
    };
    assert.ok(envelope.pagination.nextCursor, 'expected a nextCursor on page one');
    return envelope.pagination.nextCursor as string;
  } finally {
    restore();
  }
}

test('CLI research search continues a page with --cursor', async () => {
  const cursor = await issuedCursor();
  const urls: string[] = [];
  const restore = stubFetch((url) => {
    urls.push(url);
    const body = url.includes('cursor=IopXcm1jdg') ? openalexPage('W2') : openalexPage('W1', 'IopXcm1jdg==');
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  try {
    const result = await runCommand(
      ['research', 'search', 'transformers', '--source', 'openalex', '--limit', '1', '--cursor', cursor], {},
    );
    assert.equal(result.ok, true);
    assert.match(String(result.data), /research\.search: success/);
    assert.equal(urls.length, 1);
    assert.match(urls[0]!, /cursor=IopXcm1jdg/);
  } finally {
    restore();
  }
});

test('CLI research search rejects --cursor with source all', async () => {
  const urls: string[] = [];
  const restore = stubFetch((url) => {
    urls.push(url);
    return new Response('{}', { status: 200 });
  });
  try {
    const cursor = await issuedCursor();
    const result = await runCommand(
      ['research', 'search', 'transformers', '--source', 'all', '--cursor', cursor], {},
    );
    assert.equal(result.ok, false);
    assert.equal(urls.length, 0);
  } finally {
    restore();
  }
});

test('CLI research search help advertises --cursor', async () => {
  const help = await runCommand(['research', 'search', '--help'], {});
  assert.equal(help.ok, true);
  assert.match((help.data as { usage: string }).usage, /--cursor CURSOR/);
});
