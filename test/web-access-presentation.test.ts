import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  citationsToKeepWebAccess,
  formatWebAccessFusedBatchText,
  formatWebAccessFusedQueryText,
  formatWebAccessMultiQueryText,
  formatWebAccessProviderSections,
  formatWebAccessRetrieveText,
  formatWebAccessSearchSummary,
  formatWebAccessSourceCheck,
  truncateWebAccessText,
} from '../src/web-access-presentation.js';
import { buildWebAccessErrorPlan } from '../src/web-access-error-plan.js';
import {
  formatWebAccessSpecializedSection,
  selectWebAccessSpecializedKind,
} from '../src/web-access-github-presentation.js';

const HIT = (title: string, url: string) => ({ title, url, snippet: 's' });

describe('formatWebAccessSearchSummary', () => {
  it('formats answer plus numbered sources', () => {
    assert.equal(
      formatWebAccessSearchSummary([HIT('A', 'https://a.example/'), HIT('B', 'https://b.example/')], 'Answer here.'),
      'Answer here.\n\n---\n\n**Sources:**\n1. A\n   https://a.example/\n\n2. B\n   https://b.example/',
    );
  });

  it('omits the sources header body when no answer and no results', () => {
    assert.equal(formatWebAccessSearchSummary([], ''), 'No results found.');
  });

  it('notes empty sources when an answer exists without results', () => {
    assert.equal(
      formatWebAccessSearchSummary([], 'Answer.'),
      'Answer.\n\n---\n\n**Sources:**\nNo sources returned.',
    );
  });
});

describe('formatWebAccessProviderSections', () => {
  it('keeps explicit provider order', () => {
    const text = formatWebAccessProviderSections([
      { provider: 'exa', results: [HIT('E', 'https://e.example/')] },
      { provider: 'tavily', results: [HIT('T', 'https://t.example/')], answer: 'A' },
    ]);
    assert.match(text, /## Provider: exa[\s\S]*## Provider: tavily/);
    assert.match(text, /1\. T\n   https:\/\/t\.example\//);
  });
});

describe('formatWebAccessMultiQueryText', () => {
  it('headers each query and appends the responseId hint', () => {
    const text = formatWebAccessMultiQueryText({
      results: [
        { queryIndex: 0, query: 'q1', response: { provider: 'exa', results: [HIT('E', 'https://e.example/')] } },
        { queryIndex: 1, query: 'q2', error: { provider: 'tavily', kind: 'timeout', message: 'slow', retryable: true } },
      ],
      responseId: 'resp-1',
      getSearchContentTool: 'get_search_content',
    });
    assert.match(text, /## Query: "q1"/);
    assert.match(text, /## Query: "q2"/);
    assert.match(text, /Error: slow/);
    assert.match(text, /responseId "resp-1"/);
  });

  it('renders a provider-errors section without a retrieval hint when unregistered', () => {
    const text = formatWebAccessMultiQueryText({
      results: [{ queryIndex: 0, query: 'q', response: { provider: 'exa', results: [] } }],
      providerFailures: [{ provider: 'brave', kind: 'auth', message: 'bad key', retryable: false }],
      getSearchContentTool: null,
    });
    assert.match(text, /## Provider errors/);
    assert.match(text, /- brave: bad key/);
    assert.doesNotMatch(text, /responseId/);
  });
});

describe('citationsToKeepWebAccess', () => {
  it('retains through the highest cited source, floored at numResults, capped at 20', () => {
    assert.equal(citationsToKeepWebAccess('see [1] and [7]', 10, 5), 7);
    assert.equal(citationsToKeepWebAccess('plain', 10, 5), 5);
    assert.equal(citationsToKeepWebAccess('see [30]', 30, 5), 20);
    assert.equal(citationsToKeepWebAccess('see [3]', 2, 5), 2);
  });
});

describe('truncateWebAccessText', () => {
  it('passes short text through and marks long text with an in-budget marker', () => {
    assert.equal(truncateWebAccessText('abc', 100).truncated, false);
    const out = truncateWebAccessText('x'.repeat(100), 50);
    assert.equal(out.truncated, true);
    assert.ok(out.text.length <= 50);
    assert.match(out.text, /\[truncated: showing \d+ of 100 chars\]/);
  });
});

describe('formatWebAccessSourceCheck', () => {
  it('renders status, sources, and the heuristic retrieval note', () => {
    const text = formatWebAccessSourceCheck({
      id: 'a1',
      query: 'claim q',
      sources: [{ rank: 1, url: 'https://d.example/', title: 'D', quality: 'official_docs' }],
      claims: [
        {
          status: 'supported',
          rationale: 'two passages agree',
          confidence: 0.7,
          supporting_passages: ['1-0'],
          contradicting_passages: [],
        },
      ],
    });
    assert.match(text, /# Source check: claim q/);
    assert.match(text, /\*\*Status:\*\* supported \(confidence 0\.70\)/);
    assert.match(text, /1\. \[official_docs\] D/);
    assert.match(text, /heuristic assessment/);
    assert.match(text, /retrievable via get_search_content/);
  });
});

describe('formatWebAccessFusedQueryText', () => {
  it('numbers fused hits with provider provenance and safe partial failures', () => {
    const text = formatWebAccessFusedQueryText({
      query: 'q1',
      queryIndex: 0,
      hits: [HIT('A', 'https://a.example/'), HIT('B', 'https://b.example/')],
      providers: ['tavily', 'exa'],
      failures: [{ provider: 'brave', message: 'slow' }],
    });
    assert.match(text, /1\. A\n   https:\/\/a\.example\//);
    assert.match(text, /2\. B\n   https:\/\/b\.example\//);
    assert.match(text, /Providers: tavily, exa/);
    assert.match(text, /- brave: slow/);
  });

  it('appends bounded include-content without exceeding maxChars', () => {
    const text = formatWebAccessFusedQueryText({
      query: 'q',
      queryIndex: 0,
      hits: [HIT('A', 'https://a.example/')],
      providers: ['exa'],
      answer: 'Ans.',
      inlineContent: 'y'.repeat(200),
      includeContent: true,
      maxChars: 120,
    });
    assert.match(text, /Ans\./);
    assert.match(text, /Content:/);
    assert.ok(text.length <= 120);
    assert.match(text, /\[truncated:/);
  });

  it('omits content section unless includeContent is true', () => {
    const text = formatWebAccessFusedQueryText({
      query: 'q',
      queryIndex: 0,
      hits: [HIT('A', 'https://a.example/')],
      providers: ['exa'],
      inlineContent: 'hidden body',
    });
    assert.doesNotMatch(text, /hidden body/);
  });
});

describe('formatWebAccessFusedBatchText', () => {
  it('keeps per-query input order and appends failures plus retrieval hint', () => {
    const text = formatWebAccessFusedBatchText({
      results: [
        { query: 'second', queryIndex: 1, hits: [HIT('B', 'https://b.example/')], providers: ['exa'] },
        { query: 'first', queryIndex: 0, hits: [HIT('A', 'https://a.example/')], providers: ['tavily'] },
      ],
      responseId: 'resp-9',
      getSearchContentTool: 'get_search_content',
    });
    const firstAt = text.indexOf('"first"');
    const secondAt = text.indexOf('"second"');
    assert.ok(firstAt >= 0 && secondAt > firstAt);
    assert.match(text, /responseId "resp-9"/);
  });

  it('bounds batch output with an in-budget truncation marker', () => {
    const text = formatWebAccessFusedBatchText({
      results: [
        { query: 'q', queryIndex: 0, hits: [HIT('A', 'https://a.example/')], providers: ['exa'], inlineContent: 'z'.repeat(500), includeContent: true },
      ],
      maxChars: 120,
    });
    assert.ok(text.length <= 120);
    assert.match(text, /\[truncated: showing \d+ of \d+ chars\]/);
  });
});

describe('formatWebAccessRetrieveText', () => {
  it('bounds retrieved corpus text with an in-budget marker', () => {
    const short = formatWebAccessRetrieveText('abc', 100);
    assert.equal(short, 'abc');
    const long = formatWebAccessRetrieveText('x'.repeat(100), 50);
    assert.ok(long.length <= 50);
    assert.match(long, /\[truncated: showing \d+ of 100 chars\]/);
  });
});

describe('buildWebAccessErrorPlan', () => {
  it('returns null without an error or cancel signal', () => {
    assert.equal(buildWebAccessErrorPlan(undefined), null);
    assert.equal(buildWebAccessErrorPlan({}), null);
  });

  it('keeps bare errors as a single line', () => {
    assert.deepEqual(buildWebAccessErrorPlan({ error: 'No URL provided' }), {
      expanded: ['No URL provided'],
      collapsed: [],
      expandHint: null,
    });
  });

  it('builds collapsed/expanded cancel diagnostics with per-query states', () => {
    const plan = buildWebAccessErrorPlan({
      error: 'Search cancelled.',
      cancelled: true,
      cancelReason: 'stale',
      browserConnected: false,
      queryCount: 2,
      cancelledQueries: [
        { query: 'q1', provider: 'exa', error: null, resultCount: 3 },
        { query: 'q2', provider: 'tavily', error: 'boom', resultCount: 0 },
      ],
    });
    assert.ok(plan);
    assert.match(plan.expanded.join('\n'), /Diagnostics:/);
    assert.match(plan.expanded.join('\n'), /Per-query results/);
    assert.match(plan.collapsed.join('\n'), /2\/2 queries completed/);
    assert.ok(plan.expandHint);
  });

  it('previews extra detail lines for non-cancel errors', () => {
    const plan = buildWebAccessErrorPlan({ error: 'fetch failed', extraLines: ['url: https://x.example/'] });
    assert.ok(plan);
    assert.match(plan.collapsed.join('\n'), /url: https:\/\/x\.example\//);
  });
});

describe('specialized presentation routing', () => {
  it('routes github and youtube hosts without touching tool modules', () => {
    assert.equal(selectWebAccessSpecializedKind('https://github.com/a/b'), 'github');
    assert.equal(selectWebAccessSpecializedKind('https://youtu.be/v'), 'media');
    assert.equal(selectWebAccessSpecializedKind('https://www.youtube.com/watch?v=v'), 'media');
    assert.equal(selectWebAccessSpecializedKind('https://example.com/x'), undefined);
    assert.equal(selectWebAccessSpecializedKind('not a url'), undefined);
  });

  it('renders a bounded labeled section', () => {
    const text = formatWebAccessSpecializedSection({
      kind: 'github',
      url: 'https://github.com/a/b',
      title: 'readme',
      content: 'hello',
    });
    assert.match(text, /## GitHub: readme/);
    const truncated = formatWebAccessSpecializedSection({
      kind: 'media',
      url: 'https://youtu.be/v',
      title: 'vid',
      content: 'y'.repeat(100),
      maxChars: 50,
    });
    assert.match(truncated, /\[truncated:/);
  });
});
