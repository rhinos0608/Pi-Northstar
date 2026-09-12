import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  redactChromeProfileText,
  redactChromeProfileSnapshot,
  chromeProfileTextLeaksSecret,
  safeChromeProfileErrorMessage,
} from '../src/chrome-profile-redaction.js';

const secrets = {
  sessionKey: 'sess-abc-123-secret',
  grantId: 'grant-xyz-999',
  nonce: 'nonce-top-secret-1',
  typedValues: ['S3cr3tP@ssw0rd!'],
};

test('exact secret values never survive redaction', () => {
  const raw = `key sess-abc-123-secret grant grant-xyz-999 nonce-top-secret-1 typed S3cr3tP@ssw0rd!`;
  const out = redactChromeProfileText(raw, secrets);
  assert.equal(chromeProfileTextLeaksSecret(out, secrets), false);
  for (const s of ['sess-abc-123-secret', 'grant-xyz-999', 'nonce-top-secret-1', 'S3cr3tP@ssw0rd!']) {
    assert.equal(out.includes(s), false, s);
  }
});

test('cookie, authorization, bearer, and form echoes redacted', () => {
  const out = redactChromeProfileText(
    'Cookie: abc123\nAuthorization: Bearer tok\nform-value: mysecret\nBearer abc.def.ghi',
    undefined,
  );
  assert.equal(out.includes('abc123'), false);
  assert.equal(out.includes('tok'), false);
  assert.equal(out.includes('mysecret'), false);
  assert.equal(out.includes('abc.def.ghi'), false);
  assert.match(out, /\[redacted\]/);
});

test('screenshot base64 runs withheld, snapshot redaction delegates', () => {
  const b64 = 'A'.repeat(300);
  const out = redactChromeProfileSnapshot(`snapshot ok ${b64}`, undefined);
  assert.equal(out.includes(b64), false);
  assert.match(out, /\[redacted\]/);
});

test('safe error message strips typed echo and stays bounded', () => {
  const msg = safeChromeProfileErrorMessage('click failed after typing S3cr3tP@ssw0rd! at @e1', secrets);
  assert.equal(msg.includes('S3cr3tP@ssw0rd!'), false);
  assert.ok(msg.length <= 500);
  assert.equal(safeChromeProfileErrorMessage('', undefined), 'user-chrome operation failed');
});

test('ephemeral instanceId redacted and leak-checked', () => {
  const withInstance = { ...secrets, instanceId: 'inst-ephemeral-42' };
  const out = redactChromeProfileText('poll from inst-ephemeral-42 done', withInstance);
  assert.equal(out.includes('inst-ephemeral-42'), false);
  assert.equal(chromeProfileTextLeaksSecret(out, withInstance), false);
  assert.equal(chromeProfileTextLeaksSecret('still inst-ephemeral-42 here', withInstance), true);
});
