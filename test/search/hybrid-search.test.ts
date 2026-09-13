import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BM25Index } from '../../src/search/bm25.js';
import { chunkText } from '../../src/search/chunker.js';
import { VectorIndex } from '../../src/search/vector-index.js';
import { rrfMerge, normalizeUrl } from '../../src/search/fusion.js';

// --- helpers -----------------------------------------------------------

function mockEmbedding(text: string, dims = 4): Float32Array {
  // Deterministic pseudo-embedding: char codes → floats, padded/truncated
  const vec = new Float32Array(dims);
  for (let i = 0; i < text.length && i < dims; i++) {
    vec[i] = text.charCodeAt(i) / 255;
  }
  return vec;
}

// --- tests -------------------------------------------------------------

describe('hybrid search integration', () => {

  describe('BM25 + Vector RRF fusion', () => {
    it('document appearing in both BM25 and vector results ranks highest', () => {
      const docs = [
        { id: 'a', text: 'machine learning algorithms for classification' },
        { id: 'b', text: 'deep neural networks and backpropagation' },
        { id: 'c', text: 'cooking recipes for Italian pasta' },
        { id: 'd', text: 'machine learning classification with SVM' },
        { id: 'e', text: 'gardening tips for spring planting' },
      ];

      const bm25 = new BM25Index();
      bm25.addBatch(docs);

      const vecIdx = new VectorIndex(4);
      for (const doc of docs) {
        vecIdx.add(doc.id, mockEmbedding(doc.text));
      }

      const bm25Results = bm25.search('machine learning classification', 5);
      const queryVec = mockEmbedding('machine learning classification');
      const vecResults = vecIdx.search(queryVec, 5);

      const bm25Mapped = bm25Results.map(r => ({ id: r.id, score: r.score }));
      const vecMapped = vecResults.map(r => ({ id: r.id, score: r.score }));

      const fused = rrfMerge([bm25Mapped, vecMapped], { keyFn: (item: { id: string }) => item.id });

      assert.ok(fused.length > 0, 'fused results should be non-empty');

      // Document 'a' and 'd' are about machine learning — should rank high
      const topIds = fused.slice(0, 3).map(f => f.item.id);
      assert.ok(topIds.includes('a'), `expected 'a' in top 3, got ${topIds}`);
      assert.ok(topIds.includes('d'), `expected 'd' in top 3, got ${topIds}`);

      // Document appearing in both should rank higher than one appearing in only one
      const aScore = fused.find(f => f.item.id === 'a')!.rrfScore;
      const cScore = fused.find(f => f.item.id === 'c')!.rrfScore;
      assert.ok(aScore > cScore, `a (${aScore}) should score higher than c (${cScore})`);
    });
  });

  describe('chunking + BM25 integration', () => {
    it('search finds term in correct chunk first', () => {
      const section1 = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
      const section2 = 'Quantum computing uses qubits for parallel processing. '.repeat(20);
      const section3 = 'Regular expressions pattern match strings efficiently. '.repeat(20);
      const largeText = section1 + section2 + section3;

      const chunks = chunkText(largeText, { maxChars: 500, overlap: 100, minChars: 50 });
      assert.ok(chunks.length > 1, 'should produce multiple chunks');

      const bm25 = new BM25Index();
      for (let i = 0; i < chunks.length; i++) {
        bm25.add(String(i), chunks[i]!.text);
      }

      // Search for term unique to section2
      const results = bm25.search('qubits quantum', 5);
      assert.ok(results.length > 0, 'should find results');

      // The top result should contain quantum computing content
      const topChunk = chunks[Number(results[0]!.id)]!;
      assert.ok(
        topChunk.text.includes('Quantum computing'),
        `top chunk should contain 'Quantum computing', got: ${topChunk.text.slice(0, 80)}...`,
      );
    });
  });

  describe('pipeline simulation', () => {
    it('chunk → BM25 index → search returns correct shape', () => {
      const html = `
        <html><head><title>Test Page</title></head>
        <body>
          <p>${'Artificial intelligence is transforming healthcare. '.repeat(30)}</p>
          <p>${'Blockchain technology enables decentralized finance. '.repeat(30)}</p>
          <p>${'Climate change requires immediate global action. '.repeat(30)}</p>
        </body></html>
      `;

      // Strip HTML (simple version of what fetchReadablePage does)
      const content = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      const chunks = chunkText(content, { maxChars: 1000, overlap: 200, minChars: 50 });
      assert.ok(chunks.length >= 1, 'should produce at least 1 chunk');

      const bm25 = new BM25Index();
      for (let i = 0; i < chunks.length; i++) {
        bm25.add(String(i), chunks[i]!.text);
      }

      const results = bm25.search('blockchain decentralized', 3);
      assert.ok(results.length > 0, 'should find results');

      const topChunk = chunks[Number(results[0]!.id)]!;
      assert.ok(
        topChunk.text.includes('Blockchain') || topChunk.text.includes('blockchain'),
        'top chunk should contain blockchain content',
      );
    });
  });

  describe('graceful degradation', () => {
    it('BM25-only path returns results without vectors', () => {
      const bm25 = new BM25Index();
      bm25.add('doc1', 'TypeScript is a typed superset of JavaScript');
      bm25.add('doc2', 'Python is a dynamic programming language');
      bm25.add('doc3', 'Rust provides memory safety without garbage collection');

      const results = bm25.search('TypeScript typed', 5);
      assert.ok(results.length > 0, 'should return results');
      assert.equal(results[0]!.id, 'doc1', 'doc1 should rank first');
    });
  });

  describe('multi-backend URL dedup', () => {
    it('RRF fusion deduplicates URLs across backends', () => {
      // Simulate results from 3 backends with overlapping URLs
      const backend1 = [
        { url: 'https://example.com/page1', title: 'Page 1', snippet: 'A' },
        { url: 'https://example.com/page2', title: 'Page 2', snippet: 'B' },
        { url: 'https://example.com/page3', title: 'Page 3', snippet: 'C' },
      ];
      const backend2 = [
        { url: 'https://example.com/page2', title: 'Page 2 Alt', snippet: 'D' },
        { url: 'https://example.com/page4', title: 'Page 4', snippet: 'E' },
        { url: 'https://example.com/page1', title: 'Page 1 Alt', snippet: 'F' },
      ];
      const backend3 = [
        { url: 'https://example.com/page5', title: 'Page 5', snippet: 'G' },
        { url: 'https://example.com/page1', title: 'Page 1 Alt2', snippet: 'H' },
        { url: 'https://example.com/page3', title: 'Page 3 Alt', snippet: 'I' },
      ];

      const fused = rrfMerge(
        [backend1, backend2, backend3],
        { keyFn: (item: { url: string }) => normalizeUrl(item.url) },
      );

      // page1 appears in all 3 backends — should rank highest
      assert.ok(fused.length <= 5, `should have at most 5 unique URLs, got ${fused.length}`);

      const topUrl = normalizeUrl(fused[0]!.item.url);
      assert.ok(
        topUrl.includes('example.com/page1'),
        `page1 should rank first (appears in all 3), got ${topUrl}`,
      );

      // All URLs should be unique
      const urls = fused.map(f => normalizeUrl(f.item.url));
      const uniqueUrls = new Set(urls);
      assert.equal(urls.length, uniqueUrls.size, 'all URLs should be unique');
    });
  });

  describe('normalizeUrl dedup consistency', () => {
    it('normalizes www, trailing slash, and utm params', () => {
      assert.equal(
        normalizeUrl('https://www.example.com/page/?utm_source=test&key=val'),
        normalizeUrl('https://example.com/page?key=val'),
      );
    });
  });
});
