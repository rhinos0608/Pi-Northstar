import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

type Baseline = {
  package: {
    name: string;
    version: string;
    nodeFloor: string;
    bin: Record<string, string>;
    files: string[];
  };
  published: {
    requiredFiles: string[];
    allowedTopLevel: string[];
    packedPaths: string[];
  };
  sourceCliBaseline: {
    binPath: string;
    sourceEntrypoint: string;
    tsxLoader: boolean;
    sourceExtension: string;
  };
};

type PackageJson = {
  name: string;
  version: string;
  engines?: { node?: string };
  bin?: Record<string, string>;
  files?: string[];
  scripts?: Record<string, string>;
};

type PackResult = { files: Array<{ path: string }> };

const testDirectory = dirname(fileURLToPath(import.meta.url));
const root = join(testDirectory, '..', '..');
const baseline = JSON.parse(
  readFileSync(join(testDirectory, 'package-baseline.json'), 'utf8'),
) as Baseline;
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJson;

function packedPaths(): string[] {
  const output = execSync('npm pack --dry-run --json', {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result = JSON.parse(output) as PackResult[];
  assert.equal(result.length, 1, 'npm pack must return one package result');
  const [first] = result;
  assert.ok(first);
  return first.files.map(({ path }) => path).sort();
}

test('package identity and source CLI baseline remain frozen', () => {
  assert.equal(packageJson.name, baseline.package.name);
  assert.equal(packageJson.version, baseline.package.version);
  assert.equal(packageJson.engines?.node, baseline.package.nodeFloor);
  assert.deepEqual(packageJson.bin, baseline.package.bin);
  assert.deepEqual(packageJson.files, baseline.package.files);

  const binText = readFileSync(join(root, baseline.sourceCliBaseline.binPath), 'utf8');
  const sourcePathPattern = baseline.sourceCliBaseline.sourceEntrypoint.split('/').join('.*');
  assert.match(binText, new RegExp(sourcePathPattern));
  if (baseline.sourceCliBaseline.tsxLoader) {
    assert.match(binText, /import\.meta\.resolve\(['"]tsx['"]\)/);
    assert.match(binText, /--import/);
    assert.match(packageJson.scripts?.cli ?? '', /tsx/);
  }
});

test('npm packed artifact manifest remains frozen', () => {
  const paths = packedPaths();
  const topLevel = [...new Set(paths.map((path) => path.split('/')[0]))];
  assert.deepEqual(topLevel.sort(), [...baseline.published.allowedTopLevel].sort());
  assert.deepEqual(paths, baseline.published.packedPaths);
  assert.ok(paths.every((path) => !path.includes('.pi-smartread.tags.cache/')), 'packed artifact must exclude generated SmartRead tag caches');
  for (const requiredFile of baseline.published.requiredFiles) {
    assert.ok(paths.includes(requiredFile), `packed artifact missing ${requiredFile}`);
  }

  const sourcePaths = paths.filter((path) => path.startsWith('src/'));
  assert.ok(sourcePaths.every((path) => path.endsWith(baseline.sourceCliBaseline.sourceExtension)));
});
