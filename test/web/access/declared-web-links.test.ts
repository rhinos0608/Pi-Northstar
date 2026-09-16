import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appendDeclaredWebLinks,
  discoverDeclaredWebLinks,
  MAX_DECLARED_LINKS,
} from '../../../src/web/access/declared-web-links.js';

test('discovers relations from Link headers and HTML declarations', () => {
  const html = `<!doctype html><html><head>
    <base href="/v2/">
    <link rel="stylesheet service-doc" href="docs" type="text/html">
    <link rel="alternate" href="/feed.xml">
  </head><body>
    <a rel="describedby" href="/schema">Schema</a>
    <a href="/developers">Developer careers</a>
    <a rel="service-desc" href="javascript:alert(1)">Unsafe</a>
  </body></html>`;
  const links = discoverDeclaredWebLinks(
    html,
    '</catalog>; title="API, <catalog>"; rel="API-CATALOG"; type="application/linkset+json", ' +
      '</schema>; rel="service-desc"; type="application/schema+json", ' +
      '</metadata>; rel="service-meta"; optional, ' +
      '</quoted>; title="x; rel=service-doc"; rel="alternate", ' +
      '</anchored>; rel="service-doc"; anchor="/other", ' +
      '</ignored>; rel="alternate"',
    'https://example.com/root/start',
  );

  assert.deepEqual(links, [
    {
      url: 'https://example.com/catalog',
      relations: ['api-catalog'],
      type: 'application/linkset+json',
    },
    {
      url: 'https://example.com/schema',
      relations: ['service-desc', 'describedby'],
      type: 'application/schema+json',
    },
    {
      url: 'https://example.com/metadata',
      relations: ['service-meta'],
    },
    {
      url: 'https://example.com/v2/docs',
      relations: ['service-doc'],
      type: 'text/html',
    },
  ]);
});

test('malformed Link headers reject without partial links', () => {
  assert.deepEqual(
    discoverDeclaredWebLinks('<html></html>', '"</unclosed; rel="service-doc"', 'https://example.com/'),
    [],
  );
  assert.deepEqual(
    discoverDeclaredWebLinks('<html></html>', 'not-a-link-value', 'https://example.com/'),
    [],
  );
});

test('bounds declarations at 20 links and rejects oversized URLs', () => {
  assert.equal(MAX_DECLARED_LINKS, 20);
  const declarations = Array.from(
    { length: 25 },
    (_, index) => `<link rel="service-doc" href="/docs/${index}">`,
  ).join('');
  const links = discoverDeclaredWebLinks(
    `<html><head>${declarations}</head></html>`,
    null,
    'https://example.com/',
  );
  assert.equal(links.length, 20);

  const oversized = discoverDeclaredWebLinks(
    '<html></html>',
    `<https://example.com/${'x'.repeat(4096)}>; rel="service-doc"`,
    'https://example.com/',
  );
  assert.deepEqual(oversized, []);
});

test('non-http(s) declared URLs rejected', () => {
  const links = discoverDeclaredWebLinks(
    '<html><head>' +
      '<link rel="service-doc" href="ftp://example.com/docs">' +
      '<link rel="service-doc" href="mailto:a@example.com">' +
      '<link rel="service-doc" href="/docs">' +
      '</head></html>',
    null,
    'https://example.com/',
  );
  assert.deepEqual(links, [
    { url: 'https://example.com/docs', relations: ['service-doc'] },
  ]);
});

test('appendix formatting: section appended once, empty content yields section only', () => {
  const links = discoverDeclaredWebLinks(
    '<html><head><link rel="service-doc" href="/docs"></head></html>',
    null,
    'https://example.com/',
  );
  const appended = appendDeclaredWebLinks('Body text.', links);
  assert.match(appended, /^Body text\.\n\n## Declared links\n\n- Service documentation \(`service-doc`\): <https:\/\/example\.com\/docs>$/);
  assert.equal(appendDeclaredWebLinks('', links), '## Declared links\n\n- Service documentation (`service-doc`): <https://example.com/docs>');
  assert.equal(appendDeclaredWebLinks('Body.', []), 'Body.');
});

test('unquoted href values scan, bare rel-less anchors ignored', () => {
  const links = discoverDeclaredWebLinks(
    '<html><body><a rel=describedby href=/schema>Schema</a><a href=/other>Other</a></body></html>',
    null,
    'https://example.com/',
  );
  assert.deepEqual(links, [
    { url: 'https://example.com/schema', relations: ['describedby'] },
  ]);
});
