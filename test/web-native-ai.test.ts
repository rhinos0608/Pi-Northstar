import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeGeneratedText, resolveWebNativeAiPolicy } from '../src/web-native-ai.js';
import type { WebGeneratedText } from '../src/web-search-types.js';

function summary(url: string, text: string, backend: WebGeneratedText['backend'] = 'exa'): WebGeneratedText {
  return { kind: 'summary', backend, url, text, provenance: { kind: 'result_url', urls: [url] }, claimCitations: false };
}

function answer(text: string, urls: string[]): WebGeneratedText {
  return { kind: 'answer', backend: 'tavily', text, provenance: { kind: 'supporting_result_set', urls }, claimCitations: false };
}

test('native AI defaults on when absent or blank', () => {
  assert.deepEqual(resolveWebNativeAiPolicy({}), { summaries: true, answers: true });
  assert.deepEqual(resolveWebNativeAiPolicy({ PI_SEARCH_NATIVE_SUMMARIES: '', PI_SEARCH_NATIVE_ANSWERS: '  ' }), {
    summaries: true,
    answers: true,
  });
});

test('explicit opt-out honored per flag', () => {
  assert.deepEqual(resolveWebNativeAiPolicy({ PI_SEARCH_NATIVE_SUMMARIES: '0', PI_SEARCH_NATIVE_ANSWERS: 'false' }), {
    summaries: false,
    answers: false,
  });
  assert.deepEqual(resolveWebNativeAiPolicy({ PI_SEARCH_NATIVE_SUMMARIES: 'TRUE', PI_SEARCH_NATIVE_ANSWERS: '1' }), {
    summaries: true,
    answers: true,
  });
});

test('malformed boolean values rejected', () => {
  assert.throws(() => resolveWebNativeAiPolicy({ PI_SEARCH_NATIVE_SUMMARIES: 'yes' }), /PI_SEARCH_NATIVE_SUMMARIES/);
  assert.throws(() => resolveWebNativeAiPolicy({ PI_SEARCH_NATIVE_ANSWERS: 'maybe' }), /PI_SEARCH_NATIVE_ANSWERS/);
});

test('normalize drops empty summaries and answers without supporting urls', () => {
  const out = normalizeGeneratedText([
    summary('https://example.com/a', '  '),
    summary('', 'text'),
    answer('', ['https://example.com/a']),
    answer('answer text', []),
    answer('answer text', ['  ']),
    answer('kept', ['https://example.com/a']),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.kind, 'answer');
  assert.equal((out[0] as { text: string }).text, 'kept');
});

test('normalize truncates items to 8000 chars and caps collection at 32', () => {
  const long = 'x'.repeat(9000);
  const out = normalizeGeneratedText([summary('https://example.com/a', long)]);
  assert.equal((out[0]! as { text: string }).text.length, 8000);
  const many: WebGeneratedText[] = Array.from({ length: 40 }, (_, i) => summary(`https://example.com/${i}`, `t${i}`));
  assert.equal(normalizeGeneratedText(many).length, 32);
});

test('normalize dedupes repeated summary urls and repeated answers', () => {
  const out = normalizeGeneratedText([
    summary('https://example.com/a', 'first'),
    summary('https://example.com/a', 'second'),
    answer('same', ['https://example.com/a']),
    answer('same', ['https://example.com/a']),
    answer('other', ['https://example.com/a', 'https://example.com/a', 'https://example.com/b']),
  ]);
  assert.equal(out.length, 3);
  assert.equal((out[0]! as { text: string }).text, 'first');
  const last = out[2]!;
  assert.equal(last.kind, 'answer');
  if (last.kind === 'answer') {
    assert.deepEqual(last.provenance.urls, ['https://example.com/a', 'https://example.com/b']);
    assert.equal(last.claimCitations, false);
  }
});

test('normalize never emits claim citations', () => {
  const out = normalizeGeneratedText([answer('t', ['https://example.com/a'])]);
  assert.equal(out[0]!.claimCitations, false);
  if (out[0]!.kind === 'answer') {
    assert.equal(out[0]!.provenance.kind, 'supporting_result_set');
  }
});
