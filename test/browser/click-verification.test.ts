import assert from 'node:assert/strict';
import { test } from 'node:test';
import { armClickProbe, isEligibleForVerification, readClickProbe, type EvalRunner } from '../../src/browser/click-verification.js';

test('isEligibleForVerification matches role/xpath/ref selectors', () => {
  assert.equal(isEligibleForVerification('role=button[name="Submit"]'), true);
  assert.equal(isEligibleForVerification('xpath=//button'), true);
  assert.equal(isEligibleForVerification('@e12'), true);
});

test('isEligibleForVerification rejects plain CSS selectors', () => {
  assert.equal(isEligibleForVerification('#submit'), false);
  assert.equal(isEligibleForVerification('.primary-btn'), false);
  assert.equal(isEligibleForVerification('button.cta'), false);
});

test('readClickProbe returns dispatched true when fired', async () => {
  const runEval: EvalRunner = async () => ({ success: true, data: { fired: true } });
  const result = await readClickProbe(runEval);
  assert.deepEqual(result, { dispatched: true });
});

test('readClickProbe returns no-event when the listener never fired', async () => {
  const runEval: EvalRunner = async () => ({ success: true, data: { fired: false } });
  const result = await readClickProbe(runEval);
  assert.deepEqual(result, { dispatched: false, reason: 'no-event' });
});

test('readClickProbe returns no-event when data is null', async () => {
  const runEval: EvalRunner = async () => ({ success: true, data: null });
  const result = await readClickProbe(runEval);
  assert.deepEqual(result, { dispatched: false, reason: 'no-event' });
});

test('readClickProbe returns probe-error when eval itself fails', async () => {
  const runEval: EvalRunner = async () => ({ success: false, error: 'eval failed' });
  const result = await readClickProbe(runEval);
  assert.deepEqual(result, { dispatched: false, reason: 'probe-error' });
});

test('armClickProbe sends a script without document.querySelector', async () => {
  let seenExpression = '';
  const runEval: EvalRunner = async (expression) => {
    seenExpression = expression;
    return { success: true };
  };
  await armClickProbe(runEval, 'role=button[name="Submit"]');
  assert.match(seenExpression, /__pi_click_probe__/);
  assert.match(seenExpression, /fired: false/);
  assert.ok(!seenExpression.includes('querySelector'), 'should not contain querySelector');
});

test('armClickProbe works with @e-style selectors without throwing', async () => {
  let seenExpression = '';
  const runEval: EvalRunner = async (expression) => {
    seenExpression = expression;
    return { success: true };
  };
  await armClickProbe(runEval, '@e42');
  assert.match(seenExpression, /__pi_click_probe__/);
  assert.ok(!seenExpression.includes('querySelector'), 'should not contain querySelector');
});
