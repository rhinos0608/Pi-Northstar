import assert from 'node:assert/strict';
import { test } from 'node:test';

// M6 scanned-PDF degraded marking: warnings-only diagnostics over the local
// path. No describePage seam exists here, so no vision transport can trigger.

const DENSE_PAGE =
  'This page holds a full paragraph of real report content for testing, well above the scanned floor.';

test('web-access-pdf-diagnostics: sparse page warns, dense page stays quiet', async () => {
  const { pdfSparsePageWarnings } = await import('../../../src/web/access/web-access-pdf-diagnostics.js');
  let extractions = 0;
  const sparse = await pdfSparsePageWarnings(new Uint8Array([0x25, 0x50, 0x44, 0x46]), async () => {
    extractions += 1;
    return { totalPages: 1, pages: [''] };
  });
  assert.equal(sparse.totalPages, 1);
  assert.ok(
    sparse.warnings.some((w) => w === 'page-1-possibly-scanned-no-vision'),
    `expected scanned warning, got ${JSON.stringify(sparse.warnings)}`,
  );
  const dense = await pdfSparsePageWarnings(new Uint8Array([0x25, 0x50, 0x44, 0x46]), async () => ({
    totalPages: 1,
    pages: [DENSE_PAGE],
  }));
  assert.equal(dense.totalPages, 1);
  assert.deepEqual(dense.warnings, []);
  assert.equal(extractions, 1);
});

test('web-access-pdf-diagnostics: extraction failure carries failure warnings, zero pages', async () => {
  const { pdfSparsePageWarnings } = await import('../../../src/web/access/web-access-pdf-diagnostics.js');
  const out = await pdfSparsePageWarnings(new Uint8Array([1, 2, 3]), async () => {
    throw new Error('unpdf boom');
  });
  assert.equal(out.totalPages, 0);
  assert.ok(out.warnings.includes('pdf-extraction-failed'), JSON.stringify(out.warnings));
});

test('web-access-pdf-diagnostics: byte and page ceilings reject before extraction', async () => {
  const { pdfSparsePageWarnings } = await import('../../../src/web/access/web-access-pdf-diagnostics.js');
  const { PDF_MAX_BYTES, PDF_MAX_PAGES } = await import('../../../src/media-vision/pipeline-pdf.js');
  let extractions = 0;
  const overBytes = await pdfSparsePageWarnings(new Uint8Array(PDF_MAX_BYTES + 1), async () => {
    extractions += 1;
    return { totalPages: 0, pages: [] };
  });
  assert.equal(overBytes.totalPages, 0);
  assert.ok(overBytes.warnings.includes('pdf-over-byte-ceiling'), JSON.stringify(overBytes.warnings));
  assert.equal(extractions, 0);
  const overPages = await pdfSparsePageWarnings(new Uint8Array([0x25]), async () => ({
    totalPages: PDF_MAX_PAGES + 1,
    pages: [],
  }));
  assert.equal(overPages.totalPages, 0);
  assert.ok(overPages.warnings.includes('pdf-over-page-ceiling'), JSON.stringify(overPages.warnings));
});

test('web-access-pdf-diagnostics: never escalates to vision on sparse pages', async () => {
  const { pdfSparsePageWarnings } = await import('../../../src/web/access/web-access-pdf-diagnostics.js');
  // The helper accepts extractor + signal only: there is no surface that
  // could construct a describePage/vision transport. Sparse input must yield
  // the no-vision warning (not derived evidence) with a single extraction.
  let extractions = 0;
  const out = await pdfSparsePageWarnings(new Uint8Array([0x25]), async () => {
    extractions += 1;
    return { totalPages: 2, pages: ['', 'x'] };
  });
  assert.equal(extractions, 1);
  assert.equal(out.totalPages, 2);
  assert.ok(out.warnings.includes('page-1-possibly-scanned-no-vision'), JSON.stringify(out.warnings));
  assert.ok(out.warnings.includes('page-2-possibly-scanned-no-vision'), JSON.stringify(out.warnings));
});
