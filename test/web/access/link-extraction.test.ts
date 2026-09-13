import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractLinksFromHtml, sameDomain } from '../../../src/web/access/link-extraction.js';

// ── Tests ──

test('extractLinksFromHtml resolves relative links', () => {
  const html = '<html><body><a href="/about">About</a></body></html>';
  const links = extractLinksFromHtml(html, 'https://example.com/');
  assert.deepEqual(links, ['https://example.com/about']);
});

test('extractLinksFromHtml resolves protocol-relative links', () => {
  const html = '<html><body><a href="//example.com/page">Page</a></body></html>';
  const links = extractLinksFromHtml(html, 'https://example.com/');
  assert.deepEqual(links, ['https://example.com/page']);
});

test('extractLinksFromHtml strips fragments', () => {
  const html = '<html><body><a href="/page#section">Section</a></body></html>';
  const links = extractLinksFromHtml(html, 'https://example.com/');
  assert.equal(links.length, 1);
  assert.ok(!links[0]!.includes('#'), 'fragment should be stripped');
});

test('extractLinksFromHtml skips fragment-only links', () => {
  const html = '<html><body><a href="#top">Top</a><a href="/page">Page</a></body></html>';
  const links = extractLinksFromHtml(html, 'https://example.com/');
  assert.deepEqual(links, ['https://example.com/page']);
});

test('extractLinksFromHtml skips javascript: links', () => {
  const html = '<a href="javascript:void(0)">Click</a>';
  const links = extractLinksFromHtml(html, 'https://example.com/');
  assert.deepEqual(links, []);
});

test('extractLinksFromHtml skips mailto: links', () => {
  const html = '<a href="mailto:test@example.com">Email</a>';
  const links = extractLinksFromHtml(html, 'https://example.com/');
  assert.deepEqual(links, []);
});

test('extractLinksFromHtml skips binary extensions', () => {
  const html = `
    <a href="/doc.pdf">PDF</a>
    <a href="/image.png">Image</a>
    <a href="/archive.zip">Zip</a>
    <a href="/video.mp4">Video</a>
    <a href="/page.html">Page</a>
  `;
  const links = extractLinksFromHtml(html, 'https://example.com/');
  assert.deepEqual(links, ['https://example.com/page.html']);
});

test('extractLinksFromHtml skips non-http schemes', () => {
  const html = `
    <a href="ftp://files.example.com/doc">FTP</a>
    <a href="javascript:void(0)">JS</a>
    <a href="/page">Page</a>
  `;
  const links = extractLinksFromHtml(html, 'https://example.com/');
  assert.deepEqual(links, ['https://example.com/page']);
});

test('extractLinksFromHtml handles multiple links on same page', () => {
  const html = `
    <a href="/a">A</a>
    <a href="/b">B</a>
    <a href="/c?q=1&ref=test">C</a>
  `;
  const links = extractLinksFromHtml(html, 'https://example.com/');
  assert.equal(links.length, 3);
  assert.ok(links.includes('https://example.com/a'));
  assert.ok(links.includes('https://example.com/b'));
  assert.ok(links.includes('https://example.com/c?q=1&ref=test'));
});

test('extractLinksFromHtml skips empty href', () => {
  const html = '<a href="">Empty</a><a href="/page">Page</a>';
  const links = extractLinksFromHtml(html, 'https://example.com/');
  assert.deepEqual(links, ['https://example.com/page']);
});

test('extractLinksFromHtml handles single-quote attributes', () => {
  const html = "<a href='/page'>Page</a>";
  const links = extractLinksFromHtml(html, 'https://example.com/');
  assert.deepEqual(links, ['https://example.com/page']);
});

test('extractLinksFromHtml handles no-attribute links (should skip)', () => {
  const html = '<a>Link without href</a>';
  const links = extractLinksFromHtml(html, 'https://example.com/');
  assert.deepEqual(links, []);
});

test('sameDomain matches same host ignoring www', () => {
  assert.ok(sameDomain('https://www.example.com/page', 'example.com'));
  assert.ok(sameDomain('https://example.com/page', 'example.com'));
  assert.ok(!sameDomain('https://other.com/page', 'example.com'));
  assert.ok(!sameDomain('https://sub.example.com/page', 'example.com'));
});

test('sameDomain rejects malformed URLs', () => {
  assert.ok(!sameDomain('not-a-url', 'example.com'));
});
