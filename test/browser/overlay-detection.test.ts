import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectOverlayAppearance } from '../../src/browser/overlay-detection.js';

test('detectOverlayAppearance is true when overlay count increases', () => {
  assert.equal(detectOverlayAppearance({ count: 0 }, { count: 1 }), true);
});

test('detectOverlayAppearance is false when overlay count is unchanged', () => {
  assert.equal(detectOverlayAppearance({ count: 1 }, { count: 1 }), false);
});

test('detectOverlayAppearance is false when an overlay closes', () => {
  assert.equal(detectOverlayAppearance({ count: 1 }, { count: 0 }), false);
});
