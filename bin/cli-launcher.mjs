import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function launchCli() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const compiled = join(root, 'dist', 'cli', 'cli.js');
  const source = join(root, 'src', 'cli', 'cli.ts');
  let command;
  if (process.env.PI_NORTHSTAR_SOURCE_FALLBACK !== '1' && existsSync(compiled)) {
    command = [compiled];
  } else if (process.env.PI_NORTHSTAR_SOURCE_FALLBACK === '1') {
    let tsx;
    try {
      tsx = import.meta.resolve('tsx');
    } catch {
      console.error('Source fallback requires dev dependency tsx.');
      process.exit(1);
    }
    command = ['--import', tsx, source];
  } else {
    console.error('Compiled CLI missing; set PI_NORTHSTAR_SOURCE_FALLBACK=1 for development source fallback.');
    process.exit(1);
  }
  const child = spawn(process.execPath, [...command, ...process.argv.slice(2)], { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
  child.on('error', (error) => {
    console.error(error.message);
    process.exit(1);
  });
}
