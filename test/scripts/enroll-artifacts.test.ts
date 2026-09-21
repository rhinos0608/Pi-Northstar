import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const SCRIPT_PATH = join(process.cwd(), 'scripts', 'enroll-artifacts.mjs');

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeInitialManifest(): string {
  return JSON.stringify(
    {
      manifestVersion: '1.0.0',
      generatedAt: '2026-03-30T00:00:00.000Z',
      artifacts: {},
    },
    null,
    2
  ) + '\n';
}

test('enroll-artifacts enrolls a native_binary artifact hash into manifest copy', () => {
  const tmpDir = createTempDir('enroll-test-native-');
  try {
    const manifestPath = join(tmpDir, 'manifest.json');
    writeFileSync(manifestPath, makeInitialManifest());

    const artifactPath = join(tmpDir, 'cua-driver');
    const artifactBytes = Buffer.from('mock cua-driver binary contents');
    writeFileSync(artifactPath, artifactBytes);
    const expectedHash = createHash('sha256').update(artifactBytes).digest('hex');

    const stdout = execFileSync(
      process.execPath,
      [
        SCRIPT_PATH,
        '--manifest', manifestPath,
        '--name', 'cua-driver',
        '--platform', 'darwin-arm64',
        '--file', artifactPath,
        '--version', '0.7.1',
        '--team-id', 'TEAM12345',
      ],
      { encoding: 'utf8' }
    );

    assert.equal(stdout.trim(), `cua-driver@darwin-arm64 = sha256:${expectedHash}`);

    const updated = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(updated.manifestVersion, '1.0.0');
    assert.ok(updated.artifacts['cua-driver']);
    assert.equal(updated.artifacts['cua-driver'].type, 'native_binary');
    assert.equal(updated.artifacts['cua-driver'].version, '0.7.1');
    assert.ok(updated.artifacts['cua-driver'].platforms['darwin-arm64']);
    assert.equal(updated.artifacts['cua-driver'].platforms['darwin-arm64'].sha256, expectedHash);
    assert.equal(updated.artifacts['cua-driver'].platforms['darwin-arm64'].teamId, 'TEAM12345');

    // Asserts trailing newline and 2-space formatting
    const rawContent = readFileSync(manifestPath, 'utf8');
    assert.ok(rawContent.endsWith('\n'));
    assert.equal(rawContent, JSON.stringify(updated, null, 2) + '\n');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('enroll-artifacts enrolls an npm_entry artifact with flat sha256', () => {
  const tmpDir = createTempDir('enroll-test-npm-');
  try {
    const manifestPath = join(tmpDir, 'manifest.json');
    writeFileSync(manifestPath, makeInitialManifest());

    const artifactPath = join(tmpDir, 'index.js');
    const artifactBytes = Buffer.from('console.log("agent-browser");');
    writeFileSync(artifactPath, artifactBytes);
    const expectedHash = createHash('sha256').update(artifactBytes).digest('hex');

    const stdout = execFileSync(
      process.execPath,
      [
        SCRIPT_PATH,
        '--manifest', manifestPath,
        '--name', 'agent-browser',
        '--platform', 'any',
        '--file', artifactPath,
        '--type', 'npm_entry',
        '--version', '1.2.0',
      ],
      { encoding: 'utf8' }
    );

    assert.equal(stdout.trim(), `agent-browser@any = sha256:${expectedHash}`);

    const updated = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.ok(updated.artifacts['agent-browser']);
    assert.equal(updated.artifacts['agent-browser'].type, 'npm_entry');
    assert.equal(updated.artifacts['agent-browser'].version, '1.2.0');
    assert.equal(updated.artifacts['agent-browser'].sha256, expectedHash);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('re-enroll updates version and adds platform while preserving existing entries', () => {
  const tmpDir = createTempDir('enroll-test-update-');
  try {
    const manifestPath = join(tmpDir, 'manifest.json');
    writeFileSync(manifestPath, makeInitialManifest());

    const file1 = join(tmpDir, 'driver-darwin');
    writeFileSync(file1, 'darwin binary v1');
    const hash1 = createHash('sha256').update('darwin binary v1').digest('hex');

    execFileSync(
      process.execPath,
      [
        SCRIPT_PATH,
        '--manifest', manifestPath,
        '--name', 'cua-driver',
        '--platform', 'darwin-arm64',
        '--file', file1,
        '--version', '0.7.0',
      ],
      { encoding: 'utf8' }
    );

    const file2 = join(tmpDir, 'driver-linux');
    writeFileSync(file2, 'linux binary v2');
    const hash2 = createHash('sha256').update('linux binary v2').digest('hex');

    // Re-enroll with new platform and updated version
    execFileSync(
      process.execPath,
      [
        SCRIPT_PATH,
        '--manifest', manifestPath,
        '--name', 'cua-driver',
        '--platform', 'linux-x64',
        '--file', file2,
        '--version', '0.7.1',
      ],
      { encoding: 'utf8' }
    );

    const updated = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(updated.artifacts['cua-driver'].version, '0.7.1');
    assert.equal(updated.artifacts['cua-driver'].platforms['darwin-arm64'].sha256, hash1);
    assert.equal(updated.artifacts['cua-driver'].platforms['linux-x64'].sha256, hash2);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('--expect with wrong hash exits nonzero and leaves manifest untouched', () => {
  const tmpDir = createTempDir('enroll-test-expect-fail-');
  try {
    const manifestPath = join(tmpDir, 'manifest.json');
    const originalManifest = makeInitialManifest();
    writeFileSync(manifestPath, originalManifest);

    const artifactPath = join(tmpDir, 'driver.bin');
    writeFileSync(artifactPath, 'real content');

    let errorThrown = false;
    try {
      execFileSync(
        process.execPath,
        [
          SCRIPT_PATH,
          '--manifest', manifestPath,
          '--name', 'cua-driver',
          '--platform', 'darwin',
          '--file', artifactPath,
          '--expect', '0000000000000000000000000000000000000000000000000000000000000000',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
    } catch (err: unknown) {
      errorThrown = true;
      const execErr = err as { status: number; stderr: string };
      assert.notEqual(execErr.status, 0);
      assert.match(execErr.stderr, /SHA-256 mismatch/);
    }

    assert.equal(errorThrown, true);
    // Manifest must remain untouched
    assert.equal(readFileSync(manifestPath, 'utf8'), originalManifest);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('--expect with matching hash succeeds', () => {
  const tmpDir = createTempDir('enroll-test-expect-pass-');
  try {
    const manifestPath = join(tmpDir, 'manifest.json');
    writeFileSync(manifestPath, makeInitialManifest());

    const artifactPath = join(tmpDir, 'driver.bin');
    const content = 'matching content';
    writeFileSync(artifactPath, content);
    const hash = createHash('sha256').update(content).digest('hex');

    const stdout = execFileSync(
      process.execPath,
      [
        SCRIPT_PATH,
        '--manifest', manifestPath,
        '--name', 'cua-driver',
        '--platform', 'darwin',
        '--file', artifactPath,
        '--expect', hash,
      ],
      { encoding: 'utf8' }
    );

    assert.equal(stdout.trim(), `cua-driver@darwin = sha256:${hash}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('missing artifact file exits nonzero and leaves manifest untouched', () => {
  const tmpDir = createTempDir('enroll-test-missing-file-');
  try {
    const manifestPath = join(tmpDir, 'manifest.json');
    const originalManifest = makeInitialManifest();
    writeFileSync(manifestPath, originalManifest);

    let errorThrown = false;
    try {
      execFileSync(
        process.execPath,
        [
          SCRIPT_PATH,
          '--manifest', manifestPath,
          '--name', 'cua-driver',
          '--platform', 'darwin',
          '--file', join(tmpDir, 'nonexistent.bin'),
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
    } catch (err: unknown) {
      errorThrown = true;
      const execErr = err as { status: number; stderr: string };
      assert.notEqual(execErr.status, 0);
      assert.match(execErr.stderr, /Failed to read artifact file/);
    }

    assert.equal(errorThrown, true);
    assert.equal(readFileSync(manifestPath, 'utf8'), originalManifest);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('missing or malformed manifest exits nonzero', () => {
  const tmpDir = createTempDir('enroll-test-bad-manifest-');
  try {
    const artifactPath = join(tmpDir, 'driver.bin');
    writeFileSync(artifactPath, 'content');

    // Missing manifest
    assert.throws(() => {
      execFileSync(
        process.execPath,
        [
          SCRIPT_PATH,
          '--manifest', join(tmpDir, 'nonexistent-manifest.json'),
          '--name', 'cua-driver',
          '--platform', 'darwin',
          '--file', artifactPath,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
    });

    // Malformed JSON manifest
    const badJsonPath = join(tmpDir, 'bad.json');
    writeFileSync(badJsonPath, 'invalid json {');
    assert.throws(() => {
      execFileSync(
        process.execPath,
        [
          SCRIPT_PATH,
          '--manifest', badJsonPath,
          '--name', 'cua-driver',
          '--platform', 'darwin',
          '--file', artifactPath,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
    });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('empty name or platform exits nonzero', () => {
  const tmpDir = createTempDir('enroll-test-empty-args-');
  try {
    const manifestPath = join(tmpDir, 'manifest.json');
    writeFileSync(manifestPath, makeInitialManifest());
    const artifactPath = join(tmpDir, 'driver.bin');
    writeFileSync(artifactPath, 'content');

    // Empty name
    assert.throws(() => {
      execFileSync(
        process.execPath,
        [
          SCRIPT_PATH,
          '--manifest', manifestPath,
          '--name', '',
          '--platform', 'darwin',
          '--file', artifactPath,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
    });

    // Empty platform
    assert.throws(() => {
      execFileSync(
        process.execPath,
        [
          SCRIPT_PATH,
          '--manifest', manifestPath,
          '--name', 'cua-driver',
          '--platform', '',
          '--file', artifactPath,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
    });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
