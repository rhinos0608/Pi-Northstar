import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommandContext } from '../../src/commands/command-context.js';
import { commandHandler } from '../../src/commands/command-registry.js';
import {
  executeResearchSearch,
  mapResearchSearchCommandResult,
  RESEARCH_SEARCH_COMMAND,
} from '../../src/commands/research-search-handler.js';
import { buildNorthstarResult } from '../../src/result-contract.js';

function stubFetch(handler: (url: string) => Response | Promise<Response>): () => void {
  const saved = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => handler(String(input))) as typeof fetch;
  return () => { globalThis.fetch = saved; };
}

function ctx(surface = 'cli') {
  return createCommandContext({ surface, env: {}, invocationId: `research-${surface}` });
}

type CommandFailure = { commandResult?: { outcome: string; error: { code: string; message: string; retryable: boolean }; commandId: string } };

type CommandIdentity = { commandId: string; outcome: string; error?: { code: string; message: string } };

async function failedOutcome(args: Record<string, unknown>): Promise<CommandIdentity> {
  const result = await executeResearchSearch(args, ctx());
  const command = (result.details as Record<string, unknown>).northstarCommand as CommandIdentity;
  assert.ok(command, 'expected a northstarCommand on result');
  assert.equal(command.outcome, 'failed');
  return command;
}

async function fails(args: Record<string, unknown>): Promise<NonNullable<CommandFailure['commandResult']>> {
  try {
    await executeResearchSearch(args, ctx());
  } catch (error) {
    const command = (error as CommandFailure).commandResult;
    assert.ok(command, 'expected a commandResult on failure');
    return command;
  }
  assert.fail('expected executeResearchSearch to throw');
}

const OPENALEX_WORKS = {
  results: [
    {
      id: 'https://openalex.org/W1',
      display_name: 'Attention Is All You Need',
      doi: 'https://doi.org/10.1/atten',
      publication_year: 2017,
      cited_by_count: 42,
      authorships: [],
    },
  ],
  meta: {},
};

// ── Outcome mapping ──

test('research.search maps envelope statuses to command outcomes', () => {
  for (const [status, outcome] of [['ok', 'success'], ['empty', 'empty'], ['partial', 'partial'], ['degraded', 'degraded']] as const) {
    // buildNorthstarResult derives ok/empty/error itself; partial/degraded
    // are forged to prove the command mapping preserves those states.
    const envelope = status === 'partial' || status === 'degraded'
      ? {
          request: { tool: 'research', channel: 'research', action: 'search', source: 'openalex' },
          status,
          data: { kind: 'entities', entities: [{ entityVersion: 1, kind: 'work', id: 'openalex:W1', source: 'openalex', title: 'T', url: 'https://doi.org/10.1/x', snippet: 's' }] },
          sources: [{ source: 'openalex', backend: 'openalex-api', status, count: 1 }],
          errors: [],
          pagination: { supported: false, limit: 3, hasMore: false },
          notes: [],
        } as unknown as Parameters<typeof mapResearchSearchCommandResult>[0]
      : buildNorthstarResult({
        request: { tool: 'research', channel: 'research', action: 'search', source: 'openalex' },
        outcomes: status === 'empty'
          ? [{ source: 'openalex', backend: 'openalex-api', entities: [], invalid: 0 }]
          : [{ source: 'openalex', backend: 'openalex-api', entities: [{ entityVersion: 1, kind: 'work', id: 'openalex:W1', source: 'openalex', title: 'T', url: 'https://doi.org/10.1/x', snippet: 's' }], invalid: 0 }],
        pagination: { supported: false, limit: 3, hasMore: false },
      });
    const result = mapResearchSearchCommandResult(envelope, ctx());
    assert.equal(result.commandId, RESEARCH_SEARCH_COMMAND);
    assert.equal(result.outcome, outcome);
    assert.equal(result.trust, 'external');
    assert.equal(result.resolvedSurface, RESEARCH_SEARCH_COMMAND);
  }
});

// ── Strict input gate: reject-not-clamp, explicit cursor rejection ──

test('research.search rejects missing query and bad action, and surfaces unknown source without network', async () => {
  assert.equal((await fails({ query: '   ' })).error.code, 'invalid_input');
  const action = await fails({ query: 'transformers', action: 'delete' });
  assert.equal(action.error.code, 'invalid_input');
  assert.match(action.error.message, /Canonical action is "search"/);
  const urls: string[] = [];
  const restore = stubFetch((url) => {
    urls.push(url);
    return new Response('{}', { status: 200 });
  });
  try {
    // Unknown sources pass through to the seam, which returns an explicit
    // envelope (never throws, never touches generic web).
    const source = await failedOutcome({ query: 'transformers', source: 'duckduckgo' });
    assert.equal(source.error?.code, 'invalid_input');
    assert.match(source.error?.message ?? '', /Unsupported research source/);
    assert.equal(urls.length, 0);
  } finally {
    restore();
  }
});

test('research.search rejects out-of-range limits instead of clamping', async () => {
  // The code stays invalid_request (legacy native-research contract); the
  // message names the 1..30 bound explicitly.
  for (const limit of [0, 31, 99, 2.5, Number.NaN, '10']) {
    const command = await fails({ query: 'transformers', limit });
    assert.equal(command.error.code, 'invalid_request', `limit ${String(limit)}`);
    assert.match(command.error.message, /limit must be an integer 1\.\.30/);
  }
});

test('research.search accepts cursors onto the command path (Slice 2 migration)', async () => {
  // A malformed opaque cursor is a seam envelope failure (invalid_input),
  // returned — never thrown — exactly like the pre-migration native path.
  const urls: string[] = [];
  const restore = stubFetch((url) => {
    urls.push(url);
    return new Response('{}', { status: 200 });
  });
  try {
    const command = await failedOutcome({ query: 'transformers', source: 'openalex', cursor: 'AAAA' });
    assert.equal(command.error?.code, 'invalid_input');
    assert.equal(urls.length, 0);
  } finally {
    restore();
  }
});

test('research.search rejects malformed years and non-string filters', async () => {
  assert.equal((await fails({ query: 'q', yearFrom: 99 })).error.code, 'invalid_input');
  assert.equal((await fails({ query: 'q', yearFrom: 2020, yearTo: 2019 })).error.code, 'invalid_input');
  assert.equal((await fails({ query: 'q', author: 123 })).error.code, 'invalid_input');
  assert.match((await fails({ query: 'q', author: 123 })).error.message, /author filter must be a string/);
  assert.equal((await fails({ query: 'q', doi: ['10.1/x'] })).error.code, 'invalid_input');
});

// ── Silent-drop closure: filters pass through or reject explicitly ──

test('research.search passes doi/yearFrom through to the pinned adapter', async () => {
  const urls: string[] = [];
  const restore = stubFetch((url) => {
    urls.push(url);
    return new Response(JSON.stringify(OPENALEX_WORKS), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  try {
    const result = await executeResearchSearch(
      { query: 'transformers', source: 'openalex', doi: '10.1/atten', yearFrom: 2015, limit: 3 },
      ctx(),
    );
    const command = (result.details as Record<string, unknown>).northstarCommand as { commandId: string; outcome: string };
    assert.equal(command.commandId, RESEARCH_SEARCH_COMMAND);
    assert.equal(command.outcome, 'success');
    assert.equal(urls.length, 1);
    assert.match(urls[0]!, /doi%3A10\.1%2Fatten/);
    assert.match(urls[0]!, /from_publication_date%3A2015-01-01/);
  } finally {
    restore();
  }
});

test('research.search passes author through OpenAlex id resolution', async () => {
  const urls: string[] = [];
  const restore = stubFetch((url) => {
    urls.push(url);
    if (url.includes('/authors?')) {
      return new Response(JSON.stringify({ results: [{ id: 'https://openalex.org/A9' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify(OPENALEX_WORKS), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  try {
    const result = await executeResearchSearch({ query: 'transformers', source: 'openalex', author: 'Ada Lovelace' }, ctx());
    const command = (result.details as Record<string, unknown>).northstarCommand as { outcome: string };
    assert.equal(command.outcome, 'success');
    const works = urls.find((url) => url.includes('/works?'));
    assert.ok(works, `expected a works request, got ${JSON.stringify(urls)}`);
    assert.match(works!, /authorships\.author\.id%3AA9/);
  } finally {
    restore();
  }
});

test('research.search surfaces pinned unsupported filters explicitly, never dropped', async () => {
  const urls: string[] = [];
  const restore = stubFetch((url) => {
    urls.push(url);
    return new Response('{}', { status: 200 });
  });
  try {
    const author = await failedOutcome({ query: 'transformers', source: 'arxiv', author: 'Ada Lovelace' });
    assert.equal(author.error?.code, 'invalid_input');
    assert.match(author.error?.message ?? '', /"author"/);
    const yearTo = await failedOutcome({ query: 'transformers', source: 'arxiv', yearTo: 2020 });
    assert.equal(yearTo.error?.code, 'invalid_input');
    assert.match(yearTo.error?.message ?? '', /"yearTo"/);
    assert.equal(urls.length, 0);
  } finally {
    restore();
  }
});

test('research.search surfaces aggregate yearTo per-source without touching the network', async () => {
  const urls: string[] = [];
  const restore = stubFetch((url) => {
    urls.push(url);
    return new Response('{}', { status: 200 });
  });
  try {
    const command = await failedOutcome({ query: 'transformers', source: 'all', yearTo: 2020 });
    assert.equal(command.error?.code, 'invalid_input');
    assert.equal(urls.length, 0);
  } finally {
    restore();
  }
});

// ── Registry + native bypass closure ──

test('research.search resolves through the command registry', () => {
  assert.equal(commandHandler(RESEARCH_SEARCH_COMMAND).commandId, RESEARCH_SEARCH_COMMAND);
});

test('native research first-page routes through the handler, not raw dispatch', async () => {
  const { callNativeTool } = await import('../../src/native-tools.js');
  const urls: string[] = [];
  const restore = stubFetch((url) => {
    urls.push(url);
    return new Response(JSON.stringify(OPENALEX_WORKS), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  try {
    const result = await callNativeTool('research', { action: 'academic', query: 'transformers', source: 'openalex', doi: '10.1/atten' }, { env: {} });
    const command = ((result.details as Record<string, unknown>).northstarCommand ?? {}) as { commandId?: string; outcome?: string };
    assert.equal(command.commandId, RESEARCH_SEARCH_COMMAND);
    assert.equal(command.outcome, 'success');
    assert.match(urls[0]!, /doi%3A10\.1%2Fatten/);
  } finally {
    restore();
  }
});

test('native research validation failure carries the registry command identity', async () => {
  const { callNativeTool } = await import('../../src/native-tools.js');
  try {
    await callNativeTool('research', { action: 'academic', query: 'transformers', limit: 99 }, { env: {} });
  } catch (error) {
    const command = (error as CommandFailure).commandResult;
    assert.equal(command?.commandId, RESEARCH_SEARCH_COMMAND);
    assert.equal(command?.error.code, 'invalid_request');
    return;
  }
  assert.fail('expected callNativeTool to throw');
});

test('native research cursor continuations route through the handler (Slice 2)', async () => {
  const { callNativeTool } = await import('../../src/native-tools.js');
  const urls: string[] = [];
  const restore = stubFetch((url) => {
    urls.push(url);
    return new Response('{}', { status: 200 });
  });
  try {
    const result = await callNativeTool('research', { action: 'academic', query: 'transformers', source: 'arxiv', cursor: 'bogus' }, { env: {} });
    const command = (result.details as Record<string, unknown>).northstarCommand as { commandId?: string; outcome?: string; error?: { code?: string } };
    assert.equal(command?.commandId, RESEARCH_SEARCH_COMMAND);
    assert.equal(command?.outcome, 'failed');
    assert.equal(command?.error?.code, 'invalid_input');
    assert.equal(urls.length, 0);
  } finally {
    restore();
  }
});

// ── Cancellation ──

test('research.search in-flight abort rejects cancelled with code cancelled', async () => {
  // Abort during the mocked provider fetch (not pre-aborted): even if the
  // adapter converts the AbortError into an error envelope, the post-await
  // abort recheck must surface outcome 'cancelled' with error code 'cancelled'.
  const saved = globalThis.fetch;
  globalThis.fetch = ((_input: string | URL | Request, init?: { signal?: AbortSignal }) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        },
        { once: true },
      );
    })) as unknown as typeof fetch;
  const controller = new AbortController();
  try {
    const pending = executeResearchSearch(
      { query: 'transformers', source: 'openalex' },
      { ...ctx(), signal: controller.signal },
    );
    controller.abort();
    await pending;
    assert.fail('expected in-flight cancellation to throw');
  } catch (error) {
    const command = (error as CommandFailure).commandResult;
    assert.equal(command?.outcome, 'cancelled');
    assert.equal(command?.error.code, 'cancelled');
  } finally {
    globalThis.fetch = saved;
  }
});

test('research.search maps abort to cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  try {
    await executeResearchSearch({ query: 'transformers', source: 'openalex' }, { ...ctx(), signal: controller.signal });
  } catch (error) {
    assert.equal((error as CommandFailure).commandResult?.outcome, 'cancelled');
    return;
  }
  assert.fail('expected cancellation to throw');
});
