// Pure builder for the win32 `.cmd` twin of a POSIX shell test shim.
//
// Test shims are `#!/bin/sh` scripts; on win32 the runner resolves the bare
// command to `<name>.CMD` via PATHEXT, so each shim needs a batch twin with
// equivalent observable behavior: env-dump bodies become `set` dumps (same
// KEY=value shape; avoids nested-quote breakage of node -e under cmd.exe),
// `echo 'payload'` bodies print their payload, and the exit code is kept.
// Pure so the translation is unit-testable on any host.

export function cmdTwinBody(shBody: string): string {
  const dumpMatch = />\s*(\S+)\s*$/.exec(shBody.split('\n').find((line) => line.includes('>')) ?? '');
  const payloads = [...shBody.matchAll(/echo\s+'([^']*)'/g)].map((m) => m[1] ?? '');
  const exitMatch = /exit\s+(\d+)/.exec(shBody);
  const lines = ['@echo off'];
  if (dumpMatch?.[1]) {
    lines.push(`set > ${JSON.stringify(dumpMatch[1])}`);
  }
  for (const payload of payloads) lines.push(`echo ${payload}`);
  lines.push(`exit /b ${exitMatch?.[1] ?? '0'}`);
  return `${lines.join('\r\n')}\r\n`;
}
