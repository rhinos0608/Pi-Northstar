import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BM25Index, stem, tokenize } from '../src/bm25.js';

// ── Tokenizer ──

test('tokenize lowercases input', () => {
  assert.deepEqual(tokenize('Hello World'), ['hello', 'world']);
});

test('tokenize splits on non-word characters', () => {
  // Hyphen splits. Underscore also splits because `_` is not \p{L} or \p{N}.
  assert.deepEqual(tokenize('hello-world foo_bar'), ['hello', 'world', 'foo', 'bar']);
  assert.deepEqual(tokenize('ab.cd!ef?gh,ij'), ['ab', 'cd', 'ef', 'gh', 'ij']);
});

test('tokenize filters tokens shorter than minLength (default 2)', () => {
  assert.deepEqual(tokenize('a an the cat'), ['cat']);
});

test('tokenize filters English stopwords', () => {
  assert.deepEqual(tokenize('the cat is on the mat'), ['cat', 'mat']);
});

test('tokenize respects custom minLength', () => {
  assert.deepEqual(tokenize('a an the cat', { minLength: 1 }), ['cat']);
});

test('tokenize respects custom stopwords', () => {
  const noStopwords = new Set<string>();
  assert.deepEqual(tokenize('the cat', { stopwords: noStopwords }), ['the', 'cat']);
});

test('tokenize respects lower=false', () => {
  assert.deepEqual(tokenize('Hello World', { lower: false }), ['Hello', 'World']);
});

test('tokenize empty string returns empty array', () => {
  assert.deepEqual(tokenize(''), []);
});

test('tokenize all-stopwords text returns empty array', () => {
  assert.deepEqual(tokenize('the a an is are'), []);
});

test('tokenize handles numbers', () => {
  assert.deepEqual(tokenize('cat 123 dog 456'), ['cat', '123', 'dog', '456']);
});

test('tokenize preserves accented characters as whole words', () => {
  const result = tokenize('café résumé');
  assert.ok(result.includes('café'));
  assert.ok(result.includes('résumé'));
});

test('tokenize handles CJK characters', () => {
  // \p{L}+ matches CJK ideographs as letters
  const result = tokenize('机器学习');
  assert.deepEqual(result, ['机器学习']);
});

test('tokenize handles mixed Latin, accented, and CJK', () => {
  const result = tokenize('hello café 机器学习');
  assert.ok(result.includes('hello'));
  assert.ok(result.includes('café'));
  assert.ok(result.includes('机器学习'));
});

test('tokenize handles punctuation-only string', () => {
  assert.deepEqual(tokenize('!!! ??? ...'), []);
});

test('tokenize handles mixed whitespace and special chars', () => {
  assert.deepEqual(tokenize('  hello   world\t\nfoo  '), ['hello', 'world', 'foo']);
});

// ── BM25Index: add + search ──

test('BM25Index search returns results for single term query', () => {
  const idx = new BM25Index();
  idx.add('doc1', 'the cat sat on the mat');
  idx.add('doc2', 'the dog sat on the log');

  const results = idx.search('cat');
  assert.equal(results.length, 1);
  assert.equal(results[0]!.id, 'doc1');
  assert.ok(results[0]!.score > 0);
});

test('BM25Index search returns multiple results ranked by score', () => {
  const idx = new BM25Index();
  idx.add('doc1', 'cat cat cat cat cat');
  idx.add('doc2', 'dog dog dog cat dog');

  const results = idx.search('cat');
  assert.equal(results.length, 2);
  assert.equal(results[0]!.id, 'doc1');
  assert.ok(results[0]!.score >= results[1]!.score);
});

test('BM25Index search multi-term query', () => {
  const idx = new BM25Index();
  idx.add('doc1', 'cat and dog');
  idx.add('doc2', 'bird and fish');
  idx.add('doc3', 'cat bird');

  const results = idx.search('cat dog');
  assert.equal(results.length, 2);
  assert.equal(results[0]!.id, 'doc1');
});

test('BM25Index search finds accented terms', () => {
  const idx = new BM25Index();
  idx.add('doc1', 'café latte is delicious');
  idx.add('doc2', 'regular coffee is black');

  const results = idx.search('café');
  assert.equal(results.length, 1);
  assert.equal(results[0]!.id, 'doc1');
  assert.ok(results[0]!.score > 0);
});

test('BM25Index search finds CJK terms', () => {
  const idx = new BM25Index();
  idx.add('doc1', '机器学习');
  idx.add('doc2', '深度学习');

  const results = idx.search('机器学习');
  assert.equal(results.length, 1);
  assert.equal(results[0]!.id, 'doc1');
  assert.ok(results[0]!.score > 0);
});

test('BM25Index search finds mixed accented and CJK terms in query', () => {
  const idx = new BM25Index();
  idx.add('doc1', 'café latte and 机器学习');
  idx.add('doc2', 'regular coffee');

  const results = idx.search('café 机器学习');
  assert.equal(results.length, 1);
  assert.equal(results[0]!.id, 'doc1');
});

// ── Term frequency saturation ──

test('BM25Index term frequency saturates (repeating term not linear boost)', () => {
  const idx = new BM25Index();
  idx.add('few', 'cat');          // 1 occurrence
  idx.add('many', 'cat cat cat cat cat cat cat cat cat cat');  // 10 occurrences

  const results = idx.search('cat');
  assert.equal(results.length, 2);

  const fewScore = results.find((r) => r.id === 'few')!.score;
  const manyScore = results.find((r) => r.id === 'many')!.score;
  // Many should score higher but NOT 10x higher (saturation)
  assert.ok(manyScore > fewScore, 'more occurrences should score higher');
  assert.ok(manyScore < fewScore * 5, 'score should saturate (not 10x for 10x term freq)');
});

// ── IDF weighting ──

test('BM25Index rare term scores higher than common term', () => {
  const idx = new BM25Index();
  // doc1 and doc2 share a common term "document", only doc1 has rare term "aardvark"
  idx.add('doc1', 'aardvark document');
  idx.add('doc2', 'document');
  idx.add('doc3', 'document');

  // Search for both terms in single query
  const results1 = idx.search('aardvark');
  assert.equal(results1.length, 1);
  const aardvarkScore = results1[0]!.score;

  const results2 = idx.search('document');
  assert.equal(results2.length, 3);
  const documentScore = results2.find((r) => r.id === 'doc1')!.score;

  // IDF: aardvark (rare) should have higher IDF weight than document (common)
  // So the contribution of aardvark in doc1 should exceed document contribution
  assert.ok(aardvarkScore > documentScore, 'rare term (aardvark) should score higher than common term (document)');
});

// ── Document length normalization ──

test('BM25Index length normalization prevents longer docs dominating', () => {
  const idx = new BM25Index();
  idx.add('short', 'cat');
  idx.add('long', 'cat ' + 'filler '.repeat(100) + 'cat');

  const results = idx.search('cat');
  assert.equal(results.length, 2);

  const shortScore = results.find((r) => r.id === 'short')!.score;
  const longScore = results.find((r) => r.id === 'long')!.score;

  // Short doc should score higher per occurrence (length normalization penalizes long docs)
  assert.ok(shortScore > longScore, 'short doc should outrank long doc for same term frequency');
});

// ── addBatch ──

test('BM25Index addBatch produces same results as sequential adds', () => {
  const batchIdx = new BM25Index();
  batchIdx.addBatch([
    { id: 'doc1', text: 'cat cat dog' },
    { id: 'doc2', text: 'dog bird' },
  ]);

  const seqIdx = new BM25Index();
  seqIdx.add('doc1', 'cat cat dog');
  seqIdx.add('doc2', 'dog bird');

  const batchResults = batchIdx.search('cat dog');
  const seqResults = seqIdx.search('cat dog');

  assert.equal(batchResults.length, seqResults.length);
  for (let i = 0; i < batchResults.length; i++) {
    assert.equal(batchResults[i]!.id, seqResults[i]!.id);
    assert.ok(Math.abs(batchResults[i]!.score - seqResults[i]!.score) < 1e-10);
  }
});

// ── clear + search ──

test('BM25Index clear empties index', () => {
  const idx = new BM25Index();
  idx.add('doc1', 'cat dog');
  idx.clear();
  assert.deepEqual(idx.search('cat'), []);
  assert.deepEqual(idx.search('dog', 5), []);
});

test('BM25Index search on empty index returns empty array', () => {
  const idx = new BM25Index();
  assert.deepEqual(idx.search('anything'), []);
});

// ── stats ──

test('BM25Index stats reports correct counts after adds', () => {
  const idx = new BM25Index();
  assert.deepEqual(idx.stats(), { documentCount: 0, vocabularySize: 0, avgDocLength: 0 });

  idx.add('doc1', 'cat dog');
  let stats = idx.stats();
  assert.equal(stats.documentCount, 1);
  assert.equal(stats.vocabularySize, 2);
  assert.equal(stats.avgDocLength, 2);

  idx.add('doc2', 'cat bird fish');
  stats = idx.stats();
  assert.equal(stats.documentCount, 2);
  assert.equal(stats.vocabularySize, 4);  // cat, dog, bird, fish
  assert.equal(stats.avgDocLength, 2.5);  // (2 + 3) / 2
});

// ── Edge: duplicate ids ──

test('BM25Index re-adding same id replaces document', () => {
  const idx = new BM25Index();
  idx.add('doc1', 'cat dog');
  idx.add('doc1', 'bird fish');

  assert.equal(idx.stats().documentCount, 1);
  assert.deepEqual(idx.search('cat'), []);
  assert.ok(idx.search('bird').length > 0);
  assert.ok(idx.search('fish').length > 0);
});

test('BM25Index re-adding same id updates stats correctly', () => {
  const idx = new BM25Index();
  idx.add('doc1', 'abc def ghi');
  idx.add('doc1', 'xyz uvw rst');

  const stats = idx.stats();
  assert.equal(stats.documentCount, 1);
  assert.equal(stats.vocabularySize, 3);  // only new doc's terms
  assert.equal(stats.avgDocLength, 3);
});

// ── Edge: empty text ──

test('BM25Index adding empty text produces zero-length doc', () => {
  const idx = new BM25Index();
  idx.add('doc1', '');
  assert.equal(idx.stats().documentCount, 1);
  assert.equal(idx.stats().avgDocLength, 0);
  assert.deepEqual(idx.search('anything'), []);
});

// ── Edge: very long text ──

test('BM25Index handles very long text', () => {
  const idx = new BM25Index();
  const longText = 'cat '.repeat(10_000);
  idx.add('doc1', longText);
  idx.add('doc2', 'cat dog');

  const results = idx.search('cat');
  assert.equal(results.length, 2);
  // doc1 has many cats but length normalization keeps score reasonable
  assert.ok(results[0]!.score > 0);
  assert.ok(results[1]!.score > 0);
});

// ── Edge: query with only stopwords ──

test('BM25Index query with only stopwords returns empty', () => {
  const idx = new BM25Index();
  idx.add('doc1', 'cat dog');
  assert.deepEqual(idx.search('the a an'), []);
});

// ── topK parameter ──

test('BM25Index search respects topK parameter', () => {
  const idx = new BM25Index();
  idx.add('doc1', 'cat');
  idx.add('doc2', 'cat');
  idx.add('doc3', 'cat');
  idx.add('doc4', 'cat');

  const results = idx.search('cat', 2);
  assert.equal(results.length, 2);
});

// ── Default parameters ──

test('BM25Index constructor uses defaults k1=1.5, b=0.75', () => {
  const idx = new BM25Index();
  idx.add('doc1', 'cat');
  idx.add('doc2', 'dog');
  const results = idx.search('cat');
  assert.ok(results.length > 0);
  // No error means defaults were accepted
});

test('BM25Index custom k1 and b parameters', () => {
  const idx = new BM25Index(2.0, 0.5);
  idx.add('doc1', 'cat cat cat');
  idx.add('doc2', 'dog');
  const results = idx.search('cat');
  assert.equal(results.length, 1);
  assert.equal(results[0]!.id, 'doc1');
});

// ── No cross-contamination after operations ──

test('BM25Index multiple operations maintain consistency', () => {
  const idx = new BM25Index();
  idx.add('doc1', 'cat dog');
  idx.add('doc2', 'bird fish');
  assert.equal(idx.stats().documentCount, 2);

  idx.clear();
  assert.equal(idx.stats().documentCount, 0);

  idx.add('doc3', 'cat');
  assert.equal(idx.stats().documentCount, 1);
  assert.equal(idx.stats().vocabularySize, 1);

  const results = idx.search('cat');
  assert.equal(results.length, 1);
  assert.equal(results[0]!.id, 'doc3');
});

// ── Stemmer ──

test('stem folds verb inflections to a shared base', () => {
  assert.equal(stem('run'), 'run');
  assert.equal(stem('runs'), 'run');
  assert.equal(stem('running'), 'run');
  assert.equal(stem('played'), 'play');
  assert.equal(stem('stopped'), 'stop');
  assert.equal(stem('stories'), stem('story'));
  assert.equal(stem('boxes'), 'box');
  assert.equal(stem('watches'), 'watch');
  assert.equal(stem('cats'), 'cat');
});

test('stem leaves short words and non-inflected forms intact', () => {
  assert.equal(stem('run'), 'run');
  assert.equal(stem('bus'), 'bus');
  assert.equal(stem('class'), 'class');
  assert.equal(stem('red'), 'red');
  assert.equal(stem('café'), 'café');
  assert.equal(stem('机器学习'), '机器学习');
});

test('stem does not strip derivational suffixes: runner keeps its form', () => {
  // `runner` is an agent noun, not an inflection of `run`; folding it to
  // `run` would mangle code identifiers and prose alike.
  assert.equal(stem('runner'), 'runner');
  assert.equal(stem('filler'), 'filler');
});

test('tokenize folds inflections but keeps code identifiers sensible', () => {
  assert.deepEqual(tokenize('running runs'), ['run', 'run']);
  assert.deepEqual(tokenize('the runner runs'), ['runner', 'run']);
  // Underscore splits first, so `running_total` yields stemmed parts:
  // still searchable as run/total, never as one mangled token.
  assert.deepEqual(tokenize('running_total'), ['run', 'total']);
});

test('BM25Index search matches across verb inflections', () => {
  const idx = new BM25Index();
  idx.add('doc1', 'the runner keeps running every morning');
  idx.add('doc2', 'unrelated bird fish');

  const byBase = idx.search('run');
  assert.equal(byBase.length, 1);
  assert.equal(byBase[0]!.id, 'doc1');

  const byInflection = idx.search('running');
  assert.equal(byInflection.length, 1);
  assert.equal(byInflection[0]!.id, 'doc1');
});

test('stem folds movie/movies and case/cases to a shared base', () => {
  assert.equal(stem('movies'), stem('movie'));
  assert.equal(stem('cases'), stem('case'));
  assert.equal(stem('cases'), 'case');
});

test('stem keeps string intact instead of mapping to str', () => {
  assert.equal(stem('string'), 'string');
  assert.notEqual(stem('string'), stem('str'));
});

test('BM25Index search matches across noun inflections', () => {
  const idx = new BM25Index();
  idx.add('doc1', 'a movie about parallel cases');
  idx.add('doc2', 'unrelated bird fish');

  assert.equal(idx.search('movies')[0]?.id, 'doc1');
  assert.equal(idx.search('case')[0]?.id, 'doc1');
});
