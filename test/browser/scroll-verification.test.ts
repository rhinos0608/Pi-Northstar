import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isScrollNoop } from '../../src/browser/scroll-verification.js';

test('isScrollNoop is true when positions are identical', () => {
  assert.equal(isScrollNoop({ scrollX: 0, scrollY: 0 }, { scrollX: 0, scrollY: 0 }), true);
});

test('isScrollNoop is false when scrollY changed', () => {
  assert.equal(isScrollNoop({ scrollX: 0, scrollY: 0 }, { scrollX: 0, scrollY: 300 }), false);
});

test('isScrollNoop tolerates sub-pixel float differences', () => {
  assert.equal(isScrollNoop({ scrollX: 0, scrollY: 299.998 }, { scrollX: 0, scrollY: 300 }), true);
});
