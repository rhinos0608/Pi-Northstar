// Persistent local install helper for the user-Chrome companion.
// This copies the packaged unpacked extension to a stable per-user directory.
// Pairing and authorization remain exclusively owned by /chrome-authorize.

import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isChromiumFamily, type ChromiumFamily, type OsDefaultFamily } from './chrome-os-default.js';

export const CHROME_COMPANION_DIRNAME = 'chrome-companion';
export const CHROME_COMPANION_FAMILY_FILENAME = 'chrome-companion-family';

export interface ChromeCompanionInstallResult {
  installDir: string;
  family: ChromiumFamily;
  updatedExisting: boolean;
  managerOpened: boolean;
  pathCopied: boolean;
}

export function resolveChromeCompanionSourceDir(): string {
  return fileURLToPath(new URL('../../chrome-extension/', import.meta.url));
}

export function defaultChromeCompanionInstallDir(home: string = homedir()): string {
  return join(home, '.pi-northstar', CHROME_COMPANION_DIRNAME);
}

export function defaultChromeCompanionFamilyPath(home: string = homedir()): string {
  return join(home, '.pi-northstar', CHROME_COMPANION_FAMILY_FILENAME);
}

export async function readInstalledChromeCompanionFamily(
  home: string = homedir(),
): Promise<ChromiumFamily | undefined> {
  try {
    const path = defaultChromeCompanionFamilyPath(home);
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return undefined;
    const raw = (await readFile(path, 'utf8')).trim();
    return isChromiumFamily(raw as OsDefaultFamily) ? raw as ChromiumFamily : undefined;
  } catch {
    return undefined;
  }
}

export async function rememberInstalledChromeCompanionFamily(
  family: ChromiumFamily,
  home: string = homedir(),
): Promise<void> {
  const dir = join(home, '.pi-northstar');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const dirStat = await lstat(dir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error('chrome companion state directory must be a real directory');
  }
  const target = defaultChromeCompanionFamilyPath(home);
  const existing = await lstat(target).catch(() => null);
  if (existing !== null && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new Error('chrome companion family state must be a regular file');
  }
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${family}
`, { mode: 0o600 });
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

async function assertRegularTree(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error('chrome companion source must not contain symlinks');
  if (stat.isFile()) return;
  if (!stat.isDirectory()) throw new Error('chrome companion source contains a non-file entry');
  for (const entry of await readdir(path)) await assertRegularTree(join(path, entry));
}

const installQueues = new Map<string, Promise<void>>();

async function withInstallQueue<T>(installDir: string, work: () => Promise<T>): Promise<T> {
  const prior = installQueues.get(installDir) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = prior.then(() => gate, () => gate);
  installQueues.set(installDir, tail);
  await prior.catch(() => {});
  try {
    return await work();
  } finally {
    release();
    if (installQueues.get(installDir) === tail) installQueues.delete(installDir);
  }
}

/** Stage and rollback-protect refresh of the stable unpacked-extension directory. */
export async function installChromeCompanionFiles(
  sourceDir: string = resolveChromeCompanionSourceDir(),
  installDir: string = defaultChromeCompanionInstallDir(),
): Promise<string> {
  return withInstallQueue(installDir, () => installChromeCompanionFilesUnlocked(sourceDir, installDir));
}

async function installChromeCompanionFilesUnlocked(
  sourceDir: string,
  installDir: string,
): Promise<string> {
  await assertRegularTree(sourceDir);
  const manifest = join(sourceDir, 'manifest.json');
  const manifestStat = await lstat(manifest).catch(() => null);
  if (manifestStat === null || !manifestStat.isFile()) throw new Error('chrome companion manifest.json is missing');

  const parent = dirname(installDir);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentStat = await lstat(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error('chrome companion install parent must be a real directory');
  }

  const staging = await mkdtemp(join(parent, '.chrome-companion-install-'));
  const backup = `${installDir}.old-${process.pid}-${randomUUID()}`;
  let movedOld = false;
  try {
    await cp(sourceDir, staging, { recursive: true, dereference: false, force: true });
    const existing = await lstat(installDir).catch(() => null);
    if (existing !== null) {
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        throw new Error('chrome companion install path must be a real directory');
      }
      await rm(backup, { recursive: true, force: true });
      await rename(installDir, backup);
      movedOld = true;
    }
    await rename(staging, installDir);
    // The staged replacement is already complete. Failure to remove the old
    // backup must not report the install itself as failed or trigger rollback.
    if (movedOld) await rm(backup, { recursive: true, force: true }).catch(() => {});
    return installDir;
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (movedOld) {
      const current = await lstat(installDir).catch(() => null);
      if (current === null) await rename(backup, installDir).catch(() => {});
    }
    throw error;
  }
}

const MANAGER_URL: Record<ChromiumFamily, string> = {
  chrome: 'chrome://extensions',
  chromium: 'chrome://extensions',
  edge: 'edge://extensions',
  brave: 'brave://extensions',
  arc: 'arc://extensions',
  vivaldi: 'vivaldi://extensions',
};

const DARWIN_APP: Record<ChromiumFamily, string> = {
  chrome: 'Google Chrome',
  chromium: 'Chromium',
  edge: 'Microsoft Edge',
  brave: 'Brave Browser',
  arc: 'Arc',
  vivaldi: 'Vivaldi',
};

const LINUX_EXECUTABLE: Record<ChromiumFamily, string> = {
  chrome: 'google-chrome',
  chromium: 'chromium',
  edge: 'microsoft-edge',
  brave: 'brave-browser',
  arc: 'arc',
  vivaldi: 'vivaldi',
};

const WINDOWS_EXECUTABLE: Record<ChromiumFamily, string> = {
  chrome: 'chrome.exe',
  chromium: 'chromium.exe',
  edge: 'msedge.exe',
  brave: 'brave.exe',
  arc: 'Arc.exe',
  vivaldi: 'vivaldi.exe',
};

export interface ChromeExtensionManagerLaunch {
  command: string;
  args: string[];
}

export function chromeExtensionManagerLaunch(
  family: ChromiumFamily,
  platform: NodeJS.Platform = process.platform,
): ChromeExtensionManagerLaunch | null {

  const url = MANAGER_URL[family];
  if (platform === 'darwin') {
    return { command: '/usr/bin/open', args: ['-a', DARWIN_APP[family], url] };
  }
  if (platform === 'linux') {
    return { command: LINUX_EXECUTABLE[family], args: [url] };
  }
  if (platform === 'win32') {
    return {
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/c', 'start', '', WINDOWS_EXECUTABLE[family], url],
    };
  }
  return null;
}

async function openExtensionManager(family: ChromiumFamily): Promise<boolean> {
  const launch = chromeExtensionManagerLaunch(family);
  if (launch === null) return false;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const child = spawn(launch.command, launch.args, {
      stdio: 'ignore',
      detached: true,
      shell: false,
      windowsHide: true,
    });
    child.once('error', () => finish(false));
    child.once('spawn', () => {
      child.unref();
      finish(true);
    });
    const timer = setTimeout(() => finish(false), 2_000);
  });
}

function copyInstallPath(installDir: string): boolean {
  if (process.platform !== 'darwin') return false;

  const result = spawnSync('/usr/bin/pbcopy', [], {
    input: installDir,
    encoding: 'utf8',
    timeout: 2_000,
    shell: false,
  });
  return result.status === 0;
}

/**
 * Prepare persistent extension files and open the browser-owned install UI.
 * The final browser-side Load unpacked / Reload action remains a user decision by design.
 */
export async function installChromeCompanion(
  family: ChromiumFamily,
): Promise<ChromeCompanionInstallResult> {
  const target = defaultChromeCompanionInstallDir();
  const prior = await lstat(target).catch(() => null);
  const updatedExisting = prior !== null && prior.isDirectory() && !prior.isSymbolicLink();
  const installDir = await installChromeCompanionFiles(undefined, target);
  await rememberInstalledChromeCompanionFamily(family);
  const pathCopied = copyInstallPath(installDir);
  const managerOpened = await openExtensionManager(family);
  return { installDir, family, updatedExisting, managerOpened, pathCopied };
}
