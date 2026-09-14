import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acquireAsset, AssetAcquireError, estimatePdfPages } from '../../src/assets/asset-acquire.js';
import { IMAGE_MAX_PIXELS, PDF_MAX_PAGES } from '../../src/assets/asset-contract.js';

const LOOKUP = async () => [{ address: '93.184.216.34', family: 4 as const }];

function pngWithDims(width: number, height: number, pad = 64): Uint8Array {
  const out = new Uint8Array(8 + 4 + 4 + 13 + 4 + pad);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(out.buffer);
  view.setUint32(8, 13); // IHDR length
  out.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
  view.setUint32(16, width);
  view.setUint32(20, height);
  return out;
}

function pdfWithCount(count: number): Uint8Array {
  return Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Type /Pages /Count ${count} >>\nendobj\n`, 'latin1');
}

function fetchOf(bytes: Uint8Array, contentType: string, announced?: number): typeof fetch {
  return (async () => new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      'content-type': contentType,
      ...(announced !== undefined ? { 'content-length': String(announced) } : {}),
    },
  })) as unknown as typeof fetch;
}

test('small PNG admits with probed dimensions', async () => {
  const asset = await acquireAsset('https://example.com/a.png', 'image', {
    fetchFn: fetchOf(pngWithDims(800, 600), 'image/png'),
    lookup: LOOKUP,
  });
  assert.equal(asset.width, 800);
  assert.equal(asset.height, 600);
  assert.deepEqual(asset.evidence.warnings, []);
});

test('pixel bomb rejected pre-decode (48MP header, tiny body)', async () => {
  assert.ok(8000 * 6000 > IMAGE_MAX_PIXELS);
  await assert.rejects(
    acquireAsset('https://example.com/bomb.png', 'image', {
      fetchFn: fetchOf(pngWithDims(8000, 6000), 'image/png'),
      lookup: LOOKUP,
    }),
    AssetAcquireError,
  );
});

test('byte bomb rejected from announced content-length before body read', async () => {
  const tiny = pngWithDims(10, 10);
  await assert.rejects(
    acquireAsset('https://example.com/big.png', 'image', {
      fetchFn: fetchOf(tiny, 'image/png', 20 * 1024 * 1024 + 1),
      lookup: LOOKUP,
    }),
    /announces/,
  );
});

test('page bomb rejected pre-decode via /Count heuristic', () => {
  assert.equal(estimatePdfPages(pdfWithCount(500)), 500);
  assert.ok(500 > PDF_MAX_PAGES);
});

test('page bomb rejected on acquire', async () => {
  await assert.rejects(
    acquireAsset('https://example.com/bomb.pdf', 'pdf', {
      fetchFn: fetchOf(pdfWithCount(500), 'application/pdf'),
      lookup: LOOKUP,
    }),
    AssetAcquireError,
  );
});

test('small pdf admits with page estimate', async () => {
  const asset = await acquireAsset('https://example.com/small.pdf', 'pdf', {
    fetchFn: fetchOf(pdfWithCount(3), 'application/pdf'),
    lookup: LOOKUP,
  });
  assert.equal(asset.pdfPagesEstimate, 3);
});

test('zip container rejected as asset', async () => {
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
  await assert.rejects(
    acquireAsset('https://example.com/a.png', 'image', {
      fetchFn: fetchOf(zip, 'image/png'),
      lookup: LOOKUP,
    }),
    /zip container/,
  );
});

test('magic/kind mismatch rejected', async () => {
  await assert.rejects(
    acquireAsset('https://example.com/a.pdf', 'pdf', {
      fetchFn: fetchOf(pngWithDims(10, 10), 'image/png'),
      lookup: LOOKUP,
    }),
    /magic bytes say image/,
  );
});

test('private host rejected without network', async () => {
  let fetched = false;
  const spy = (async () => { fetched = true; throw new Error('must not fetch'); }) as unknown as typeof fetch;
  await assert.rejects(acquireAsset('http://169.254.169.254/latest', 'image', { fetchFn: spy }), AssetAcquireError);
  assert.equal(fetched, false);
});
