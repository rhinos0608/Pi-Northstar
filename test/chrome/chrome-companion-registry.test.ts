import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CompanionRegistry,
  COMPANION_REGISTRY_PORT,
  COMPANION_MAX_VERSION_CHARS,
  COMPANION_MAX_EVIDENCE_CHARS,
} from '../../src/chrome/chrome-companion-registry.js';
import { CHROME_BRIDGE_PORT } from '../../src/chrome/chrome-profile-contract.js';

function deps(start = 1_000_000) {
  let t = start;
  let n = 0;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
    randomId: () => `ephemeral-${(n += 1)}`,
  };
}

test('registry binds one bridge port; entries ephemeral with heartbeat', () => {
  const d = deps();
  const reg = new CompanionRegistry({ now: d.now, randomId: d.randomId });
  assert.equal(reg.port, CHROME_BRIDGE_PORT);
  assert.equal(COMPANION_REGISTRY_PORT, CHROME_BRIDGE_PORT);
  const a = reg.register({ family: 'chrome', version: '1.2.3', evidence: 'os:chrome' });
  assert.ok(a.instanceId.startsWith('ephemeral-'));
  assert.equal(reg.liveCount(), 1);
  d.advance(10_000);
  assert.equal(reg.heartbeat(a.instanceId), true);
  assert.equal(reg.heartbeat('nope'), false);
});

test('stale heartbeat pruned; bad claims rejected without profile fields', () => {
  const d = deps();
  const reg = new CompanionRegistry({ now: d.now, randomId: d.randomId, heartbeatTtlMs: 1_000 });
  const a = reg.register({ family: 'edge', version: 'v', evidence: 'e' });
  assert.ok(!('profile' in a));
  d.advance(1_001);
  assert.equal(reg.prune(), 1);
  assert.equal(reg.liveCount(), 0);
  assert.throws(() => reg.register({ family: 'safari' as never, version: 'v', evidence: 'e' }), /unknown family/);
  assert.throws(() => reg.register({ family: 'chrome', version: '  ', evidence: 'e' }), /version/);
});

test('claims truncate at bounds; prune TTL and remove/clear entries', () => {
  const d = deps();
  const reg = new CompanionRegistry({ now: d.now, randomId: d.randomId, heartbeatTtlMs: 1_000 });
  const entry = reg.register({ family: 'chrome', version: ` ${'v'.repeat(COMPANION_MAX_VERSION_CHARS + 10)} `, evidence: ` ${'e'.repeat(COMPANION_MAX_EVIDENCE_CHARS + 10)} ` });
  assert.equal(entry.version.length, COMPANION_MAX_VERSION_CHARS);
  assert.equal(entry.evidence.length, COMPANION_MAX_EVIDENCE_CHARS);
  d.advance(1_000);
  assert.equal(reg.prune(), 0);
  d.advance(1);
  assert.equal(reg.prune(), 1);
  const second = reg.register({ family: 'chrome', version: '2', evidence: 'e' });
  assert.equal(reg.remove(second.instanceId), true);
  assert.equal(reg.remove(second.instanceId), false);
  reg.register({ family: 'chrome', version: '3', evidence: 'e' });
  reg.clear();
  assert.equal(reg.liveCount(), 0);
});
