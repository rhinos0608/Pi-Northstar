import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
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
    commands: pythonToolCommands('yt-dlp'),
  },
  {
    id: 'opencli',
    label: 'OpenCLI',
    channels: ['twitter', 'reddit', 'xiaohongshu', 'facebook', 'instagram', 'bilibili'],
    binaries: ['opencli'],
    // Pinned to the verified version declared in social-opencli.ts (OPENCLI_VERSION).
    commands: [{ command: 'npm', args: ['install', '-g', '@jackwener/opencli@1.8.6'] }],
  },
  {
    id: 'twitter-cli',
    label: 'twitter-cli',
    channels: ['twitter'],
    binaries: ['twitter'],
    core: true,
    // Pinned to the verified version declared in social-twitter.ts (0.8.5).
    commands: pythonToolCommands('twitter-cli', '==0.8.5'),
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
  },
  {
    id: 'bili-cli',
    label: 'bili-cli',
    channels: ['bilibili'],
    binaries: ['bili'],
    commands: pythonToolCommands('bilibili-cli'),
  },
  {
    id: 'xhs-cli',
    label: 'xhs-cli',
    channels: ['xiaohongshu'],
    binaries: ['xhs'],
    commands: pythonToolCommands('xhs-cli'),
  },
  {
    id: 'mcpporter',
    label: 'mcpporter',
    channels: ['search'],
    binaries: ['mcpporter'],
    core: true,
    commands: [{ command: 'npm', args: ['install', '-g', 'mcpporter'] }],
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
    return {
      id: installer.id,
      label: installer.label,
      channels: installer.channels,
      status: 'present',
      message: `${installer.label} already installed.`,
    };
  }

  let lastFailure: InstallerResult | undefined;
  for (const candidate of installer.commands) {
    if (candidate.platforms && !candidate.platforms.includes(process.platform)) continue;
    if (!(await commandExists(candidate.command, env))) continue;

    const result = await runCommand(candidate.command, candidate.args, env, signal);
    if (result.code === 0) {
      return {
        id: installer.id,
        label: installer.label,
        channels: installer.channels,
        status: 'installed',
        command: [candidate.command, ...candidate.args],
        message: `${installer.label} install command completed.`,
        stdout: tail(result.stdout),
        stderr: tail(result.stderr),
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

async function commandExists(command: string, env: Record<string, string | undefined>): Promise<boolean> {
  if (command.includes('/') || command.includes('\\')) {
    return access(command, constants.X_OK).then(() => true, () => false);
  }
  const path = env.PATH ?? process.env.PATH ?? '';
  for (const entry of path.split(delimiter)) {
    if (!entry) continue;
    if (await access(join(entry, command), constants.X_OK).then(() => true, () => false)) return true;
    if (process.platform === 'win32' && await access(join(entry, `${command}.exe`), constants.X_OK).then(() => true, () => false)) return true;
  }
  return false;
}

function runCommand(command: string, args: string[], env: Record<string, string | undefined>, signal?: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
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
