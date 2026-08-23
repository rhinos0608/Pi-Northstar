import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateJobRequest, jobStepToBrowserRequest } from '../src/browser-job.js';

// ── validateJobRequest ──

test('validateJobRequest rejects empty steps', () => {
  assert.throws(() => validateJobRequest({ steps: [] }), /non-empty/);
});

test('validateJobRequest rejects non-array steps', () => {
  assert.throws(() => validateJobRequest({ steps: 'not-array' }), /non-empty/);
});

test('validateJobRequest rejects exceeding maxSteps', () => {
  const steps = Array.from({ length: 5 }, () => ({ kind: 'wait', waitMs: 100 }));
  assert.throws(() => validateJobRequest({ steps, maxSteps: 3 }), /too many steps/);
});

test('validateJobRequest rejects unknown kind', () => {
  assert.throws(() => validateJobRequest({ steps: [{ kind: 'fly' }] }), /unknown kind/);
});

test('validateJobRequest requires url for open', () => {
  assert.throws(() => validateJobRequest({ steps: [{ kind: 'open' }] }), /open requires url/);
});

test('validateJobRequest requires selector for click', () => {
  assert.throws(() => validateJobRequest({ steps: [{ kind: 'click' }] }), /click requires selector/);
});

test('validateJobRequest requires selector for fill', () => {
  assert.throws(
    () => validateJobRequest({ steps: [{ kind: 'fill' }] }),
    /fill requires selector/,
  );
});

test('validateJobRequest requires text for fill', () => {
  assert.throws(
    () => validateJobRequest({ steps: [{ kind: 'fill', selector: '#input' }] }),
    /fill requires text/,
  );
});

test('validateJobRequest requires text for type', () => {
  assert.throws(
    () => validateJobRequest({ steps: [{ kind: 'type', selector: '#input' }] }),
    /type requires text/,
  );
});

test('validateJobRequest requires selector for select', () => {
  assert.throws(
    () => validateJobRequest({ steps: [{ kind: 'select' }] }),
    /select requires selector/,
  );
});

test('validateJobRequest requires values array for select', () => {
  assert.throws(
    () => validateJobRequest({ steps: [{ kind: 'select', selector: '#sel' }] }),
    /select requires values/,
  );
});

test('validateJobRequest requires selector for assert', () => {
  assert.throws(
    () => validateJobRequest({ steps: [{ kind: 'assert' }] }),
    /assert requires selector/,
  );
});

test('validateJobRequest accepts valid steps', () => {
  const result = validateJobRequest({
    steps: [
      { kind: 'open', url: 'https://example.com' },
      { kind: 'click', selector: '#btn' },
      { kind: 'fill', selector: '#input', text: 'hello' },
      { kind: 'type', selector: '#input', text: 'world' },
      { kind: 'select', selector: '#sel', values: ['a', 'b'] },
      { kind: 'wait', waitMs: 500 },
      { kind: 'assert', selector: 'body', assertText: 'Done' },
      { kind: 'snapshot' },
      { kind: 'screenshot' },
    ],
  });
  assert.equal(result.steps.length, 9);
  assert.equal(result.maxSteps, 20);
});

test('validateJobRequest preserves continueOnFailure flag', () => {
  const result = validateJobRequest({
    steps: [{ kind: 'click', selector: '#btn', continueOnFailure: true }],
  });
  assert.equal(result.steps[0]!.continueOnFailure, true);
});

test('validateJobRequest defaults maxSteps to 20', () => {
  const result = validateJobRequest({ steps: [{ kind: 'snapshot' }] });
  assert.equal(result.maxSteps, 20);
});

// ── jobStepToBrowserRequest ──

test('jobStepToBrowserRequest maps open to navigate', () => {
  const req = jobStepToBrowserRequest({ kind: 'open', url: 'https://example.com' });
  assert.equal(req.action, 'navigate');
  assert.equal(req.url, 'https://example.com');
});

test('jobStepToBrowserRequest maps click', () => {
  const req = jobStepToBrowserRequest({ kind: 'click', selector: '#btn' });
  assert.equal(req.action, 'click');
  assert.equal(req.selector, '#btn');
});

test('jobStepToBrowserRequest maps fill', () => {
  const req = jobStepToBrowserRequest({ kind: 'fill', selector: '#input', text: 'hello' });
  assert.equal(req.action, 'fill');
  assert.equal(req.selector, '#input');
  assert.equal(req.text, 'hello');
});

test('jobStepToBrowserRequest maps type', () => {
  const req = jobStepToBrowserRequest({ kind: 'type', selector: '#input', text: 'world' });
  assert.equal(req.action, 'type');
  assert.equal(req.selector, '#input');
  assert.equal(req.text, 'world');
});

test('jobStepToBrowserRequest maps select to fill with first value', () => {
  const req = jobStepToBrowserRequest({ kind: 'select', selector: '#sel', values: ['a', 'b'] });
  assert.equal(req.action, 'fill');
  assert.equal(req.selector, '#sel');
  assert.equal(req.text, 'a');
});

test('jobStepToBrowserRequest maps select with empty values to fill without text', () => {
  const req = jobStepToBrowserRequest({ kind: 'select', selector: '#sel', values: [] });
  assert.equal(req.action, 'fill');
  assert.equal(req.selector, '#sel');
  assert.equal(req.text, undefined);
});

test('jobStepToBrowserRequest maps wait', () => {
  const req = jobStepToBrowserRequest({ kind: 'wait', waitMs: 1000 });
  assert.equal(req.action, 'wait');
  assert.equal(req.waitMs, 1000);
});

test('jobStepToBrowserRequest maps snapshot', () => {
  const req = jobStepToBrowserRequest({ kind: 'snapshot' });
  assert.equal(req.action, 'snapshot');
});

test('jobStepToBrowserRequest maps screenshot', () => {
  const req = jobStepToBrowserRequest({ kind: 'screenshot' });
  assert.equal(req.action, 'screenshot');
});

test('jobStepToBrowserRequest maps assert to wait', () => {
  const req = jobStepToBrowserRequest({ kind: 'assert', selector: 'body', assertText: 'Done' });
  assert.equal(req.action, 'wait');
  assert.equal(req.selector, 'body');
});

test('validateJobRequest caps effective max at 20 even when caller supplies higher maxSteps', () => {
  // maxSteps: 21 should NOT allow 21 steps; effective cap is 20
  const steps21 = Array.from({ length: 21 }, () => ({ kind: 'snapshot' as const }));
  assert.throws(() => validateJobRequest({ steps: steps21, maxSteps: 21 }), /too many steps/);
  // Exactly 20 should still pass
  const steps20 = Array.from({ length: 20 }, () => ({ kind: 'snapshot' as const }));
  const res = validateJobRequest({ steps: steps20, maxSteps: 21 });
  assert.equal(res.steps.length, 20);
});
