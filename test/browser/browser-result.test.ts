import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyFailure,
  classifySuccess,
  enrichResult,
  type FailureCategory,
} from '../../src/browser/browser-result.js';

const FAILURE_SAMPLES: ReadonlyArray<[string, FailureCategory]> = [
  ['Command timed out after 30000ms', 'timeout'],
  ['executable not found on PATH', 'missing-binary'],
  ['Element not found: @e12', 'stale-ref'],
  ['No active page', 'no-active-page'],
  ['Navigation to example.com blocked by domain policy', 'domain-blocked'],
  ['evaluate disabled by policy. Set PI_SEARCH_BROWSER_ALLOW_SENSITIVE=1 to enable.', 'policy-denied'],
  ['click failed: covered by <div#consent-banner>', 'overlay-blocked'],
  ['selector is required', 'invalid-request'],
  ['Process error: spawn ENOENT', 'process-error'],
  ['something totally unexpected happened', 'unknown'],
];

for (const [message, expected] of FAILURE_SAMPLES) {
  test(`classifyFailure categorizes "${message}" as ${expected}`, () => {
    assert.equal(classifyFailure(message), expected);
  });
}

test('classifySuccess maps read-only actions to inspection', () => {
  assert.equal(classifySuccess('text'), 'inspection');
  assert.equal(classifySuccess('html'), 'inspection');
  assert.equal(classifySuccess('get_url'), 'inspection');
  assert.equal(classifySuccess('get_title'), 'inspection');
  assert.equal(classifySuccess('snapshot'), 'inspection');
  assert.equal(classifySuccess('tabs'), 'inspection');
  assert.equal(classifySuccess('cookies'), 'inspection');
  assert.equal(classifySuccess('status'), 'inspection');
});

test('classifySuccess maps click to completed', () => {
  assert.equal(classifySuccess('click'), 'completed');
});

test('classifySuccess maps screenshot to artifact-unverified', () => {
  assert.equal(classifySuccess('screenshot'), 'artifact-unverified');
});

test('enrichResult preserves content and details on success', () => {
  const raw = { content: [{ type: 'text', text: 'ok' }], details: { ok: true } };
  const enriched = enrichResult(raw, { action: 'click' });
  assert.deepEqual(enriched.content, raw.content);
  assert.deepEqual(enriched.details, raw.details);
  assert.equal(enriched.resultCategory, 'success');
  assert.equal(enriched.successCategory, 'completed');
});

test('enrichResult sets domain-blocked failure with nextActions', () => {
  const raw = {
    content: [{ type: 'text', text: 'blocked' }],
    details: { error: 'Navigation to example.com blocked by domain policy' },
  };
  const enriched = enrichResult(raw, { action: 'navigate', errorMessage: raw.details.error });
  assert.deepEqual(enriched.content, raw.content);
  assert.deepEqual(enriched.details, raw.details);
  assert.equal(enriched.resultCategory, 'failure');
  assert.equal(enriched.failureCategory, 'domain-blocked');
  assert.ok(Array.isArray(enriched.nextActions));
  assert.ok(enriched.nextActions!.length > 0);
});

// ── dispatchUnverified override ──

test('enrichResult overrides failureCategory to dispatch-unverified when details.dispatchUnverified is true', () => {
  const raw = {
    content: [{ type: 'text', text: 'unverified' }],
    details: { error: 'Click dispatch unverified: no-event', dispatchUnverified: true },
  };
  const enriched = enrichResult(raw, { action: 'click', errorMessage: raw.details.error });
  assert.equal(enriched.resultCategory, 'failure');
  assert.equal(enriched.failureCategory, 'dispatch-unverified');
});

test('dispatch-unverified override takes priority over classifyFailure pattern', () => {
  // Error message matches "no-event" which would classify as 'unknown',
  // but details.dispatchUnverified=true forces 'dispatch-unverified'
  const raw = {
    content: [{ type: 'text', text: 'unverified' }],
    details: { error: 'Click dispatch unverified: no-event', dispatchUnverified: true },
  };
  const enriched = enrichResult(raw, { action: 'click', errorMessage: raw.details.error });
  assert.equal(enriched.failureCategory, 'dispatch-unverified');
  assert.notEqual(enriched.failureCategory, 'unknown');
});

// ── staleRef override ──

test('enrichResult overrides failureCategory to stale-ref when details.staleRef is true', () => {
  const raw = {
    content: [{ type: 'text', text: 'stale' }],
    details: { error: 'Stale or unknown ref @e5: no snapshot recorded', staleRef: true },
  };
  const enriched = enrichResult(raw, { action: 'click', errorMessage: raw.details.error });
  assert.equal(enriched.resultCategory, 'failure');
  assert.equal(enriched.failureCategory, 'stale-ref');
});

test('staleRef override takes priority over classifyFailure pattern', () => {
  // Error message that wouldn't match 'stale-ref' pattern but details.staleRef=true forces it
  const raw = {
    content: [{ type: 'text', text: 'stale' }],
    details: { error: 'ref not valid for this page', staleRef: true },
  };
  const enriched = enrichResult(raw, { action: 'click', errorMessage: raw.details.error });
  assert.equal(enriched.failureCategory, 'stale-ref');
});

// ── overlay appeared on success ──

test('enrichResult adds nextAction when overlay appeared on success', () => {
  const raw = {
    content: [{ type: 'text', text: 'ok' }],
    details: { ok: true, overlay: { appeared: true } },
  };
  const enriched = enrichResult(raw, { action: 'click' });
  assert.equal(enriched.resultCategory, 'success');
  assert.ok(Array.isArray(enriched.nextActions));
  assert.equal(enriched.nextActions!.length, 1);
  assert.equal(enriched.nextActions![0]!.tool, 'browser');
  assert.equal(enriched.nextActions![0]!.args.action, 'snapshot');
  assert.match(enriched.nextActions![0]!.reason, /overlay appeared/);
});

test('enrichResult does not add nextAction when overlay did not appear', () => {
  const raw = {
    content: [{ type: 'text', text: 'ok' }],
    details: { ok: true, overlay: { appeared: false } },
  };
  const enriched = enrichResult(raw, { action: 'click' });
  assert.equal(enriched.resultCategory, 'success');
  assert.ok(!enriched.nextActions || enriched.nextActions.length === 0);
});

test('enrichResult does not add nextAction when no overlay field present', () => {
  const raw = {
    content: [{ type: 'text', text: 'ok' }],
    details: { ok: true },
  };
  const enriched = enrichResult(raw, { action: 'click' });
  assert.equal(enriched.resultCategory, 'success');
  assert.ok(!enriched.nextActions || enriched.nextActions.length === 0);
});
