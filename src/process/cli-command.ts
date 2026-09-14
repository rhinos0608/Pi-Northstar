// Windows CLI command resolution and portable spawn without a shell.
//
// `spawn(cmd, args, { shell: false })` on win32 goes straight to
// CreateProcess, which resolves bare command names to `.exe` only — the
// PATHEXT lookup that finds npm-installed `.cmd`/`.bat` shims (bili-cli,
// opencli, rdt, ...) is a cmd.exe behavior. Routing through a shell instead
// would concatenate argv unescaped (Node DEP0190: a query like `a&b` becomes
// command injection, and requireCliPositional deliberately allows such text),
// so resolve the extension up front (resolveCliCommand) and run `.cmd`/`.bat`
// targets via `cmd.exe /d /s /c` with every argv element pre-quoted
// (spawnCliCommand). Directly spawning a resolved `.cmd` path with
// shell:false fails with `spawn EINVAL` — `.cmd`/`.bat` are not
// CreateProcess images.
//
// Dependency-free except node builtins: importable from any CLI runner.

import { spawn, type ChildProcessByStdio, type SpawnOptions } from 'node:child_process';
import type { Readable } from 'node:stream';
import { existsSync } from 'node:fs';
import { delimiter, join, win32 } from 'node:path';

export interface CliResolveOptions {
  platform?: NodeJS.Platform;
  pathValue?: string;
  pathext?: string;
  exists?: (path: string) => boolean;
}

export interface CliSpawnOptions extends SpawnOptions {
  /** Test seam: target platform. Defaults to process.platform; identical behavior when unset. */
  platform?: NodeJS.Platform;
  /** Test seams forwarded to resolveCliCommand. */
  pathValue?: string;
  pathext?: string;
  exists?: (path: string) => boolean;
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * Resolve a bare CLI command to its on-disk path on Windows, mirroring
 * cmd.exe lookup order (PATH dirs in order, PATHEXT extensions in order,
 * then the bare name). Non-Windows platforms, explicit paths, and misses
 * return the command unchanged so spawn error behavior is preserved.
 */
export function windowsPathValue(env: Record<string, string | undefined> = process.env): string {
  for (const key of ['PATH', 'Path', 'path']) {
    const val = env[key];
    if (typeof val === 'string' && val.length > 0) return val;
  }
  return '';
}

/** Absolute cmd.exe so stripped child envs (shim dir only) still spawn .cmd shims. */
export function windowsCmdExe(env: Record<string, string | undefined> = process.env): string {
  const comspec = env.COMSPEC ?? env.ComSpec ?? env.comspec;
  if (typeof comspec === 'string' && comspec.length > 0) return comspec;
  const root = env.SystemRoot ?? env.systemroot ?? env.windir;
  if (typeof root === 'string' && root.length > 0) return `${root}\\System32\\cmd.exe`;
  return 'C:\\Windows\\System32\\cmd.exe';
}

export function resolveCliCommand(command: string, options: CliResolveOptions = {}): string {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return command;
  if (command.length === 0 || command.includes('/') || command.includes('\\')) return command;
  const pathValue = options.pathValue ?? windowsPathValue();
  if (pathValue.length === 0) return command;
  const extensions = (options.pathext ?? process.env.PATHEXT ?? DEFAULT_PATHEXT)
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('.'));
  if (extensions.length === 0) return command;
  const exists = options.exists ?? existsSync;
  // PATH separator and joining follow the *target* platform so injected
  // win32 lookups behave identically on any host (on real win32 `delimiter`
  // is already ';' and `join` is already win32.join — no behavior change).
  const separator = platform === 'win32' ? ';' : delimiter;
  const joinPath = platform === 'win32' ? win32.join : join;
  const dirs = pathValue
    .split(separator)
    .map((dir) => stripSurroundingQuotes(dir.trim()))
    .filter((dir) => dir.length > 0);
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = joinPath(dir, `${command}${extension}`);
      if (exists(candidate)) return candidate;
    }
    const bare = joinPath(dir, command);
    if (exists(bare)) return bare;
  }
  return command;
}

/** Quoted PATH entries (`"C:\\Program Files\\..."`) are common on Windows. */
function stripSurroundingQuotes(dir: string): string {
  return dir.length >= 2 && dir.startsWith('"') && dir.endsWith('"') ? dir.slice(1, -1) : dir;
}

// ── Portable spawn ──
//
// `.cmd`/`.bat` shims are not CreateProcess images: spawning a resolved
// `.cmd` path with shell:false fails on Windows with `spawn EINVAL`. Routing
// through a shell instead would concatenate argv unescaped (a query like
// `a&b` becomes command injection, and requireCliPositional deliberately
// allows such text), so .cmd/.bat targets go through cmd.exe with every argv
// element pre-quoted by quoteCmdArg — metacharacters inside double quotes
// stay literal to cmd.exe parsing, with one exception: `%` (see below).
//
// Transport detail: the pre-quoted command line is wrapped in one outer pair
// of quotes (`cmd.exe /d /s /c "\"resolved\" \"arg\""`) and spawned with
// `windowsVerbatimArguments` so Node performs no additional quoting. cmd.exe
// then sees a raw command line starting and ending with `"`, and its
// documented `/s` behavior strips exactly that outer pair before executing
// the remainder. Without verbatim arguments Node re-quotes the parameter
// (embedded quotes become `\"`, literal backslashes to cmd parsing), the
// command line no longer starts with `"`, no stripping happens, and cmd
// reports the whole `"\"...\" \"..\""` string as not recognized.
//
// `%` is NOT safe inside quotes: cmd.exe expands %VariableName% on the /c
// command line even inside double quotes, so a model-controlled query like
// `%OPENCLI_TOKEN%` would expand against the child env (which carries
// OPENCLI_TOKEN) before the shim runs. Doubling to `%%` does not help: in
// command-line (/c) context `%%` does not collapse (SS64 syntax-esc), so the
// doubled spelling reaches the child and corrupts valid input. `^%` does not
// help either: `%` expansion runs before caret handling, and inside quotes
// `^` is literal anyway.
//
// quoteCmdArg therefore splits every `%` as `"%"`. The inserted quotes
// poison cmd's %NAME% match (a name containing `"` never resolves), while
// CommandLineToArgvW parses them as quote toggles and strips them, so the
// child receives the original spelling byte-identical — lone `%`, `100%`,
// and undefined %NAME% sequences included. Backslash runs preceding an
// inserted toggle are doubled per CommandLineToArgvW rules so `\%` survives.

/**
 * Quote one argv element for cmd.exe (always double-quoted).
 *
 * `%` is split as `"%"` so cmd.exe cannot expand %NAME% on the /c line
 * (see above); CommandLineToArgvW strips the inserted toggles, restoring
 * the original spelling in the child.
 */
export function quoteCmdArg(value: string): string {
  let body = '';
  let index = 0;
  while (index < value.length) {
    const char = value[index]!;
    if (char === '\\') {
      let end = index;
      while (end < value.length && value[end] === '\\') end++;
      const next = end < value.length ? value[end]! : '';
      const run = value.slice(index, end);
      // A run reaching the closing quote, an embedded quote, or an inserted
      // `"%"` toggle must be doubled: 2n backslashes before a quote yield n
      // backslashes and keep the quote a delimiter (CommandLineToArgvW).
      body += next === '' || next === '"' || next === '%' ? run + run : run;
      index = end;
    } else if (char === '"') {
      body += '""';
      index++;
    } else if (char === '%') {
      body += '"%"';
      index++;
    } else {
      body += char;
      index++;
    }
  }
  return `"${body}"`;
}

/**
 * Resolve `command` (resolveCliCommand) then spawn it portably: Windows
 * `.cmd`/`.bat` targets run via `cmd.exe /d /s /c` with a pre-quoted command
 * line (outer quotes preserve the inner per-arg quoting); everything else
 * spawns directly with shell:false.
 */
/**
 * Build the cmd.exe argv for a resolved `.cmd`/`.bat` target: the pre-quoted
 * command line wrapped in the single outer quote pair cmd `/s /c` strips.
 * Pure (no spawn) so the transport shape is unit-testable on any platform.
 */
export function buildCmdArgv(resolved: string, args: readonly string[]): string[] {
  const inner = [resolved, ...args].map(quoteCmdArg).join(' ');
  return ['/d', '/s', '/c', `"${inner}"`];
}

export function spawnCliCommand(
  command: string,
  args: readonly string[],
  options: CliSpawnOptions = {},
): ChildProcessByStdio<null, Readable, Readable> {
  const platform = options.platform ?? process.platform;
  const resolveOptions: CliResolveOptions = { platform };
  // Win32 PATH lookup must use the env the child will run with: callers pass
  // a sanitized child env (often shim-only PATH) while the parent PATH points
  // elsewhere. Without this, bare commands resolve against the parent and the
  // spawn misses with ENOENT even though the shim is on the child PATH.
  if (options.pathValue !== undefined) resolveOptions.pathValue = options.pathValue;
  else if (platform === 'win32') {
    const childPath = childPathValue(options.env);
    if (childPath !== undefined) resolveOptions.pathValue = childPath;
  }
  if (options.pathext !== undefined) resolveOptions.pathext = options.pathext;
  if (options.exists !== undefined) resolveOptions.exists = options.exists;
  const resolved = resolveCliCommand(command, resolveOptions);
  const { platform: _platform, pathValue: _pathValue, pathext: _pathext, exists: _exists, ...spawnOptions } = options;
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(resolved)) {
    return spawn(cmdExeForSpawn(spawnOptions.env), buildCmdArgv(resolved, args), {
      ...spawnOptions,
      windowsVerbatimArguments: true,
    }) as ChildProcessByStdio<null, Readable, Readable>;
  }
  return spawn(resolved, args, spawnOptions) as ChildProcessByStdio<null, Readable, Readable>;
}

/** Child-env PATH (any case variant) for win32 shim resolution. Exported for unit tests. */
export function childPathValue(spawnEnv: SpawnOptions['env']): string | undefined {
  if (spawnEnv === undefined || spawnEnv === null || typeof spawnEnv !== 'object') return undefined;
  for (const key of ['PATH', 'Path', 'path']) {
    const val = (spawnEnv as Record<string, unknown>)[key];
    if (typeof val === 'string' && val.length > 0) return val;
  }
  return undefined;
}

/**
 * cmd.exe for the `.cmd` transport: explicit child env wins, process.env is
 * the fallback (identical to before when no `env` is passed or it carries
 * COMSPEC/SystemRoot, as every child-env allowlist does).
 */
function cmdExeForSpawn(spawnEnv: SpawnOptions['env']): string {
  if (spawnEnv !== undefined && spawnEnv !== null && typeof spawnEnv === 'object') {
    const combined: Record<string, string | undefined> = { ...process.env };
    for (const [key, value] of Object.entries(spawnEnv)) {
      if (value !== undefined) combined[key] = String(value);
    }
    return windowsCmdExe(combined);
  }
  return windowsCmdExe();
}
