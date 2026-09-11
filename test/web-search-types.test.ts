import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_WEB_SEARCH_PROVIDER_COUNT,
  DEFAULT_WEB_SEARCH_PROVIDER_ORDER,
  DEFAULT_WEB_SEARCH_PROVIDER_TIMEOUT_MS,
  MAX_WEB_SEARCH_PROVIDER_COUNT,
  MAX_WEB_SEARCH_PROVIDER_TIMEOUT_MS,
  MIN_WEB_SEARCH_PROVIDER_TIMEOUT_MS,
  WEB_GENERATED_TEXT_MAX_CHARS,
  WEB_GENERATED_TEXT_MAX_ITEMS,
  WEB_KNOWLEDGE_MAX_RESULTS,
  WEB_SEARCH_PROVIDER_IDS,
  type WebFetchAdapter,
  type WebGeneratedText,
  type WebSearchAdapter,
} from '../src/web-search-types.js';
import { validateWebEntity, type WebArticleV1 } from '../src/web-contract.js';

test('provider ids frozen: 10 ids, codex last, default order excludes codex', () => {
  assert.deepEqual([...WEB_SEARCH_PROVIDER_IDS], [
    'tavily',
    'exa',
    'brave',
    'diffbot',
    'firecrawl',
    'jina',
    'searxng',
    'ollama-search',
    'duckduckgo',
    'codex',
  ]);
  assert.deepEqual([...DEFAULT_WEB_SEARCH_PROVIDER_ORDER], [
    'tavily',
    'exa',
    'brave',
    'diffbot',
    'firecrawl',
    'jina',
    'searxng',
    'ollama-search',
    'duckduckgo',
  ]);
  assert.ok(!DEFAULT_WEB_SEARCH_PROVIDER_ORDER.includes('codex' as never));
});

test('limits frozen', () => {
  assert.equal(DEFAULT_WEB_SEARCH_PROVIDER_COUNT, 3);
  assert.equal(MAX_WEB_SEARCH_PROVIDER_COUNT, 8);
  assert.equal(DEFAULT_WEB_SEARCH_PROVIDER_TIMEOUT_MS, 12_000);
  assert.equal(MIN_WEB_SEARCH_PROVIDER_TIMEOUT_MS, 1_000);
  assert.equal(MAX_WEB_SEARCH_PROVIDER_TIMEOUT_MS, 30_000);
  assert.equal(WEB_GENERATED_TEXT_MAX_CHARS, 8_000);
  assert.equal(WEB_GENERATED_TEXT_MAX_ITEMS, 32);
  assert.equal(WEB_KNOWLEDGE_MAX_RESULTS, 3);
});

test('generated text discriminated: summary uses result_url, answer non-citation supporting set', () => {
  const summary: WebGeneratedText = {
    kind: 'summary',
    backend: 'exa',
    url: 'https://example.com/a',
    text: 'generated summary',
    provenance: { kind: 'result_url', urls: ['https://example.com/a'] },
    claimCitations: false,
  };
  const answer: WebGeneratedText = {
    kind: 'answer',
    backend: 'tavily',
    text: 'generated answer',
    provenance: { kind: 'supporting_result_set', urls: ['https://example.com/a'] },
    claimCitations: false,
  };
  assert.equal(summary.claimCitations, false);
  assert.equal(answer.claimCitations, false);
  assert.equal(answer.provenance.kind, 'supporting_result_set');
  const bad: WebGeneratedText = {
    kind: 'answer',
    backend: 'tavily',
    text: 'x',
    // @ts-expect-error answer must not carry citation provenance
    provenance: { kind: 'claim_citations', urls: [] },
    // @ts-expect-error claimCitations must stay false (non-citation)
    claimCitations: true,
  };
  void bad;
});

test('adapter contracts structurally typecheck', () => {
  const adapter: WebSearchAdapter = {
    id: 'duckduckgo',
    configured: (_env) => true,
    search: async (input) => ({ backend: input.limit > 0 ? adapter.id : adapter.id, hits: [], generatedText: [] }),
  };
  const fetchAdapter: WebFetchAdapter = {
    id: 'firecrawl',
    configured: (_env) => false,
    fetch: async (input) => ({
      url: input.url,
      title: '',
      content: '',
      backend: 'firecrawl',
      externalProcessing: true,
      generatedText: [],
    }),
  };
  assert.equal(adapter.id, 'duckduckgo');
  assert.equal(fetchAdapter.id, 'firecrawl');
});

test('canonical WebArticleV1 unchanged: rejects generated/contributor fields', () => {
  const base: WebArticleV1 = {
    version: 1,
    kind: 'article',
    id: 'web:article:1',
    url: 'https://example.com/a',
    source: 'exa',
    backend: 'exa',
    title: 't',
    snippet: 's',
  };
  assert.equal(validateWebEntity(base).ok, true);
  const withGenerated = { ...base, generatedText: [] };
  const check = validateWebEntity(withGenerated);
  assert.equal(check.ok, false);
  assert.ok(check.issues.some((i) => i.includes('generatedText')));
  const withContributors = { ...base, contributors: [] };
  const check2 = validateWebEntity(withContributors);
  assert.equal(check2.ok, false);
});
