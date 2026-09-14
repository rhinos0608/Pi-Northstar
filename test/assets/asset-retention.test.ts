import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DERIVED_PERSISTENCE_MAX_TTL_MS,
  ORPHAN_TELEMETRY_DEFAULT_MAX,
  OrphanTelemetry,
  assertDerivedPersistenceTtl,
  deleteCloudUpload,
  deleteLocalAsset,
  isDerivedEntryExpired,
  isDerivedPersistenceEnabled,
  redactReason,
  redactRef,
  runWithAssetCleanup,
} from '../../src/assets/asset-retention.js';
import { WEB_ACCESS_STORE_TTL_MS } from '../../src/web/access/web-access-contract.js';

test('finally-deletion removes temp paths even when work throws', async () => {
  const deleted: string[] = [];
  const telemetry = new OrphanTelemetry();
  await assert.rejects(
    runWithAssetCleanup(async (scope) => {
      scope.add('/tmp/asset-1.bin', 'raw-asset');
      scope.add('/tmp/frame-1.png', 'keyframe');
      throw new Error('work failed');
    }, { unlink: (p) => { deleted.push(p); }, telemetry }),
    /work failed/,
  );
  assert.deepEqual(deleted.sort(), ['/tmp/asset-1.bin', '/tmp/frame-1.png']);
  assert.equal(telemetry.size, 0);
});

test('unlink failure records bounded redacted orphan, never throws cleanup', async () => {
  const telemetry = new OrphanTelemetry();
  const ok = await deleteLocalAsset('/tmp/sess-TOKEN-abc/cred-1.bin', 'temp-credential', {
    unlink: () => { throw new Error('EPERM'); },
    telemetry,
  });
  assert.equal(ok, false);
  const [record] = telemetry.list();
  assert.equal(record!.kind, 'temp-credential');
  // Only the opaque basename tail survives: no directories, no provider/model/secret keys.
  assert.equal(record!.ref, 'cred-1.bin');
  assert.ok(!record!.ref.includes('/'));
  assert.ok(!JSON.stringify(record).includes('provider'));
  assert.ok(!JSON.stringify(record).includes('TOKEN'));
});

test('cloud-upload deletion attempted; failure becomes orphan, no throw', async () => {
  const telemetry = new OrphanTelemetry();
  const attempted: string[] = [];
  const ok = await deleteCloudUpload('upload-9', {
    deleteRemote: (ref) => { attempted.push(ref); throw new Error('remote gone'); },
    telemetry,
  });
  assert.deepEqual(attempted, ['upload-9']);
  assert.equal(ok, false);
  assert.equal(telemetry.size, 1);
  assert.equal(telemetry.list()[0]!.kind, 'cloud-upload');
});

test('orphan telemetry LRU-bounded at 64 by default, operator-lowerable', () => {
  assert.equal(ORPHAN_TELEMETRY_DEFAULT_MAX, 64);
  const telemetry = new OrphanTelemetry();
  for (let i = 0; i < 70; i++) telemetry.record({ kind: 'render', ref: `r-${i}`, reason: 'x' }, i);
  assert.equal(telemetry.size, 64);
  assert.equal(telemetry.list()[0]!.ref, 'r-6');
  const small = new OrphanTelemetry(2);
  for (let i = 0; i < 5; i++) small.record({ kind: 'render', ref: `s-${i}`, reason: 'x' }, i);
  assert.equal(small.size, 2);
});

test('telemetry redaction keeps only opaque tail', () => {
  assert.equal(redactRef('/tmp/sess-xyz/frame-1.png'), 'frame-1.png');
  assert.ok(!redactRef('https://provider.example/key=abc').includes('provider.example'));
  assert.ok(redactRef(`/tmp/${'a'.repeat(100)}.bin`).length <= 64);
});

test('telemetry redaction strips query secrets and scrubs reasons', async () => {
  // Query/fragment secrets never survive the ref: safe tail passes through,
  // secret-bearing tails collapse to an opaque hash.
  assert.equal(redactRef('/tmp/x/frame-1.png?token=abc123'), 'frame-1.png');
  assert.equal(redactRef('/tmp/x/upload#secret=s3cr3t'), 'upload');
  const hashed = redactRef('https://h.example/dl/key=abc123');
  assert.match(hashed, /^ref-[0-9a-f]{8}$/);
  assert.ok(!hashed.includes('key=abc123'));
  const eqTail = redactRef('https://h.example/token=abc123');
  assert.match(eqTail, /^ref-[0-9a-f]{8}$/);
  assert.ok(!eqTail.includes('token=abc123'));
  // Reasons scrub URLs/paths/key-fragments and cap at 200 chars.
  const reason = redactReason('unlink failed for /tmp/sess-1/a.bin token=abc123 https://provider.example/x EPERM');
  assert.ok(!reason.includes('token=abc123'));
  assert.ok(!reason.includes('provider.example'));
  assert.ok(!reason.includes('/tmp/sess-1/a.bin'));
  assert.ok(reason.length <= 200);
  // End-to-end: failure telemetry carries scrubbed reason only.
  const telemetry = new OrphanTelemetry();
  await deleteLocalAsset('/tmp/sess-1/cred-1.bin', 'temp-credential', {
    unlink: () => { throw new Error('EPERM unlink /tmp/sess-1/cred-1.bin token=abc123 https://provider.example/x'); },
    telemetry,
  });
  const [record] = telemetry.list();
  assert.equal(record!.ref, 'cred-1.bin');
  assert.ok(!record!.reason.includes('token=abc123'));
  assert.ok(!record!.reason.includes('provider.example'));
  assert.ok(!record!.reason.includes('/tmp/sess-1/cred-1.bin'));
});

test('symlink cleanup removes the link, never the target', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asset-sym-'));
  try {
    const target = join(dir, 'target.bin');
    const link = join(dir, 'link.bin');
    await writeFile(target, 'target-bytes');
    await symlink(target, link);
    const telemetry = new OrphanTelemetry();
    await runWithAssetCleanup(async (scope) => {
      scope.add(link, 'raw-asset');
    }, { unlink: (p) => unlink(p), telemetry });
    // Link gone, target intact: cleanup unlinks the registered path as-is and
    // never resolves/follows the symlink to delete the target.
    await assert.rejects(unlink(link), /ENOENT/);
    assert.equal(await readFile(target, 'utf8'), 'target-bytes');
    assert.equal(telemetry.size, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('derived/response entries enforce 1h TTL', () => {
  const now = 10_000_000;
  assert.equal(isDerivedEntryExpired(now - WEB_ACCESS_STORE_TTL_MS - 1, now), true);
  assert.equal(isDerivedEntryExpired(now - 1000, now), false);
});

test('derived-only persistence default-off, env-gated, TTL capped at 24h', () => {
  assert.equal(isDerivedPersistenceEnabled({}), false);
  assert.equal(isDerivedPersistenceEnabled({ PI_ASSET_DERIVED_PERSIST: '1' }), true);
  assert.equal(assertDerivedPersistenceTtl(DERIVED_PERSISTENCE_MAX_TTL_MS), DERIVED_PERSISTENCE_MAX_TTL_MS);
  assert.throws(() => assertDerivedPersistenceTtl(DERIVED_PERSISTENCE_MAX_TTL_MS + 1), /TTL/);
  assert.throws(() => assertDerivedPersistenceTtl(0), /TTL/);
});
