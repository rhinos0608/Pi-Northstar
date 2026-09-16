import { constants } from 'node:fs';
import { resolveCliCommand, spawnCliCommand, windowsPathValue } from '../process/cli-command.js';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

export type InstallAction = 'install_core' | 'install_all' | 'install_channels';

type InstallStatus = 'present' | 'installed' | 'skipped' | 'failed';

interface InstallCommand {
  command: string;
  args: string[];
  platforms?: NodeJS.Platform[];
}

interface InstallerDefinition {
  id: string;
  label: string;
  channels: string[];
  binaries: string[];
  commands: InstallCommand[];
  core?: boolean;
  // Exact expected version, verified post-install (`<binary> --version` must
  // equal `expected` or `<binary> <expected>`, per cua-client verify pattern).
  // Omitted only when the source cannot pin (gh via brew tracks latest).
  expectedVersion?: string;
  versionArgs?: string[];
}

interface InstallerResult {
  id: string;
  label: string;
  channels: string[];
  status: InstallStatus;
  command?: string[];
  message: string;
  stdout?: string;
  stderr?: string;
}

export interface SetupInstallResult {
  descriptor: false;
  action: InstallAction;
  installAllowed: boolean;
  status: 'ok' | 'partial' | 'skipped' | 'error';
  message: string;
  installers: InstallerResult[];
}

const COMMAND_TIMEOUT_MS = 300_000;
const OUTPUT_LIMIT = 8_000;
const RDT_GIT_SOURCE = 'git+https://github.com/public-clis/rdt-cli.git@5e4fb3720d5c174e976cd425ccc3b879d52cac66';

// Post-install exact-match versions. Verified pins mirror the capability
// registry (social-opencli.ts OPENCLI_VERSION, social-twitter.ts 0.8.5,
// social-reddit.ts 0.4.2, social-xiaohongshu.ts 0.1.4). UNVERIFIED pins are
// latest-at-pin-time with no in-code verified version; bump deliberately.
const EXPECTED_OPENCLI_VERSION = '1.8.6';
const EXPECTED_TWITTER_CLI_VERSION = '0.8.5';
const EXPECTED_RDT_CLI_VERSION = '0.4.2';
const EXPECTED_XHS_CLI_VERSION = '0.1.4';
const EXPECTED_BILI_CLI_VERSION = '0.6.2'; // UNVERIFIED: no in-code verified version.
const EXPECTED_YT_DLP_VERSION = '2026.8.19'; // UNVERIFIED: legacy probe only, media.ts never routes here.
const EXPECTED_MCPORTER_VERSION = '0.13.12'; // npm mcporter (was `mcpporter`: 404 on npm/pip/brew, suspected typo).

const installers: InstallerDefinition[] = [
  {
    id: 'gh',
    label: 'GitHub CLI',
    channels: ['github'],
    binaries: ['gh'],
    core: true,
    commands: [{ command: 'brew', args: ['install', 'gh'], platforms: ['darwin'] }],
  },
  {
    id: 'yt-dlp',
    label: 'yt-dlp',
    channels: ['youtube'],
    binaries: ['yt-dlp'],
    core: true,
    // UNVERIFIED pin: no in-code verified version (see EXPECTED_YT_DLP_VERSION).
    commands: pythonToolCommands('yt-dlp', '==2026.8.19'),
    expectedVersion: EXPECTED_YT_DLP_VERSION,
  },
  {
    // ffmpeg floats like gh (no pinned version): presence is all we assert.
    // Fetch-time YouTube keyframe extraction only; never a search surface.
    id: 'ffmpeg',
    label: 'ffmpeg',
    channels: ['youtube'],
    binaries: ['ffmpeg'],
    core: true,
    commands: [{ command: 'brew', args: ['install', 'ffmpeg'], platforms: ['darwin'] }],
  },
  {
    id: 'opencli',
    label: 'OpenCLI',
    channels: ['twitter', 'reddit', 'xiaohongshu', 'facebook', 'instagram', 'bilibili'],
    binaries: ['opencli'],
    // Pinned to the verified version declared in social-opencli.ts (OPENCLI_VERSION).
    commands: [{ command: 'npm', args: ['install', '-g', '@jackwener/opencli@1.8.6'] }],
    expectedVersion: EXPECTED_OPENCLI_VERSION,
  },
  {
    id: 'twitter-cli',
    label: 'twitter-cli',
    channels: ['twitter'],
    binaries: ['twitter'],
    core: true,
    // Pinned to the verified version declared in social-twitter.ts (0.8.5).
    commands: pythonToolCommands('twitter-cli', '==0.8.5'),
    expectedVersion: EXPECTED_TWITTER_CLI_VERSION,
  },
  {
    id: 'rdt-cli',
    label: 'rdt-cli',
    channels: ['reddit'],
    binaries: ['rdt'],
    core: true,
    commands: [
      { command: 'pipx', args: ['install', RDT_GIT_SOURCE] },
      { command: 'uv', args: ['tool', 'install', '--from', RDT_GIT_SOURCE, 'rdt-cli'] },
    ],
    // Git-SHA pinned above; expected binary version per social-reddit.ts (0.4.2).
    expectedVersion: EXPECTED_RDT_CLI_VERSION,
  },
  {
    id: 'bili-cli',
    label: 'bili-cli',
    channels: ['bilibili'],
    binaries: ['bili'],
    // UNVERIFIED pin: no in-code verified version (see EXPECTED_BILI_CLI_VERSION).
    commands: pythonToolCommands('bilibili-cli', '==0.6.2'),
    expectedVersion: EXPECTED_BILI_CLI_VERSION,
  },
  {
    id: 'xhs-cli',
    label: 'xhs-cli',
    channels: ['xiaohongshu'],
    binaries: ['xhs'],
    // Pinned to the verified version declared in social-xiaohongshu.ts (0.1.4).
    commands: pythonToolCommands('xhs-cli', '==0.1.4'),
    expectedVersion: EXPECTED_XHS_CLI_VERSION,
  },
  {
    id: 'mcporter',
    label: 'mcporter',
    channels: ['search'],
    binaries: ['mcporter'],
    core: true,
    // Was `mcpporter`: unresolvable on npm/pip/brew (suspected typo for npm `mcporter`).
    commands: [{ command: 'npm', args: ['install', '-g', 'mcporter@0.13.12'] }],
    expectedVersion: EXPECTED_MCPORTER_VERSION,
  },
];

export async function runSetupInstall(
  action: InstallAction,
  env: Record<string, string | undefined>,
  channels: string[] | undefined,
  signal?: AbortSignal,
): Promise<SetupInstallResult> {
  if (!installAllowed(env)) {
    return {
      descriptor: false,
      action,
      installAllowed: false,
      status: 'skipped',
      message: 'Installation skipped by PI_SEARCH_ALLOW_INSTALL=0.',
      installers: [],
    };
  }

  const selected = selectInstallers(action, channels);
  const results: InstallerResult[] = [];
  for (const installer of selected) {
    results.push(await runInstaller(installer, env, signal));
  }

  const failed = results.filter((result) => result.status === 'failed').length;
  const skipped = results.filter((result) => result.status === 'skipped').length;
  const installed = results.filter((result) => result.status === 'installed').length;
  const present = results.filter((result) => result.status === 'present').length;
  const status = failed > 0 ? 'partial' : 'ok';

  return {
    descriptor: false,
    action,
    installAllowed: true,
    status,
    message: `Install complete: ${present} present, ${installed} installed, ${skipped} skipped, ${failed} failed.`,
    installers: results,
  };
}

export function installAllowed(env: Record<string, string | undefined>): boolean {
  const value = env.PI_SEARCH_ALLOW_INSTALL;
  if (!value) return true;
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

function selectInstallers(action: InstallAction, channels: string[] | undefined): InstallerDefinition[] {
  if (action === 'install_core') return installers.filter((installer) => installer.core);
  if (action === 'install_channels' && channels) {
    return installers.filter((installer) => installer.channels.some((channel) => channels.includes(channel)));
  }
  return installers;
}

async function runInstaller(installer: InstallerDefinition, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<InstallerResult> {
  if (await hasAnyBinary(installer.binaries, env)) {
    // Existence alone is not enough: a stale/drifted binary must not be
    // reported `present`. Pinned installers re-verify the exact expected
    // version; on mismatch fall through to the install flow (reinstall +
    // post-verify) instead of claiming the wanted version is installed.
    if (installer.expectedVersion !== undefined) {
      const checked = await verifyInstalledBinary(installer, env, signal);
      if (checked.ok) {
        return {
          id: installer.id,
          label: installer.label,
          channels: installer.channels,
          status: 'present',
          message: `${installer.label} already installed. ${checked.message}`,
        };
      }
    } else {
      return {
        id: installer.id,
        label: installer.label,
        channels: installer.channels,
        status: 'present',
        message: `${installer.label} already installed.`,
      };
    }
  }

  let lastFailure: InstallerResult | undefined;
  for (const candidate of installer.commands) {
    if (candidate.platforms && !candidate.platforms.includes(process.platform)) continue;
    if (!(await commandExists(candidate.command, env))) continue;

    const result = await runCommand(candidate.command, candidate.args, env, signal);
    if (result.code === 0) {
      const installed: InstallerResult = {
        id: installer.id,
        label: installer.label,
        channels: installer.channels,
        status: 'installed',
        command: [candidate.command, ...candidate.args],
        message: `${installer.label} install command completed.`,
        stdout: tail(result.stdout),
        stderr: tail(result.stderr),
      };
      // Post-install verification (cua-client exact-match pattern): the
      // package manager exited 0, but that proves nothing about the binary.
      const verified = await verifyInstalledBinary(installer, env, signal);
      if (!verified.ok) {
        return {
          ...installed,
          status: 'failed',
          message: verified.message,
        };
      }
      return {
        ...installed,
        message: verified.message === '' ? installed.message : `${installed.message} ${verified.message}`,
      };
    }

    lastFailure = {
      id: installer.id,
      label: installer.label,
      channels: installer.channels,
      status: 'failed',
      command: [candidate.command, ...candidate.args],
      message: `${installer.label} install failed with exit code ${result.code ?? 'signal'}.`,
      stdout: tail(result.stdout),
      stderr: tail(result.stderr),
    };
  }

  if (lastFailure) return lastFailure;

  return {
    id: installer.id,
    label: installer.label,
    channels: installer.channels,
    status: 'skipped',
    message: `No supported installer found for ${installer.label}.`,
  };
}

// Post-install check: exact-match `expected` (or `<binary> <expected>`,
// mirroring verifyCuaDriverVersion) when pinned; otherwise require the binary
// to exist on PATH (gh via brew floats, so presence is all we can assert).
// The version probe runs against the resolved absolute binary path, not the
// bare name: a bare-name probe re-resolves via PATH at spawn time and could
// execute a different (earlier-on-PATH) binary than the one presence-checked.
// Residual: exact stdout match is not authenticity — a same-path binary
// spoofing `--version` output passes. Hash/signature pinning is deliberately
// out of scope (no published checksums for these distributions).
async function verifyInstalledBinary(
  installer: InstallerDefinition,
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<{ ok: boolean; message: string }> {
  const binary = installer.binaries[0] ?? installer.id;
  if (installer.expectedVersion === undefined) {
    if (await hasAnyBinary(installer.binaries, env)) return { ok: true, message: '' };
    return { ok: false, message: `${installer.label} install succeeded but ${binary} not found on PATH.` };
  }
  const expected = installer.expectedVersion;
  const trustedPath = await resolveBinaryPath(installer.binaries, env);
  if (trustedPath === undefined) {
    return { ok: false, message: `${installer.label} install succeeded but ${binary} not found on PATH.` };
  }
  const probe = await runCommand(trustedPath, installer.versionArgs ?? ['--version'], env, signal);
  if (probe.code !== 0) {
    return { ok: false, message: `${installer.label} install succeeded but ${binary} version check failed (exit ${probe.code ?? 'signal'}).` };
  }
  const output = probe.stdout.trim() || probe.stderr.trim();
  if (output !== expected && output !== `${binary} ${expected}`) {
    return { ok: false, message: `${installer.label} version mismatch: expected exact ${expected}, got ${JSON.stringify(output).slice(0, 80)}.` };
  }
  return { ok: true, message: `Verified ${binary} ${expected}.` };
}

function pythonToolCommands(packageName: string, versionPin = ''): InstallCommand[] {
  const spec = `${packageName}${versionPin}`;
  return [
    { command: 'pipx', args: ['install', spec] },
    { command: 'uv', args: ['tool', 'install', spec] },
    { command: 'python3', args: ['-m', 'pip', 'install', '--user', spec] },
  ];
}

async function hasAnyBinary(binaries: string[], env: Record<string, string | undefined>): Promise<boolean> {
  for (const binary of binaries) {
    if (await commandExists(binary, env)) return true;
  }
  return false;
}

/** PATH lookup honoring the Windows `Path` alias, falling back to the process env. */
function pathValueFor(env: Record<string, string | undefined>): string {
  return windowsPathValue(env) || windowsPathValue();
}

async function commandExists(command: string, env: Record<string, string | undefined>): Promise<boolean> {
  if (command.includes('/') || command.includes('\\')) {
    return access(command, constants.X_OK).then(() => true, () => false);
  }
  // Single-spawner rule (migration note): bare install-tool names resolve
  // through resolveCliCommand (src/cli-command.ts, owned by a sibling worker
  // — import only, do not move or edit it). On win32 this mirrors cmd.exe
  // PATHEXT lookup so npm .cmd/.bat shims (pipx/uv/npm-provided tools) are
  // found; on other platforms it returns the command unchanged and the
  // manual PATH scan below applies. runCommand spawns through the same
  // resolver (spawnCliCommand) so probe and spawn agree.
  const resolved = resolveCliCommand(command, { pathValue: pathValueFor(env) });
  if (resolved !== command) {
    return access(resolved, constants.X_OK).then(() => true, () => false);
  }
  const path = pathValueFor(env);
  for (const entry of path.split(delimiter)) {
    if (!entry) continue;
    if (await access(join(entry, command), constants.X_OK).then(() => true, () => false)) return true;
    if (process.platform === 'win32' && await access(join(entry, `${command}.exe`), constants.X_OK).then(() => true, () => false)) return true;
  }
  return false;
}

/** Absolute path of the first resolvable binary (same lookup as commandExists),
 * so version probes execute the trusted installed file instead of re-resolving
 * a bare name via PATH at spawn time. */
async function resolveBinaryPath(binaries: string[], env: Record<string, string | undefined>): Promise<string | undefined> {
  for (const binary of binaries) {
    const found = await resolveSingleBinaryPath(binary, env);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function resolveSingleBinaryPath(command: string, env: Record<string, string | undefined>): Promise<string | undefined> {
  if (command.includes('/') || command.includes('\\')) {
    return access(command, constants.X_OK).then(() => command, () => undefined);
  }
  const resolved = resolveCliCommand(command, { pathValue: pathValueFor(env) });
  if (resolved !== command) {
    return access(resolved, constants.X_OK).then(() => resolved, () => undefined);
  }
  const path = pathValueFor(env);
  for (const entry of path.split(delimiter)) {
    if (!entry) continue;
    const candidate = join(entry, command);
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
    if (process.platform === 'win32') {
      const exeCandidate = join(entry, `${command}.exe`);
      if (await access(exeCandidate, constants.X_OK).then(() => true, () => false)) return exeCandidate;
    }
  }
  return undefined;
}

function runCommand(command: string, args: string[], env: Record<string, string | undefined>, signal?: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> {
  // Single-spawner rule (migration note): never raw-spawn here. spawnCliCommand
  // resolves win32 .cmd/.bat shims up front and routes them via
  // `cmd.exe /d /s /c` with pre-quoted argv instead of a shell, so install
  // args cannot become command injection. All external CLI spawns in this
  // repo must funnel through src/cli-command.ts (sibling-owned; import only).
  return new Promise((resolve) => {
    const child = spawnCliCommand(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: installEnv(env),
      signal,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), COMMAND_TIMEOUT_MS);

    child.stdout?.on('data', (chunk) => { stdout = bounded(stdout + chunk.toString()); });
    child.stderr?.on('data', (chunk) => { stderr = bounded(stderr + chunk.toString()); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr || error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: sanitizeExternalOutput(stdout), stderr: sanitizeExternalOutput(stderr) });
    });
  });
}

function installEnv(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {};
  const keys = [
    'PATH', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'NPM_CONFIG_PREFIX', 'PIPX_HOME', 'PIPX_BIN_DIR', 'UV_TOOL_DIR', 'UV_TOOL_BIN_DIR',
  ];
  for (const key of keys) {
    const value = env[key] ?? process.env[key];
    if (typeof value === 'string') merged[key] = value;
  }
  return merged;
}

function bounded(value: string): string {
  return value.length > OUTPUT_LIMIT ? value.slice(-OUTPUT_LIMIT) : value;
}

function tail(value: string): string {
  return sanitizeExternalOutput(value).slice(-2_000);
}

function sanitizeExternalOutput(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/gi, '$1***')
    .replace(/(set-cookie\s*[:=]\s*)[^\n\r]+/gi, '$1***')
    .replace(/((?:[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTH|COOKIE|CT0)[A-Z0-9_]*|apiKey|authToken)\s*[:=]\s*)[^\s,;]+/gi, '$1***');
}
