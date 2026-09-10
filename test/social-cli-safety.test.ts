// Tests for the shared Stage 2 social CLI safety primitive
// (src/social-cli-safety.ts): option-shaped positional rejection and bounded
// secret redaction for caller-visible CLI diagnostics.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SocialError } from '../src/social-contract.js';
import {
  MAX_CLI_DIAGNOSTIC_CHARS,
  redactCliDiagnostics,
  requireCliPositional,
} from '../src/social-cli-safety.js';

function invalidRequestOf(run: () => unknown): SocialError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof SocialError, `expected SocialError, got ${String(error)}`);
    assert.equal(error.code, 'invalid_request');
    return error;
  }
  assert.fail('expected SocialError to be thrown');
}

// ── requireCliPositional ──

test('requireCliPositional rejects blank values with platform/field context', () => {
  for (const blank of ['', '   ', undefined, null, 42]) {
    const error = invalidRequestOf(() => requireCliPositional(blank, 'query', 'twitter'));
    assert.equal(error.platform, 'twitter');
    assert.match(error.message, /query/);
  }
});

test('requireCliPositional rejects option-shaped values', () => {
  for (const optionLike of ['-f', '--limit', '- foo', '  --json ']) {
    const error = invalidRequestOf(() => requireCliPositional(optionLike, 'user', 'reddit'));
    assert.equal(error.platform, 'reddit');
    assert.match(error.message, /user/);
  }
});

test('requireCliPositional option-shaped rejection leaks no input value', () => {
  const sentinel = 'sentinel-cred-83712';
  const error = invalidRequestOf(() =>
    requireCliPositional(`--xsec-token=${sentinel}`, 'query', 'xiaohongshu'),
  );
  assert.ok(!error.message.includes(sentinel), 'rejection message leaked credential material');
  assert.match(error.message, /query/);
  assert.match(error.message, /xiaohongshu/);
});

test('requireCliPositional preserves ordinary multilingual and interior-hyphen text', () => {
  assert.equal(requireCliPositional('  hello world  ', 'query', 'twitter'), 'hello world');
  assert.equal(requireCliPositional('你好世界', 'query', 'xiaohongshu'), '你好世界');
  assert.equal(requireCliPositional('café au lait', 'query', 'twitter'), 'café au lait');
  assert.equal(requireCliPositional('well-known topic', 'query', 'reddit'), 'well-known topic');
  assert.equal(requireCliPositional('50 - 20 = 30', 'query', 'reddit'), '50 - 20 = 30');
});

// ── redactCliDiagnostics ──

test('redactCliDiagnostics redacts secret-bearing labels', () => {
  const output = [
    'OPENCLI_TOKEN=opensesame-123',
    'XHS_COOKIE=session-abc',
    'xsec_token=token-xyz',
    'ct0=ct0-secret',
    'auth_token=auth-secret',
  ].join('\n');
  const redacted = redactCliDiagnostics(output);
  for (const secret of ['opensesame-123', 'session-abc', 'token-xyz', 'ct0-secret', 'auth-secret']) {
    assert.ok(!redacted.includes(secret), `leaked secret: ${secret}`);
  }
  assert.match(redacted, /\*\*\*/);
});

test('redactCliDiagnostics redacts Authorization/Cookie headers', () => {
  const output = 'request failed\nAuthorization: Bearer header-secret-1\nCookie: cookie-secret-2';
  const redacted = redactCliDiagnostics(output);
  assert.ok(!redacted.includes('header-secret-1'), 'leaked Authorization secret');
  assert.ok(!redacted.includes('cookie-secret-2'), 'leaked Cookie secret');
});

test('redactCliDiagnostics redacts explicitly supplied sensitive values', () => {
  const secret = 'super-secret-value-999';
  const redacted = redactCliDiagnostics(`boom, backend said: ${secret} (exit 1)`, [secret]);
  assert.ok(!redacted.includes(secret), 'leaked supplied secret');
  assert.match(redacted, /boom/);
});

test('redactCliDiagnostics masks every component of semicolon-delimited labeled cookies', () => {
  const redacted = redactCliDiagnostics('XHS_COOKIE=a1=first-secret; web_session=second-secret');
  assert.ok(!redacted.includes('first-secret'), 'leaked first cookie component');
  assert.ok(!redacted.includes('second-secret'), 'leaked trailing cookie component');
  assert.match(redacted, /\*\*\*/);
});

test('redactCliDiagnostics masks trailing key=value pairs in cookie-shaped text', () => {
  const redacted = redactCliDiagnostics('XHS_COOKIE=session-abc; web_session=trailing-secret-xyz');
  assert.ok(!redacted.includes('session-abc'), 'leaked labeled cookie value');
  assert.ok(!redacted.includes('trailing-secret-xyz'), 'leaked unlabeled trailing pair');
});

test('redactCliDiagnostics matches percent-encoded secret labels', () => {
  const secret = 'xsec-secret-xyz-789';
  const redacted = redactCliDiagnostics(`boom xsec%5Ftoken%3D${secret}`, [secret]);
  assert.ok(!redacted.includes(secret), 'leaked value behind encoded label');
  assert.match(redacted, /\*\*\*/);
});

test('redactCliDiagnostics redacts percent-encoded sensitive values', () => {
  const secret = 'super secret/value?&';
  const encoded = encodeURIComponent(secret);
  const redacted = redactCliDiagnostics(`boom, backend said: ${encoded} (exit 1)`, [secret]);
  assert.ok(!redacted.includes(encoded), 'leaked percent-encoded sensitive value');
  assert.ok(!redacted.includes(secret), 'leaked raw sensitive value');
});

test('redactCliDiagnostics keeps benign error text intact', () => {
  const benign = 'exit code 1: tweet not found; author bob has no timeline';
  assert.equal(redactCliDiagnostics(benign), benign);
});

test('redactCliDiagnostics bounds output length', () => {
  const long = `failure: ${'x'.repeat(MAX_CLI_DIAGNOSTIC_CHARS + 500)}`;
  const redacted = redactCliDiagnostics(long);
  assert.ok(redacted.length <= MAX_CLI_DIAGNOSTIC_CHARS, `length ${redacted.length}`);
});
