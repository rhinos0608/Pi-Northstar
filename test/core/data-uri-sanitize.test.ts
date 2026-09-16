import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  MAX_DATA_URI_HEADER_CHARS,
  sanitizeInlineDataUris,
} from '../../src/core/data-uri-sanitize.js';

const MARKER_PREFIX = '[pi-northstar inline data URI omitted;';

function markerCount(text: string): number {
  return text.split(MARKER_PREFIX).length - 1;
}

test('base64 + percent-encoded forms collapse to markers', () => {
  const input =
    'Before ![diagram](data:image/png;base64,SGVsbG8=) between <img src="data:text/plain,hello%20world"> after.';
  const { text, omissions } = sanitizeInlineDataUris(input, 'fetch.content[0]');
  assert.equal(omissions.length, 2);
  assert.equal(markerCount(text), 2);
  assert.equal(omissions[0]?.mimeType, 'image/png');
  assert.equal(omissions[0]?.encoding, 'base64');
  assert.equal(omissions[1]?.mimeType, 'text/plain');
  assert.equal(omissions[1]?.encoding, 'percent-encoded');
  assert.doesNotMatch(text, /data:/i);
  assert.ok(text.startsWith('Before ![diagram]('));
});

test('small SVG omitted with decoded digest metadata', () => {
  const decoded = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';
  const payload = encodeURIComponent(decoded);
  const { text, omissions } = sanitizeInlineDataUris(
    `Diagram: ![tiny vector](data:image/svg+xml;charset=utf-8,${payload}) done`,
    'fetch.content[0]',
  );
  assert.equal(omissions.length, 1);
  const omission = omissions[0]!;
  assert.equal(omission.mimeType, 'image/svg+xml');
  assert.equal(omission.decodedBytes, Buffer.byteLength(decoded));
  assert.equal(omission.sha256, createHash('sha256').update(decoded).digest('hex'));
  assert.equal(omission.digestBasis, 'decoded');
  assert.equal(omission.retrieval, 'not-retained');
  assert.ok(text.includes('retrieval=not-retained]'));
  assert.doesNotMatch(text, /data:/i);
});

test('header over 1024 chars bounded without retaining payload', () => {
  assert.equal(MAX_DATA_URI_HEADER_CHARS, 1024);
  const header = `image/png;name=${'x'.repeat(2048)};base64`;
  const { text, omissions } = sanitizeInlineDataUris(`![x](data:${header},SGVsbG8=)`, 'fetch.content[0]');
  assert.equal(omissions.length, 1);
  assert.equal(omissions[0]?.decodeError, 'header-too-long');
  assert.equal(omissions[0]?.decodedBytes, null);
  assert.ok(!text.includes('x'.repeat(128)));
  assert.doesNotMatch(text, /data:/i);
});

test('non-data schemes untouched, prose data: label kept', () => {
  const input = 'See https://example.com/a and ordinary data: value here';
  const { text, omissions } = sanitizeInlineDataUris(input, 'fetch.content[0]');
  assert.equal(omissions.length, 0);
  assert.equal(text, input);
});

test('data: inside prose/code without comma is not an inline URI', () => {
  const { text } = sanitizeInlineDataUris('ordinary data: value', 'fetch.content[0]');
  assert.equal(text, 'ordinary data: value');
});

test('marker carries ordinal, source, mime, encoding, byte counts, sha256', () => {
  const { text } = sanitizeInlineDataUris('x data:text/plain,hi y', 'fetch.content[0]');
  assert.match(text, /ordinal=1;/);
  assert.ok(text.includes('source=fetch.content_0_;') || text.includes('source=fetch.content'));
  assert.match(text, /mime=text\/plain;/);
  assert.match(text, /encoding=percent-encoded;/);
  assert.match(text, /encodedBytes=\d+;/);
  assert.match(text, /sha256=[a-f0-9]{64};/);
  assert.ok(text.includes('retrieval=not-retained]'));
});

test('sanitize is idempotent: markers contain no data: payload', () => {
  const once = sanitizeInlineDataUris('a data:image/png;base64,SGVsbG8= b', 'fetch.content[0]');
  const twice = sanitizeInlineDataUris(once.text, 'fetch.content[0]');
  assert.equal(twice.text, once.text);
  assert.equal(twice.omissions.length, 0);
});

test('no ordinal leakage across calls: each call restarts at 1', () => {
  const first = sanitizeInlineDataUris('a data:text/plain,one b', 'fetch.content[0]');
  const second = sanitizeInlineDataUris('c data:text/plain,two d', 'fetch.content[0]');
  assert.match(first.text, /ordinal=1;/);
  assert.match(second.text, /ordinal=1;/);
  assert.doesNotMatch(second.text, /ordinal=2/);
});

test('invalid base64 classified without payload-bearing errors', () => {
  const { text, omissions } = sanitizeInlineDataUris('x data:image/png;base64,***not-base64*** y', 'k');
  assert.equal(omissions.length, 1);
  assert.equal(omissions[0]?.decodedBytes, null);
  assert.equal(omissions[0]?.digestBasis, 'encoded');
  assert.equal(omissions[0]?.decodeError, 'invalid-base64-character');
  assert.ok(text.includes('decodedBytes=unknown'));
  assert.ok(!text.includes('not-base64'));
});
