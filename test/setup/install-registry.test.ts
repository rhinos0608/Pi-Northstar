import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { installAllowed, runSetupInstall } from '../../src/setup/installer.js';

const script = '#!/bin/sh\necho "GITHUB_TOKEN=ghp_should_redact" >&2\nexit 0\n';

// Windows-only skip flag: these tests install extensionless `#!/bin/sh`
// fixtures as fake `pipx`/`uv`/`npm` binaries. src/installer.ts spawns
// candidates via raw spawn(..., { shell: false }) and its commandExists
// check only probes the bare name (plus .exe on win32), so the fixtures
// are never executable there — and chmod 0o600 vs 0o700 is a no-op on
// Windows, which also breaks the non-executable-candidate test.
const requiresPosixInstallShim = process.platform === 'win32' ? 'requires POSIX executable shims' : false;

// Fake installer modeling reality: the install drops the binary onto PATH so
// the post-install version probe finds it. (Planting the binary upfront would
// fake a 'present' short-circuit instead of exercising the install path.)
// POSIX single-quote escaping for paths interpolated into the /bin/sh fixture.
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
function plantingScript(dir: string, binary: string, version: string): string {
  // Absolute /bin/chmod: the installer child env PATH is the shim dir only,
  // so bare `chmod` does not resolve. POSIX-only tests (see skip flag).
  const target = shQuote(`${dir}/${binary}`);
  return `#!/bin/sh\necho "GITHUB_TOKEN=ghp_should_redact" >&2\nprintf '#!/bin/sh\\necho "${version}"\\n' > ${target}\n/bin/chmod 700 ${target}\nexit 0\n`;
}

test('installer opt-out disables execution', async () => {
  const result = await runSetupInstall('install_core', { PI_SEARCH_ALLOW_INSTALL: '0' }, undefined);

  assert.equal(result.installAllowed, false);
  assert.equal(result.status, 'skipped');
  assert.deepEqual(result.installers, []);
});

test('installer uses allowed package-manager command and redacts output', { skip: requiresPosixInstallShim }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-installer-'));
  try {
    const pipx = join(dir, 'pipx');
    await writeFile(pipx, plantingScript(dir, 'twitter', '0.8.5'));
    await chmod(pipx, 0o700);

    const result = await runSetupInstall('install_channels', { PATH: dir, GITHUB_TOKEN: 'ghp_live_secret' }, ['twitter']);

    assert.equal(result.installAllowed, true);
    const installed = result.installers.find((installer) => installer.status === 'installed');
    assert.ok(installed);
    assert.equal(installed.command?.[0], 'pipx');
    const text = JSON.stringify(result);
    assert.match(text, /GITHUB_TOKEN=\*\*\*/);
    assert.doesNotMatch(text, /ghp_should_redact|ghp_live_secret/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('installer ignores non-executable command candidates on PATH', { skip: requiresPosixInstallShim }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-installer-executable-'));
  try {
    const pipx = join(dir, 'pipx');
    const uv = join(dir, 'uv');
    await writeFile(pipx, script);
    await chmod(pipx, 0o600);
    await writeFile(uv, plantingScript(dir, 'twitter', '0.8.5'));
    await chmod(uv, 0o700);

    const result = await runSetupInstall('install_channels', { PATH: dir }, ['twitter']);
    const installed = result.installers.find((installer) => installer.status === 'installed');

    assert.equal(installed?.command?.[0], 'uv');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('installer reports skipped when no installer binary is available', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-empty-path-'));
  try {
    const result = await runSetupInstall('install_channels', { PATH: dir }, ['twitter']);

    assert.equal(result.status, 'ok');
    assert.equal(result.installers[0]?.status, 'skipped');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('installAllowed defaults to enabled', () => {
  assert.equal(installAllowed({}), true);
  assert.equal(installAllowed({ PI_SEARCH_ALLOW_INSTALL: 'off' }), false);
});

test('installer pins verified CLI versions (opencli 1.8.6, twitter-cli 0.8.5)', { skip: requiresPosixInstallShim }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-installer-pinned-'));
  try {
    // PATH offers only pipx (exit 0): twitter-cli installs via pipx with a
    // pinned spec; the npm-only opencli installer skips without npm present.
    const pipx = join(dir, 'pipx');
    await writeFile(pipx, plantingScript(dir, 'twitter', '0.8.5'));
    await chmod(pipx, 0o700);

    const result = await runSetupInstall('install_channels', { PATH: dir }, ['twitter']);
    const twitterCli = result.installers.find((installer) => installer.id === 'twitter-cli');
    assert.equal(twitterCli?.status, 'installed');
    assert.ok(
      twitterCli?.command?.some((part) => part.includes('twitter-cli==0.8.5')),
      `twitter-cli install must pin 0.8.5, got ${JSON.stringify(twitterCli?.command)}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('installer pins opencli npm spec to verified 1.8.6', { skip: requiresPosixInstallShim }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-installer-opencli-'));
  try {
    const npm = join(dir, 'npm');
    await writeFile(npm, plantingScript(dir, 'opencli', '1.8.6'));
    await chmod(npm, 0o700);

    const result = await runSetupInstall('install_channels', { PATH: dir }, ['facebook']);
    const opencli = result.installers.find((installer) => installer.id === 'opencli');
    assert.equal(opencli?.status, 'installed');
    assert.deepEqual(opencli?.command, ['npm', 'install', '-g', '@jackwener/opencli@1.8.6']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('installer fails when post-install version mismatches the pin', { skip: requiresPosixInstallShim }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-installer-mismatch-'));
  try {
    // Install exits 0 but the planted binary reports the wrong version.
    await writeFile(join(dir, 'pipx'), plantingScript(dir, 'twitter', '9.9.9'));
    await chmod(join(dir, 'pipx'), 0o700);

    const result = await runSetupInstall('install_channels', { PATH: dir }, ['twitter']);
    const twitterCli = result.installers.find((installer) => installer.id === 'twitter-cli');
    assert.equal(twitterCli?.status, 'failed');
    assert.match(twitterCli?.message ?? '', /expected exact 0\.8\.5/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('installer pins xhs-cli to verified 0.1.4 with post-install verification', { skip: requiresPosixInstallShim }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-installer-xhs-'));
  try {
    await writeFile(join(dir, 'pipx'), plantingScript(dir, 'xhs', '0.1.4'));
    await chmod(join(dir, 'pipx'), 0o700);

    const result = await runSetupInstall('install_channels', { PATH: dir }, ['xiaohongshu']);
    const xhsCli = result.installers.find((installer) => installer.id === 'xhs-cli');
    assert.equal(xhsCli?.status, 'installed');
    assert.ok(
      xhsCli?.command?.some((part) => part.includes('xhs-cli==0.1.4')),
      `xhs-cli install must pin 0.1.4, got ${JSON.stringify(xhsCli?.command)}`,
    );
    assert.match(xhsCli?.message ?? '', /Verified xhs 0\.1\.4/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('installer pins mcporter npm spec to 0.13.12 with post-install verification', { skip: requiresPosixInstallShim }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-installer-mcporter-'));
  try {
    await writeFile(join(dir, 'npm'), plantingScript(dir, 'mcporter', '0.13.12'));
    await chmod(join(dir, 'npm'), 0o700);

    const result = await runSetupInstall('install_channels', { PATH: dir }, ['search']);
    const mcporter = result.installers.find((installer) => installer.id === 'mcporter');
    assert.equal(mcporter?.status, 'installed');
    assert.deepEqual(mcporter?.command, ['npm', 'install', '-g', 'mcporter@0.13.12']);
    assert.match(mcporter?.message ?? '', /Verified mcporter 0\.13\.12/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
