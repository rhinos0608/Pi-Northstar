// Windows CLI command resolution without a shell.
//
// `spawn(cmd, args, { shell: false })` on win32 goes straight to
// CreateProcess, which resolves bare command names to `.exe` only — the
// PATHEXT lookup that finds npm-installed `.cmd`/`.bat` shims (bili-cli,
// opencli, rdt, ...) is a cmd.exe behavior. Routing through a shell instead
// would concatenate argv unescaped (Node DEP0190: a query like `a&b` becomes
// command injection, and requireCliPositional deliberately allows such text),
// so resolve the extension up front and keep shell:false. libuv executes
// resolved `.cmd`/`.bat` paths directly and quotes argv for CreateProcess
// itself, so arguments never reach cmd.exe parsing.
//
// Dependency-free except node builtins: importable from any CLI runner.

import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface CliResolveOptions {
  platform?: NodeJS.Platform;
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
export function resolveCliCommand(command: string, options: CliResolveOptions = {}): string {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return command;
  if (command.length === 0 || command.includes('/') || command.includes('\\')) return command;
  const pathValue = options.pathValue ?? process.env.PATH ?? '';
  if (pathValue.length === 0) return command;
  const extensions = (options.pathext ?? process.env.PATHEXT ?? DEFAULT_PATHEXT)
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('.'));
  if (extensions.length === 0) return command;
  const exists = options.exists ?? existsSync;
  const dirs = pathValue.split(delimiter).filter((dir) => dir.length > 0);
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = join(dir, `${command}${extension}`);
      if (exists(candidate)) return candidate;
    }
    const bare = join(dir, command);
    if (exists(bare)) return bare;
  }
  return command;
}
