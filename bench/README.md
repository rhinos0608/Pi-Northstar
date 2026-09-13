# Search-backend spawn benchmarks

Diagnostic harnesses for the `CliSearchBackend` per-call process cost.
Not tests: numbers are host-specific, informational only. Re-run on any
host before sizing concurrency controls — do not treat the table below
as a universal budget.

## `cli-spawn-bench.mjs`: per-tool-call spawn tax + fanout stress

Times the cheapest real CLI command (`status`: pure env read, no network)
through the exact spawn argv `CliSearchBackend` uses
(`node --import tsx src/cli/cli.ts …`), sequential and at parallelism
1/4/8/16/32, plus an in-process `runCommand(['status'])` A/B isolating
spawn cost from work cost. Real `call web_search` spawns cost **at least**
this much (same boot + real provider work), so treat all figures as lower
bounds.

Run: `npm run bench:cli-spawn` (repo root). No network, minimal env.

### Baseline — 2026-09-14, Apple M1 Pro (10 cores), 32 GB, Node v25.9.0

| signal | mean | p50 | p95 | max |
|---|---|---|---|---|
| sequential spawn `status` (n=10) | 305 ms | 307 ms | 317 ms | 317 ms |
| in-process `runCommand status` (n=10) | ~0 ms | ~0 ms | ~0 ms | ~0 ms |

Spawn tax ≈ **~300 ms per tool call**, ~all of it Node boot + tsx compile.

| parallel spawns | wall | per-call p50 | per-call p95 | throughput |
|---|---|---|---|---|
| 1 | 309 ms | 309 ms | 309 ms | 3 spawns/s |
| 4 | 362 ms | 359 ms | 361 ms | 11 spawns/s |
| 8 | 585 ms | 562 ms | 585 ms | 14 spawns/s |
| 16 | 1003 ms | 979 ms | 1000 ms | 16 spawns/s |
| 32 | 2006 ms | 1915 ms | 1985 ms | 16 spawns/s |

Throughput plateaus at **~16 spawns/s** on this host; beyond 8-way
parallelism every call pays contention (p50 6× worse at 32-way).

### Amplification model

One `web_search` fans out to up to 3 providers by default (max 8 when
`PI_SEARCH_WEB_BACKENDS` is explicit), each a fresh spawn on the CLI
backend — concurrent via `Promise.allSettled`, so unloaded wall ≈ one
~300 ms spawn. Under agent pools it multiplies:

- 32 agents × 3 providers ≈ **96 concurrent spawns** → ~2 s spawn tax per
  call on M1-Pro-class hardware (measured 32-way p50 1.9 s).
- 64 agents × 8 providers ≈ **512 concurrent spawns** → unmeasured;
  extrapolating the plateau, expect multi-second latency and heavy CPU
  contention from tsx compilation alone.

### Escape hatch (already in the architecture)

`SEARCH_BACKEND=mcp` selects `SearchMcpClient`, which single-flights its
initial connection and reuses one persistent stdio transport across calls
until `close()` — no per-call spawn. Prefer it for pool deployments;
keep the CLI backend default for isolation (one-shot children share no
state and inherit only the env allowlist).

### Policy

No global semaphore yet, deliberately: benchmark first, then decide.
Before adding one, re-run this harness on the deployment host and pair
it with a provider-fanout cap decision (default-3 vs max-8). A semaphore
is the obvious next control if pool latency tracks this curve.
