import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommandContext } from '../../src/commands/command-context.js';
import {
  executeResearchCitations,
  RESEARCH_CITATIONS_COMMAND,
} from '../../src/commands/research-citations-handler.js';
import { callNativeTool } from '../../src/native-tools.js';
import { resolveCitationsSource } from '../../src/research/research-citations.js';
import { encodeResultCursor } from '../../src/result-contract.js';

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): () => void {
  const saved = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
  return () => { globalThis.fetch = saved; };
}

const OPENALEX_CITATIONS_PAYLOAD = {
  meta: {
    count: 42,
    db_response_time_ms: 10,
    page: 1,
    per_page: 2,
    next_cursor: 'ILYA_CURSOR_PAGE_2',
  },
  results: [
    {
      id: 'https://openalex.org/W100',
      display_name: 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding',
      doi: 'https://doi.org/10.48550/arxiv.1810.04805',
      publication_year: 2018,
      cited_by_count: 65000,
      authorships: [{ author: { id: 'https://openalex.org/A10', display_name: 'Jacob Devlin' } }],
    },
    {
      id: 'https://openalex.org/W101',
      display_name: 'Language Models are Few-Shot Learners',
      doi: 'https://doi.org/10.48550/arxiv.2005.14165',
      publication_year: 2020,
      cited_by_count: 40000,
      authorships: [{ author: { id: 'https://openalex.org/A11', display_name: 'Tom B. Brown' } }],
    },
  ],
};

const S2_CITATIONS_PAYLOAD = {
  offset: 0,
  next: 2,
  data: [
    {
      citingPaper: {
        paperId: 'df2b0e26d0599ce3e70df8a9da02e51594e0e9bc',
        title: 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding',
        year: 2018,
        citationCount: 65000,
        authors: [{ authorId: '10', name: 'Jacob Devlin' }],
      },
    },
    {
      citingPaper: {
        paperId: '6b9e3f9479b0c0347895393ffbb90e1f74ec6a54',
        title: 'Language Models are Few-Shot Learners',
        year: 2020,
        citationCount: 40000,
        authors: [{ authorId: '11', name: 'Tom B. Brown' }],
      },
    },
  ],
};

test('resolveCitationsSource infers openalex and semantic_scholar from ID', () => {
  assert.equal(resolveCitationsSource('W2741809807'), 'openalex');
  assert.equal(resolveCitationsSource('openalex:W2741809807'), 'openalex');
  assert.equal(resolveCitationsSource('https://openalex.org/W2741809807'), 'openalex');
  assert.equal(resolveCitationsSource('649def34f8be52c8b66281af98ae884c09aef38b'), 'semantic_scholar');
  assert.equal(resolveCitationsSource('s2:649def34f8be52c8b66281af98ae884c09aef38b'), 'semantic_scholar');
  assert.equal(resolveCitationsSource('https://www.semanticscholar.org/paper/649def34f8be52c8b66281af98ae884c09aef38b'), 'semantic_scholar');
  assert.equal(resolveCitationsSource('10.1038/nature12373'), 'openalex');
});

test('research.citations rejects missing ID, source:all, and out-of-range limits strictly', async () => {
  const ctx = createCommandContext({ surface: 'test', env: {} });

  // Missing ID
  await assert.rejects(
    async () => executeResearchCitations({ id: '   ' }, ctx),
    (err: Error & { code?: string }) => err.code === 'invalid_input',
  );

  // Reject-not-clamp: limits
  for (const limit of [0, 31, 1.5, -5]) {
    await assert.rejects(
      async () => executeResearchCitations({ id: 'W2741809807', limit }, ctx),
      (err: Error & { code?: string }) => err.code === 'invalid_request',
    );
  }

  // source: all
  const allRes = await executeResearchCitations({ id: 'W2741809807', source: 'all' }, ctx);
  const allCmd = (allRes.details as Record<string, unknown>).northstarCommand as { outcome: string; error?: { code: string } };
  assert.equal(allCmd.outcome, 'failed');
  assert.equal(allCmd.error?.code, 'invalid_input');

  // Unknown source
  const unknownRes = await executeResearchCitations({ id: 'W2741809807', source: 'duckduckgo' }, ctx);
  const unknownCmd = (unknownRes.details as Record<string, unknown>).northstarCommand as { outcome: string; error?: { code: string } };
  assert.equal(unknownCmd.outcome, 'failed');
  assert.equal(unknownCmd.error?.code, 'invalid_input');
});

test('research.citations surfaces unsupported sources without touching the network', async () => {
  const ctx = createCommandContext({ surface: 'test', env: {} });
  let networkTouched = false;
  const restore = stubFetch(() => {
    networkTouched = true;
    return new Response('{}', { status: 200 });
  });

  try {
    for (const source of ['pubmed', 'arxiv', 'crossref', 'datacite', 'gdelt', 'hackernews', 'stackoverflow', 'wikipedia', 'wikidata', 'ror']) {
      const res = await executeResearchCitations({ id: 'W2741809807', source }, ctx);
      const cmd = (res.details as Record<string, unknown>).northstarCommand as { outcome: string; error?: { code: string; message: string } };
      assert.equal(cmd.outcome, 'failed');
      assert.equal(cmd.error?.code, 'unsupported_action');
      assert.match(cmd.error?.message ?? '', new RegExp(`${source} does not support the "citations" action`));
    }
    assert.equal(networkTouched, false, 'network must not be touched for unsupported sources');
  } finally {
    restore();
  }
});

test('research.citations fetches OpenAlex cited-by works with cursor and count', async () => {
  const ctx = createCommandContext({ surface: 'test', env: {} });
  const urls: string[] = [];
  const restore = stubFetch((url) => {
    urls.push(url);
    return new Response(JSON.stringify(OPENALEX_CITATIONS_PAYLOAD), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  try {
    const res = await executeResearchCitations({ id: 'W2741809807', limit: 2 }, ctx);
    assert.equal(urls.length, 1);
    assert.match(urls[0]!, /filter=cites%3AW2741809807/);
    assert.match(urls[0]!, /per_page=2/);

    const cmd = (res.details as Record<string, unknown>).northstarCommand as {
      outcome: string;
      data: { kind: string; entities: Array<Record<string, unknown>> };
    };
    assert.equal(cmd.outcome, 'success');
    assert.equal(cmd.data.entities.length, 2);
    assert.match(String((res as { content?: Array<{ text?: string }> }).content?.[0]?.text), /Total citations: 42/);

    const pagination = ((res.details as { northstar?: { pagination?: unknown } })?.northstar?.pagination as Record<string, unknown>) as {
      hasMore: boolean;
      nextCursor?: string;
    };
    assert.equal(pagination.hasMore, true);
    assert.ok(pagination.nextCursor, 'must emit continuation cursor');
  } finally {
    restore();
  }
});

test('research.citations fetches Semantic Scholar cited-by papers with cursor', async () => {
  const ctx = createCommandContext({ surface: 'test', env: {} });
  const urls: string[] = [];
  const restore = stubFetch((url) => {
    urls.push(url);
    return new Response(JSON.stringify(S2_CITATIONS_PAYLOAD), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  try {
    const res = await executeResearchCitations({ id: '649def34f8be52c8b66281af98ae884c09aef38b', limit: 2 }, ctx);
    assert.equal(urls.length, 1);
    assert.match(urls[0]!, /paper\/649def34f8be52c8b66281af98ae884c09aef38b\/citations/);

    const cmd = (res.details as Record<string, unknown>).northstarCommand as {
      outcome: string;
      data: { kind: string; entities: Array<Record<string, unknown>> };
    };
    assert.equal(cmd.outcome, 'success');
    assert.equal(cmd.data.entities.length, 2);

    const pagination = ((res.details as { northstar?: { pagination?: unknown } })?.northstar?.pagination as Record<string, unknown>) as {
      hasMore: boolean;
      nextCursor?: string;
    };
    assert.equal(pagination.hasMore, true);
    assert.ok(pagination.nextCursor);
  } finally {
    restore();
  }
});

test('research.citations adheres to Slice 2 continuation cursor rules', async () => {
  const ctx = createCommandContext({ surface: 'test', env: {} });

  // 1. Continuation with valid cursor
  const validCursor = encodeResultCursor({
    source: 'openalex',
    query: 'W2741809807',
    state: { cursor: 'ILYA_CURSOR_PAGE_2' },
  });

  const urls: string[] = [];
  const restore = stubFetch((url) => {
    urls.push(url);
    return new Response(JSON.stringify(OPENALEX_CITATIONS_PAYLOAD), { status: 200 });
  });

  try {
    const res = await executeResearchCitations({ id: 'W2741809807', cursor: validCursor }, ctx);
    assert.equal(urls.length, 1);
    assert.match(urls[0]!, /cursor=ILYA_CURSOR_PAGE_2/);
    const cmd = (res.details as Record<string, unknown>).northstarCommand as { outcome: string };
    assert.equal(cmd.outcome, 'success');
  } finally {
    restore();
  }

  // 2. Foreign source cursor fails closed with pagination_not_supported
  const foreignCursor = encodeResultCursor({
    source: 'semantic_scholar',
    query: 'W2741809807',
    state: { offset: 10 },
  });
  const foreignRes = await executeResearchCitations({ id: 'W2741809807', source: 'openalex', cursor: foreignCursor }, ctx);
  const foreignCmd = (foreignRes.details as Record<string, unknown>).northstarCommand as { outcome: string; error?: { code: string } };
  assert.equal(foreignCmd.outcome, 'failed');
  assert.equal(foreignCmd.error?.code, 'pagination_not_supported');

  // 3. Mismatched target ID cursor fails closed with invalid_input
  const mismatchedCursor = encodeResultCursor({
    source: 'openalex',
    query: 'W9999999999',
    state: { cursor: 'abc' },
  });
  const mismatchedRes = await executeResearchCitations({ id: 'W2741809807', cursor: mismatchedCursor }, ctx);
  const mismatchedCmd = (mismatchedRes.details as Record<string, unknown>).northstarCommand as { outcome: string; error?: { code: string } };
  assert.equal(mismatchedCmd.outcome, 'failed');
  assert.equal(mismatchedCmd.error?.code, 'invalid_input');

  // 4. Invalid token shape
  await assert.rejects(
    async () => executeResearchCitations({ id: 'W2741809807', cursor: '' }, ctx),
    (err: Error & { code?: string }) => err.code === 'invalid_input',
  );
});

test('research.citations maps rate limits and abort correctly', async () => {
  const ctx = createCommandContext({ surface: 'test', env: {} });

  // 429 -> rate_limited
  let restore = stubFetch(() => new Response('Too Many Requests', { status: 429 }));
  try {
    const res = await executeResearchCitations({ id: 'W2741809807' }, ctx);
    const cmd = (res.details as Record<string, unknown>).northstarCommand as {
      outcome: string;
      error?: { code: string; retryable: boolean };
    };
    assert.equal(cmd.outcome, 'failed');
    assert.equal(cmd.error?.code, 'rate_limited');
    assert.equal(cmd.error?.retryable, true);
  } finally {
    restore();
  }

  // Abort -> cancelled
  const controller = new AbortController();
  controller.abort();
  const abortedCtx = createCommandContext({ surface: 'test', env: {}, signal: controller.signal });
  await assert.rejects(
    async () => executeResearchCitations({ id: 'W2741809807' }, abortedCtx),
    (err: Error & { commandResult?: { outcome: string } }) => err.commandResult?.outcome === 'cancelled',
  );
});

test('callNativeTool routes research citations through the command handler', async () => {
  const restore = stubFetch(() => new Response(JSON.stringify(OPENALEX_CITATIONS_PAYLOAD), { status: 200 }));
  try {
    const res = await callNativeTool('research', { action: 'citations', id: 'W2741809807' });
    const cmd = (res.details as Record<string, unknown>).northstarCommand as {
      commandId: string;
      outcome: string;
    };
    assert.equal(cmd.commandId, RESEARCH_CITATIONS_COMMAND);
    assert.equal(cmd.outcome, 'success');
  } finally {
    restore();
  }
});
