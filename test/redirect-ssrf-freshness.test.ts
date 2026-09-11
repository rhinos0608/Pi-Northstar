import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchText } from '../src/http.js';
import { ObservationStore, COORDINATE_MUTATION_FRESHNESS_MS } from '../src/desktop-contract.js';
import { DesktopService } from '../src/desktop-tools.js';

const publicLookup = async (_h: string) => [{ address: '93.184.216.34', family: 4 as const }];
const evilLookup = async (h: string) => h === 'redirect-dns.attacker.example'
  ? [{ address: '192.168.1.10', family: 4 as const }]
  : [{ address: '93.184.216.34', family: 4 as const }];

function redirectFetch(from: string, to: string, body = 'ok') {
  return async (input: string | URL | Request) => {
    const url = String(input);
    if (url === from) return new Response('', { status: 302, headers: { location: to } });
    return new Response(body, { status: 200 });
  };
}

test('redirect hostname resolving private IP rejected before second request', async () => {
  const saved = globalThis.fetch;
  let hits = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    hits++;
    const url = String(input);
    if (url === 'https://attacker.example/start') {
      return new Response('', { status: 302, headers: { location: 'https://redirect-dns.attacker.example/foo' } });
    }
    return new Response('never', { status: 200 });
  }) as typeof fetch;
  try {
    await assert.rejects(fetchText('https://attacker.example/start', {}, undefined, undefined, evilLookup as never), /private\/reserved/);
    assert.equal(hits, 1);
  } finally { globalThis.fetch = saved; }
});

test('redirect to public hostname still follows', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = redirectFetch('https://attacker.example/start', 'https://cdn.example.com/asset', 'hello') as typeof fetch;
  try {
    assert.equal(await fetchText('https://attacker.example/start', {}, undefined, undefined, publicLookup as never), 'hello');
  } finally { globalThis.fetch = saved; }
});

test('coordinate mutation rejects observation older than freshness window', () => {
  const s = new ObservationStore();
  const o = s.issue(1, 'w', { ax: 'v1' });
  const realNow = Date.now;
  Date.now = () => realNow() + 20_000; // 20s later: outside 15s coordinate window, inside 30s default
  try {
    assert.throws(() => s.get(o.stateId, 1, 'w', COORDINATE_MUTATION_FRESHNESS_MS), /STALE_OBSERVATION/);
    assert.equal(s.get(o.stateId, 1, 'w').stateId, o.stateId); // non-coordinate read still valid
  } finally { Date.now = realNow; }
});

test('pre-mutation fingerprint mismatch evicts stale state', async () => {
  let state = { ax: 'v1' };
  const fake = {
    calls: [] as string[],
    async callTool(name: string) { this.calls.push(name); return { echo: state.ax }; },
    async close() {},
  };
  const svc = new DesktopService(fake as never, { PI_SEARCH_DESKTOP_AUTOMATION: '1' });
  const obs = await svc.execute({ action: 'observe_window', pid: 1, windowId: 'w' });
  state = { ax: 'v2-user-moved-window' }; // external change after observe
  await assert.rejects(svc.execute({ action: 'click', pid: 1, windowId: 'w', stateId: obs.stateId as string, x: 10, y: 20 }), /STALE_OBSERVATION/);
  assert.ok(fake.calls[0] === 'get_window_state' && fake.calls[1] === 'get_window_state');
});
