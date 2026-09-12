import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestRaw = readFileSync(join(root, 'chrome-extension', 'manifest.json'), 'utf8');
const swSrc = readFileSync(join(root, 'chrome-extension', 'service_worker.js'), 'utf8');
const snapshotSrc = readFileSync(join(root, 'chrome-extension', 'snapshot_injected.js'), 'utf8');
const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;

function loadCompanion(chromeMock: Record<string, unknown>) {
  const sandbox: Record<string, unknown> = {
    console,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    JSON,
    Number,
    String,
    Array,
    Object,
    Promise,
    chrome: chromeMock,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(swSrc, sandbox, { filename: 'service_worker.js' });
  const companion = sandbox.__atlasCompanion as Record<string, (...args: never[]) => unknown> & {
    _state: { grant: unknown; owned: unknown };
    _reset: () => void;
  };
  assert.ok(companion, 'service_worker exposes __atlasCompanion');
  return companion;
}

function fakeChrome() {
  const calls: string[] = [];
  const tabsStore = new Map<number, Record<string, unknown>>([[11, { id: 11, url: 'https://example.com/', title: 'Example' }]]);
  return {
    calls,
    tabs: {
      create: async (opts: Record<string, unknown>) => {
        calls.push(`tabs.create active=${String(opts.active)}`);
        assert.equal(opts.active, false, 'owned tab must be inactive');
        const tab = { id: 77, url: 'about:blank', title: '' };
        tabsStore.set(77, tab);
        return tab;
      },
      get: async (id: number) => {
        const t = tabsStore.get(id);
        if (!t) throw new Error('no such tab');
        return t;
      },
      update: async (id: number, opts: Record<string, unknown>) => {
        calls.push(`tabs.update ${id} ${String(opts.url)}`);
        tabsStore.set(id, { ...(tabsStore.get(id) ?? { id }), ...opts });
        return tabsStore.get(id);
      },
      remove: async (id: number) => {
        calls.push(`tabs.remove ${id}`);
        tabsStore.delete(id);
      },
    },
    windows: {
      create: async () => {
        calls.push('windows.create');
        return { tabs: [{ id: 78 }] };
      },
    },
    storage: { session: { set: async () => {}, get: async () => ({}), remove: async () => {} } },
    declarativeNetRequest: {
      updateDynamicRules: async (opts: Record<string, unknown>) => {
        calls.push(`dnr ${JSON.stringify(opts).slice(0, 80)}`);
      },
    },
    scripting: {
      executeScript: async (opts: Record<string, unknown>) => {
        calls.push(`scripting ${JSON.stringify(opts).slice(0, 120)}`);
        const func = opts.func as ((...a: unknown[]) => unknown) | undefined;
        if (typeof func === 'function') return [{ result: '# Atlas snapshot\n@e1 button "Continue"' }];
        return [{}];
      },
    },
    debugger: {
      attach: (_t: unknown, _v: unknown, cb: () => void) => cb(),
      detach: (_t: unknown, cb: () => void) => cb(),
      sendCommand: (_t: unknown, method: string, _p: unknown, cb: (r: unknown) => void) => {
        calls.push(`cdp ${method}`);
        if (method === 'DOM.getDocument') cb({ root: { nodeId: 1 } });
        else if (method === 'DOM.querySelector') cb({ nodeId: 5 });
        else if (method === 'DOM.getBoxModel') cb({ model: { content: [0, 0, 20, 0, 20, 20, 0, 20] } });
        else if (method === 'Page.captureScreenshot') cb({ data: 'iVBORw0KGgoAAA' });
        else cb({});
      },
    },
    runtime: { lastError: undefined },
  };
}

test('manifest: MV3, Atlas bridge only, least-privilege permissions', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.background, { service_worker: 'service_worker.js' });
  const bg = manifest.background as Record<string, unknown>;
  assert.equal(bg.service_worker, 'service_worker.js');
  const perms = manifest.permissions as string[];
  for (const p of ['tabs', 'scripting', 'storage', 'debugger', 'declarativeNetRequest', 'alarms']) {
    assert.ok(perms.includes(p), `permission ${p}`);
  }
  for (const banned of ['cookies', 'history', 'identity', 'browsingData', 'proxy']) {
    assert.ok(!perms.includes(banned), `no ${banned} permission`);
  }
  const hosts = manifest.host_permissions as string[];
  assert.ok(hosts.includes('http://127.0.0.1:17319/*'), 'Atlas bridge host pinned');
  assert.equal(manifestRaw.includes('17318'), false, 'never pi-chrome port');
  assert.equal(manifestRaw.includes('<all_urls>'), false, 'no all-urls host permission');
});

test('service_worker: static prohibitions hold', () => {
  const code = swSrc.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  for (const banned of ['chrome.cookies', 'chrome.history', 'chrome.identity', 'Runtime.evaluate', 'captureVisibleTab', 'windows.remove']) {
    assert.equal(code.includes(banned), false, `absent: ${banned}`);
  }
  assert.equal(/[^_a-zA-Z]eval\s*\(/.test(code), false, 'absent: eval(');
  for (const required of ['tabs.create', 'active: false', 'focused: false', 'declarativeNetRequest', 'Page.captureScreenshot', 'chrome.storage.session', 'Input.dispatchMouseEvent', 'Input.insertText', 'DOM.querySelector', 'ISOLATED']) {
    assert.ok(swSrc.includes(required), `present: ${required}`);
  }
});

test('snapshot_injected: redacts form values, assigns @e refs, bounds output', () => {
  for (const api of ['chrome.tabs', 'chrome.debugger', 'chrome.cookies', 'chrome.storage', 'chrome.declarativeNetRequest']) {
    assert.equal(snapshotSrc.includes(api), false, `no ${api} in injected script`);
  }
  assert.equal(snapshotSrc.includes('eval('), false, 'no eval in injected script');
  const sandbox: Record<string, unknown> = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const elements = [
    { tagName: 'A', getAttribute: (k: string) => (k === 'role' ? null : null), hasAttribute: () => false, style: {}, innerText: 'Docs link', textContent: 'Docs link' },
    { tagName: 'INPUT', getAttribute: (k: string) => (k === 'type' ? 'password' : k === 'name' ? 'password' : null), hasAttribute: () => false, style: {}, innerText: '', textContent: '' },
    { tagName: 'INPUT', getAttribute: () => 'hidden', hasAttribute: () => false, style: {}, innerText: 'x', textContent: 'x' },
    { tagName: 'BUTTON', getAttribute: () => null, hasAttribute: () => false, style: {}, innerText: 'Continue', textContent: 'Continue' },
  ];
  sandbox.document = {
    title: 'Sign in',
    querySelectorAll: () => elements,
  };
  vm.runInContext(snapshotSrc + '\nglobalThis.__atlasSnapshotResult = globalThis.__atlasSnapshot(true);', sandbox);
  const out = String(sandbox.__atlasSnapshotResult);
  assert.match(out, /@e1/);
  assert.match(out, /\[redacted\]/, 'form value redacted');
  assert.equal(out.includes('S3cr3tP@ssw0rd'), false);
  assert.ok(out.length <= 30000);
});

test('fixture page carries secrets the injected script must redact', () => {
  const html = readFileSync(join(root, 'test', 'fixtures', 'chrome-profile-extension-page.html'), 'utf8');
  assert.ok(html.includes('S3cr3tP@ssw0rd!'), 'fixture has typed-secret sentinel');
  assert.ok(html.includes('csrf-token-abc123'));
  assert.ok(html.includes('<input'), 'fixture has form fields');
  // Run the real collector against fixture-modeled DOM: secrets redacted at source.
  const sandbox: Record<string, unknown> = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const attrsOf = (attrs: Record<string, string>) => ({
    getAttribute: (k: string) => attrs[k] ?? null,
    hasAttribute: (k: string) => k === 'hidden' && attrs.hidden === 'true',
    style: {},
  });
  const elements = [
    { tagName: 'A', ...attrsOf({}), innerText: 'Docs', textContent: 'Docs' },
    { tagName: 'BUTTON', ...attrsOf({ 'aria-label': 'Continue' }), innerText: 'Continue', textContent: 'Continue' },
    { tagName: 'INPUT', ...attrsOf({ type: 'text', name: 'username' }), innerText: '', textContent: '' },
    { tagName: 'INPUT', ...attrsOf({ type: 'password', name: 'password' }), innerText: '', textContent: '' },
    { tagName: 'INPUT', ...attrsOf({ type: 'hidden', name: 'csrf' }), innerText: '', textContent: '' },
    { tagName: 'TEXTAREA', ...attrsOf({ name: 'notes' }), innerText: 'typed secret notes', textContent: 'typed secret notes' },
    { tagName: 'SELECT', ...attrsOf({ name: 'role' }), innerText: 'Admin', textContent: 'Admin' },
    { tagName: 'IMG', ...attrsOf({ alt: 'Example logo' }), innerText: '', textContent: '' },
  ];
  sandbox.document = { title: 'Atlas Companion Fixture', querySelectorAll: () => elements };
  vm.runInContext(snapshotSrc + '\nglobalThis.__atlasFixtureResult = globalThis.__atlasSnapshot(true);', sandbox);
  const out = String(sandbox.__atlasFixtureResult);
  assert.equal(out.includes('S3cr3tP@ssw0rd!'), false, 'typed password value never echoed');
  assert.equal(out.includes('csrf-token-abc123'), false, 'csrf value never echoed');
  assert.ok(out.includes('[redacted]'), 'form values redacted at source');
  assert.equal((out.match(/value=\[redacted\]/g) ?? []).length, 4, 'username/password/textarea/select redacted, hidden input skipped');
  assert.ok(out.includes('notes'), 'textarea label present');
  assert.ok(out.includes('role'), 'select label present');
});

test('companion: pre-auth execute rejected, zero chrome calls', async () => {
  const chrome = fakeChrome();
  const c = loadCompanion(chrome as unknown as Record<string, unknown>);
  const check = c.checkExecute as unknown as (cmd: unknown) => { code: string } | null;
  const gated = check({ protocol: 1, id: 'a', sessionKey: 's', grantId: 'g', kind: 'execute', operation: { kind: 'text' } });
  assert.equal(gated?.code, 'chrome_locked');
  assert.equal(chrome.calls.length, 0, 'no tab/debugger calls before auth');
});

test('companion: wrong/expired grant rejected', async () => {
  const chrome = fakeChrome();
  const c = loadCompanion(chrome as unknown as Record<string, unknown>);
  const onAuth = c.onAuthorize as unknown as (cmd: unknown) => unknown;
  onAuth({ protocol: 1, id: '1', sessionKey: 's1', grantId: 'g1', kind: 'authorize', leaseExpiresAt: Date.now() + 60_000 });
  const check = c.checkExecute as unknown as (cmd: unknown, at?: number) => { code: string } | null;
  assert.equal(check({ protocol: 1, id: '2', sessionKey: 'WRONG', grantId: 'g1', kind: 'execute', operation: { kind: 'text' } })?.code, 'chrome_revoked');
  assert.equal(check({ protocol: 1, id: '3', sessionKey: 's1', grantId: 'g1', kind: 'execute', operation: { kind: 'text' } }, Date.now() + 3600_000)?.code, 'chrome_revoked');
});

test('companion: unknown protocol/operation fails closed', () => {
  const chrome = fakeChrome();
  const c = loadCompanion(chrome as unknown as Record<string, unknown>);
  const parse = c.parseCommand as unknown as (v: unknown) => unknown;
  assert.throws(() => parse({ protocol: 2, id: 'x', sessionKey: 's', grantId: 'g', kind: 'execute', operation: { kind: 'text' } }), /version_mismatch/);
  assert.throws(() => parse({ protocol: 1, id: 'x', sessionKey: 's', grantId: 'g', targetInstanceId: 'i-1', bridgeToken: 't', kind: 'execute', operation: { kind: 'evaluate', expression: '1' } }), /unknown operation kind/);
  assert.throws(() => parse({ protocol: 1, id: 'x', sessionKey: 's', grantId: 'g', kind: 'execute', operation: { kind: 'text' } }), /targetInstanceId\/bridgeToken required/);
});

test('companion: DNR rules deny-by-default with exact-host allow, tab-scoped', () => {
  const chrome = fakeChrome();
  const c = loadCompanion(chrome as unknown as Record<string, unknown>);
  const build = c.buildDnrRules as unknown as (h: string, t: number) => Array<{ id: number; priority: number; action: { type: string }; condition: Record<string, unknown> }>;
  const rules = build('example.com', 77);
  assert.equal(rules.length, 2);
  const deny = rules[0]!;
  const allow = rules[1]!;
  assert.equal(deny.action.type, 'block');
  assert.equal(allow.action.type, 'allow');
  assert.ok(allow.priority > deny.priority, 'allow outranks deny');
  assert.equal(JSON.stringify(deny.condition.tabIds), '[77]');
  assert.equal(JSON.stringify(allow.condition.tabIds), '[77]');
  const re = new RegExp(String(allow.condition.regexFilter));
  assert.ok(re.test('https://example.com/page'), 'exact host allowed');
  assert.equal(re.test('https://evil-example.com/'), false, 'lookalike host blocked');
  assert.equal(re.test('https://example.com.evil.com/'), false, 'suffix host blocked');
  assert.equal(re.test('https://sub.example.com/'), false, 'subdomain not covered by exact freeze');
});

test('companion: navigate installs DNR before tab update; close removes only owned tab', async () => {
  const chrome = fakeChrome();
  const c = loadCompanion(chrome as unknown as Record<string, unknown>);
  (c.onAuthorize as unknown as (cmd: unknown) => unknown)({ protocol: 1, id: '1', sessionKey: 's1', grantId: 'g1', kind: 'authorize', leaseExpiresAt: Date.now() + 60_000 });
  const dispatch = c.dispatchOperation as unknown as (ch: unknown, cmd: unknown) => Promise<unknown>;
  await dispatch(chrome, { protocol: 1, id: 'n', sessionKey: 's1', grantId: 'g1', kind: 'execute', operation: { kind: 'navigate', url: 'https://example.com/', frozenHostname: 'example.com' } });
  const dnrIdx = chrome.calls.findIndex((s) => s.startsWith('dnr'));
  const navIdx = chrome.calls.findIndex((s) => s.startsWith('tabs.update'));
  assert.ok(dnrIdx !== -1 && navIdx !== -1 && dnrIdx < navIdx, 'DNR installed before navigation');
  assert.ok(chrome.calls.some((s) => s.startsWith('tabs.create active=false')));
  // close path: only owned tab id removed, never windows.remove
  await dispatch(chrome, { protocol: 1, id: 'c', sessionKey: 's1', grantId: 'g1', kind: 'execute', operation: { kind: 'close' } });
  assert.ok(chrome.calls.includes('tabs.remove 77'), 'owned tab removed');
  assert.equal(chrome.calls.some((s) => s.includes('windows.remove')), false);
  assert.equal(chrome.calls.some((s) => s.includes('tabs.remove 11')), false, 'never unknown tab');
});

test('companion: revoke purges locally and detaches; sentinel secrets never echoed', async () => {
  const chrome = fakeChrome();
  const c = loadCompanion(chrome as unknown as Record<string, unknown>);
  (c.onAuthorize as unknown as (cmd: unknown) => unknown)({ protocol: 1, id: '1', sessionKey: 'sess-SECRET-1', grantId: 'grant-SECRET-2', kind: 'authorize', leaseExpiresAt: Date.now() + 60_000 });
  const dispatch = c.dispatchOperation as unknown as (ch: unknown, cmd: unknown) => Promise<unknown>;
  await dispatch(chrome, { protocol: 1, id: 'n', sessionKey: 'sess-SECRET-1', grantId: 'grant-SECRET-2', kind: 'execute', operation: { kind: 'navigate', url: 'https://example.com/', frozenHostname: 'example.com' } });
  const snap = (await dispatch(chrome, { protocol: 1, id: 's', sessionKey: 'sess-SECRET-1', grantId: 'grant-SECRET-2', kind: 'execute', operation: { kind: 'snapshot', compact: true } })) as Record<string, string>;
  assert.equal(String(snap.snapshot ?? '').includes('sess-SECRET-1'), false);
  await (c.revokeLocal as unknown as (ch: unknown) => Promise<void>)(chrome);
  const check = c.checkExecute as unknown as (cmd: unknown) => { code: string } | null;
  assert.equal(check({ protocol: 1, id: 'z', sessionKey: 'sess-SECRET-1', grantId: 'grant-SECRET-2', kind: 'execute', operation: { kind: 'text' } })?.code, 'chrome_locked');
  const redact = c.redactSecrets as unknown as (t: string, s: unknown) => string;
  const cleaned = redact('cookie: abc123 Bearer tok sess-SECRET-1', { sessionKey: 'sess-SECRET-1', grantId: 'grant-SECRET-2' });
  assert.equal(cleaned.includes('sess-SECRET-1'), false);
  assert.equal(cleaned.includes('abc123'), false);
});

function sessionChrome() {
  const base = fakeChrome() as unknown as Record<string, Record<string, unknown>> & { calls: string[] };
  const store = new Map<string, unknown>();
  const session = {
    set: async (v: Record<string, unknown>) => { for (const [k, val] of Object.entries(v)) store.set(k, val); },
    get: async (k: string) => ({ [k]: store.get(k) }),
    remove: async (k: string) => { store.delete(k); },
  };
  (base as unknown as Record<string, unknown>).storage = { session };
  return { chrome: base, store };
}

test('companion: ephemeral instance registration in storage.session with heartbeat + family evidence', async () => {
  const { chrome, store } = sessionChrome();
  const c = loadCompanion(chrome as unknown as Record<string, unknown>);
  const ensure = c.ensureInstance as unknown as (ch: unknown, at?: number) => Promise<Record<string, unknown>>;
  const first = await ensure(chrome, 1000);
  assert.ok(typeof first.instanceId === 'string' && String(first.instanceId).length > 0, 'random ephemeral instanceId');
  assert.equal(first.lastSeen, 1000);
  assert.ok(typeof first.family === 'string' && typeof first.evidence === 'string', 'family evidence present');
  const persisted = store.get(c.INSTANCE_KEY as unknown as string) as Record<string, unknown>;
  assert.equal(persisted.instanceId, first.instanceId, 'persisted under INSTANCE_KEY');
  const heartbeat = c.heartbeatInstance as unknown as (ch: unknown, at?: number) => Promise<Record<string, unknown>>;
  const second = await heartbeat(chrome, 2000);
  assert.equal(second.instanceId, first.instanceId, 'heartbeat preserves instanceId');
  assert.equal(second.lastSeen, 2000, 'heartbeat refreshes lastSeen');
  assert.equal(swSrc.includes('chrome.storage.local'), false, 'instance state never in local storage');
});

test('companion: family detection claims Chromium only, never Firefox/Safari', () => {
  const chrome = fakeChrome();
  const c = loadCompanion(chrome as unknown as Record<string, unknown>);
  const detect = c.detectFamily as unknown as (u: unknown) => Record<string, string>;
  const chrom = detect({ brands: [{ brand: 'Chromium', version: '126' }, { brand: 'Google Chrome', version: '126' }] });
  assert.notEqual(chrom.family, 'unknown');
  assert.ok(String(chrom.evidence).length > 0);
  const edge = detect({ brands: [{ brand: 'Chromium', version: '126' }, { brand: 'Microsoft Edge', version: '126' }] });
  assert.ok(String(edge.family).includes('edge'));
  const fox = detect({ brands: [{ brand: 'Firefox', version: '126' }] });
  assert.equal(fox.family, 'unknown', 'no unsupported family claim');
  const none = detect(null);
  assert.equal(none.family, 'unknown');
});

test('companion: poll loop starts, heartbeats, and idles without busy-loop', async () => {
  assert.ok(swSrc.includes('runtime.onStartup'), 'startup hook registers poll loop');
  assert.ok(swSrc.includes('startPolling'), 'startPolling present');
  const { chrome } = sessionChrome();
  const c = loadCompanion(chrome as unknown as Record<string, unknown>);
  let fetches = 0;
  const fetchImpl = async () => { fetches += 1; return { ok: true, json: async () => ({ none: true }) }; };
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 30);
  await (c.pollLoop as unknown as (d: unknown) => Promise<void>)({ chrome, fetchImpl, idleMs: 5, signal: ctl.signal }).catch(() => {});
  assert.ok(fetches >= 1, 'poll loop issued bridge fetch');
  const instKey = c.INSTANCE_KEY as unknown as string;
  const inst = (await (chrome as unknown as { storage: { session: { get: (k: string) => Promise<Record<string, unknown>> } } }).storage.session.get(instKey))[instKey] as Record<string, unknown>;
  assert.ok(inst && typeof inst.lastSeen === 'number', 'poll loop heartbeats instance');
});
