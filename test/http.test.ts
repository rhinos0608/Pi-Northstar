import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeResponseText, validatePublicHttpUrl } from '../src/http.js';

test('validatePublicHttpUrl accepts public http/https and rejects private/reserved', () => {
  // Public URLs accepted
  assert.equal(validatePublicHttpUrl('https://example.com/path'), 'https://example.com/path');
  assert.equal(validatePublicHttpUrl('https://api.github.com/repos'), 'https://api.github.com/repos');
  assert.equal(validatePublicHttpUrl('http://8.8.8.8/'), 'http://8.8.8.8/');

  // Private/reserved hostnames rejected
  assert.throws(() => validatePublicHttpUrl('http://localhost:3000/'), /Blocked hostname/);
  assert.throws(() => validatePublicHttpUrl('http://10.0.0.1/'), /Private\/reserved/);
  assert.throws(() => validatePublicHttpUrl('http://192.168.1.1/'), /Private\/reserved/);
  assert.throws(() => validatePublicHttpUrl('http://127.0.0.1/'), /Private\/reserved/);
  assert.throws(() => validatePublicHttpUrl('http://169.254.169.254/'), /Private\/reserved/);
  assert.throws(() => validatePublicHttpUrl('http://metadata.google.internal/'), /Blocked hostname/);
  assert.throws(() => validatePublicHttpUrl('http://[fd00::1]/'), /Private\/reserved/);
  assert.throws(() => validatePublicHttpUrl('http://[fc00::1]/'), /Private\/reserved/);
  assert.throws(() => validatePublicHttpUrl('http://100.64.0.1/'), /Private\/reserved/);

  // Non-HTTP schemes rejected
  assert.throws(() => validatePublicHttpUrl('ftp://example.com'), /scheme/);
  assert.throws(() => validatePublicHttpUrl('file:///etc/passwd'), /scheme/);
});

test('safeResponseText rejects content-length over cap', async () => {
  const response = new Response('', { headers: { 'content-length': '10' } });
  await assert.rejects(() => safeResponseText(response, 'https://example.com', 5), /too large/);
});
