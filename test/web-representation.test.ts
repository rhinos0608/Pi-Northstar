import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseRepresentation, cleanContentLength, contentRichness } from '../src/web-representation.js';
import type { WebSearchHit } from '../src/web-search-types.js';

function hit(overrides: Partial<WebSearchHit> & { snippet: string }): WebSearchHit {
  return {
    title: 't',
    url: 'https://example.com/a',
    backend: 'exa',
    ...overrides,
  };
}

test('omitted contentKind ranks as snippet', () => {
  assert.equal(contentRichness(undefined), 0);
  assert.ok(contentRichness('summary') > contentRichness(undefined));
  assert.ok(contentRichness('full') > contentRichness('summary'));
});

test('richer kind wins regardless of length or order', () => {
  const snippet = hit({ snippet: 'a much longer snippet body with many words', backend: 'exa' });
  const summary = hit({ snippet: 'short', contentKind: 'summary', backend: 'brave' });
  assert.equal(chooseRepresentation(snippet, summary).backend, 'brave');
  assert.equal(chooseRepresentation(summary, snippet).backend, 'brave');
  const full = hit({ snippet: 'x', contentKind: 'full', backend: 'tavily' });
  assert.equal(chooseRepresentation(summary, full).backend, 'tavily');
});

test('within one kind, longer clean content wins', () => {
  const short = hit({ snippet: 'abc', backend: 'exa' });
  const long = hit({ snippet: 'a longer snippet body', backend: 'brave' });
  assert.equal(chooseRepresentation(short, long).backend, 'brave');
  assert.equal(chooseRepresentation(long, short).backend, 'brave');
  assert.equal(cleanContentLength('  padded  '), 'padded'.length);
});

test('exact richness ties keep the earlier selected provider', () => {
  const first = hit({ snippet: 'same', backend: 'exa', title: 'First' });
  const second = hit({ snippet: 'same', backend: 'brave', title: 'Second' });
  const chosen = chooseRepresentation(first, second);
  assert.equal(chosen.backend, 'exa');
  assert.equal(chosen.title, 'First');
});

test('publication metadata backfills only when winner lacks it', () => {
  const winner = hit({ snippet: 'longer winner body here', backend: 'exa' });
  const loser = hit({
    snippet: 'x',
    backend: 'brave',
    publishedDate: '2026-01-01',
    author: 'Ada',
  });
  const merged = chooseRepresentation(winner, loser);
  assert.equal(merged.backend, 'exa');
  assert.equal(merged.publishedDate, '2026-01-01');
  assert.equal(merged.author, 'Ada');

  const conflictWinner = hit({
    snippet: 'longer winner body here',
    backend: 'exa',
    publishedDate: '2026-02-02',
    author: 'Grace',
  });
  const conflicted = chooseRepresentation(conflictWinner, loser);
  assert.equal(conflicted.publishedDate, '2026-02-02');
  assert.equal(conflicted.author, 'Grace');
});

test('selection takes no score or rank input', () => {
  assert.equal(chooseRepresentation.length, 2);
});
