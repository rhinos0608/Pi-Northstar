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
  it('tier overrides stay within their declared hard ceilings', async () => {
    const {
      PDF_TIER_HARD_MAX_SIZE_MB,
      PDF_TIER_HARD_MAX_PAGES,
      resolvePdfTierConfig,
    } = await import('../../../src/web/access/web-access-pdf.js');
    assert.deepEqual(resolvePdfTierConfig({ maxSizeMB: 5, maxPages: 25 }), {
      enabled: true,
      maxSizeMB: 5,
      maxPages: 25,
      provider: 'auto',
    });
    assert.throws(() => resolvePdfTierConfig({ maxSizeMB: 0.5 }), /maxSizeMB/);
    assert.throws(() => resolvePdfTierConfig({ maxSizeMB: PDF_TIER_HARD_MAX_SIZE_MB + 1 }), /maxSizeMB/);
    assert.throws(() => resolvePdfTierConfig({ maxPages: PDF_TIER_HARD_MAX_PAGES + 1 }), /maxPages/);
  });

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

  it('pushes lower maxPages into unpdf before page parsing', async () => {
    const { loadUnpdfExtractor } = await import('../../../src/web/access/web-access-pdf.js');
    const requested: number[] = [];
    const extractor = await loadUnpdfExtractor({
      getDocumentProxy: async () => ({
        numPages: 20,
        getPage: async (n: number) => {
          requested.push(n);
          return { getTextContent: async () => ({ items: [{ str: `t${n}`, hasEOL: false }] }) };
        },
        loadingTask: { destroy: async () => {} },
      }),
    });
    const raw = await extractor?.(
      new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      { maxPages: 3 },
    );
    assert.equal(raw?.totalPages, 20);
    assert.deepEqual(requested, [1, 2, 3]);
  });

  it('bounds huge-page-count PDFs: numPages gate first, only the configured page ceiling is read', async () => {
    const { loadUnpdfExtractor, WEB_ACCESS_PDF_MAX_PAGES } = await import(
      '../../../src/web/access/web-access-pdf.js'
    );
    const requested: number[] = [];
    let destroyed = false;
    const fakeModule = {
      getDocumentProxy: async () => ({
        numPages: 200,
        getPage: async (n: number) => {
          requested.push(n);
          return { getTextContent: async () => ({ items: [{ str: `t${n}`, hasEOL: false }] }) };
        },
        loadingTask: {
          destroy: async () => {
            destroyed = true;
          },
        },
      }),
    };
    const extractor = await loadUnpdfExtractor(fakeModule);
    assert.equal(typeof extractor, 'function');
    const raw = await extractor?.(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {});
    assert.equal(raw?.totalPages, 200);
    assert.equal(raw?.pages.length, WEB_ACCESS_PDF_MAX_PAGES);
    assert.deepEqual(requested, Array.from({ length: WEB_ACCESS_PDF_MAX_PAGES }, (_, i) => i + 1));
    assert.equal(destroyed, true);
    // End-to-end through the page/char capper: still reports 200, keeps 50.
    const { extractWebAccessPdfText } = await import('../../../src/web/access/web-access-pdf.js');
    const out = await extractWebAccessPdfText(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
      extractor: extractor as (data: Uint8Array) => Promise<{ totalPages: number; pages: string[] }>,
    });
    assert.equal(out.totalPages, 200);
    assert.equal(out.pages.length, WEB_ACCESS_PDF_MAX_PAGES);
    assert.equal(out.truncated, true);
  });

  it('destroys the eventual proxy when abort/timeout fires before open settles', async () => {
    const { extractBoundedProxyPages, extractWebAccessPdfText } = await import(
      '../../../src/web/access/web-access-pdf.js'
    );
    // Abort before open settles: eventual proxy destroyed, read rejects.
    let destroyedBeforeOpen = false;
    let resolveOpen!: (proxy: never) => void;
    const gate = new Promise<never>((resolve) => {
      resolveOpen = resolve;
    });
    const controller = new AbortController();
    const task = extractBoundedProxyPages(() => gate, 50, controller.signal);
    controller.abort();
    resolveOpen({
      numPages: 1,
      getPage: async () => ({
        getTextContent: async () => ({ items: [{ str: 'late', hasEOL: false }] }),
      }),
      loadingTask: {
        destroy: async () => {
          destroyedBeforeOpen = true;
        },
      },
    } as unknown as never);
    await assert.rejects(task);
    assert.equal(destroyedBeforeOpen, true);
    // Timeout path: withTimeout aborts the controller while open is pending;
    // the late proxy is still destroyed instead of leaking.
    let destroyedOnTimeout = false;
    let resolveLate!: (proxy: never) => void;
    const lateGate = new Promise<never>((resolve) => {
      resolveLate = resolve;
    });
    const pendingText = extractWebAccessPdfText(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
      extractor: (_data: Uint8Array, options?: { signal?: AbortSignal | undefined }) =>
        extractBoundedProxyPages(() => lateGate, 50, options?.signal),
      timeoutMs: 10,
    });
    // Attach early so the timeout rejection at 10ms is handled before the
    // late proxy resolves below; assert.rejects still observes it afterwards.
    void pendingText.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 30));
    resolveLate({
      numPages: 1,
      getPage: async () => ({
        getTextContent: async () => ({ items: [{ str: 'late', hasEOL: false }] }),
      }),
      loadingTask: {
        destroy: async () => {
          destroyedOnTimeout = true;
        },
      },
    } as unknown as never);
    await assert.rejects(pendingText, /timed out|timeout/i);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(destroyedOnTimeout, true);
  });

  it('removes external abort listeners after successful extraction', async () => {
    const { getEventListeners } = await import('node:events');
    const { extractWebAccessPdfText } = await import('../../../src/web/access/web-access-pdf.js');
    const controller = new AbortController();
    const before = getEventListeners(controller.signal, 'abort').length;
    await extractWebAccessPdfText(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
      extractor: async () => ({ totalPages: 1, pages: ['ok'] }),
      signal: controller.signal,
    });
    assert.equal(getEventListeners(controller.signal, 'abort').length, before);
  });

  it('isPdfUrl infers format internally from path or content type', async () => {
    const { isPdfUrl } = await import('../../../src/web/access/web-access-pdf.js');
    assert.equal(isPdfUrl('https://example.com/doc.pdf'), true);
    assert.equal(isPdfUrl('https://example.com/a', 'application/pdf'), true);
    assert.equal(isPdfUrl('https://example.com/a', 'text/html'), false);
    assert.equal(isPdfUrl('https://example.com/a'), false);
  });

  it('rejects mid-read abort during page 2 of N and destroys the proxy', async () => {
    const { extractBoundedProxyPages, extractWebAccessPdfText } = await import(
      '../../../src/web/access/web-access-pdf.js'
    );
    // Proxy-level: abort fires while page 2 getTextContent is in flight.
    // The late-resolving read must not return success; proxy destroyed once.
    let destroyed = 0;
    let releasePage2!: () => void;
    const page2Gate = new Promise<void>((resolve) => {
      releasePage2 = resolve;
    });
    const controller = new AbortController();
    const task = extractBoundedProxyPages(
      async () => ({
        numPages: 5,
        getPage: async (n: number) => ({
          getTextContent: async () => {
            if (n === 2) await page2Gate;
            return { items: [{ str: `t${n}`, hasEOL: false }] };
          },
        }),
        loadingTask: {
          destroy: async () => {
            destroyed += 1;
          },
        },
      }),
      50,
      controller.signal,
    );
    void task.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    releasePage2();
    await assert.rejects(task);
    assert.equal(destroyed, 1);
    // Extractor-level: signal-ignoring extractor resolving after abort still rejects.
    const slowController = new AbortController();
    const pending = extractWebAccessPdfText(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
      extractor: () => new Promise((resolve) => setTimeout(() => resolve({ totalPages: 1, pages: ['late'] }), 30)),
      signal: slowController.signal,
      timeoutMs: 1000,
    });
    void pending.catch(() => {});
    slowController.abort();
    await assert.rejects(pending);
  });
});

describe('M6 fetch pdf: scanned pages mark degraded, text pages stay clean', () => {
  function pdfBytes(stream: string): Uint8Array {
    const doc =
      '%PDF-1.4\n' +
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n' +
      `4 0 obj<</Length ${stream.length}>>stream\n${stream}endstream\nendobj\n` +
      '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n' +
      'trailer<</Root 1 0 R>>';
    return new Uint8Array(Buffer.from(doc, 'latin1'));
  }

  const DENSE_STREAM =
    'BT /F1 24 Tf 100 700 Td (Dense report paragraph with plenty of local text for the diagnostics floor) Tj ET\n';

  async function fetchPdf(url: string, bytes: Uint8Array) {
    const { dispatchSpecializedUrl } = await import('../../../src/native-fetch.js');
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      })) as typeof fetch;
    try {
      return await dispatchSpecializedUrl(url, {
        env: {},
        lookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
      });
    } finally {
      globalThis.fetch = savedFetch;
    }
  }

  it('marks degraded with the fixed local-only note for a scanned fixture', async () => {
    const out = await fetchPdf('https://example.com/scan.pdf', pdfBytes(' '));
    const details = (out as { details?: Record<string, unknown> }).details ?? {};
    assert.equal(details.degraded, true);
    assert.match(String(details.note ?? ''), /local-only PDF policy/);
    const pdf = details.pdf as { warnings?: string[] } | undefined;
    assert.ok(
      pdf?.warnings?.some((w) => w.includes('possibly-scanned-no-vision')),
      JSON.stringify(pdf?.warnings),
    );
  });

  it('stays undegraded for a text fixture', async () => {
    const out = await fetchPdf('https://example.com/text.pdf', pdfBytes(DENSE_STREAM));
    const details = (out as { details?: Record<string, unknown> }).details ?? {};
    assert.equal(details.degraded, undefined);
    assert.equal(details.note, undefined);
    const pdf = details.pdf as { warnings?: string[] } | undefined;
    assert.equal(pdf?.warnings, undefined);
  });
});
