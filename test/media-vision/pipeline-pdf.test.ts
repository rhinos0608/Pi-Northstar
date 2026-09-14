// Plan D Task D4 PDF-pipeline tests: unpdf local first, scanned/layout
// vision escalation per page, extracted vs derived kinds with page locators.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PDF_MAX_BYTES,
  runPdfPipeline,
} from '../../src/media-vision/pipeline-pdf.js';
import { chunkVisionEvidence, rankVisionChunks } from '../../src/media-vision/pipeline-image.js';

test('oversize pdf rejects before extraction', async () => {
  let extractions = 0;
  const result = await runPdfPipeline(new Uint8Array(PDF_MAX_BYTES + 1), {
    async extractor() {
      extractions += 1;
      return { totalPages: 0, pages: [] };
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'over-byte-ceiling');
  assert.equal(extractions, 0);
});

test('extractor failure degrades without throwing', async () => {
  const result = await runPdfPipeline(new Uint8Array([1, 2, 3]), {
    async extractor() {
      throw new Error('unpdf boom');
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'extraction-failed');
});

test('local text pages are extracted entries; no vision calls when rich', async () => {
  let visions = 0;
  const result = await runPdfPipeline(new Uint8Array([1, 2, 3]), {
    async extractor() {
      return {
        totalPages: 2,
        pages: [
          'This page holds a full paragraph of real report content for testing.',
          'Second page with another full paragraph of substantive local text.',
        ],
      };
    },
    async describePage() {
      visions += 1;
      return { text: 'must not run' };
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.totalPages, 2);
  assert.equal(result.evidence.length, 2);
  assert.ok(result.evidence.every((e) => e.sourceKind === 'extracted' && e.kind === 'pdf-text'));
  assert.deepEqual(result.evidence.map((e) => e.locator.page), [1, 2]);
  assert.equal(visions, 0);
});

test('sparse scanned page escalates to vision as derived entry', async () => {
  const result = await runPdfPipeline(new Uint8Array([1, 2, 3]), {
    async extractor() {
      return { totalPages: 2, pages: ['', 'Rich local paragraph with plenty of words for the no-escalation path.'] };
    },
    async describePage({ page }) {
      assert.equal(page, 1);
      return { text: 'Scanned invoice total $42.' };
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const byPage = new Map(result.evidence.map((e) => [`${e.locator.page}:${e.kind}`, e.sourceKind]));
  assert.equal(byPage.get('2:pdf-text'), 'extracted');
  assert.equal(byPage.get('1:description'), 'derived');
});

test('sparse page without vision seam warns instead of fabricating', async () => {
  const result = await runPdfPipeline(new Uint8Array([1, 2, 3]), {
    async extractor() {
      return { totalPages: 1, pages: [''] };
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.evidence.length, 0);
  assert.ok(result.warnings.includes('page-1-possibly-scanned-no-vision'));
  assert.ok(result.warnings.includes('no-extractable-text'));
});

test('pdf evidence chunks rank through shared BM25 path', async () => {
  const result = await runPdfPipeline(new Uint8Array([1, 2, 3]), {
    async extractor() {
      return { totalPages: 1, pages: ['Quarterly revenue grew twenty percent on cloud expansion.'] };
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const chunked = chunkVisionEvidence(result.evidence);
  assert.equal(chunked.length, 1);
  const ranked = rankVisionChunks(chunked, 'quarterly revenue cloud');
  assert.ok((ranked[0]?.bm25Score ?? 0) > 0);
});
