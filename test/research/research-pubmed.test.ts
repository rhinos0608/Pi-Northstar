import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchPubmed } from '../../src/research/research-pubmed.js';
import { decodeResultCursor, validateNorthstarResult } from '../../src/result-contract.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const ESEARCH = {
  esearchresult: {
    count: '25',
    retmax: '2',
    retstart: '0',
    idlist: ['36925667', '12345678'],
    translationset: [],
  },
};

const ESUMMARY = {
  result: {
    uids: ['36925667', '12345678'],
    '36925667': {
      title: 'Example trial',
      authors: [{ name: 'Ada Example' }],
      source: 'Example Journal',
      pubdate: '2024 Mar 1',
      articleids: [{ idtype: 'doi', value: '10.1234/pm' }],
    },
    '12345678': {
      title: 'Second docsum',
      source: 'Other Journal',
      pubdate: '2023',
    },
  },
};

test('pubmed: esearch+esummary flow, field-tag filters, auth params, entity mapping, cursor', async () => {
  const urls: string[] = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    urls.push(String(input));
    return String(input).includes('esearch.fcgi') ? jsonResponse(ESEARCH) : jsonResponse(ESUMMARY);
  };
  try {
    const result = await searchPubmed(
      {
        query: 'CRISPR review',
        limit: 2,
        yearFrom: 2022,
        author: 'Ada Example',
        doi: '10.1234/pm',
        venue: 'Example Journal',
        env: { NCBI_API_KEY: 'ncbi-secret-1', NCBI_EMAIL: 'team@example.com' },
      },
      { requestedAction: 'search' },
    );
    assert.equal(urls.length, 2);
    const esearchUrl = new URL(urls[0]!);
    assert.equal(esearchUrl.origin + esearchUrl.pathname, 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi');
    assert.equal(esearchUrl.searchParams.get('db'), 'pubmed');
    assert.equal(esearchUrl.searchParams.get('term'), 'CRISPR review AND Ada Example[Author] AND 10.1234/pm[doi] AND Example Journal[Journal]');
    assert.equal(esearchUrl.searchParams.get('retmode'), 'json');
    assert.equal(esearchUrl.searchParams.get('retstart'), '0');
    assert.equal(esearchUrl.searchParams.get('retmax'), '2');
    assert.equal(esearchUrl.searchParams.get('mindate'), '2022');
    assert.equal(esearchUrl.searchParams.get('datetype'), 'pdat');
    assert.equal(esearchUrl.searchParams.get('api_key'), 'ncbi-secret-1');
    assert.equal(esearchUrl.searchParams.get('email'), 'team@example.com');
    assert.equal(esearchUrl.searchParams.get('tool'), 'pi-northstar');

    const esummaryUrl = new URL(urls[1]!);
    assert.equal(esummaryUrl.pathname.endsWith('esummary.fcgi'), true);
    assert.equal(esummaryUrl.searchParams.get('id'), '36925667,12345678');

    assert.ok(validateNorthstarResult(result).ok, JSON.stringify(result));
    assert.equal(result.status, 'ok');
    assert.equal(result.sources[0]?.backend, 'pubmed-eutils');
    if (result.data.kind !== 'entities') return;
    const first = result.data.entities[0]!;
    assert.equal(first.kind, 'work');
    assert.equal(first.id, '36925667');
    assert.equal(first.url, 'https://pubmed.ncbi.nlm.nih.gov/36925667/');
    assert.equal(first.venue, 'Example Journal');
    assert.equal(first.year, 2024);
    assert.equal(first.doi, '10.1234/pm');
    assert.deepEqual(first.authors, [{ name: 'Ada Example' }]);

    assert.equal(result.pagination.hasMore, true);
    const decoded = decodeResultCursor(result.pagination.nextCursor!, { source: 'pubmed', query: 'CRISPR review', yearFrom: 2022 });
    assert.equal(decoded.state.retstart, 2);

    await searchPubmed({
      query: 'CRISPR review', limit: 2, yearFrom: 2022,
      cursor: result.pagination.nextCursor!, env: {},
    });
    assert.equal(new URL(urls[2]!).searchParams.get('retstart'), '2');
    assert.doesNotMatch(JSON.stringify(result), /ncbi-secret-1/);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('pubmed: empty idlist → empty envelope, esummary never called', async () => {
  const savedFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input: string | URL | Request) => {
    urls.push(String(input));
    return jsonResponse({ esearchresult: { count: '0', idlist: [] } });
  };
  try {
    const result = await searchPubmed({ query: 'q', env: {} });
    assert.equal(result.status, 'empty');
    assert.equal(urls.length, 1);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('pubmed: esearchresult.error → rate_limited', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ esearchresult: { error: 'API rate limit exceeded', idlist: [] } });
  try {
    const result = await searchPubmed({ query: 'q', env: {} });
    assert.equal(result.errors[0]?.code, 'rate_limited');
    assert.equal(result.errors[0]?.retryable, true);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('pubmed: malformed containers → invalid_backend_response', async () => {
  const savedFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    return call === 1
      ? jsonResponse({ error: 'not the right shape' })
      : jsonResponse({ result: { no_uids: true } });
  };
  try {
    const first = await searchPubmed({ query: 'q', env: {} });
    assert.equal(first.errors[0]?.code, 'invalid_backend_response');
    const second = await searchPubmed({ query: 'q', env: {} });
    assert.equal(second.errors[0]?.code, 'invalid_backend_response');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('pubmed: HTTP failure messages never contain the key-bearing URL', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 429 });
  try {
    const result = await searchPubmed({ query: 'q', env: { NCBI_API_KEY: 'ncbi-secret-1' } });
    assert.equal(result.errors[0]?.code, 'rate_limited');
    const text = JSON.stringify(result);
    assert.doesNotMatch(text, /ncbi-secret-1/);
    assert.doesNotMatch(text, /api_key=/);
  } finally {
    globalThis.fetch = savedFetch;
  }
});
