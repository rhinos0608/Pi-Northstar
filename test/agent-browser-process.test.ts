import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSandboxEnvironment, generateNamespace, parseAgentBrowserOutput } from '../src/agent-browser-process.js';

test('sandbox environment strips hostile inherited variables', () => {
  const env = buildSandboxEnvironment({ PATH: '/bin', HOME: '/tmp', AGENT_BROWSER_SESSION: 'evil', NODE_OPTIONS: '--import evil', GITHUB_TOKEN: 'secret' }, { runtimeRoot: '/tmp/pi', namespace: 'owned' });
  assert.equal(env.AGENT_BROWSER_SESSION, 'owned');
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.AGENT_BROWSER_CONFIG, '/tmp/pi/config/config.json');
});

test('output parser accepts JSON envelopes and ignores diagnostics', () => {
  assert.deepEqual(parseAgentBrowserOutput('diagnostic\n{"success":true,"data":{"ok":1}}\n'), [{ success: true, data: { ok: 1 } }]);
  assert.deepEqual(parseAgentBrowserOutput('[{"success":false,"error":"bad"}]'), [{ success: false, error: 'bad' }]);
});

test('namespace is unique-shaped', () => assert.match(generateNamespace(), /^pi-/));

test('sandbox environment includes proxy vars when loopback active', () => {
  const env = buildSandboxEnvironment(
    { PATH: '/bin' },
    { runtimeRoot: '/tmp/pi', namespace: 'ns1' },
    { AGENT_BROWSER_PROXY: 'http://127.0.0.1:9999', AGENT_BROWSER_PROXY_BYPASS: '<-loopback>' },
  );
  assert.equal(env.AGENT_BROWSER_PROXY, 'http://127.0.0.1:9999');
  assert.equal(env.AGENT_BROWSER_PROXY_BYPASS, '<-loopback>');
});

test('sandbox environment does not include proxy vars in normal mode', () => {
  const env = buildSandboxEnvironment(
    { PATH: '/bin' },
    { runtimeRoot: '/tmp/pi', namespace: 'ns1' },
  );
  assert.equal(env.AGENT_BROWSER_PROXY, undefined);
  assert.equal(env.AGENT_BROWSER_PROXY_BYPASS, undefined);
});

test('hostile parent proxy vars are overridden by adapter-controlled values', () => {
  const env = buildSandboxEnvironment(
    { PATH: '/bin', AGENT_BROWSER_PROXY: 'http://evil.com:8080', HTTP_PROXY: 'http://evil.com:8080' },
    { runtimeRoot: '/tmp/pi', namespace: 'ns1' },
    { AGENT_BROWSER_PROXY: 'http://127.0.0.1:9999', AGENT_BROWSER_PROXY_BYPASS: '<-loopback>' },
  );
  assert.equal(env.AGENT_BROWSER_PROXY, 'http://127.0.0.1:9999');
  assert.equal(env.AGENT_BROWSER_PROXY_BYPASS, '<-loopback>');
});
