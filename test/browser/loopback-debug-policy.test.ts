import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseLoopbackDebugTarget,
  isAllowedLoopbackRequest,
  sameNetworkOrigin,
} from '../../src/browser/loopback-debug-policy.js';

// ── parseLoopbackDebugTarget ──

test('accepts localhost with default port', () => {
  const p = parseLoopbackDebugTarget('http://localhost');
  assert.ok(p);
  assert.equal(p.hostname, 'localhost');
  assert.equal(p.port, 80);
  assert.equal(p.origin, 'http://localhost');
  assert.equal(p.protocol, 'http:');
});

test('accepts localhost with explicit port', () => {
  const p = parseLoopbackDebugTarget('http://localhost:3000');
  assert.ok(p);
  assert.equal(p.port, 3000);
  assert.equal(p.origin, 'http://localhost:3000');
});

test('navigation URL preserves pathname', () => {
  const p = parseLoopbackDebugTarget('http://localhost:3000/debug/start');
  assert.ok(p);
  assert.equal(p.navigationUrl, 'http://localhost:3000/debug/start');
});

test('navigation URL preserves query', () => {
  const p = parseLoopbackDebugTarget('http://localhost:3000/debug?mode=loopback');
  assert.ok(p);
  assert.equal(p.navigationUrl, 'http://localhost:3000/debug?mode=loopback');
});

test('accepts 127.0.0.1', () => {
  const p = parseLoopbackDebugTarget('http://127.0.0.1:8080');
  assert.ok(p);
  assert.equal(p.hostname, '127.0.0.1');
  assert.equal(p.port, 8080);
});

test('accepts 127.42.0.9', () => {
  const p = parseLoopbackDebugTarget('http://127.42.0.9:3000');
  assert.ok(p);
  assert.equal(p.hostname, '127.42.0.9');
});

test('accepts IPv6 ::1', () => {
  const p = parseLoopbackDebugTarget('http://[::1]:5173');
  assert.ok(p);
  // Node URL returns [::1] with brackets
  assert.equal(p.hostname, '[::1]');
  assert.equal(p.port, 5173);
});

test('accepts decimal IPv4 host normalization', () => {
  // WHATWG URL maps 2130706433 → 127.0.0.1
  const p = parseLoopbackDebugTarget('http://2130706433:3000/');
  assert.ok(p);
  assert.equal(p.hostname, '127.0.0.1');
});

test('accepts octal IPv4 host normalization', () => {
  // WHATWG URL maps 0177.0.0.1 → 127.0.0.1
  const p = parseLoopbackDebugTarget('http://0177.0.0.1:3000/');
  assert.ok(p);
  assert.equal(p.hostname, '127.0.0.1');
});

test('rejects IPv4-mapped IPv6 form', () => {
  assert.equal(parseLoopbackDebugTarget('http://[::ffff:7f00:1]:3000'), undefined);
});

test('accepts expanded IPv6 loopback form', () => {
  const p = parseLoopbackDebugTarget('http://[0:0:0:0:0:0:0:1]:3000');
  assert.ok(p);
  assert.equal(p.hostname, '[::1]');
});

test('accepts https', () => {
  const p = parseLoopbackDebugTarget('https://localhost:443');
  assert.ok(p);
  assert.equal(p.protocol, 'https:');
  assert.equal(p.port, 443);
});

test('rejects 0.0.0.0', () => {
  assert.equal(parseLoopbackDebugTarget('http://0.0.0.0:3000'), undefined);
});

test('rejects [::]', () => {
  assert.equal(parseLoopbackDebugTarget('http://[::]:3000'), undefined);
});

test('rejects host.docker.internal', () => {
  assert.equal(parseLoopbackDebugTarget('http://host.docker.internal:3000'), undefined);
});

test('rejects RFC1918 10.x', () => {
  assert.equal(parseLoopbackDebugTarget('http://10.0.0.1:3000'), undefined);
});

test('rejects RFC1918 172.16.x', () => {
  assert.equal(parseLoopbackDebugTarget('http://172.16.0.1:3000'), undefined);
});

test('rejects RFC1918 192.168.x', () => {
  assert.equal(parseLoopbackDebugTarget('http://192.168.1.1:3000'), undefined);
});

test('rejects link-local 169.254.x', () => {
  assert.equal(parseLoopbackDebugTarget('http://169.254.1.1:3000'), undefined);
});

test('rejects external hostname', () => {
  assert.equal(parseLoopbackDebugTarget('http://example.com:3000'), undefined);
});

test('rejects credentials in URL', () => {
  assert.equal(parseLoopbackDebugTarget('http://user:pass@localhost:3000'), undefined);
});

test('rejects non-http protocol', () => {
  assert.equal(parseLoopbackDebugTarget('ftp://localhost:3000'), undefined);
  assert.equal(parseLoopbackDebugTarget('file:///etc/passwd'), undefined);
});

test('rejects invalid URL', () => {
  assert.equal(parseLoopbackDebugTarget('not-a-url'), undefined);
});

// ── isAllowedLoopbackRequest ──

test('same origin path accepted', () => {
  const p = parseLoopbackDebugTarget('http://localhost:3000')!;
  assert.equal(isAllowedLoopbackRequest(p, 'http://localhost:3000/app/main.js'), true);
});

test('same origin query accepted', () => {
  const p = parseLoopbackDebugTarget('http://localhost:3000')!;
  assert.equal(isAllowedLoopbackRequest(p, 'http://localhost:3000/api?token=abc'), true);
});

test('different port rejected', () => {
  const p = parseLoopbackDebugTarget('http://localhost:3000')!;
  assert.equal(isAllowedLoopbackRequest(p, 'http://localhost:5432/'), false);
});

test('different scheme rejected', () => {
  const p = parseLoopbackDebugTarget('http://localhost:3000')!;
  assert.equal(isAllowedLoopbackRequest(p, 'https://localhost:3000/'), false);
});

test('different host rejected', () => {
  const p = parseLoopbackDebugTarget('http://localhost:3000')!;
  assert.equal(isAllowedLoopbackRequest(p, 'http://127.0.0.1:3000/'), false);
});

test('ws:// maps to http:// for HMR', () => {
  const p = parseLoopbackDebugTarget('http://localhost:3000')!;
  assert.equal(isAllowedLoopbackRequest(p, 'ws://localhost:3000/'), true);
});

test('wss:// maps to https:// for HMR', () => {
  const p = parseLoopbackDebugTarget('https://localhost:3000')!;
  assert.equal(isAllowedLoopbackRequest(p, 'wss://localhost:3000/'), true);
});

test('cross-port HMR rejected', () => {
  const p = parseLoopbackDebugTarget('http://localhost:3000')!;
  assert.equal(isAllowedLoopbackRequest(p, 'ws://localhost:24678/'), false);
});

test('non-http scheme rejected', () => {
  const p = parseLoopbackDebugTarget('http://localhost:3000')!;
  assert.equal(isAllowedLoopbackRequest(p, 'ftp://localhost:3000/'), false);
});

test('invalid URL rejected', () => {
  const p = parseLoopbackDebugTarget('http://localhost:3000')!;
  assert.equal(isAllowedLoopbackRequest(p, 'not-a-url'), false);
});

// ── sameNetworkOrigin ──

test('same http origins match', () => {
  assert.equal(sameNetworkOrigin('http://localhost:3000/a', 'http://localhost:3000/b'), true);
});

test('ws maps to http for comparison', () => {
  assert.equal(sameNetworkOrigin('http://localhost:3000/', 'ws://localhost:3000/'), true);
});

test('wss maps to https for comparison', () => {
  assert.equal(sameNetworkOrigin('https://localhost:443/', 'wss://localhost:443/'), true);
});

test('different ports do not match', () => {
  assert.equal(sameNetworkOrigin('http://localhost:3000/', 'http://localhost:4000/'), false);
});

test('different hosts do not match', () => {
  assert.equal(sameNetworkOrigin('http://localhost:3000/', 'http://127.0.0.1:3000/'), false);
});
