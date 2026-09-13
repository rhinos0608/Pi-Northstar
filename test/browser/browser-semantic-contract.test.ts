import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SEMANTIC_LOCATORS,
  SEMANTIC_VERBS,
  validateSemanticActionRequest,
} from '../../src/browser/browser-policy.js';

test('semantic contract exposes canonical Northstar vocabulary', () => {
  assert.deepEqual([...SEMANTIC_LOCATORS], [
    'role', 'text', 'label', 'placeholder', 'alt', 'title', 'testid', 'first', 'last', 'nth',
  ]);
  assert.deepEqual([...SEMANTIC_VERBS], ['click', 'fill', 'check', 'hover', 'text']);
});

test('semantic contract rejects non-integer and negative nth index', () => {
  assert.throws(
    () => validateSemanticActionRequest({ locator: 'nth', query: 'button', verb: 'click', index: -1 }),
    /nonnegative integer/,
  );
  assert.throws(
    () => validateSemanticActionRequest({ locator: 'nth', query: 'button', verb: 'click', index: 1.5 }),
    /nonnegative integer/,
  );
  assert.equal(
    validateSemanticActionRequest({ locator: 'nth', query: 'button', verb: 'click', index: 0 }).index,
    0,
  );
});

test('semantic contract rejects index unless locator is nth', () => {
  assert.throws(
    () => validateSemanticActionRequest({ locator: 'role', query: 'button', verb: 'click', index: 0 }),
    /only allowed when locator is nth/,
  );
});

test('semantic contract requires value for fill and rejects value otherwise', () => {
  assert.throws(
    () => validateSemanticActionRequest({ locator: 'role', query: 'textbox', verb: 'fill' }),
    /value is required when verb is fill/,
  );
  for (const verb of ['click', 'check', 'hover', 'text']) {
    assert.throws(
      () => validateSemanticActionRequest({ locator: 'role', query: 'x', verb, value: 'v' }),
      /value is only allowed when verb is fill/,
    );
  }
  assert.equal(
    validateSemanticActionRequest({ locator: 'role', query: 'textbox', verb: 'fill', value: 'hello' }).value,
    'hello',
  );
});

test('semantic contract allows name for role locator only', () => {
  assert.equal(
    validateSemanticActionRequest({ locator: 'role', query: 'button', verb: 'click', name: 'Submit' }).name,
    'Submit',
  );
  assert.equal(
    validateSemanticActionRequest({ locator: 'role', query: 'button', verb: 'click', name: '  Submit  ' }).name,
    'Submit',
  );
  assert.throws(
    () => validateSemanticActionRequest({ locator: 'role', query: 'button', verb: 'click', name: '   ' }),
    /name must be a non-empty string/,
  );
  for (const locator of ['text', 'label', 'placeholder', 'alt', 'title', 'testid', 'first', 'last', 'nth']) {
    const raw: Record<string, unknown> =
      locator === 'nth'
        ? { locator, query: 'x', verb: 'click', index: 0, name: 'Submit' }
        : { locator, query: 'x', verb: 'click', name: 'Submit' };
    assert.throws(() => validateSemanticActionRequest(raw), /name is only allowed when locator is role/);
  }
});

test('semantic contract rejects unknown fields and keeps query semantics', () => {
  assert.throws(
    () => validateSemanticActionRequest({ locator: 'role', query: 'button', verb: 'click', foo: 1 }),
    /unknown field: foo/,
  );
  assert.throws(
    () => validateSemanticActionRequest({ locator: 'role', verb: 'click' }),
    /query is required/,
  );
  assert.equal(
    validateSemanticActionRequest({ locator: 'role', query: '  button  ', verb: 'click' }).query,
    'button',
  );
});

test('semantic contract rejects non-boolean exact', () => {
  assert.throws(
    () => validateSemanticActionRequest({ locator: 'role', query: 'button', verb: 'click', exact: 'yes' }),
    /exact must be a boolean/,
  );
});
