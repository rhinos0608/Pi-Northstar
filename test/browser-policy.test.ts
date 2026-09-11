import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateNavigationUrl, validateAllowedDomain, freezeAllowedDomains, checkDomainAllowed, validateBrowserRequest, isSensitiveAction, validateSemanticActionRequest, validateBatchRequest, validateNoLoopbackInBatch, validateAllowedDomainsDns, dnsPreflight, validateScrollCoord, validateWaitMs, MAX_TEXT_LENGTH, MAX_SCROLL_COORD, MAX_WAIT_MS } from '../src/browser-policy.js';
import type { DnsLookup } from '../src/network-policy.js';

test('browser policy accepts http/https URLs, rejects private/reserved from public validator', () => {
  // Public URLs accepted
  assert.equal(validateNavigationUrl('https://example.com/path'), 'https://example.com/path');

  // Private/reserved hostnames rejected
  assert.throws(() => validateNavigationUrl('http://localhost:3000'), /Blocked hostname/);
  assert.throws(() => validateNavigationUrl('http://10.0.0.1/'), /Private\/reserved/);
  assert.throws(() => validateNavigationUrl('http://192.168.1.1/'), /Private\/reserved/);
  assert.throws(() => validateNavigationUrl('http://[::1]:8080'), /Private\/reserved/);
  assert.throws(() => validateNavigationUrl('http://169.254.169.254/'), /Private\/reserved/);
  assert.throws(() => validateNavigationUrl('http://metadata.google.internal/'), /Blocked hostname/);

  // Non-HTTP schemes rejected
  assert.throws(() => validateNavigationUrl('ftp://example.com'), /scheme/);
  assert.throws(() => validateNavigationUrl('file:///etc/passwd'), /scheme/);
  assert.throws(() => validateNavigationUrl('data:text/html,hello'), /scheme/);
});

test('domain policy: checkDomainAllowed uses label-boundary matching', () => {
  assert.equal(checkDomainAllowed('cdn.example.com', ['*.example.com']), true);
  assert.equal(checkDomainAllowed('deep.sub.example.com', ['*.example.com']), true);
  assert.equal(checkDomainAllowed('example.com', ['*.example.com']), false);
  assert.equal(checkDomainAllowed('evil-example.com', ['*.example.com']), false);
  assert.equal(checkDomainAllowed('example.com', ['example.com']), true);
  assert.equal(checkDomainAllowed('other.com', ['example.com']), false);
  assert.equal(checkDomainAllowed('anything.com', []), false);
});

test('domain policy: validateAllowedDomain rejects private and wildcard apex', () => {
  assert.throws(() => validateAllowedDomain('localhost'), /Blocked hostname|Private\/reserved/);
  assert.throws(() => validateAllowedDomain('10.0.0.1'), /Private\/reserved/);
  assert.throws(() => validateAllowedDomain('metadata.google.internal'), /Blocked hostname/);
  assert.throws(() => validateAllowedDomain('*'), /Wildcard-only/);
});

test('domain policy freezes normalized domains and validates DNS', async () => {
  assert.deepEqual(freezeAllowedDomains(['*.Example.com', 'cdn.example.net']), ['*.example.com', 'cdn.example.net']);
  const fakeLookup: DnsLookup = async () => [{ address: '8.8.8.8', family: 4 }];
  await validateAllowedDomainsDns(['example.com', '*.example.net'], undefined, fakeLookup);
});

test('DNS: dnsPreflight rejects private address', async () => {
  const fakeLookup: DnsLookup = async () => [{ address: '10.0.0.1', family: 4 }];
  await assert.rejects(
    () => dnsPreflight('internal.example.com', undefined, fakeLookup),
    /private\/reserved address: 10.0.0.1/,
  );
});

test('request action union and no-op sensitive classification', () => {
  assert.equal(validateBrowserRequest({ action: 'snapshot' }).action, 'snapshot');
  assert.throws(() => validateBrowserRequest({ action: 'shell' }), /Unsupported/);
  assert.equal(isSensitiveAction('evaluate'), true);
  assert.equal(isSensitiveAction('set_cookies'), true);
  assert.equal(isSensitiveAction('text'), false);
});

test('request accepts semanticAction and batch actions', () => {
  assert.equal(validateBrowserRequest({ action: 'semanticAction' }).action, 'semanticAction');
  assert.equal(validateBrowserRequest({ action: 'job' }).action, 'job');
  assert.equal(validateBrowserRequest({ action: 'batch' }).action, 'batch');
});

// ── Component 9: validateSemanticActionRequest ──

test('validateSemanticActionRequest rejects missing locator', () => {
  assert.throws(() => validateSemanticActionRequest({ query: 'button', verb: 'click' }), /locator/);
});

test('validateSemanticActionRequest rejects invalid locator', () => {
  assert.throws(() => validateSemanticActionRequest({ locator: 'invalid', query: 'x', verb: 'click' }), /locator/);
});

test('validateSemanticActionRequest rejects missing query', () => {
  assert.throws(() => validateSemanticActionRequest({ locator: 'role', verb: 'click' }), /query/);
});

test('validateSemanticActionRequest rejects missing verb', () => {
  assert.throws(() => validateSemanticActionRequest({ locator: 'role', query: 'button' }), /verb/);
});

test('validateSemanticActionRequest rejects invalid verb', () => {
  assert.throws(() => validateSemanticActionRequest({ locator: 'role', query: 'button', verb: 'invalid' }), /verb/);
});

test('validateSemanticActionRequest requires index for nth locator', () => {
  assert.throws(
    () => validateSemanticActionRequest({ locator: 'nth', query: 'button', verb: 'click' }),
    /index is required when locator is nth/,
  );
});

test('validateSemanticActionRequest requires value for fill verb', () => {
  assert.throws(
    () => validateSemanticActionRequest({ locator: 'role', query: 'textbox', verb: 'fill' }),
    /value is required when verb is fill/,
  );
});

test('validateSemanticActionRequest rejects verbs outside the CLI find action set', () => {
  // agent-browser 0.37.1 find accepts only click, fill, check, hover, text
  // (verified: `find role foo <verb>` errors "Unknown action" without launching).
  for (const verb of ['type', 'select', 'uncheck']) {
    assert.throws(
      () => validateSemanticActionRequest({ locator: 'role', query: 'x', verb, value: 'v' }),
      /verb is required and must be one of/,
    );
  }
});

test('validateSemanticActionRequest accepts valid role click', () => {
  const r = validateSemanticActionRequest({ locator: 'role', query: 'button', verb: 'click', name: 'Submit', exact: true });
  assert.equal(r.locator, 'role');
  assert.equal(r.query, 'button');
  assert.equal(r.verb, 'click');
  assert.equal(r.name, 'Submit');
  assert.equal(r.exact, true);
});

test('validateSemanticActionRequest accepts valid nth locator with index', () => {
  const r = validateSemanticActionRequest({ locator: 'nth', query: 'button', verb: 'click', index: 2 });
  assert.equal(r.index, 2);
});

test('validateSemanticActionRequest accepts valid fill with value', () => {
  const r = validateSemanticActionRequest({ locator: 'role', query: 'textbox', verb: 'fill', value: 'hello' });
  assert.equal(r.value, 'hello');
});

// ── Component 11: validateBatchRequest ──

test('validateBatchRequest rejects empty commands', () => {
  assert.throws(() => validateBatchRequest({ commands: [] }), /non-empty/);
});

test('validateBatchRequest rejects exceeding maxCommands', () => {
  const commands = Array.from({ length: 5 }, () => ({ args: ['click', '#btn'] }));
  assert.throws(() => validateBatchRequest({ commands, maxCommands: 3 }), /too many commands/);
});

test('validateBatchRequest rejects command with empty args', () => {
  assert.throws(() => validateBatchRequest({ commands: [{ args: [] }] }), /args is required/);
});

test('validateBatchRequest accepts valid commands', () => {
  const r = validateBatchRequest({ commands: [{ args: ['click', '#btn'] }, { args: ['type', '#input', 'hello'] }] });
  assert.equal(r.commands.length, 2);
  assert.equal(r.commands[0]!.args[0], 'click');
  assert.equal(r.commands[0]!.sensitive, true); // default
});

test('validateBatchRequest preserves sensitive flag', () => {
  const r = validateBatchRequest({ commands: [{ args: ['snapshot'], sensitive: false }] });
  assert.equal(r.commands[0]!.sensitive, false);
});

test('batch is classified as sensitive action', () => {
  assert.equal(isSensitiveAction('batch'), true);
});

test('semantic query/name/value reject above MAX_TEXT_LENGTH', () => {
  const tooLong = 'x'.repeat(MAX_TEXT_LENGTH + 1);
  assert.throws(() => validateSemanticActionRequest({ locator: 'role', query: tooLong, verb: 'click' }), /query too long/);
  assert.throws(() => validateSemanticActionRequest({ locator: 'role', query: 'button', verb: 'click', name: tooLong }), /name too long/);
  assert.throws(() => validateSemanticActionRequest({ locator: 'role', query: 'textbox', verb: 'fill', value: tooLong }), /value too long/);
});

test('semantic query/name/value at MAX_TEXT_LENGTH boundary pass', () => {
  const boundary = 'x'.repeat(MAX_TEXT_LENGTH);
  const withQuery = validateSemanticActionRequest({ locator: 'role', query: boundary, verb: 'click' });
  assert.equal(withQuery.query.length, MAX_TEXT_LENGTH);
  const withName = validateSemanticActionRequest({ locator: 'role', query: 'button', verb: 'click', name: boundary });
  assert.equal(withName.name!.length, MAX_TEXT_LENGTH);
  const withValue = validateSemanticActionRequest({ locator: 'role', query: 'textbox', verb: 'fill', value: boundary });
  assert.equal(withValue.value!.length, MAX_TEXT_LENGTH);
});

// ── Loopback batch bypass guard ──

test('validateBatchRequest rejects loopback URL in open command', () => {
  assert.throws(
    () => validateBatchRequest({ commands: [{ args: ['open', 'http://127.0.0.1:3000'] }] }),
    /loopback URL/,
  );
});

test('validateBatchRequest rejects loopback URL in navigate command', () => {
  assert.throws(
    () => validateBatchRequest({ commands: [{ args: ['navigate', 'http://localhost:8080/'] }] }),
    /loopback URL/,
  );
});

test('validateBatchRequest rejects loopback URL with ::1', () => {
  assert.throws(
    () => validateBatchRequest({ commands: [{ args: ['open', 'http://[::1]:3000/'] }] }),
    /loopback URL/,
  );
});

test('validateBatchRequest passes non-loopback URL in open command', () => {
  const r = validateBatchRequest({ commands: [{ args: ['open', 'https://example.com'] }] });
  assert.equal(r.commands.length, 1);
});

test('validateBatchRequest passes non-navigate action with loopback-like URL', () => {
  const r = validateBatchRequest({ commands: [{ args: ['click', 'http://127.0.0.1:3000/btn'] }] });
  assert.equal(r.commands.length, 1);
});

test('validateNoLoopbackInBatch passes empty list', () => {
  validateNoLoopbackInBatch([]);
});

test('validateBatchRequest rejects credentialed loopback URL in open command', () => {
  assert.throws(
    () => validateBatchRequest({ commands: [{ args: ['open', 'http://user:pass@localhost:3000/'] }] }),
    /credentials/,
  );
});

test('validateBatchRequest rejects credentialed IPv6 loopback URL in navigate command', () => {
  assert.throws(
    () => validateBatchRequest({ commands: [{ args: ['navigate', 'https://user:pass@[::1]:3000/'] }] }),
    /credentials/,
  );
});

test('validateScrollCoord rejects out-of-range instead of clamping', () => {
  assert.equal(validateScrollCoord(0, 'x'), 0);
  assert.equal(validateScrollCoord(MAX_SCROLL_COORD, 'x'), MAX_SCROLL_COORD);
  assert.equal(validateScrollCoord(-MAX_SCROLL_COORD, 'y'), -MAX_SCROLL_COORD);
  assert.equal(validateScrollCoord(undefined, 'x'), 0);
  assert.throws(() => validateScrollCoord(MAX_SCROLL_COORD + 1, 'x'), /invalid_request.*x.*100000/);
  assert.throws(() => validateScrollCoord(-MAX_SCROLL_COORD - 1, 'y'), /invalid_request.*y.*100000/);
  assert.throws(() => validateScrollCoord(Number.NaN, 'x'), /invalid_request.*x/);
  assert.throws(() => validateScrollCoord('10' as unknown as number, 'x'), /invalid_request.*x/);
});

test('validateWaitMs rejects out-of-range instead of clamping', () => {
  assert.equal(validateWaitMs(0), 0);
  assert.equal(validateWaitMs(MAX_WAIT_MS), MAX_WAIT_MS);
  assert.equal(validateWaitMs(undefined), 0);
  assert.throws(() => validateWaitMs(MAX_WAIT_MS + 1), /invalid_request.*waitMs.*120000/);
  assert.throws(() => validateWaitMs(-1), /invalid_request.*waitMs/);
  assert.throws(() => validateWaitMs(Number.NaN), /invalid_request.*waitMs/);
  assert.throws(() => validateWaitMs('500' as unknown as number), /invalid_request.*waitMs/);
});

test('validateBatchRequest caps effective max at 20 even when caller supplies higher maxCommands', () => {
  // maxCommands: 21 should NOT allow 21 commands; effective cap is 20
  const commands21 = Array.from({ length: 21 }, () => ({ args: ['click', '#btn'] }));
  assert.throws(() => validateBatchRequest({ commands: commands21, maxCommands: 21 }), /too many commands/);
  // 21 commands with maxCommands:21 must not pass — the hard cap is 20
  // Verify exactly 20 still passes
  const commands20 = Array.from({ length: 20 }, () => ({ args: ['click', '#btn'] }));
  const r = validateBatchRequest({ commands: commands20, maxCommands: 21 });
  assert.equal(r.commands.length, 20);
});
