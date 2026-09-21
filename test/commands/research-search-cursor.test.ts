import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommandContext } from '../../src/commands/command-context.js';
import { executeResearchSearch, RESEARCH_SEARCH_COMMAND } from '../../src/commands/research-search-handler.js';
import { encodeResultCursor } from '../../src/result-contract.js';

function stubFetch(handler: (url: string) => Response | Promise<Response>): () => void {
  const saved = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => handler(String(input))) as typeof fetch;
  return () => { globalThis.fetch = saved; };
}

function ctx() {
  return createCommandContext({ surface: 'cli', env: {}, invocationId: 'research-cursor' });
}

interface EnvelopeLike {
  pagination: { supported: boolean; hasMore: boolean; nextCursor?: string; limit: number; returned: number };
  errors: Array<{ code: string; message: string }>;
  status: string;
}

function envelopeOf(result: { details?: unknown }): EnvelopeLike {
  const envelope = (result.details as Record<string, unknown>).northstar as EnvelopeLike;
  assert.ok(envelope, 'expected a northstar envelope on result');
  return envelope;
}

function failedOf(result: { details?: unknown }): { commandId: string; outcome: string; error?: { code: string; message: string } } {
  const command = (result.details as Record<string, unknown>).northstarCommand as {
    commandId: string; outcome: string; error?: { code: string; message: string };
  };
  assert.ok(command, 'expected a northstarCommand on result');
  assert.equal(command.commandId, RESEARCH_SEARCH_COMMAND);
  assert.equal(command.outcome, 'failed');
  return command;
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

// ── Valid continuation ──

test('research.search continues an OpenAlex page through the issued cursor', async () => {
  const urls: string[] = [];
  const restore = stubFetch((url) => {
    urls.push(url);
    const body = url.includes('cursor=IopXcm1jdg')
      ? openalexPage('W2')
      : openalexPage('W1', 'IopXcm1jdg==');
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  try {
    const first = await executeResearchSearch({ query: 'transformers', source: 'openalex', limit: 1 }, ctx());
    const firstCommand = (first.details as Record<string, unknown>).northstarCommand as { outcome: string };
    assert.equal(firstCommand.outcome, 'success');
    const cursor = envelopeOf(first).pagination.nextCursor;
    assert.ok(typeof cursor === 'string' && cursor.length > 0, 'expected a nextCursor on page one');

    const second = await executeResearchSearch({ query: 'transformers', source: 'openalex', limit: 1, cursor }, ctx());
    const secondCommand = (second.details as Record<string, unknown>).northstarCommand as { outcome: string };
    assert.equal(secondCommand.outcome, 'success');
    assert.equal(urls.length, 2);
    assert.match(urls[1]!, /cursor=IopXcm1jdg/);
    const rows = (second.details as Record<string, { results: Array<{ title: string }> }>).northstar as unknown;
    assert.ok(rows !== undefined);
  } finally {
    restore();
  }
});

// ── Mismatched-selector cursor ──

test('research.search rejects a foreign-source cursor with pagination_not_supported', async () => {
  const urls: string[] = [];
  const restore = stubFetch((url) => {
    urls.push(url);
    return new Response('{}', { status: 200 });
  });
  try {
    const foreign = encodeResultCursor({ source: 'arxiv', query: 'transformers', state: { offset: 10 } });
    const result = await executeResearchSearch({ query: 'transformers', source: 'openalex', cursor: foreign }, ctx());
    assert.equal(failedOf(result).error?.code, 'pagination_not_supported');
    assert.equal(urls.length, 0);
  } finally {
    restore();
  }
});

test('research.search rejects a cursor bound to another query with invalid_input', async () => {
  const urls: string[] = [];
  const restore = stubFetch((url) => {
    urls.push(url);
    return new Response('{}', { status: 200 });
  });
  try {
    const otherQuery = encodeResultCursor({ source: 'openalex', query: 'other topic', state: { cursor: 'abc' } });
    const result = await executeResearchSearch({ query: 'transformers', source: 'openalex', cursor: otherQuery }, ctx());
    assert.equal(failedOf(result).error?.code, 'invalid_input');
    assert.equal(urls.length, 0);
  } finally {
    restore();
  }
});

// ── Aggregate + cursor reject ──

test('research.search rejects source:all continuations with pagination_not_supported', async () => {
  const urls: string[] = [];
  const restore = stubFetch((url) => {
    urls.push(url);
    return new Response('{}', { status: 200 });
  });
  try {
    const single = encodeResultCursor({ source: 'openalex', query: 'transformers', state: { cursor: 'abc' } });
    const result = await executeResearchSearch({ query: 'transformers', source: 'all', cursor: single }, ctx());
    assert.equal(failedOf(result).error?.code, 'pagination_not_supported');
    assert.equal(urls.length, 0);
  } finally {
    restore();
  }
});

// ── Single-source cursor modes ──

test('research.search rejects cursors for pagination-unsupported sources without network', async () => {
  const urls: string[] = [];
  const restore = stubFetch((url) => {
    urls.push(url);
    return new Response('{}', { status: 200 });
  });
  try {
    for (const source of ['wikipedia', 'gdelt']) {
      const cursor = encodeResultCursor({ source, query: 'transformers', state: { page: 1 } });
      const result = await executeResearchSearch({ query: 'transformers', source, cursor }, ctx());
      assert.equal(failedOf(result).error?.code, 'pagination_not_supported', source);
    }
    assert.equal(urls.length, 0);
  } finally {
    restore();
  }
});

// ── Cursor shape gate ──

test('research.search rejects non-string and empty cursors as invalid_input', async () => {
  for (const cursor of [123, '', true]) {
    try {
      await executeResearchSearch({ query: 'transformers', source: 'openalex', cursor }, ctx());
    } catch (error) {
      const command = (error as { commandResult?: { outcome: string; error: { code: string } } }).commandResult;
      assert.equal(command?.outcome, 'failed');
      assert.equal(command?.error.code, 'invalid_input');
      continue;
    }
    assert.fail(`expected cursor ${String(cursor)} to throw`);
  }
});
