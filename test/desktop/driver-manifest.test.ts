import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  assertDriverTrusted,
  bundledManifestPath,
  DriverManifestError,
  isDriverEnrolled,
  loadArtifactManifest,
  loadBundledManifest,
  loadManifestIfPresent,
  verifyFileAgainstManifest,
  type ArtifactManifest,
} from '../../src/desktop/driver-manifest.js';

test('loadArtifactManifest loads and validates valid manifest', () => {
  const manifest = loadArtifactManifest('artifacts/artifacts.manifest.json');
  assert.equal(manifest.manifestVersion, '1.0.0');
  assert.ok(manifest.generatedAt);
  assert.deepEqual(manifest.artifacts, {});
});

test('loadArtifactManifest throws DriverManifestError on missing file or malformed manifest', () => {
  assert.throws(
    () => loadArtifactManifest('artifacts/non-existent-manifest.json'),
    (err) => err instanceof DriverManifestError && err.message.includes('Failed to read')
  );

  const tmpDir = mkdtempSync(join(tmpdir(), 'driver-manifest-test-'));
  try {
    const malformedJsonPath = join(tmpDir, 'malformed.json');
    writeFileSync(malformedJsonPath, '{ invalid json');
    assert.throws(
      () => loadArtifactManifest(malformedJsonPath),
      (err) => err instanceof DriverManifestError && err.message.includes('Invalid JSON')
    );

    const nonObjectPath = join(tmpDir, 'non-object.json');
    writeFileSync(nonObjectPath, '["not an object"]');
    assert.throws(
      () => loadArtifactManifest(nonObjectPath),
      (err) => err instanceof DriverManifestError && err.message.includes('root must be an object')
    );

    const missingVersionPath = join(tmpDir, 'missing-version.json');
    writeFileSync(missingVersionPath, JSON.stringify({ generatedAt: '2026-03-30', artifacts: {} }));
    assert.throws(
      () => loadArtifactManifest(missingVersionPath),
      (err) => err instanceof DriverManifestError && err.message.includes('manifestVersion')
    );

    const missingArtifactsPath = join(tmpDir, 'missing-artifacts.json');
    writeFileSync(missingArtifactsPath, JSON.stringify({ manifestVersion: '1.0.0', generatedAt: '2026-03-30' }));
    assert.throws(
      () => loadArtifactManifest(missingArtifactsPath),
      (err) => err instanceof DriverManifestError && err.message.includes('artifacts must be an object')
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('verifyFileAgainstManifest: enrolled hash passes, tampered fails, missing entry false, missing file false', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'driver-manifest-verify-'));
  try {
    const validFilePath = join(tmpDir, 'driver.bin');
    const validContent = Buffer.from('executable binary content v1.0.0');
    writeFileSync(validFilePath, validContent);
    const validSha256 = createHash('sha256').update(validContent).digest('hex');

    const manifest: ArtifactManifest = {
      manifestVersion: '1.0.0',
      generatedAt: '2026-03-30T00:00:00.000Z',
      artifacts: {
        'cua-driver': {
          platforms: {
            darwin: { sha256: validSha256 },
            linux: { sha256: 'deadbeef' },
          },
        },
        'agent-browser': {
          sha256: validSha256,
        },
        'no-sha256-driver': {
          platforms: {
            darwin: {} as { sha256: string },
          },
        },
      },
    };

    // 1. Enrolled hash passes (platform-specific shape)
    assert.equal(verifyFileAgainstManifest(manifest, 'cua-driver', 'darwin', validFilePath), true);

    // 2. Enrolled hash passes (top-level sha256 shape)
    assert.equal(verifyFileAgainstManifest(manifest, 'agent-browser', 'darwin', validFilePath), true);

    // 3. Tampered content fails
    const tamperedFilePath = join(tmpDir, 'tampered.bin');
    writeFileSync(tamperedFilePath, Buffer.from('tampered content'));
    assert.equal(verifyFileAgainstManifest(manifest, 'cua-driver', 'darwin', tamperedFilePath), false);

    // 4. Unknown driver returns false (never throws)
    assert.equal(verifyFileAgainstManifest(manifest, 'unknown-driver', 'darwin', validFilePath), false);

    // 5. Unknown platform returns false
    assert.equal(verifyFileAgainstManifest(manifest, 'cua-driver', 'win32', validFilePath), false);

    // 6. Missing file returns false (never throws)
    assert.equal(verifyFileAgainstManifest(manifest, 'cua-driver', 'darwin', join(tmpDir, 'missing.bin')), false);

    // 7. Missing sha256 in entry returns false
    assert.equal(verifyFileAgainstManifest(manifest, 'no-sha256-driver', 'darwin', validFilePath), false);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('isDriverEnrolled: returns true when expected sha256 exists, false otherwise', () => {
  const manifest: ArtifactManifest = {
    manifestVersion: '1.0.0',
    generatedAt: '2026-03-30T00:00:00.000Z',
    artifacts: {
      'cua-driver': {
        platforms: {
          darwin: { sha256: 'abc123' },
          'linux-empty': { sha256: '' },
          'no-sha': {} as { sha256: string },
        },
      },
      'agent-browser': {
        sha256: 'def456',
      },
      'empty-browser': {
        sha256: '',
      },
    },
  };

  assert.equal(isDriverEnrolled(manifest, 'cua-driver', 'darwin'), true);
  assert.equal(isDriverEnrolled(manifest, 'agent-browser', 'any-platform'), true);
  assert.equal(isDriverEnrolled(manifest, 'cua-driver', 'linux-empty'), false);
  assert.equal(isDriverEnrolled(manifest, 'cua-driver', 'no-sha'), false);
  assert.equal(isDriverEnrolled(manifest, 'cua-driver', 'win32'), false);
  assert.equal(isDriverEnrolled(manifest, 'empty-browser', 'darwin'), false);
  assert.equal(isDriverEnrolled(manifest, 'unknown-driver', 'darwin'), false);
  assert.equal(isDriverEnrolled({ manifestVersion: '1.0.0', generatedAt: '', artifacts: {} }, 'cua-driver', 'darwin'), false);
});

test('assertDriverTrusted: passes when verified, throws DriverManifestError on enrolled mismatch, passes silently when unenrolled', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'driver-manifest-assert-'));
  try {
    const validFilePath = join(tmpDir, 'cua-driver');
    const content = Buffer.from('mock binary cua-driver 0.7.1');
    writeFileSync(validFilePath, content);
    const validSha256 = createHash('sha256').update(content).digest('hex');

    const tamperedFilePath = join(tmpDir, 'tampered-cua-driver');
    writeFileSync(tamperedFilePath, Buffer.from('tampered binary'));

    const manifest: ArtifactManifest = {
      manifestVersion: '1.0.0',
      generatedAt: '2026-03-30T00:00:00.000Z',
      artifacts: {
        'cua-driver': {
          platforms: {
            darwin: { sha256: validSha256 },
            'darwin-arm64': { sha256: validSha256 },
          },
        },
        'agent-browser': {
          sha256: validSha256,
        },
      },
    };

    // 1. Enrolled + matching hash passes without throwing
    assert.doesNotThrow(() => {
      assertDriverTrusted(manifest, 'cua-driver', 'darwin', validFilePath);
    });
    assert.doesNotThrow(() => {
      assertDriverTrusted(manifest, 'cua-driver', 'darwin-arm64', validFilePath);
    });
    assert.doesNotThrow(() => {
      assertDriverTrusted(manifest, 'agent-browser', 'darwin', validFilePath);
    });

    // 2. Enrolled + hash mismatch throws DriverManifestError
    assert.throws(
      () => assertDriverTrusted(manifest, 'cua-driver', 'darwin', tamperedFilePath),
      (err) => err instanceof DriverManifestError && err.message.includes('Driver untrusted')
    );
    assert.throws(
      () => assertDriverTrusted(manifest, 'agent-browser', 'darwin', tamperedFilePath),
      (err) => err instanceof DriverManifestError && err.message.includes('Driver untrusted')
    );

    // 3. Unenrolled platform/driver returns silently (passes without throwing)
    assert.doesNotThrow(() => {
      assertDriverTrusted(manifest, 'cua-driver', 'linux', validFilePath);
    });
    assert.doesNotThrow(() => {
      assertDriverTrusted(manifest, 'unknown-driver', 'darwin', validFilePath);
    });

    // 4. Empty/unenrolled manifest returns silently
    const emptyManifest: ArtifactManifest = {
      manifestVersion: '1.0.0',
      generatedAt: '2026-03-30T00:00:00.000Z',
      artifacts: {},
    };
    assert.doesNotThrow(() => {
      assertDriverTrusted(emptyManifest, 'cua-driver', 'darwin', validFilePath);
    });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('bundledManifestPath and loadBundledManifest behavior', () => {
  const p = bundledManifestPath();
  assert.ok(p.endsWith(join('artifacts', 'artifacts.manifest.json')));
  const manifest = loadBundledManifest();
  assert.ok(manifest);
  assert.equal(manifest?.manifestVersion, '1.0.0');
});

test('loadManifestIfPresent returns undefined for missing file, parses valid, and throws on malformed', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'driver-manifest-present-'));
  try {
    const missingPath = join(tmpDir, 'does-not-exist.json');
    assert.equal(loadManifestIfPresent(missingPath), undefined);

    const malformedPath = join(tmpDir, 'malformed.json');
    writeFileSync(malformedPath, '{ bad json');
    assert.throws(
      () => loadManifestIfPresent(malformedPath),
      (err) => err instanceof DriverManifestError && err.message.includes('Invalid JSON')
    );

    const validPath = join(tmpDir, 'valid.json');
    writeFileSync(validPath, JSON.stringify({
      manifestVersion: '1.0.0',
      generatedAt: '2026-03-30T00:00:00.000Z',
      artifacts: {},
    }));
    const loaded = loadManifestIfPresent(validPath);
    assert.ok(loaded);
    assert.equal(loaded?.manifestVersion, '1.0.0');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
