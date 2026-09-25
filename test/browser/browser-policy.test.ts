import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateNavigationUrl, validateAllowedDomain, freezeAllowedDomains, checkDomainAllowed, validateBrowserRequest, isSensitiveAction, validateSemanticActionRequest, validateBatchRequest, validateNoLoopbackInBatch, validateAllowedDomainsDns, dnsPreflight, validateScrollCoord, validateWaitMs, MAX_TEXT_LENGTH, MAX_SCROLL_COORD, MAX_WAIT_MS } from '../../src/browser/browser-policy.js';
import type { DnsLookup } from '../../src/network-policy.js';

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

test('observe field policy allows only matching read fields', () => {
  for (const what of ['status','tabs','get_url','get_title','text','html','snapshot','screenshot']) {
    assert.equal(validateBrowserRequest({ what }).action, what);
  }
  assert.equal(validateBrowserRequest({ what: 'text', selector: '#main' }).selector, '#main');
  assert.equal(validateBrowserRequest({ what: 'snapshot', compact: true }).compact, true);
  assert.throws(() => validateBrowserRequest({ what: 'status', selector: '#main' }), /selector is not allowed/);
  assert.throws(() => validateBrowserRequest({ what: 'text', compact: true }), /compact is not allowed/);
});

test('request action union and no-op sensitive classification', () => {
  assert.equal(validateBrowserRequest({ action: 'snapshot' }).action, 'snapshot');
  assert.throws(() => validateBrowserRequest({ action: 'shell' }), /Unsupported/);
  assert.equal(isSensitiveAction('evaluate'), true);
  assert.equal(isSensitiveAction('set_cookies'), true);
  assert.equal(isSensitiveAction('text'), false);
});

test('request accepts semanticAction/job/batch only with their required payloads', () => {
  assert.throws(() => validateBrowserRequest({ action: 'semanticAction' }), /semanticAction is required/);
  assert.throws(() => validateBrowserRequest({ action: 'job' }), /job is required/);
  assert.throws(() => validateBrowserRequest({ action: 'batch' }), /batch is required/);
  assert.equal(validateBrowserRequest({ action: 'semanticAction', semanticAction: { locator: 'role', query: 'button', verb: 'click' } }).action, 'semanticAction');
  assert.equal(validateBrowserRequest({ action: 'job', job: { steps: [{ kind: 'snapshot' }] } }).action, 'job');
  assert.equal(validateBrowserRequest({ action: 'batch', batch: { commands: [{ args: ['snapshot'] }] } }).action, 'batch');
});

test('browser request envelope rejects unknown, cross-action, and wrong-type fields', () => {
  assert.throws(() => validateBrowserRequest({ action: 'click', selector: '#ok', bogus: true }), /unknown field/);
  assert.throws(() => validateBrowserRequest({ action: 'click', selector: '#ok', url: 'https:\/\/example.com' }), /not allowed.*click/);
  assert.throws(() => validateBrowserRequest({ action: 'click', selector: 42 }), /selector must be a string/);
  assert.throws(() => validateBrowserRequest({ action: 'cookies', urls: ['https:\/\/example.com', 42] }), /urls must be an array of strings/);
  assert.throws(() => validateBrowserRequest({ action: 'snapshot', compact: 'yes' }), /compact must be a boolean/);
});

test('credentialed navigation errors never echo URL userinfo', () => {
  const secret = 'SUPER_SECRET_PASSWORD_123';
  assert.throws(
    () => validateNavigationUrl(`https:\/\/alice:${secret}@example.com/path`),
    (error: unknown) => error instanceof Error && /credentials are not allowed/.test(error.message) && !error.message.includes(secret) && !error.message.includes('alice'),
  );
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

test('validateBatchRequest rejects malformed maxCommands instead of silently admitting it', () => {
  const commands = [{ args: ['click', '#btn'] }];
  for (const maxCommands of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => validateBatchRequest({ commands, maxCommands }),
      /maxCommands must be a positive integer/,
      String(maxCommands),
    );
  }
  assert.throws(
    () => validateBatchRequest({ commands, maxCommands: '2' as unknown as number }),
    /maxCommands must be a positive integer/,
  );
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

test('validateBatchRequest stores normalized subcommand in argv', () => {
  const input = { commands: [{ args: ['Open', 'https://example.com/'] }] };
  const r = validateBatchRequest(input);
  assert.equal(r.commands[0]!.args[0], 'open');
  assert.equal(r.commands[0]!.subcommand, 'open');
  assert.equal(input.commands[0]!.args[0], 'Open'); // caller argv not mutated
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

test('validateBatchRequest allows @ in path and query without credentials', () => {
  const r = validateBatchRequest({ commands: [{ args: ['open', 'https://example.com/@user?x=a@b'] }] });
  assert.equal(r.commands.length, 1);
  const tabbed = validateBatchRequest({ commands: [{ args: ['tab', 'new', 'https://example.com/@user'] }] });
  assert.equal(tabbed.commands.length, 1);
});

test('validateBatchRequest rejects credentialed loopback URL in open command', () => {
  assert.throws(
    () => validateBatchRequest({ commands: [{ args: ['open', 'http://user:pass@localhost:3000/'] }] }),
    /credentials/,
  );
});

test('validateBatchRequest rejects loopback URL via tab new (preflight parity)', () => {
  assert.throws(
    () => validateBatchRequest({ commands: [{ args: ['tab', 'new', 'http://127.0.0.1:3000/'] }] }),
    /loopback URL/,
  );
  assert.throws(
    () => validateBatchRequest({ commands: [{ args: ['TAB', 'NEW', 'http://localhost:8080/'] }] }),
    /loopback URL/,
  );
});

test('validateBatchRequest rejects credentialed URL via tab new', () => {
  assert.throws(
    () => validateBatchRequest({ commands: [{ args: ['tab', 'new', 'http://user:pass@localhost:3000/'] }] }),
    /credentials/,
  );
});

test('validateBatchRequest passes tab new with a public URL and tab list', () => {
  const r = validateBatchRequest({ commands: [{ args: ['tab', 'new', 'https://example.com/'] }] });
  assert.equal(r.commands.length, 1);
  const listed = validateBatchRequest({ commands: [{ args: ['tab', 'list'] }] });
  assert.equal(listed.commands.length, 1);
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

// ── Batch subcommand allowlist + per-command arity ──

test('validateBatchRequest rejects unknown subcommands with a stable error', () => {
  for (const args of [
    ['shell', 'id'],
    ['screenshot', 'out.png'],
    ['session', 'shutdown', '--force'],
    ['network', 'requests'],
    ['connect', 'http://example.com'],
  ]) {
    assert.throws(() => validateBatchRequest({ commands: [{ args }] }), /unsupported batch subcommand/);
  }
});

test('validateBatchRequest rejects non-string args instead of filtering them', () => {
  assert.throws(
    () => validateBatchRequest({ commands: [{ args: ['click', 42] as unknown as string[] }] }),
    /array of strings/,
  );
});

test('validateBatchRequest rejects per-command arity violations', () => {
  assert.throws(() => validateBatchRequest({ commands: [{ args: ['click'] }] }), /click requires exactly 2/);
  assert.throws(() => validateBatchRequest({ commands: [{ args: ['type', '#a'] }] }), /type requires exactly 3/);
  assert.throws(() => validateBatchRequest({ commands: [{ args: ['open', 'https://a.com', 'https://b.com'] }] }), /open requires exactly 2/);
  assert.throws(() => validateBatchRequest({ commands: [{ args: ['eval', ''] }] }), /expression/);
  assert.throws(() => validateBatchRequest({ commands: [{ args: ['scroll', 'diagonal'] }] }), /scroll direction/);
  assert.throws(() => validateBatchRequest({ commands: [{ args: ['wait', '--text'] }] }), /wait --text requires/);
  assert.throws(() => validateBatchRequest({ commands: [{ args: ['find', 'role', 'x', 'explode'] }] }), /find verb/);
  assert.throws(() => validateBatchRequest({ commands: [{ args: ['cookies', 'drop'] }] }), /cookies operation/);
  assert.throws(() => validateBatchRequest({ commands: [{ args: ['cookies', 'set', 'name'] }] }), /cookies set requires a name and value/);
  assert.throws(
    () => validateBatchRequest({ commands: [{ args: ['select', '#c', ...Array.from({ length: 33 }, (_, i) => `v${i}`)] }] }),
    /select requires/,
  );
});

test('validateBatchRequest accepts every allowlisted subcommand with valid argv', () => {
  const r = validateBatchRequest({
    commands: [
      { args: ['open', 'https://example.com'] },
      { args: ['navigate', 'https://example.com'] },
      { args: ['eval', 'document.title'] },
      { args: ['read'] },
      { args: ['get', 'url'] },
      { args: ['get', 'text', '#main'] },
      { args: ['click', '#btn'] },
      { args: ['type', '#input', 'hello'] },
      { args: ['fill', '#input', 'hello'] },
      { args: ['scroll', 'down', '500'] },
      { args: ['tab', 'list', '--json'] },
      { args: ['cookies', 'get', '--json'] },
      { args: ['snapshot', '-i', '--json'] },
      { args: ['select', '#country', 'US'] },
      { args: ['wait', '500'] },
      { args: ['wait', '--text', 'loaded'] },
      { args: ['find', 'role', 'button', 'click'] },
      { args: ['find', 'nth', '2', 'button', 'click'] },
    ],
  });
  assert.equal(r.commands.length, 18);
  assert.equal(r.commands[0]!.subcommand, 'open');
  assert.equal(r.commands[16]!.subcommand, 'find');
});

test('validateBatchRequest rejects maxCommands above the hard cap instead of clamping it', () => {
  const commands = Array.from({ length: 20 }, () => ({ args: ['click', '#btn'] }));
  assert.throws(
    () => validateBatchRequest({ commands, maxCommands: 21 }),
    /maxCommands must be an integer 1\.\.20/,
  );
  const r = validateBatchRequest({ commands, maxCommands: 20 });
  assert.equal(r.commands.length, 20);
});
