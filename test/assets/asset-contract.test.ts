import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AGGREGATE_MAX_BYTES,
  IMAGE_MAX_BYTES,
  IMAGE_MAX_PIXELS,
  PDF_MAX_BYTES,
  PDF_MAX_PAGES,
  VIDEO_MAX_BYTES,
  VIDEO_MAX_KEYFRAMES,
  VIDEO_MAX_MINUTES,
  AssetContractError,
  assertUtf8Admitted,
  createAssetOwnerId,
  maxBytesForKind,
  utf8Bytes,
} from '../../src/assets/asset-contract.js';

test('ceilings match Plan B values', () => {
  assert.equal(IMAGE_MAX_BYTES, 20 * 1024 * 1024);
  assert.equal(IMAGE_MAX_PIXELS, 40_000_000);
  assert.equal(PDF_MAX_BYTES, 25 * 1024 * 1024);
  assert.equal(PDF_MAX_PAGES, 100);
  assert.equal(VIDEO_MAX_BYTES, 250 * 1024 * 1024);
  assert.equal(VIDEO_MAX_MINUTES, 120);
  assert.equal(VIDEO_MAX_KEYFRAMES, 12);
  assert.equal(AGGREGATE_MAX_BYTES, 512 * 1024 * 1024);
});

test('maxBytesForKind routes per kind', () => {
  assert.equal(maxBytesForKind('image'), IMAGE_MAX_BYTES);
  assert.equal(maxBytesForKind('pdf'), PDF_MAX_BYTES);
  assert.equal(maxBytesForKind('video'), VIDEO_MAX_BYTES);
});

test('utf8Bytes counts multibyte chars as bytes', () => {
  assert.equal(utf8Bytes('abc'), 3);
  assert.equal(utf8Bytes('é'), 2);
});

test('assertUtf8Admitted admits under budget, rejects over without truncating', () => {
  assert.equal(assertUtf8Admitted('abc', 3, 'label'), 3);
  assert.throws(() => assertUtf8Admitted('abcd', 3, 'label'), AssetContractError);
});

test('createAssetOwnerId returns unique isolated ids', () => {
  const a = createAssetOwnerId();
  const b = createAssetOwnerId();
  assert.ok(a.length > 0);
  assert.notEqual(a, b);
  assert.equal(createAssetOwnerId(() => 'fixed'), 'fixed');
});
