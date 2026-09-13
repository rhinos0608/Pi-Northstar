import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkText } from '../../src/search/chunker.js';

test('short text returns single chunk', () => {
  const text = 'Hello world. This is short.';
  const result = chunkText(text, { maxChars: 2048, minChars: 1 });
  assert.equal(result.length, 1);
  assert.equal(result[0]!.text, text);
  assert.equal(result[0]!.start, 0);
  assert.equal(result[0]!.end, text.length);
});

test('empty text returns empty array', () => {
  assert.deepEqual(chunkText(''), []);
});

test('text exactly at maxChars returns single chunk', () => {
  const text = 'x'.repeat(100);
  const result = chunkText(text, { maxChars: 100, minChars: 1, overlap: 0 });
  assert.equal(result.length, 1);
  assert.equal(result[0]!.text, text);
  assert.equal(result[0]!.start, 0);
  assert.equal(result[0]!.end, 100);
});

test('text just over maxChars splits at sentence boundary', () => {
  // 'First. Second.' = 14 chars, maxChars=13 forces split
  const text = 'First. Second.';
  const result = chunkText(text, { maxChars: 13, minChars: 1, overlap: 0 });
  assert.equal(result.length, 2);
  assert.equal(result[0]!.text, 'First.');
  assert.equal(result[0]!.start, 0);
  assert.equal(result[0]!.end, 6);
  assert.equal(result[1]!.text, 'Second.');
  assert.equal(result[1]!.start, 7);
  assert.equal(result[1]!.end, 14);
});

test('overlap includes trailing content from previous chunk', () => {
  // 'A. B. C. D.' — each sentence 2 chars, space-separated (11 chars total)
  // maxChars=8: chunk 1 holds ~2.5 sentences, overlap=2 carries "C." into chunk 2
  const text = 'A. B. C. D.';
  const result = chunkText(text, { maxChars: 8, overlap: 2, minChars: 1 });

  assert.equal(result.length, 2);
  assert.equal(result[0]!.text, 'A. B. C.');
  assert.equal(result[0]!.start, 0);
  assert.equal(result[0]!.end, 8);
  assert.equal(result[1]!.text, 'C. D.');
  assert.equal(result[1]!.start, 6);
  assert.equal(result[1]!.end, 11);

  // Overlap content "C." (2 chars) appears in both chunks
  assert.ok(result[0]!.text.includes('C.'));
  assert.ok(result[1]!.text.includes('C.'));
});

test('overlap zero means no shared content between chunks', () => {
  const text = 'First. Second. Third. Fourth.';
  const result = chunkText(text, { maxChars: 16, overlap: 0, minChars: 1 });

  assert.equal(result.length, 2);
  assert.equal(result[0]!.text, 'First. Second.');
  assert.equal(result[0]!.start, 0);
  assert.equal(result[0]!.end, 14);
  assert.equal(result[1]!.text, 'Third. Fourth.');
  assert.equal(result[1]!.start, 15);
  assert.equal(result[1]!.end, 29);

  // No overlap: end of first chunk does not exceed start of second
  assert.ok(result[0]!.end <= result[1]!.start);
  // Each chunk text matches original slice exactly
  assert.equal(result[0]!.text, text.slice(result[0]!.start, result[0]!.end));
  assert.equal(result[1]!.text, text.slice(result[1]!.start, result[1]!.end));
});

test('minChars filters short trailing chunk', () => {
  // 'Alpha. Beta. Gamma. Delta. E.' — last sentence 'E.' (2 chars) < minChars(6)
  const text = 'Alpha. Beta. Gamma. Delta. E.';
  const result = chunkText(text, { maxChars: 15, minChars: 6, overlap: 0 });

  assert.equal(result.length, 2);
  assert.equal(result[0]!.text, 'Alpha. Beta.');
  assert.equal(result[1]!.text, 'Gamma. Delta.');
});

test('minChars filters short chunks entirely', () => {
  // Every sentence is 2 chars, maxChars=4 means one-sentence chunks
  // Each chunk (2 chars) < minChars(5), so all are filtered
  const text = 'A. B. C. D.';
  const result = chunkText(text, { maxChars: 4, minChars: 5, overlap: 0 });
  assert.equal(result.length, 0);
});

test('paragraph boundaries preserved in chunking', () => {
  const p1 = 'Paragraph one here.';
  const p2 = 'Paragraph two here.';
  const text = p1 + '\n\n' + p2;
  // text = 19 + 2 + 19 = 40 chars
  const result = chunkText(text, { maxChars: 30, minChars: 1, overlap: 0 });

  assert.equal(result.length, 2);
  assert.equal(result[0]!.text, p1);
  assert.equal(result[0]!.start, 0);
  assert.equal(result[0]!.end, 19);
  assert.equal(result[1]!.text, p2);
  assert.equal(result[1]!.start, 21);
  assert.equal(result[1]!.end, 40);
});

test('no sentence boundaries falls back to paragraph split', () => {
  // Lowercase text with no .!? before capitalized words
  const para1 = 'this is a paragraph with no sentence boundaries at all';
  const para2 = 'another paragraph here without capitals after periods';
  const text = para1 + '\n\n' + para2;

  const result = chunkText(text, { maxChars: 70, minChars: 1, overlap: 0 });

  assert.equal(result.length, 2);
  assert.equal(result[0]!.text, para1);
  assert.equal(result[1]!.text, para2);
});

test('no paragraph breaks falls back to fixed-size slicing', () => {
  // Single run of text with no sentence boundaries and no paragraph breaks
  const text =
    'hello world this is a test with no punctuation at all and no paragraph breaks just one long string of text that must be split by fixed size';
  const result = chunkText(text, { maxChars: 30, minChars: 1, overlap: 5 });
  assert.ok(result.length >= 2);
  // Verify every chunk slice matches the original text
  for (const chunk of result) {
    assert.equal(chunk.text, text.slice(chunk.start, chunk.end));
  }
});

test('unicode characters preserved in single chunk', () => {
  const text = 'Hello. 🌍 Earth. 中文 works. 🎉 Party.';
  const result = chunkText(text, { maxChars: 100, overlap: 10, minChars: 1 });
  assert.equal(result.length, 1);
  assert.equal(result[0]!.text, text);
  assert.ok(result[0]!.text.includes('🌍'));
  assert.ok(result[0]!.text.includes('中文'));
  assert.ok(result[0]!.text.includes('🎉'));
});

test('unicode multi-chunk with overlap preserves characters', () => {
  const text = '🌍 One. 🎉 Two. 🚀 Three. ⭐ Four. 💥 Five.';
  const result = chunkText(text, { maxChars: 16, overlap: 4, minChars: 1 });
  assert.ok(result.length >= 2);

  // Verify no lone surrogates (no mid-emoji splitting)
  for (const chunk of result) {
    assert.ok(chunk.text.length > 0);
    for (let i = 0; i < chunk.text.length; i++) {
      const code = chunk.text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        assert.ok(i + 1 < chunk.text.length);
        const next = chunk.text.charCodeAt(i + 1);
        assert.ok(next >= 0xdc00 && next <= 0xdfff);
      }
    }
  }

  // All emoji appear somewhere in the combined output
  const allText = result.map((c) => c.text).join('');
  for (const emoji of ['🌍', '🎉', '🚀', '⭐', '💥']) {
    assert.ok(allText.includes(emoji));
  }
});

test('position metadata accurate across chunks', () => {
  const text = 'First. Second. Third. Fourth.';
  const result = chunkText(text, { maxChars: 16, minChars: 1, overlap: 0 });

  assert.equal(result.length, 2);
  // Each chunk text matches the slice from original
  for (const chunk of result) {
    assert.equal(chunk.text, text.slice(chunk.start, chunk.end));
  }
  // No overlap between chunks
  assert.ok(result[0]!.end <= result[1]!.start);
  // Full coverage: from first start to last end
  const covered = result[1]!.end - result[0]!.start;
  assert.equal(covered, text.length);
  // Separator space at index 14 is between chunks
  assert.equal(result[0]!.end, 14);
  assert.equal(result[1]!.start, 15);
});

test('very short text filtered by minChars returns empty', () => {
  const text = 'Hi.';
  const result = chunkText(text, { maxChars: 2048, minChars: 100 });
  assert.equal(result.length, 0);
});

test('text with default options handles medium text', () => {
  // Build text long enough to be above default minChars (100) but below maxChars (2048)
  const text = 'Hello world. This is a test. '.repeat(5);
  const result = chunkText(text);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.text, text);
});

test('overlap >= maxChars throws RangeError', () => {
  assert.throws(
    () => chunkText('test', { maxChars: 10, overlap: 10 }),
    RangeError,
  );
});

test('maxChars <= 0 throws RangeError', () => {
  assert.throws(
    () => chunkText('test', { maxChars: 0 }),
    RangeError,
  );
});

test('minChars < 0 throws RangeError', () => {
  assert.throws(
    () => chunkText('test', { minChars: -1 }),
    RangeError,
  );
});

test('oversized sentence split correctly', () => {
  // Single sentence that exceeds maxChars (no sentence boundary, no paragraph break)
  // 'A. BBBBB...' → two spans, second span (200 B's) > maxChars(50)
  const text = 'A. ' + 'B'.repeat(200);
  const result = chunkText(text, { maxChars: 50, minChars: 1, overlap: 0 });
  // Every chunk must respect maxChars
  for (const chunk of result) {
    assert.ok(
      chunk.text.length <= 50,
      `chunk length ${chunk.text.length} exceeds maxChars 50`,
    );
    assert.equal(chunk.text, text.slice(chunk.start, chunk.end));
  }
});

test('surrogate pairs not split', () => {
  const text = '😀';
  const result = chunkText(text, { maxChars: 1, minChars: 0, overlap: 0 });
  assert.ok(result.length > 0, 'result should be non-empty');
  const reconstructed = result.map(c => c.text).join('');
  assert.equal(reconstructed, text, 'reconstructed text must match original');
  for (const chunk of result) {
    for (let i = 0; i < chunk.text.length; i++) {
      const code = chunk.text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        assert.ok(i + 1 < chunk.text.length, 'lone high surrogate');
        const next = chunk.text.charCodeAt(i + 1);
        assert.ok(next >= 0xdc00 && next <= 0xdfff, 'lone high surrogate');
      }
      if (code >= 0xdc00 && code <= 0xdfff) {
        assert.ok(i > 0, 'lone low surrogate at start');
        const prev = chunk.text.charCodeAt(i - 1);
        assert.ok(prev >= 0xd800 && prev <= 0xdbff, 'lone low surrogate');
      }
    }
  }
});
