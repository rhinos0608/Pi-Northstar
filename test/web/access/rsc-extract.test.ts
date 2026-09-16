import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractRSCContent,
  RSC_MIN_EXTRACTED_CONTENT,
  RSC_MIN_USEFUL_CONTENT,
} from '../../../src/web/access/rsc-extract.js';

assert.equal(RSC_MIN_USEFUL_CONTENT, 500);
assert.equal(RSC_MIN_EXTRACTED_CONTENT, 100);

function flightHtml(body: string, title: string): string {
  return (
    `<!doctype html><html><head><title>${title}</title></head><body><div>Loading...</div>` +
    `<script>self.__next_f.push([1,${JSON.stringify(body)}])</script></body></html>`
  );
}

function para(text: string): string {
  return JSON.stringify(['$', 'p', null, { children: text }]);
}

test('non-RSC HTML returns null', () => {
  assert.equal(
    extractRSCContent('<html><head><title>Plain</title></head><body><p>Text</p></body></html>'),
    null,
  );
  assert.equal(extractRSCContent(''), null);
});

test('main chunk 23 adopted with title fallback split on |', () => {
  const article = 'RSC article content survives the loading shell. '.repeat(20);
  const body = `23:${JSON.stringify(['$', 'article', null, { children: ['$', 'p', null, { children: article }] }])}\n`;
  const result = extractRSCContent(flightHtml(body, 'RSC article | Example'));
  assert.ok(result);
  assert.equal(result.title, 'RSC article');
  assert.match(result.content, /RSC article content survives the loading shell/);
});

test('chunk dedup keeps the longest payload per id', () => {
  const long = `Longer dedup content wins over the shorter payload variant here. ${'x'.repeat(80)}`;
  const body = `40:${para('tiny')}\n40:${para(long)}\n`;
  const result = extractRSCContent(flightHtml(body, 'Dedup'));
  assert.ok(result);
  assert.match(result.content, /Longer dedup content wins/);
});

test('$L ref resolution follows cross-chunk references', () => {
  const target = `Target paragraph reached through a flight reference. ${'y'.repeat(120)}`;
  const ref = JSON.stringify(['$', 'div', null, { children: '$L30' }]);
  const body = `23:${ref}\n30:${para(target)}\n`;
  const result = extractRSCContent(flightHtml(body, 'Refs'));
  assert.ok(result);
  assert.match(result.content, /Target paragraph reached through a flight reference/);
});

test('table builder renders header separator markdown', () => {
  const cell = (text: string): unknown[] => ['$', 'th', null, { children: text }];
  const table = JSON.stringify([
    '$', 'table', null,
    {
      children: [
        ['$', 'thead', null, { children: ['$', 'tr', null, { children: [cell(`Name ${'n'.repeat(60)}`), cell(`Age ${'a'.repeat(60)}`)] }] }],
        ['$', 'tbody', null, { children: ['$', 'tr', null, { children: [cell(`Ada ${'d'.repeat(60)}`), cell(`36 ${'e'.repeat(60)}`)] }] }],
      ],
    },
  ]);
  const result = extractRSCContent(flightHtml(`23:${table}\n`, 'Tables'));
  assert.ok(result);
  assert.match(result.content, /\| --- \|/);
  assert.match(result.content, /Ada/);
});

test('100-char floor: short payloads return null', () => {
  const body = `23:${para('Short content under the floor.')}\n`;
  assert.equal(extractRSCContent(flightHtml(body, 'Short')), null);
});

test('malformed JSON chunks skipped, valid sibling still adopted', () => {
  const article = 'Valid sibling chunk adopted despite the malformed neighbor. '.repeat(10);
  const body = `24:not-json[{{broken}\n23:${para(article)}\n`;
  const result = extractRSCContent(flightHtml(body, 'Mixed'));
  assert.ok(result);
  assert.match(result.content, /Valid sibling chunk adopted/);
});

test('malformed-only payload returns null', () => {
  const body = '24:not-json[{{broken}\n';
  assert.equal(extractRSCContent(flightHtml(body, 'Broken')), null);
});
