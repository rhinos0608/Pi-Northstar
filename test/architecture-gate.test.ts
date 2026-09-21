import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const IMPORT_RE = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

function specifiersFromSource(source: string): string[] {
  IMPORT_RE.lastIndex = 0;
  return [...source.matchAll(IMPORT_RE)].map((match) => match[1]).filter((value): value is string => value !== undefined);
}

async function importsOf(relativePath: string): Promise<string[]> {
  const source = await readFile(resolve(ROOT, relativePath), 'utf8');
  return specifiersFromSource(source);
}

function localTarget(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(ROOT, dirname(from), specifier).replace(/\.js$/, '');
  return base.endsWith('.ts') ? base : `${base}.ts`;
}

async function assertNoImports(from: string, forbidden: readonly string[]): Promise<void> {
  const imports = await importsOf(from);
  for (const specifier of imports) {
    const target = localTarget(from, specifier);
    if (target === undefined) continue;
    assert.ok(
      !forbidden.some((path) => target === resolve(ROOT, path)),
      `${from} must not import ${target.replace(`${ROOT}/`, '')}`,
    );
  }
}

async function assertImports(from: string, required: readonly string[]): Promise<void> {
  const imports = (await importsOf(from))
    .map((specifier) => localTarget(from, specifier))
    .filter((target): target is string => target !== undefined);
  for (const path of required) {
    assert.ok(imports.includes(resolve(ROOT, path)), `${from} must import ${path}`);
  }
}

test('import scanner detects static, dynamic, and side-effect imports', () => {
  const source = [
    "import foo from './static-a';",
    'import { bar } from "./static-b";',
    "import './side-effect-a';",
    'import "./side-effect-b";',
    'const lazyA = await import("./dynamic-a");',
    "const lazyB = await import('./dynamic-b');",
  ].join('\n');
  assert.deepEqual(specifiersFromSource(source), [
    './static-a',
    './static-b',
    './side-effect-a',
    './side-effect-b',
    './dynamic-a',
    './dynamic-b',
  ]);
});

test('runtime protocol stays isolated from host and adapter layers', async () => {
  const imports = await importsOf('src/runtime/runtime-rpc-protocol.ts');
  assert.deepEqual(imports, [], 'runtime protocol must remain self-contained');
  await assertNoImports('src/runtime/leaf-runtime-client.ts', [
    'src/index.ts',
    'src/native-tools.ts',
    'src/cli/cli.ts',
    'src/web/agent/agent-rpc.ts',
  ]);
  await assertImports('src/runtime/leaf-runtime-client.ts', ['src/runtime/runtime-rpc-protocol.ts']);
});

test('capability registry does not depend on Pi, runtime, CLI, or dispatcher code', async () => {
  await assertNoImports('src/capabilities.ts', [
    'src/index.ts',
    'src/native-tools.ts',
    'src/cli/cli.ts',
    'src/runtime/runtime-rpc-protocol.ts',
    'src/runtime/leaf-runtime-client.ts',
  ]);
  await assertImports('src/capabilities.ts', ['src/social/social-contract.ts']);
});

test('CLI stays isolated from native dispatcher (one-way adapter/command isolation)', async () => {
  await assertNoImports('src/cli/cli.ts', ['src/native-tools.ts']);
  await assertNoImports('src/native-tools.ts', [
    'src/cli/cli.ts',
    'src/cli/cli-backend.ts',
    'src/index.ts',
  ]);
  // Slice 2 deleted the legacy native research() branch (the only direct
  // web-contract consumer in the dispatcher); research now rides the
  // registry handler, so the seam pins only the handler-adjacent edges.
  await assertImports('src/native-tools.ts', [
    'src/github/github-domain.ts',
  ]);
  await assertNoImports('src/native-tools.ts', [
    'src/web/web-contract.ts',
  ]);
});

test('current production composition edges remain reachable', async () => {
  await assertImports('src/index.ts', [
    'src/capabilities.ts',
    'src/runtime/leaf-runtime-client.ts',
    'src/web/agent/agent-rpc.ts',
  ]);
});
