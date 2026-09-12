import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { installAllowed, runSetupInstall } from '../src/installer.js';

const script = '#!/bin/sh\necho "GITHUB_TOKEN=ghp_should_redact" >&2\nexit 0\n';

test('installer opt-out disables execution', async () => {
  const result = await runSetupInstall('install_core', { PI_SEARCH_ALLOW_INSTALL: '0' }, undefined);

  assert.equal(result.installAllowed, false);
  assert.equal(result.status, 'skipped');
  assert.deepEqual(result.installers, []);
});

test('installer uses allowed package-manager command and redacts output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-installer-'));
  try {
    const pipx = join(dir, 'pipx');
    await writeFile(pipx, script);
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

test('installer ignores non-executable command candidates on PATH', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-installer-executable-'));
  try {
    const pipx = join(dir, 'pipx');
    const uv = join(dir, 'uv');
    await writeFile(pipx, script);
    await chmod(pipx, 0o600);
    await writeFile(uv, script);
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

test('installer pins verified CLI versions (opencli 1.8.6, twitter-cli 0.8.5)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-installer-pinned-'));
  try {
    // PATH offers only pipx (exit 0): twitter-cli installs via pipx with a
    // pinned spec; the npm-only opencli installer skips without npm present.
    const pipx = join(dir, 'pipx');
    await writeFile(pipx, script);
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

test('installer pins opencli npm spec to verified 1.8.6', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-installer-opencli-'));
  try {
    const npm = join(dir, 'npm');
    await writeFile(npm, script);
    await chmod(npm, 0o700);

    const result = await runSetupInstall('install_channels', { PATH: dir }, ['facebook']);
    const opencli = result.installers.find((installer) => installer.id === 'opencli');
    assert.equal(opencli?.status, 'installed');
    assert.deepEqual(opencli?.command, ['npm', 'install', '-g', '@jackwener/opencli@1.8.6']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
