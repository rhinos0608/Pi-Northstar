# Roadmap Ledger: Northstar CLI-First Staged Plan Reconciliation

**Document status:** verified against repository evidence and execution plan (`plan.md`).  
**Baseline branch:** `design/northstar-cli-skill-router`  
**Reference plan:** `plan.md` (Phases 0–9, Gates A and B)  
**Execution audit date:** March 29, 2026  
**Gate B Tier-1 closeout date:** September 21, 2026  

---

## Executive Summary

This ledger reconciles the staged architecture plan (`plan.md`) with verified live repository evidence. Northstar is undergoing a CLI-first hard cut:
- Model-facing native tools default to **zero** (`PUBLIC_TOOL_ALLOWLIST_ENV_VAR`, `PI_SEARCH_NATIVE_TOOLS`), requiring explicit profile configuration.
- Broad portable surfaces move to compiled CLI commands (`northstar <domain> <action>`) accompanied by skills and untrusted evidence wrapping.
- Canonical caller-neutral domain handlers in `src/commands/` serve direct invocations, CLI renderers, and optional Pi native tool adapters alike.

### Key Milestones Verified
1. **Phase 2 Raw-Call Closure Verified:** `call TOOL JSON` public debug/dispatch bypass is completely retired. Migrated commands route through canonical registry handlers (`src/commands/command-registry.ts`). Private worker transport (`src/cli/worker.ts`, `src/cli/cli-backend.ts`) uses closed canonical request shapes and rejects raw-tool protocol.
2. **Phase 4 Stateless Migrated Command Coverage Complete:** All 28 stateless migrated command IDs (20 dual + 8 CLI+skill) are wired to canonical handlers with tri-mode rendering, CLI help/grammar, and bypass closure. Residual internal dispatcher branches in `src/native-tools.ts` and `cli-backend.ts` remain isolated for Phase 7 deletion.
3. **Phase 5 / Gate B Tier-1 Implementation Complete (2026-09-21):** Standalone Rust broker (`northstar-broker`) and TS v2 contract implemented across 13 slices. Version 2 wire protocol with mandatory `kind`, kernel attestation scaffolding (Unix live, Windows DACL frozen at ACE `0x0012019F`), memory-only HMAC grants (60s TTL), bundled SQLite receipts (rusqlite 0.40.2 / SQLite 3.49.0, WAL/FULL/fullfsync), dual lifecycle + single-owner lock, settle engine, scoped workers, installer skeleton + release CI, TCB manifest gate (verify-if-enrolled), and additive unregistered grammar. Research gates R-1..R-8 resolved. Evidence: TS 3995 pass/0 fail, Rust 78 pass/0 fail, typecheck + cargo clean, hostile suites green.
4. **Stateful Public CLI Remains Closed:** Stateful commands (`jobs`, `broker`, `browser`, `desktop`) remain unexposed in public CLI grammar (28 stateless IDs unchanged; `broker.serve` and `jobs.status` handlers exist but unregistered). Stateful unlock gated on Tier-2 proof.
5. **Phases 6–9 Status:** Phase 6 groundwork verified, awaiting Tier-2 proof and final release closure. Obsolete authority deletion (Phase 7) is running separately. Aggressive provider additions (Phase 8) and multi-harness token/timing benchmarks (Phase 9 release gates) remain post-cut work requiring Tier-2 proof + stateful unlock.

---

## Phase Breakdown (0–9)

| Phase | Title | Status | Summary & Evidence |
|---|---|---|---|
| **Phase 0** | Contract Freeze, Baseline & Architecture Gates | **Complete** | Versioned `CommandResultV1<T>` envelope implemented in `src/commands/command-result.ts` with 9 distinct outcomes (`success`, `empty`, `partial`, `degraded`, `failed`, `cancelled`, `suppressed`, `stale`, `outcome_unknown`). Tri-mode CLI renderers (`human`, `json`, `agent` with untrusted-content fencing) active in `src/commands/command-render.ts`. Architecture gates and artifact boundaries verified. |
| **Phase 1** | Canonical Stateless Command Seam | **Complete** | Canonical `CommandContext`, handler registration, and outcome mapping established in `src/commands/command-context.ts` and `src/commands/command-registry.ts`. Initial seam `github.file` fully wired across direct caller, CLI (`src/commands/github-file-handler.ts`), and native tool adapter, preserving terminal auth/invalid_request states and backend clone/REST fallback. |
| **Phase 2** | Compiled CLI & Private Worker Boundary | **Complete** | Binaries `bin/northstar.mjs` and `bin/pi-northstar.mjs` present. Private worker boundary (`src/cli/worker.ts`) replaces public raw tool dispatch. Raw-call closure verified (`test/cli/cli.test.ts`, `test/cli/cli-backend.test.ts`): public `call` rejects even if legacy debug gates set. Capability-scoped child environments enforced (`src/cli/cli-backend.ts`). |
| **Phase 3** | Skills, Router, Tool Profiles & HARD CUT | **Complete** | Hard-cut default zero native-tool exposure enforced (`parsePublicToolAllowlist` in `src/capabilities.ts`, verified in `test/contract.test.ts`). Compact router and domain skill structures added under `skills/` and `src/skills/`. CLI acts as primary schema/transport escape hatch. |
| **Phase 4** | Command Coverage Expansion & Central Dispatch Retirement | **Complete** *(Coverage complete; Phase 7 residual cleanup separate)* | Broad read/search commands migrated to caller-neutral handlers in `src/commands/`: `github.*` (12 commands), `research.*` (3 commands), `kg.*` (2 commands), `graph.*` (2 commands), `social.*` (2 commands), `media.*` (5 commands), and `fetch.read`/`search.web`. Total: 28 migrated command IDs (20 dual + 8 CLI+skill). Parity and bypass closure verified. Central-dispatch retirement of residual unmigrated code (`browse`, legacy fallbacks) separated to Phase 7. |
| **Phase 5** | Integrate & Harden Runtime/State Work | **Tier-1 Complete; Tier-2 Open** *(Stateful CLI Closed)* | **Gate B Tier-1 complete across 13 slices (2026-09-21):** Rust `northstar-broker` + TS v2 contract, memory-only HMAC grants, bundled SQLite receipts (rusqlite 0.40.2 / SQLite 3.49.0), dual lifecycle + single-owner lock, settle engine, scoped workers, TCB manifest gate, installer skeleton + release CI, hostile suites green (TS 3995 pass, Rust 78 pass). All 8 research gates R-1..R-8 resolved.<br>**Tier-2 privileged proof is OPEN:** Signed installers, per-job isolation, kill-to-zero, live socket denial out-of-scope for unprivileged machine; documented in `docs/tier2-proof.md`.<br>**Stateful public reachability closed by design:** 28 stateless IDs unchanged; `broker.serve` and `jobs.status` handlers implemented but unregistered. |
| **Phase 6** | Release Parity & Public-Surface Closure | **Blocked** *(Groundwork verified; blocked by Tier-2 Gate B proof & Phase 7)* | Stateless capability matrix (28 migrated commands) and package install smoke are verified. However, overall Phase 6 sign-off is blocked pending Tier-2 Gate B proof and final release closure gates. |
| **Phase 7** | Delete Obsolete Authority | **Outstanding** | Deletion of residual internal dispatch branches in `src/native-tools.ts` / `src/cli/cli-backend.ts`, legacy schema definitions, and old report paths scheduled after Phase 6. AGENTS.md owner map synchronization required at deletion commit. |
| **Phase 8** | Aggressive Provider/Capability Expansion | **Outstanding** | Expansion of SERP-only providers, academic sources, cloud browser backends, and async crawling scheduled after clean hard-cut baseline. |
| **Phase 9** | Cross-Harness Validation & Release Discipline | **Outstanding** | Systematic multi-harness token evaluation (Pi zero-tool, Pi explicit-profile, Claude Code / shell, local model CLI) and CodeScene delta analysis scheduled for final release qualification. |

---

## Detailed Gate & Phase Evidence

### Phase 2: Raw-Call Closure (Verified)
- **Files:** `src/cli/cli.ts`, `src/cli/worker.ts`, `src/cli/cli-backend.ts`
- **Tests:** `test/cli/cli.test.ts`, `test/cli/cli-backend.test.ts`
- **Evidence:**
  - `public call rejects even when the former debug gate is enabled` passed.
  - `compiled worker accepts closed canonical request and preserves handler result` passed.
  - `compiled worker rejects unexpected request keys` passed.
  - `compiled worker rejects the retired raw-tool protocol` passed.
  - No public `call TOOL JSON` syntax is documented or accepted.

### Phase 4: Stateless Migrated Command Coverage (Complete)
- **Files:** `src/commands/*.ts`, `src/skills/skill-registry.ts`, `src/native-tools.ts`
- **Tests:** `test/commands/*.test.ts`, `test/cli/*.test.ts`, `test/web/web-*-pi-parity.test.ts`
- **Evidence:**
  - All 28 command IDs (20 dual CLI+tool, 8 CLI+skill) registered and tested across direct, CLI, and Pi adapters.
  - Bypass closure verified via `test/cli/fetch-search-cli.test.ts` and `test/native-tools-routing-regression.test.ts`.
  - Media classified internal/CLI acquisition only (5 CLI+skill commands, 0 public native tools).
  - Residual seams (`browse`, legacy helper paths in `src/native-tools.ts`) tracked for Phase 7 deletion.

### Phase 5 & Gate B: Native Authority Boundary (Tier-1 Complete; Tier-2 Open — 2026-09-21)
- **Commits on `design/northstar-cli-skill-router`:**
  - `87b1b2c` docs(gate-b): authority boundary ADR, implementation plan, installer and Tier-2 guides
  - `1f160c4` feat(gate-b): Rust northstar-broker with full test suite
  - `c7a9917` feat(gate-b): broker-v2 TS contract, lifecycle host, golden fixtures
  - `3480d71` feat(gate-b): TCB manifest gate, enrollment tooling, installer and release CI
  - `eb2c8e2` feat(gate-b): additive stateful grammar handlers, unregistered
- **Status:** **Tier-1 COMPLETE across 13 slices.** Final review OK with P0/P1 issues found and fixed. Tier-2 privileged integration proof is OPEN.
- **Implemented Reality (13 Slices):**
  1. **Broker-v2 wire parity:** TS + Rust parity, mandatory `kind` discriminator, version/kind gated (`BROKER_PROTOCOL_VERSION = 2`), length-prefixed frame codec, golden fixtures (`test/fixtures/rpc-golden/`).
  2. **Kernel attestation scaffolding:** Unix peer credentials live (`SO_PEERCRED`/`getpeereid`/`LOCAL_PEERPID`), Windows DACL frozen at ACE `0x0012019F` with `PIPE_REJECT_REMOTE_CLIENTS`.
  3. **Memory-only HMAC grants:** Ephemeral root key generated in heap via CSPRNG, zeroized on shutdown, 60s session token TTL, server-owned CLI grant ceiling.
  4. **Bundled SQLite receipts:** `rusqlite 0.40.2` / `SQLite 3.49.0` (libsqlite3-sys 0.38.2), WAL mode, `PRAGMA synchronous = FULL`, `PRAGMA fullfsync = 1`, 4-state journal, BEGIN IMMEDIATE, 4096B bounds.
  5. **Dual lifecycle & single-owner lock:** Foreground terminal `serve` + session-owned Pi host, single-owner advisory lock (`broker.lock`) with owner-validated fail-closed recovery, probe-only client path.
  6. **Settle engine:** 1..64 runIds, 1..10000ms window, per-client isolation.
  7. **Scoped workers:** Empty-base env, denied sensitive prefixes, kill-to-zero.
  8. **Installer skeleton & release CI:** WiX (`broker.wxs`), macOS pkgbuild/productbuild scripts, systemd unit, GitHub Actions release pipeline (`.github/workflows/northstar-release.yml`).
  9. **TCB manifest gate:** Verify-if-enrolled driver gate (`src/desktop/driver-manifest.ts`) on `cua-driver` and `agent-browser` launch paths, artifact enrollment CLI (`scripts/enroll-artifacts.mjs`).
  10. **Additive unregistered grammar:** `broker.serve` (`src/commands/broker-serve-handler.ts`) and `jobs.status` (`src/commands/jobs-status-handler.ts`) implemented but unregistered.
- **Research Gates Resolved (R-1..R-8):** R-1 (Windows DACL 0x0012019F), R-2 (macOS LOCAL_PEERPID / LOCAL_PEERCRED), R-3 (rusqlite 0.40.2 / SQLite 3.49.0 compile-proven), R-4 (WiX v4 in CI), R-5 (macOS notarytool), R-6 (Linux DynamicUser root service), R-7 (macOS service pool & kill-to-zero), R-8 (driver SHA-256 manifest verification).
- **Stateful Public CLI Remains Closed:** 28 stateless IDs unchanged. Stateful grammar remains unregistered pending Tier-2 proof.
- **Tier-2 Privileged Proof Handoff:** Documented in `docs/tier2-proof.md`. Requires privileged runners/VMs for live root/admin signed installer testing, live per-job UID/AppContainer isolation, live kill-to-zero on daemonized processes, live socket denial, and Authenticode/spctl checks.
- **Residual Risk Register:**
  1. PID-recycling TOCTOU: macOS `LOCAL_PEERPID` advisory; UID check authoritative against cross-user impersonation.
  2. Lock-liveness TOCTOU: File lock advisory; endpoint probe re-verifies live health.
  3. Model text must never spawn broker: Negative tests enforce no auto-spawn on client unavailable.
  4. Unenrolled manifest equals status quo: Driver launch permits execution when manifest is absent until Slice-12 packaging enrollment.

### Phase 6: Release Parity Groundwork (Verified Groundwork; Phase Blocked)
- **Files:** `northstar-capability-matrix.md`, `package.json`, `bin/*`
- **Status:** Stateless matrix complete and verified. Release packaging, compiled artifacts, and clean-install smoke pass. Full Phase 6 release sign-off remains blocked by Gate B and Phase 7 cleanup.

---

## Commands Run & Validation Summary

| Command | Status | Details / Output |
|---|---|---|
| `npm run build` | **Passed** | TypeScript build (`tsc -p tsconfig.build.json`) completed with 0 errors. |
| `npm run typecheck` | **Passed** | Clean TypeScript compile (`tsc --noEmit`), 0 errors across entire workspace. |
| `git diff --check` | **Passed** | No whitespace, newline, or merge conflict marker issues in working tree. |
| `node --import tsx --test test/web/web-fetch-route-contract.test.ts test/web/web-search-route-contract.test.ts test/web/web-fetch-pi-parity.test.ts test/web/web-search-pi-parity.test.ts test/commands/fetch-read-handler.test.ts test/commands/search-web-handler.test.ts test/cli/fetch-search-cli.test.ts test/web/access/web-access-contract.test.ts` | **Passed** | Focused fetch/route acceptance suite: 65 passed, 0 failed, 0 skipped. |
| `npm test` | **Passed** | Full workspace test suite: 3,959 passed, 0 failed, 11 skipped across 50 test suites (duration ~52s). |
| Isolated npm pack + clean install smoke | **Passed** | Tarball packed, installed into clean temp directory; binaries (`northstar`, `pi-northstar`), `--version`, `--help`, and `domains` command passed without error; published files manifest verified. |

---

## Traceability & Source/Test Index

### Canonical Handlers & CLI
- `src/commands/command-result.ts` / `src/commands/command-render.ts`
- `src/commands/command-context.ts` / `src/commands/command-registry.ts`
- `src/commands/github-*.ts` / `test/cli/cli.test.ts`
- `src/commands/search-web-handler.ts` / `src/commands/fetch-read-handler.ts` / `test/cli/fetch-search-cli.test.ts`
- `src/commands/kg-search-handler.ts` / `src/commands/graph-query-handler.ts` / `test/cli/kg-graph-cli.test.ts`
- `src/commands/media-*.ts` / `test/cli/media-cli.test.ts`
- `src/commands/research-*.ts` / `test/cli/research-paper-citations-cli.test.ts`
- `src/commands/social-*.ts` / `test/cli/social-cli.test.ts`

### Broker & Runtime Authority (Gate B Tier-1 Complete; Tier-2 Open)
- TypeScript v2 runtime: `src/runtime/broker-*.ts` / `test/runtime/broker-*.test.ts`
- Rust broker: `rust/crates/northstar-broker/src/*.rs` / `rust/crates/northstar-broker/tests/*.rs`
- Golden fixtures & tests: `test/fixtures/rpc-golden/*.json` / `test/runtime/runtime-rpc-golden.test.ts` / `rust/crates/northstar-broker/tests/golden_conformance_tests.rs`
- Driver TCB manifest: `src/desktop/driver-manifest.ts` / `test/desktop/driver-manifest.test.ts` / `scripts/enroll-artifacts.mjs`
- Installer & CI: `installer/` / `.github/workflows/northstar-release.yml`
- Additive handlers (unregistered): `src/commands/broker-serve-handler.ts` / `src/commands/jobs-status-handler.ts` / `test/commands/broker-serve-handler.test.ts` / `test/commands/jobs-status-handler.test.ts`
