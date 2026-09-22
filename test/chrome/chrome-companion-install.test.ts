import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  chromeExtensionManagerLaunch,
  defaultChromeCompanionFamilyPath,
  defaultChromeCompanionInstallDir,
  installChromeCompanionFiles,
  readInstalledChromeCompanionFamily,
  rememberInstalledChromeCompanionFamily,
} from '../../src/chrome/chrome-companion-install.js';

async function fixture(root: string, marker: string): Promise<string> {
  const source = join(root, 'source');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'test companion',
    version: '1.0.0',
  }));
  await writeFile(join(source, 'service_worker.js'), marker);
  return source;
}

test('default companion install directory is stable under the user home', () => {
  const home = join('Users', 'example');
  assert.equal(
    defaultChromeCompanionInstallDir(home),
    join(home, '.pi-northstar', 'chrome-companion'),
  );
});

test('companion install staged-refreshes the same stable directory and removes stale files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-atlas-chrome-install-'));
  const source = await fixture(root, 'first');
  const installDir = join(root, 'home', '.pi-northstar', 'chrome-companion');

  assert.equal(await installChromeCompanionFiles(source, installDir), installDir);
  assert.equal(await readFile(join(installDir, 'service_worker.js'), 'utf8'), 'first');

  await writeFile(join(source, 'service_worker.js'), 'second');
  await writeFile(join(installDir, 'stale.txt'), 'remove-me');
  assert.equal(await installChromeCompanionFiles(source, installDir), installDir);
  assert.equal(await readFile(join(installDir, 'service_worker.js'), 'utf8'), 'second');
  await assert.rejects(() => readFile(join(installDir, 'stale.txt'), 'utf8'));
});

test('concurrent companion refreshes serialize on the stable install directory', async () => {
  const rootA = await mkdtemp(join(tmpdir(), 'pi-atlas-chrome-install-a-'));
  const rootB = await mkdtemp(join(tmpdir(), 'pi-atlas-chrome-install-b-'));
  const sourceA = await fixture(rootA, 'first');
  const sourceB = await fixture(rootB, 'second');
  const installDir = join(rootA, 'home', '.pi-northstar', 'chrome-companion');
  const [a, b] = await Promise.all([
    installChromeCompanionFiles(sourceA, installDir),
    installChromeCompanionFiles(sourceB, installDir),
  ]);
  assert.equal(a, installDir);
  assert.equal(b, installDir);
  assert.equal(await readFile(join(installDir, 'service_worker.js'), 'utf8'), 'second');
});

test('installed family state round-trips and ignores malformed values', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-atlas-chrome-family-'));
  await rememberInstalledChromeCompanionFamily('brave', home);
  assert.equal(await readInstalledChromeCompanionFamily(home), 'brave');
  assert.equal(defaultChromeCompanionFamilyPath(home), join(home, '.pi-northstar', 'chrome-companion-family'));
  await writeFile(defaultChromeCompanionFamilyPath(home), 'not-a-browser\n');
  assert.equal(await readInstalledChromeCompanionFamily(home), undefined);
});

test('companion install rejects symlinks in the packaged source tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-atlas-chrome-symlink-'));
  const source = await fixture(root, 'safe');
  const outside = join(root, 'outside.txt');
  await writeFile(outside, 'outside');
  await symlink(outside, join(source, 'linked.txt'));

  await assert.rejects(
    () => installChromeCompanionFiles(source, join(root, 'installed')),
    /must not contain symlinks/,
  );
});

test('extension manager launch is browser-family aware and shell-free', () => {
  assert.deepEqual(chromeExtensionManagerLaunch('chrome', 'darwin'), {
    command: '/usr/bin/open',
    args: ['-a', 'Google Chrome', 'chrome://extensions'],
  });
  assert.deepEqual(chromeExtensionManagerLaunch('brave', 'darwin'), {
    command: '/usr/bin/open',
    args: ['-a', 'Brave Browser', 'brave://extensions'],
  });
  assert.deepEqual(chromeExtensionManagerLaunch('edge', 'win32'), {
    command: 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/c', 'start', '', 'msedge.exe', 'edge://extensions'],
  });
  assert.deepEqual(chromeExtensionManagerLaunch('vivaldi', 'linux'), {
    command: 'vivaldi',
    args: ['vivaldi://extensions'],
  });
  assert.deepEqual(chromeExtensionManagerLaunch('brave', 'linux'), {
    command: 'brave-browser',
    args: ['brave://extensions'],
  });
  assert.equal(chromeExtensionManagerLaunch('chrome', 'aix'), null);
});
