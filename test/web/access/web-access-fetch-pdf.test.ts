import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// RED: final fetch URL-array + internal specialization + local PDF.
// Public interface only; no shared-file or manifest changes.

describe('web-access fetch final: specialization routing', () => {
  it('routes github/media/feed/pdf/page internally with no format param', async () => {
    const { selectWebAccessReaderKind } = await import('../../../src/web/access/web-access-specialization.js');
    assert.equal(selectWebAccessReaderKind('https://github.com/o/r'), 'github');
    assert.equal(selectWebAccessReaderKind('https://youtu.be/v'), 'media');
    assert.equal(selectWebAccessReaderKind('https://example.com/feed.xml'), 'feed');
    assert.equal(selectWebAccessReaderKind('https://example.com/doc.pdf'), 'pdf');
    assert.equal(selectWebAccessReaderKind('https://example.com/a'), 'page');
    assert.equal(selectWebAccessReaderKind('not a url'), 'page');
  });

  it('fetch tries github/media/feed readers first, infers pdf, keeps readable/raw modes', async () => {
    const { fetchWebAccessContent } = await import('../../../src/web/access/web-access-fetch.js');
    const calls: string[] = [];
    const pageReader = {
      read: async (url: string, mode: 'readable' | 'raw') => {
        calls.push(`page:${mode}:${url}`);
        return { title: `page ${mode}`, content: `body ${url}` };
      },
    };
    const githubMediaReader = {
      read: async (url: string) => {
        if (url.includes('github.com')) return { title: 'gh', content: 'gh body' };
        return undefined;
      },
    };
    const feedReader = {
      read: async (url: string) => {
        if (url.includes('feed.xml')) {
          calls.push(`feed:${url}`);
          return { title: 'feed', content: 'feed body' };
        }
        return undefined;
      },
    };
    const out = await fetchWebAccessContent(
      { urls: ['https://example.com/a', 'https://github.com/o/r', 'https://example.com/feed.xml'] },
      { mode: 'raw', pageReader, githubMediaReader, feedReader, allowExternal: true },
    );
    assert.equal(out.length, 3);
    assert.equal(out[0]?.source, 'page');
    assert.equal(out[0]?.mode, 'raw');
    assert.equal(out[1]?.source, 'github-media');
    assert.equal(out[2]?.source, 'feed');
    assert.ok(calls.some((c: string) => c.startsWith('page:raw:')) && calls.some((c: string) => c.startsWith('feed:')));
  });
});

describe('web-access pdf: bounded local extraction, page citations, no OCR/cloud', () => {
  it('extracts per-page text with [p. N] citations and truncates at page/char caps', async () => {
    const { extractWebAccessPdfText, WEB_ACCESS_PDF_MAX_PAGES } = await import('../../../src/web/access/web-access-pdf.js');
    const pages = Array.from({ length: WEB_ACCESS_PDF_MAX_PAGES + 10 }, (_, i) => `page-${i + 1} body`);
    const out = await extractWebAccessPdfText(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
      extractor: async () => ({ totalPages: pages.length, pages }),
      maxChars: 200,
    });
    assert.ok(out.totalPages > WEB_ACCESS_PDF_MAX_PAGES);
    assert.equal(out.pages.length, WEB_ACCESS_PDF_MAX_PAGES);
    assert.equal(out.truncated, true);
    assert.ok(out.citations.every((c) => /^\[p\. \d+\]$/.test(c.cite)));
    assert.ok(out.text.includes('[p. 1]'));
    assert.ok(out.text.length <= 200 + 500);
  });

  it('rejects oversize bytes, times out, never OCRs', async () => {
    const { extractWebAccessPdfText, WEB_ACCESS_PDF_MAX_BYTES } = await import('../../../src/web/access/web-access-pdf.js');
    await assert.rejects(
      () =>
        extractWebAccessPdfText(new Uint8Array(WEB_ACCESS_PDF_MAX_BYTES + 1), {
          extractor: async () => ({ totalPages: 1, pages: ['x'] }),
        }),
      /exceed|byte|large/i,
    );
    await assert.rejects(
      () =>
        extractWebAccessPdfText(new Uint8Array([1, 2, 3]), {
          extractor: () => new Promise(() => {}),
          timeoutMs: 10,
        }),
      /timed out|timeout/i,
    );
    const { loadUnpdfExtractor } = await import('../../../src/web/access/web-access-pdf.js');
    // unpdf ^1.8.1 is a hard dependency: loader resolves the extractor deterministically.
    const loaded = await loadUnpdfExtractor();
    assert.equal(typeof loaded, 'function');
  });

  it('isPdfUrl infers format internally from path or content type', async () => {
    const { isPdfUrl } = await import('../../../src/web/access/web-access-pdf.js');
    assert.equal(isPdfUrl('https://example.com/doc.pdf'), true);
    assert.equal(isPdfUrl('https://example.com/a', 'application/pdf'), true);
    assert.equal(isPdfUrl('https://example.com/a', 'text/html'), false);
    assert.equal(isPdfUrl('https://example.com/a'), false);
  });
});
