// CLI spawn-overhead stress benchmark (diagnostic, not a test).
//
// Question: what does one CliSearchBackend tool call cost in process-spawn
// overhead, and how does it amplify under concurrent-agent fanout?
//
// Method: time the cheapest real CLI command (`status`, pure env read, no
// network) through the exact spawn argv CliSearchBackend uses
// (`node --import tsx src/cli/cli.ts status`), sequential and at parallelism
// 1/4/8/16/32. A/B against in-process runCommand(['status']) to isolate
// spawn cost from work cost. Reports per-call p50/p95 + wall time.
//
// Run: `node bench/cli-spawn-bench.mjs` (repo root). No network, no secrets:
// the child inherits a minimal PATH/HOME-only env.
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import os from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli', 'cli.ts');
const TSX = import.meta.resolve('tsx');
const MIN_ENV = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function summarize(name, samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return {
    name,
    n: samples.length,
    mean_ms: Math.round(mean),
    p50_ms: Math.round(percentile(sorted, 50)),
    p95_ms: Math.round(percentile(sorted, 95)),
    max_ms: Math.round(sorted[sorted.length - 1]),
  };
}

function spawnStatusOnce() {
  const start = performance.now();
  const child = spawnSync(process.execPath, ['--import', TSX, CLI, 'status'], {
    env: MIN_ENV,
    encoding: 'utf8',
    timeout: 120_000,
  });
  const ms = performance.now() - start;
  if (child.status !== 0) throw new Error(`status spawn failed: ${child.stderr.slice(0, 300)}`);
  return ms;
}

function spawnStatusAsync() {
  return new Promise((resolvePromise, reject) => {
    const start = performance.now();
    const child = spawn(process.execPath, ['--import', TSX, CLI, 'status'], {
      env: MIN_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`status spawn failed: ${stderr.slice(0, 300)}`));
      else resolvePromise(performance.now() - start);
    });
  });
}

// Warmup: tsx loader + V8 compile caches are cold on first spawn.
spawnStatusOnce();
spawnStatusOnce();

// A. Sequential spawn cost (N=10).
const sequential = [];
for (let i = 0; i < 10; i++) sequential.push(spawnStatusOnce());

// B. In-process cost of the same work (isolates spawn overhead).
const { runCommand } = await import('../src/cli/cli.ts');
await runCommand(['status'], MIN_ENV);
await runCommand(['status'], MIN_ENV);
const inProcess = [];
for (let i = 0; i < 10; i++) {
  const start = performance.now();
  await runCommand(['status'], MIN_ENV);
  inProcess.push(performance.now() - start);
}

// C. Concurrent fanout: K parallel spawns, wall + per-call distribution.
const levels = [1, 4, 8, 16, 32];
const concurrency = [];
for (const k of levels) {
  const wallStart = performance.now();
  const samples = await Promise.all(Array.from({ length: k }, () => spawnStatusAsync()));
  const wall = performance.now() - wallStart;
  concurrency.push({ parallelism: k, wall_ms: Math.round(wall), ...summarize('per-call', samples), spawns_per_s: Math.round((k / wall) * 1000) });
}

const report = {
  host: {
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus().length,
    cpu_model: os.cpus()[0]?.model ?? 'unknown',
    total_mem_mb: Math.round(os.totalmem() / 1024 / 1024),
    node: process.version,
  },
  sequential_spawn: summarize('spawn status', sequential),
  in_process: summarize('runCommand status', inProcess),
  concurrency,
  // Amplification model: one web_search fans out to up-to-3 default providers
  // (max 8 explicit), each a fresh spawn on the CLI backend.
  fanout_model: {
    default_providers_per_search: 3,
    max_providers_per_search: 8,
    per_provider_spawn_p50_ms: summarize('spawn status', sequential).p50_ms,
  },
};

console.log(JSON.stringify(report, null, 2));
