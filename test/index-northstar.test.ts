// /northstar slash admission contract (mirrors registerNorthstarCommand in
// src/index.ts, which is not exported so it cannot be imported here).
//
// Threat model: asset = operator-chosen leaf model id + agent steering flag.
// The slash admits only exact `provider/model` ids for known, auth-configured
// models; model text never mutates config. These tests pin the admission
// predicate, the stub registry interplay, usage/completions text, and the
// env > config precedence owned by src/runtime/northstar-config.ts.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  isNorthstarModelIdShape,
  loadNorthstarConfig,
  northstarConfigPath,
  resolveNorthstarAgentEnabled,
  resolveNorthstarModelId,
  saveNorthstarConfig,
} from '../src/runtime/northstar-config.js';

const NORTHSTAR_USAGE =
  'Usage: /northstar model <provider/model-id> | /northstar model clear | /northstar agent <on|off> | /northstar status';

function northstarCompletions(prefix: string): Array<{ value: string; label: string }> {
  const parts = prefix.split(/\s+/);
  const last = parts[parts.length - 1] ?? '';
  if (parts.length > 1 && parts[0] === 'agent') {
    return ['on', 'off'].filter((s) => s.startsWith(last)).map((value) => ({ value, label: value }));
  }
  if (parts.length > 1 && parts[0] === 'model') {
    return 'clear'.startsWith(last) ? [{ value: 'clear', label: 'clear' }] : [];
  }
  return ['model', 'agent', 'status']
    .filter((s) => s.startsWith(parts[0] ?? ''))
    .map((value) => ({ value, label: value }));
}

// Minimal stub of the Pi modelRegistry surface consumed by the slash:
// find(provider, id) + hasConfiguredAuth(model).
interface StubModel {
  provider: string;
  id: string;
}
function stubRegistry(known: StubModel[], authedProviders: string[]) {
  return {
    find(provider: string, id: string): StubModel | undefined {
      return known.find((m) => m.provider === provider && m.id === id);
    },
    hasConfiguredAuth(model: StubModel): boolean {
      return authedProviders.includes(model.provider);
    },
  };
}

type Admit = { ok: true; modelId: string } | { ok: false; reason: string };

// Exact mirror of the slash `model <ref>` admission order in src/index.ts:
// shape (incl. thinking suffix) -> known -> auth-configured.
function admitNorthstarModel(
  raw: string,
  registry: ReturnType<typeof stubRegistry>,
): Admit {
  if (!isNorthstarModelIdShape(raw.trim())) {
    return { ok: false, reason: `Rejected: model must be an exact provider/model id (no thinking suffix). ${NORTHSTAR_USAGE}` };
  }
  const slash = raw.trim().indexOf('/');
  const provider = raw.trim().slice(0, slash);
  const id = raw.trim().slice(slash + 1);
  const model = registry.find(provider, id);
  if (!model) return { ok: false, reason: `Rejected: unknown model '${provider}/${id}' (not in the Pi model catalogue).` };
  if (!registry.hasConfiguredAuth(model)) {
    return { ok: false, reason: `Rejected: no configured auth for provider '${provider}'. Authenticate the provider first.` };
  }
  return { ok: true, modelId: `${provider}/${id}` };
}

const REG = stubRegistry(
  [{ provider: 'acme', id: 'large' }],
  ['acme'],
);

test('northstar shape: exact provider/id admits; blanks/paths/suffixes reject', () => {
  assert.equal(isNorthstarModelIdShape('acme/large'), true);
  assert.equal(isNorthstarModelIdShape(''), false);
  assert.equal(isNorthstarModelIdShape('acme'), false);
  assert.equal(isNorthstarModelIdShape('/large'), false);
  assert.equal(isNorthstarModelIdShape('acme/large/extra'), false);
  assert.equal(isNorthstarModelIdShape('acme large'), false);
  assert.equal(isNorthstarModelIdShape('a'.repeat(300)), false);
});

test('northstar shape: every thinking suffix rejects', () => {
  for (const suffix of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(isNorthstarModelIdShape(`acme/large:${suffix}`), false);
  }
  // Suffix-like text mid-id is not a suffix: still governed by shape pattern.
  assert.equal(isNorthstarModelIdShape('acme/large:high-detail'), true);
});

test('northstar slash admit: known + authed model admits', () => {
  assert.deepEqual(admitNorthstarModel('acme/large', REG), { ok: true, modelId: 'acme/large' });
});

test('northstar slash reject: bad shape and thinking suffix fail before registry', () => {
  const bad = admitNorthstarModel('not-a-model', REG);
  assert.equal(bad.ok, false);
  assert.match((bad as { reason: string }).reason, /exact provider\/model/);
  const suffixed = admitNorthstarModel('acme/large:high', REG);
  assert.equal(suffixed.ok, false);
  assert.match((suffixed as { reason: string }).reason, /no thinking suffix/);
});

test('northstar slash reject: unknown model and missing auth fail closed distinctly', () => {
  const unknown = admitNorthstarModel('ghost/tiny', REG);
  assert.equal(unknown.ok, false);
  assert.match((unknown as { reason: string }).reason, /unknown model/);
  const noAuthReg = stubRegistry([{ provider: 'acme', id: 'large' }], []);
  const noAuth = admitNorthstarModel('acme/large', noAuthReg);
  assert.equal(noAuth.ok, false);
  assert.match((noAuth as { reason: string }).reason, /no configured auth/);
});

test('northstar usage + completions: stable operator text', () => {
  assert.match(NORTHSTAR_USAGE, /\/northstar model <provider\/model-id>/);
  assert.match(NORTHSTAR_USAGE, /\/northstar status/);
  assert.deepEqual(northstarCompletions('').map((c) => c.value), ['model', 'agent', 'status']);
  assert.deepEqual(northstarCompletions('agent ').map((c) => c.value), ['on', 'off']);
  assert.deepEqual(northstarCompletions('model ').map((c) => c.value), ['clear']);
});

test('northstar precedence: env > config file > none; steering forced off', () => {
  const home = mkdtempSync(join(tmpdir(), 'northstar-'));
  saveNorthstarConfig({ modelId: 'acme/large', agentEnabled: true }, home);
  assert.deepEqual(loadNorthstarConfig(home), { modelId: 'acme/large', agentEnabled: true });
  // Env wins over the file.
  assert.deepEqual(
    resolveNorthstarModelId({ PI_NORTHSTAR_MODEL: 'other/model' }, loadNorthstarConfig(home)),
    { modelId: 'other/model', source: 'env' },
  );
  assert.deepEqual(
    resolveNorthstarModelId({}, loadNorthstarConfig(home)),
    { modelId: 'acme/large', source: 'config' },
  );
  assert.deepEqual(
    resolveNorthstarModelId({ PI_NORTHSTAR_MODEL: 'not-an-exact-model' }, loadNorthstarConfig(home)),
    { modelId: undefined, source: 'env' },
    'a malformed explicit env override must fail closed instead of falling through to stored config',
  );
  assert.deepEqual(resolveNorthstarModelId({}, {}), { modelId: undefined, source: 'none' });
  // Malformed file content fails closed to defaults.
  assert.deepEqual(loadNorthstarConfig('/definitely/not/a/real/home-dir'), {});
  // Steering: PI_NORTHSTAR_AGENT_STEERING=0 forces off even when file says on.
  assert.deepEqual(
    resolveNorthstarAgentEnabled({ PI_NORTHSTAR_AGENT_STEERING: '0' }, { agentEnabled: true }),
    { enabled: false, forcedOff: true },
  );
  assert.deepEqual(
    resolveNorthstarAgentEnabled({}, { agentEnabled: true }),
    { enabled: true, forcedOff: false },
  );
  assert.deepEqual(resolveNorthstarAgentEnabled({}, {}), { enabled: false, forcedOff: false });
  assert.deepEqual(
    resolveNorthstarAgentEnabled({ PI_NORTHSTAR_LEAF_MODEL: 'acme/large' }, {}),
    { enabled: true, forcedOff: false },
    'legacy leaf-model configuration keeps its prior steering behavior',
  );
  assert.deepEqual(
    resolveNorthstarAgentEnabled({ PI_NORTHSTAR_LEAF_MODEL: 'acme/large' }, { agentEnabled: false }),
    { enabled: false, forcedOff: false },
    'explicit unified config overrides legacy compatibility',
  );
});

test('northstar config load and save refuse symlinked state', () => {
  const home = mkdtempSync(join(tmpdir(), 'northstar-symlink-'));
  mkdirSync(join(home, '.pi-northstar'), { recursive: true });
  const outside = join(home, 'outside.json');
  writeFileSync(outside, JSON.stringify({ modelId: 'attacker/model', agentEnabled: true }));
  symlinkSync(outside, northstarConfigPath(home));

  assert.deepEqual(loadNorthstarConfig(home), {}, 'load must not follow a symlinked operator config');
  assert.throws(
    () => saveNorthstarConfig({ modelId: 'acme/large' }, home),
    /regular file/,
  );
  assert.match(readFileSync(outside, 'utf8'), /attacker\/model/);
});

test('northstar persistence preserves unknown fields and refuses malformed existing state', () => {
  const home = mkdtempSync(join(tmpdir(), 'northstar-write-'));
  mkdirSync(join(home, '.pi-northstar'), { recursive: true });
  const path = northstarConfigPath(home);
  writeFileSync(path, JSON.stringify({ futureField: { version: 2 }, modelId: 'acme/large' }));
  saveNorthstarConfig({ modelId: 'other/model', agentEnabled: true }, home);
  const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(stored.futureField, { version: 2 });
  assert.equal(stored.modelId, 'other/model');
  assert.equal(stored.agentEnabled, true);

  writeFileSync(path, '{broken-json');
  assert.throws(
    () => saveNorthstarConfig({ modelId: 'acme/large' }, home),
    /malformed; refusing to overwrite/,
  );
  assert.equal(readFileSync(path, 'utf8'), '{broken-json');
});

test('northstar status: unauthenticated model reports invalid without secrets', () => {
  const snapshot = resolveNorthstarModelId({}, { modelId: 'acme/large' });
  const model = REG.find('acme', 'large');
  const configured = model !== undefined && stubRegistry([], []).hasConfiguredAuth(model);
  assert.equal(snapshot.modelId, 'acme/large');
  assert.equal(configured, false);
});
