import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSnapshotRefs, extractSnapshotUrl, compactSnapshotRefs } from '../../src/browser/snapshot-parser.js';
import type { PageRef } from '../../src/browser/session-page-state.js';

// ── Component 7: parseSnapshotRefs ──

test('parseSnapshotRefs normalizes flat array with missing @ prefix', () => {
  const raw = [
    { ref: 'e1', role: 'button', name: 'Submit' },
    { ref: 'e2', role: 'textbox', name: 'Email' },
  ];
  const refs = parseSnapshotRefs(raw);
  assert.equal(refs.length, 2);
  assert.equal(refs[0]!.ref, '@e1');
  assert.equal(refs[0]!.role, 'button');
  assert.equal(refs[0]!.name, 'Submit');
  assert.equal(refs[1]!.ref, '@e2');
});

test('parseSnapshotRefs preserves @ prefix when present', () => {
  const raw = [{ ref: '@e12', role: 'link', name: 'Home' }];
  const refs = parseSnapshotRefs(raw);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.ref, '@e12');
});

test('parseSnapshotRefs flattens nested tree', () => {
  const raw = [
    {
      ref: 'e1', role: 'header', name: 'Main',
      children: [
        { ref: 'e2', role: 'nav', children: [
          { ref: 'e3', role: 'link', name: 'Home' },
          { ref: 'e4', role: 'link', name: 'About' },
        ]},
      ],
    },
  ];
  const refs = parseSnapshotRefs(raw);
  assert.equal(refs.length, 4);
  assert.equal(refs[0]!.ref, '@e1');
  assert.equal(refs[1]!.ref, '@e2');
  assert.equal(refs[2]!.ref, '@e3');
  assert.equal(refs[3]!.ref, '@e4');
});

test('parseSnapshotRefs flattens deeply nested tree (3+ levels)', () => {
  const raw = [{
    ref: 'e1', role: 'div', children: [{
      ref: 'e2', children: [{
        ref: 'e3', children: [{
          ref: 'e4', role: 'button', name: 'Deep',
        }],
      }],
    }],
  }];
  const refs = parseSnapshotRefs(raw);
  assert.equal(refs.length, 4);
  assert.equal(refs[3]!.ref, '@e4');
  assert.equal(refs[3]!.role, 'button');
});

test('parseSnapshotRefs returns [] for null/undefined/primitive input', () => {
  assert.deepEqual(parseSnapshotRefs(null), []);
  assert.deepEqual(parseSnapshotRefs(undefined), []);
  assert.deepEqual(parseSnapshotRefs('string'), []);
  assert.deepEqual(parseSnapshotRefs(42), []);
  assert.deepEqual(parseSnapshotRefs({}), []);
});

test('parseSnapshotRefs sets isContentEditable from editable: true', () => {
  const raw = [
    { ref: 'e1', role: 'textbox', name: 'Comment', editable: true },
    { ref: 'e2', role: 'textbox', name: 'Name', editable: false },
    { ref: 'e3', role: 'button', name: 'OK' },
  ];
  const refs = parseSnapshotRefs(raw);
  assert.equal(refs[0]!.isContentEditable, true);
  assert.equal(refs[1]!.isContentEditable, undefined);
  assert.equal(refs[2]!.isContentEditable, undefined);
});

test('parseSnapshotRefs skips nodes without valid ref', () => {
  const raw = [
    { role: 'div', name: 'No ref' },
    { ref: '', role: 'button' },
    { ref: 'e1', role: 'button', name: 'Submit' },
  ];
  const refs = parseSnapshotRefs(raw);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.ref, '@e1');
});

test('parseSnapshotRefs handles wrapped { nodes: [...] } shape', () => {
  const raw = { nodes: [{ ref: 'e1', role: 'button' }] };
  const refs = parseSnapshotRefs(raw);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.ref, '@e1');
});

test('parseSnapshotRefs handles wrapped { refs: [...] } shape', () => {
  const raw = { refs: [{ ref: 'e5', role: 'link' }] };
  const refs = parseSnapshotRefs(raw);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.ref, '@e5');
});

test('extractSnapshotUrl returns url from data', () => {
  assert.equal(extractSnapshotUrl({ url: 'https://example.com' }), 'https://example.com');
  assert.equal(extractSnapshotUrl({ nodes: [] }), '');
  assert.equal(extractSnapshotUrl(null), '');
  assert.equal(extractSnapshotUrl('string'), '');
});

// ── Component 8: compactSnapshotRefs ──

test('compactSnapshotRefs drops nameless structural divs', () => {
  const refs: PageRef[] = [
    { ref: '@e1', role: 'div' },
    { ref: '@e2', role: 'button', name: 'Submit' },
    { ref: '@e3', role: 'span' },
  ];
  const result = compactSnapshotRefs(refs);
  assert.equal(result.refs.length, 1);
  assert.equal(result.refs[0]!.ref, '@e2');
  assert.equal(result.omittedCount, 2);
  assert.equal(result.truncated, false);
});

test('compactSnapshotRefs keeps high-value roles', () => {
  const refs: PageRef[] = [
    { ref: '@e1', role: 'button', name: 'A' },
    { ref: '@e2', role: 'link', name: 'B' },
    { ref: '@e3', role: 'textbox', name: 'C' },
    { ref: '@e4', role: 'checkbox', name: 'D' },
    { ref: '@e5', role: 'radio', name: 'E' },
    { ref: '@e6', role: 'combobox', name: 'F' },
    { ref: '@e7', role: 'select', name: 'G' },
    { ref: '@e8', role: 'menuitem', name: 'H' },
    { ref: '@e9', role: 'tab', name: 'I' },
    { ref: '@e10', role: 'switch', name: 'J' },
  ];
  const result = compactSnapshotRefs(refs);
  assert.equal(result.refs.length, 10);
  assert.equal(result.omittedCount, 0);
});

test('compactSnapshotRefs keeps no-role nodes with name (headings)', () => {
  const refs: PageRef[] = [
    { ref: '@e1', name: 'Section Title' },
    { ref: '@e2', role: 'div' },
  ];
  const result = compactSnapshotRefs(refs);
  assert.equal(result.refs.length, 1);
  assert.equal(result.refs[0]!.ref, '@e1');
  assert.equal(result.refs[0]!.name, 'Section Title');
});

test('compactSnapshotRefs respects maxRefs and sets truncated', () => {
  const refs: PageRef[] = Array.from({ length: 10 }, (_, i) => ({
    ref: `@e${i + 1}` as string,
    role: 'button' as string,
    name: `Btn ${i + 1}` as string,
  }));
  const result = compactSnapshotRefs(refs, { maxRefs: 5 });
  assert.equal(result.refs.length, 5);
  assert.equal(result.truncated, true);
  assert.equal(result.omittedCount, 5);
});

test('compactSnapshotRefs omitedCount correct when not truncated', () => {
  const refs: PageRef[] = [
    { ref: '@e1', role: 'button' },
    { ref: '@e2', role: 'div' },
    { ref: '@e3' },
  ];
  const result = compactSnapshotRefs(refs);
  assert.equal(result.refs.length, 1);
  assert.equal(result.omittedCount, 2);
});

test('compactSnapshotRefs prioritizes high-value over named', () => {
  const refs: PageRef[] = [
    { ref: '@e2', name: 'Heading' },        // named
    { ref: '@e3', role: 'button', name: 'X' }, // high-value
  ];
  const result = compactSnapshotRefs(refs, { maxRefs: 1 });
  // High-value first
  assert.equal(result.refs.length, 1);
  assert.equal(result.refs[0]!.ref, '@e3');
  assert.equal(result.truncated, true);
});

test('compactSnapshotRefs handles empty input', () => {
  const result = compactSnapshotRefs([]);
  assert.equal(result.refs.length, 0);
  assert.equal(result.omittedCount, 0);
  assert.equal(result.truncated, false);
});
