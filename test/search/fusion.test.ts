import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeUrl, rrfMerge } from '../../src/search/fusion.js';

test('normalizeUrl canonicalizes URL variants for dedup', () => {
  assert.equal(
    normalizeUrl('https://www.Example.com/path/?utm_source=x&a=1#section'),
    'https://example.com/path?a=1',
  );
});

test('normalizeUrl strips only unequivocal tracking params', () => {
  assert.equal(
    normalizeUrl('https://example.com/p?gclsrc=aw.ds&dclid=x&msclkid=y&_ga=1&_gl=2&a=1'),
    'https://example.com/p?a=1',
  );
  assert.equal(normalizeUrl('https://example.com/p?utm_source=x&fbclid=y&gclid=z&mc_cid=c&mc_eid=e&a=1'), 'https://example.com/p?a=1');
});

test('normalizeUrl retains ambiguous identity-bearing params', () => {
  for (const param of ['ref', 'source', 'src', 'pos']) {
    const normalized = normalizeUrl(`https://example.com/p?${param}=x&a=1`);
    assert.ok(normalized.includes(`${param}=x`), `${param} must survive normalization`);
  }
});

test('rrfMerge dedupes within rankings and boosts cross-ranking agreement', () => {
  const fused = rrfMerge([
    [{ url: 'https://a.test', title: 'A1' }, { url: 'https://a.test/', title: 'A duplicate' }, { url: 'https://b.test', title: 'B' }],
    [{ url: 'https://b.test/', title: 'B2' }, { url: 'https://c.test', title: 'C' }, { url: 'https://a.test', title: 'A2' }],
  ], { keyFn: (item) => normalizeUrl(item.url) });

  assert.deepEqual(fused.map((result) => normalizeUrl(result.item.url)), [
    'https://b.test/',
    'https://a.test/',
    'https://c.test/',
  ]);
  assert.ok(fused[0]!.rrfScore > fused[2]!.rrfScore);
});

test('rrfMerge keeps the first-seen item version on cross-ranking key overlap', () => {
  // Rankings arrive in priority order (operator backend order); the earliest
  // copy wins while RRF scores still accumulate across rankings.
  const fused = rrfMerge([
    [{ url: 'https://a.test', title: 'First-priority copy' }],
    [{ url: 'https://a.test/', title: 'Later copy' }],
  ], { keyFn: (item) => normalizeUrl(item.url) });

  assert.equal(fused.length, 1);
  assert.equal(fused[0]!.item.title, 'First-priority copy');
  const single = rrfMerge([
    [{ url: 'https://a.test', title: 'Only copy' }],
  ], { keyFn: (item) => normalizeUrl(item.url) });
  assert.ok(fused[0]!.rrfScore > single[0]!.rrfScore, 'score accumulates across rankings');
});
