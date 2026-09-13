import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browser, browserToolConfigured } from '../../src/browser/browser-tools.js';

test('browserToolConfigured respects opt-out', () => {
  assert.equal(browserToolConfigured({ PI_SEARCH_BROWSER_AUTOMATION: '0' }), false);
  assert.equal(browserToolConfigured({ PI_SEARCH_BROWSER_AUTOMATION: '0', BROWSER_EXECUTABLE_PATH: '/nonexistent' }), false);
});

// ── browser action dispatch tests (agent-browser backend) ──

test('browser action dispatch: status (agent-browser)', async () => {
  const result = await browser({ action: 'status' }, { env: {} });
  const details = result.details as Record<string, unknown>;
  assert.equal(details.backend, 'agent-browser');
  assert.ok(typeof details.version === 'string');
  assert.ok(typeof details.executable === 'string');
});

// ── browser opt-out and validation tests ──

test('browser respects PI_SEARCH_BROWSER_AUTOMATION=0 opt-out', async () => {
  const result = await browser({}, { env: { PI_SEARCH_BROWSER_AUTOMATION: '0' } });
  assert.match(JSON.stringify(result.details), /disabled/);
});

test('browser navigate rejects credentialed URL (user:pass@host)', async () => {
  const result = await browser(
    { action: 'navigate', url: 'http://user:pass@localhost:3000/' },
    { env: {} },
  );
  const text = JSON.stringify(result.content);
  assert.match(text, /credentials/);
});
