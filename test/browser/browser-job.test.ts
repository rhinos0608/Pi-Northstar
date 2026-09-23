import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateJobRequest, validateNoLoopbackInJob, jobStepToBrowserRequest } from '../../src/browser/browser-job.js';

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

test('validateJobRequest rejects malformed maxSteps instead of silently admitting it', () => {
  const steps = [{ kind: 'snapshot' as const }];
  for (const maxSteps of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => validateJobRequest({ steps, maxSteps }),
      /maxSteps must be a positive integer/,
      String(maxSteps),
    );
  }
  assert.throws(
    () => validateJobRequest({ steps, maxSteps: '2' as unknown as number }),
    /maxSteps must be a positive integer/,
  );
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
  assert.throws(
    () => validateJobRequest({ steps: [{ kind: 'select', selector: '#sel', values: ['a', 2] }] }),
    /select values must all be strings/,
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

test('jobStepToBrowserRequest maps select to the native select action with all values', () => {
  const req = jobStepToBrowserRequest({ kind: 'select', selector: '#sel', values: ['a', 'b'] });
  assert.equal(req.action, 'select');
  assert.equal(req.selector, '#sel');
  assert.deepEqual(req.values, ['a', 'b']);
  assert.equal(req.text, undefined);
});

test('jobStepToBrowserRequest maps select with empty values to select without text', () => {
  const req = jobStepToBrowserRequest({ kind: 'select', selector: '#sel', values: [] });
  assert.equal(req.action, 'select');
  assert.equal(req.selector, '#sel');
  assert.deepEqual(req.values, []);
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
  assert.equal(req.text, 'Done');
});

test('jobStepToBrowserRequest maps assert without assertText to plain selector wait', () => {
  const req = jobStepToBrowserRequest({ kind: 'assert', selector: 'body' });
  assert.equal(req.action, 'wait');
  assert.equal(req.selector, 'body');
  assert.equal(req.text, undefined);
});

test('validateJobRequest rejects loopback URL in open step', () => {
  assert.throws(
    () => validateJobRequest({ steps: [{ kind: 'open', url: 'http://127.0.0.1:3000/' }] }),
    /loopback URL/,
  );
});

test('validateJobRequest rejects localhost URL in open step', () => {
  assert.throws(
    () => validateJobRequest({ steps: [{ kind: 'open', url: 'http://localhost:8080/' }] }),
    /loopback URL/,
  );
});

test('validateJobRequest rejects loopback URL in later step (whole job pre-execution)', () => {
  assert.throws(
    () =>
      validateJobRequest({
        steps: [
          { kind: 'open', url: 'https://example.com' },
          { kind: 'click', selector: '#btn' },
          { kind: 'open', url: 'http://[::1]:3000/' },
        ],
      }),
    /step 2.*loopback URL/,
  );
});

test('validateJobRequest rejects credentialed URL in open step', () => {
  assert.throws(
    () => validateJobRequest({ steps: [{ kind: 'open', url: 'http://user:pass@localhost:3000/' }] }),
    /credentials/,
  );
});

test('validateJobRequest allows @ in path/query when URL has no credentials', () => {
  const r = validateJobRequest({ steps: [{ kind: 'open', url: 'https://example.com/@alice?q=@team' }] });
  assert.equal(r.steps[0]?.url, 'https://example.com/@alice?q=@team');
});

test('validateJobRequest passes non-loopback open URL', () => {
  const r = validateJobRequest({ steps: [{ kind: 'open', url: 'https://example.com' }] });
  assert.equal(r.steps.length, 1);
});

test('validateNoLoopbackInJob passes steps without open URLs', () => {
  validateNoLoopbackInJob([{ kind: 'click', selector: '#btn' }]);
});

test('validateJobRequest rejects maxSteps above the hard cap instead of clamping it', () => {
  const steps20 = Array.from({ length: 20 }, () => ({ kind: 'snapshot' as const }));
  assert.throws(() => validateJobRequest({ steps: steps20, maxSteps: 21 }), /maxSteps must be an integer 1\.\.20/);
  const res = validateJobRequest({ steps: steps20, maxSteps: 20 });
  assert.equal(res.steps.length, 20);
});

test('validateJobRequest rejects unknown wrapper and cross-step fields', () => {
  assert.throws(() => validateJobRequest({ steps: [{ kind: 'snapshot' }], bogus: true }), /unknown job field/);
  assert.throws(() => validateJobRequest({ steps: [{ kind: 'click', selector: '#ok', url: 'https:\/\/example.com' }] }), /field url is not allowed.*click/);
  assert.throws(() => validateJobRequest({ steps: [{ kind: 'snapshot', continueOnFailure: 'yes' }] }), /continueOnFailure must be a boolean/);
});

test('validateJobRequest preserves wait selectors/text and assert waitMs', () => {
  const result = validateJobRequest({ steps: [
    { kind: 'wait', selector: '#ready', text: 'Loaded', waitMs: 250 },
    { kind: 'assert', selector: '#done', assertText: 'Done', waitMs: 500 },
  ] });
  assert.deepEqual(result.steps[0], { kind: 'wait', selector: '#ready', text: 'Loaded', waitMs: 250 });
  assert.deepEqual(result.steps[1], { kind: 'assert', selector: '#done', assertText: 'Done', waitMs: 500 });
});
