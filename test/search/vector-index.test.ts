import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VectorIndex } from '../../src/search/vector-index.js';

// ── add + search: identical vector returns score ~1.0 ──

test('identical vector returns cosine similarity ~1.0', () => {
  const idx = new VectorIndex(4);
  idx.add('doc1', [1, 0, 0, 0]);
  idx.add('doc2', [0, 1, 0, 0]);

  const results = idx.search([1, 0, 0, 0]);
  assert.equal(results.length, 2);
  assert.equal(results[0]!.id, 'doc1');
  assert.ok(Math.abs(results[0]!.score - 1) < 1e-6);
});

// ── Orthogonal vectors return score ~0.0 ──

test('orthogonal vectors return cosine similarity ~0.0', () => {
  const idx = new VectorIndex(2);
  idx.add('doc1', [1, 0]);
  idx.add('doc2', [0, 1]);

  void idx.search([1, 1]);
  // Both should have non-equal cosine (1/√2 ≈ 0.707)
  // But if we search with [1, 0], doc2 is orthogonal → score ~0
  const resultsOrtho = idx.search([1, 0]);
  const doc2Score = resultsOrtho.find((r) => r.id === 'doc2')!.score;
  assert.ok(Math.abs(doc2Score) < 1e-6);
});

// ── search returns correct topK sorted ──

test('search returns topK results sorted descending', () => {
  const idx = new VectorIndex(2);
  idx.add('a', [1, 0]);
  idx.add('b', [0.9, 0.1]);
  idx.add('c', [0.8, 0.2]);
  idx.add('d', [0.7, 0.3]);

  const results = idx.search([1, 0], 2);
  assert.equal(results.length, 2);
  assert.equal(results[0]!.id, 'a');
  assert.equal(results[1]!.id, 'b');
  assert.ok(results[0]!.score >= results[1]!.score);
});

test('search respects topK limit less than total docs', () => {
  const idx = new VectorIndex(2);
  idx.add('a', [1, 0]);
  idx.add('b', [0, 1]);
  idx.add('c', [0.5, 0.5]);

  const results = idx.search([1, 0], 1);
  assert.equal(results.length, 1);
});

test('search returns all results when topK exceeds count', () => {
  const idx = new VectorIndex(2);
  idx.add('a', [1, 0]);
  idx.add('b', [0, 1]);

  const results = idx.search([1, 0], 100);
  assert.equal(results.length, 2);
});

// ── Dimension mismatch ──

test('dimension mismatch on add throws', () => {
  const idx = new VectorIndex(3);
  idx.add('doc1', [1, 2, 3]);

  assert.throws(() => {
    idx.add('doc2', [1, 2]);
  }, /Dimension mismatch/);
});

test('inferred dimensions reject mismatched vector', () => {
  const idx = new VectorIndex();
  idx.add('doc1', [1, 2, 3]);

  assert.throws(() => {
    idx.add('doc2', [1, 2]);
  }, /Dimension mismatch/);
});

test('dimension mismatch on search throws', () => {
  const idx = new VectorIndex(3);
  idx.add('doc1', [1, 2, 3]);
  assert.throws(() => { idx.search([1, 2]); }, /Dimension mismatch/);
});

test('inferred dimensions reject mismatched search query', () => {
  const idx = new VectorIndex();
  idx.add('doc1', [1, 2, 3]);
  assert.throws(() => { idx.search([1, 2]); }, /Dimension mismatch/);
});

// ── clear ──

test('clear empties index', () => {
  const idx = new VectorIndex(2);
  idx.add('doc1', [1, 0]);
  idx.add('doc2', [0, 1]);
  assert.equal(idx.stats().count, 2);

  idx.clear();
  assert.equal(idx.stats().count, 0);
  assert.deepEqual(idx.search([1, 0]), []);
});

// ── stats ──

test('stats returns correct counts', () => {
  const idx = new VectorIndex(4);
  assert.deepEqual(idx.stats(), { count: 0, dimensions: 4 });

  idx.add('doc1', [1, 0, 0, 0]);
  let s = idx.stats();
  assert.equal(s.count, 1);
  assert.equal(s.dimensions, 4);

  idx.add('doc2', [0, 1, 0, 0]);
  s = idx.stats();
  assert.equal(s.count, 2);
  assert.equal(s.dimensions, 4);
});

test('stats returns dimensions 0 before any add', () => {
  const idx = new VectorIndex();
  assert.equal(idx.stats().dimensions, 0);
  assert.equal(idx.stats().count, 0);
});

test('stats returns inferred dimensions after first add', () => {
  const idx = new VectorIndex();
  idx.add('doc1', [1, 2, 3, 4, 5]);
  assert.equal(idx.stats().dimensions, 5);
});

// ── Edge: empty index search ──

test('empty index search returns empty array', () => {
  const idx = new VectorIndex(3);
  assert.deepEqual(idx.search([1, 2, 3]), []);
  assert.deepEqual(idx.search([1, 2, 3], 5), []);
});

// ── Edge: single vector in index ──

test('single vector in index returns itself', () => {
  const idx = new VectorIndex(3);
  idx.add('only', [1, 2, 3]);

  const results = idx.search([1, 2, 3]);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.id, 'only');
  assert.ok(Math.abs(results[0]!.score - 1) < 1e-6);
});

// ── Idempotent add ──

test('re-adding same id replaces vector', () => {
  const idx = new VectorIndex(2);
  idx.add('doc', [1, 0]);
  idx.add('doc', [0, 1]); // replace

  assert.equal(idx.stats().count, 1);

  // Searching for [1, 0] should now return doc with ~0 score
  const resultsSearch = idx.search([1, 0]);
  assert.equal(resultsSearch[0]!.id, 'doc');
  assert.ok(Math.abs(resultsSearch[0]!.score) < 1e-6);

  // Searching for [0, 1] should give ~1.0
  const resultsSearch2 = idx.search([0, 1]);
  assert.equal(resultsSearch2[0]!.id, 'doc');
  assert.ok(Math.abs(resultsSearch2[0]!.score - 1) < 1e-6);
});

// ── number[] input works same as Float32Array ──

test('number[] input works same as Float32Array on add', () => {
  const idx = new VectorIndex(3);
  idx.add('num', [1, 2, 3]);
  idx.add('float', new Float32Array([1, 2, 3]));

  const results = idx.search([1, 2, 3]);
  assert.equal(results.length, 2);
  // Both should have score ~1.0
  assert.ok(Math.abs(results[0]!.score - 1) < 1e-6);
  assert.ok(Math.abs(results[1]!.score - 1) < 1e-6);
});

test('number[] input works same as Float32Array on search', () => {
  const idx = new VectorIndex(3);
  idx.add('doc1', [1, 2, 3]);

  const resultsNum = idx.search([1, 2, 3]);
  const resultsFloat = idx.search(new Float32Array([1, 2, 3]));

  assert.equal(resultsNum.length, 1);
  assert.equal(resultsFloat.length, 1);
  assert.equal(resultsNum[0]!.id, resultsFloat[0]!.id);
  assert.ok(Math.abs(resultsNum[0]!.score - resultsFloat[0]!.score) < 1e-6);
});

// ── Edge: zero-magnitude vector ──

test('zero vector has cosine similarity 0', () => {
  const idx = new VectorIndex(2);
  idx.add('doc', [0, 0]);
  idx.add('other', [1, 0]);

  const results = idx.search([1, 0]);
  // doc has zero norm, so cosine is 0
  const zeroScore = results.find((r) => r.id === 'doc')!.score;
  assert.equal(zeroScore, 0);
});

// ── Edge: query with zero vector ──

test('zero query vector returns score 0 for all', () => {
  const idx = new VectorIndex(2);
  idx.add('doc1', [1, 0]);
  idx.add('doc2', [0.5, 0.5]);

  const results = idx.search([0, 0]);
  assert.equal(results.length, 2);
  assert.equal(results[0]!.score, 0);
  assert.equal(results[1]!.score, 0);
});

// ── Negative values work ──

test('vectors with negative values produce correct cosine similarity', () => {
  const idx = new VectorIndex(2);
  idx.add('a', [1, 0]);
  idx.add('b', [-1, 0]);

  const results = idx.search([1, 0]);
  assert.equal(results[0]!.id, 'a');
  assert.equal(results[1]!.id, 'b');
  assert.ok(results[0]!.score > 0);
  assert.ok(results[1]!.score < 0);
});

// ── Multiple operations maintain consistency ──

test('multiple operations maintain consistency', () => {
  const idx = new VectorIndex(2);
  assert.equal(idx.stats().count, 0);

  idx.add('a', [1, 0]);
  idx.add('b', [0, 1]);
  assert.equal(idx.stats().count, 2);
  assert.equal(idx.stats().dimensions, 2);

  let res = idx.search([1, 0]);
  assert.equal(res.length, 2);
  assert.equal(res[0]!.id, 'a');

  idx.clear();
  assert.equal(idx.stats().count, 0);

  idx.add('c', [0.5, 0.5]);
  assert.equal(idx.stats().count, 1);
  assert.equal(idx.stats().dimensions, 2);

  res = idx.search([0.5, 0.5]);
  assert.equal(res.length, 1);
  assert.equal(res[0]!.id, 'c');
  assert.ok(Math.abs(res[0]!.score - 1) < 1e-6);
});


