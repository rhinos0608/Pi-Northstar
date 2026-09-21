# Gate B Implementation Plan: Native Authority Boundary, Bundled SQLite & Worker Service

**Status:** Approved Direction / Draft (Implementation not started).
**Context:** Implements the native authority boundary approved in [ADR 0010: Gate B native authority boundary](../adr/0010-gate-b-native-authority-boundary.md) and required by Phase 5 of `plan.md`.

---

## 1. Executive Summary & Non-Negotiable Constraints

Stateful Northstar operations (`jobs`, background tasks, state queries, cancellation, browser, desktop) require a hardened native authority boundary. This plan establishes a standalone Rust broker (`northstar-broker`), peer-attested handshake without client root secrets, bundled-SQLite receipt authority, a private Node executor channel, dual lifecycle ownership, and an opt-in signed native installer for `northstar-worker-service` with per-job identity isolation.

### Non-Negotiable Invariants
1. **Public Stateful CLI Stays Closed**: Stateful public CLI commands remain locked until Slice 13 completes Gate B acceptance. Stateless commands (28 current command IDs) remain unaffected. When unlocked, standard CLI commands connect only to an existing healthy broker (or run `northstar broker serve` explicitly); absence returns a typed unavailable error and never auto-spawns background authority.
2. **Never Elevate via npm or Node**: Neither `npm postinstall`, `sudo northstar`, nor Node scripts may ever invoke privilege escalation or install system daemons.
3. **No Client Root Secrets**: The broker root signing key resides solely in Rust broker memory. Admission is based on kernel peer UID/SID/PID attestation and server-owned grant profiles.
4. **Project Identity Bound at Startup**: The broker endpoint and startup freeze `projectId`. Client-supplied `projectId` values in handshake and subsequent requests must match the frozen project identity exactly; client-supplied project identifiers are routing checks and never grant authority.
5. **No Authoritative TypeScript Fallback**: The TS v1 broker is internal migration code and will not serve as a production fallback. If native binaries cannot run, stateful commands fail closed with a typed error.
6. **Per-Job Isolation, Not Shared UID**: Linux uses systemd `DynamicUser` transient units; macOS uses a bounded preallocated pool of leased service accounts with process enumeration kill-to-zero; Windows uses per-job AppContainer / restricted tokens with Job Objects. Identities are never reused until verified process-tree death and scrub. Proposed mechanics require Tier 2 proof.
7. **UI Automation TCB**: Browser and desktop automation drivers run under the user's interactive session (not via worker service) as approved TCB components, subject to origin controls, lease limits, and human approval. `cua-driver` resolves strictly as the fixed command from the sanitized `PATH` and is verified against the versioned signed artifact manifest; `agent-browser` resolves from its pinned optional package and platform artifact manifest. No arbitrary path substitution.
8. **Bundled SQLite Durability**: Managed via `rusqlite` (exact version locked in `Cargo.lock` in Slice 5). WAL mode, `synchronous=FULL`, and macOS `fullfsync`. Interrupted writes conservatively map pending/dispatched transactions to `outcome_unknown`. Zero auto-retry.
9. **Strict Test Tier Separation**:
   - *Tier 1 (Unprivileged / CI)*: Standard GitHub Actions without root privileges on Ubuntu, macOS, and Windows. Tests parser, mock attestation logic with synthetic mismatched UID/SID, SQLite durability, protocol conformance, and golden fixtures. Workers in Tier 1 run under ambient same-UID, would pass owner peer attestation, and are explicitly not isolated; worker service is unavailable.
   - *Tier 2 (Privileged / Native Integration)*: Dedicated runners or VMs with root/admin access testing signed installers, real per-job multi-user isolation, live hostile worker socket denial, hostile canary file-access blocking, cross-worker snooping prevention, and setsid/double-fork escape termination.

---

## 2. Dependency Graph & Sequencing Slices

```
+---------------------------------------------------------------------------------+
| Slice 1: Contract & Threat Freeze + Cross-Language Golden Fixtures              |
+---------------------------------------------------------------------------------+
                                      |
                                      v
+---------------------------------------------------------------------------------+
| Slice 2: Rust Workspace & Closed Wire Protocol Parser                           |
+---------------------------------------------------------------------------------+
                                      |
                                      v
+---------------------------------------------------------------------------------+
| Slice 3: Native Endpoints & Kernel Peer Attestation (Unix & Windows)            |
+---------------------------------------------------------------------------------+
                                      |
                                      v
+---------------------------------------------------------------------------------+
| Slice 4: Memory-Only Grant & Session Admission Engine                            |
+---------------------------------------------------------------------------------+
                                      |
                                      v
+---------------------------------------------------------------------------------+
| Slice 5: Bundled-SQLite Receipt Authority & Outcome-Unknown Engine              |
+---------------------------------------------------------------------------------+
                                      |
                                      v
+---------------------------------------------------------------------------------+
| Slice 6: Dual Lifecycle Supervision, Single-Owner Lock & Node Host              |
+---------------------------------------------------------------------------------+
                                      |
                                      v
+---------------------------------------------------------------------------------+
| Slice 7: Cancel & Settle Authority Engine                                        |
+---------------------------------------------------------------------------------+
                                      |
                                      v
+---------------------------------------------------------------------------------+
| Slice 8: Signed Native Installer & Worker Service Skeleton                      |
+---------------------------------------------------------------------------------+
                                      |
                                      v
+---------------------------------------------------------------------------------+
| Slice 9: Per-Job Worker Launch with Capability-Scoped Credentials                |
+---------------------------------------------------------------------------------+
                                      |
                                      v
+---------------------------------------------------------------------------------+
| Slice 10: UI Automation TCB Integration (Browser & Desktop Drivers)              |
+---------------------------------------------------------------------------------+
                                      |
                                      v
+---------------------------------------------------------------------------------+
| Slice 11: Hostile Security Tests & Fault Injection Suite                         |
+---------------------------------------------------------------------------------+
                                      |
                                      v
+---------------------------------------------------------------------------------+
| Slice 12: Packaging, Signing & Tier 2 Integration Proof                         |
+---------------------------------------------------------------------------------+
                                      |
                                      v
+---------------------------------------------------------------------------------+
| Slice 13: Public Stateful CLI Grammar Unlock & Gate B Sign-off                   |
+---------------------------------------------------------------------------------+
```

---

## 3. Detailed Slices: Files, Interfaces, TDD Tests & Research Tasks

### Slice 1: Contract & Threat Freeze + Cross-Language Golden Fixtures
- **Objective:** Freeze runtime RPC types in TypeScript (`RUNTIME_RPC_VERSION = 1`), introduce native `BROKER_PROTOCOL_VERSION = 2` with mandatory `kind` discriminator across all messages, establish canonical JSON golden fixtures, and delete prototype secret-file paths from TS files.
- **Files Touched/Created:**
  - `src/runtime/runtime-rpc-protocol.ts` (freeze canonical types)
  - `src/runtime/broker-protocol.ts` (bump `BROKER_PROTOCOL_VERSION = 2`, add mandatory `kind: 'hello' | 'welcome'`, remove rootSecret from Hello)
  - `src/runtime/broker-endpoint.ts` (deprecate and remove secret-file read/write paths)
  - `test/fixtures/rpc-golden/*.json` (golden request/reply fixtures: broker v2 envelope + runtime RPC v1 payload mirrored from external pi-subagents ground truth)
  - `test/runtime/runtime-rpc-golden.test.ts` (TS golden validator)
- **Envelope Discriminator Contract:**
  ```ts
  export interface BrokerHello {
    version: 2;
    kind: 'hello';
    clientId: string;
    projectId: string;
    requestedCapabilities: BrokerCapability[];
  }

  export interface BrokerWelcome {
    version: 2;
    kind: 'welcome';
    epoch: string;
    clientId: string;
    sessionId: string;
    token: string;
    expiresAt: number;
    capabilities: BrokerCapability[];
    projectId: string;
  }
  ```
- **TDD / Verification:**
  - Command: `node --import tsx --test test/runtime/runtime-rpc-golden.test.ts`
  - Unprivileged test: Validates that all RPC messages match golden JSON schemas; verifies zero `.secret` paths are generated.

---

### Slice 2: Rust Workspace & Closed Wire Protocol Parser
- **Objective:** Set up native Rust workspace and implement binary frame parser with strict 256KiB limits, exact property key validation, and Serde models with `#[serde(tag = "kind")]` matching Slice 1 golden fixtures.
- **Files Touched/Created:**
  - `rust/Cargo.toml`
  - `rust/crates/northstar-broker/Cargo.toml`
  - `rust/crates/northstar-broker/src/frame.rs`
  - `rust/crates/northstar-broker/src/protocol.rs`
  - `rust/crates/northstar-broker/tests/golden_conformance_tests.rs`
- **Interfaces & Constants:**
  ```rust
  pub const BROKER_MAX_FRAME_BYTES: usize = 256 * 1024;
  pub const BROKER_PROTOCOL_VERSION: u32 = 2;

  #[derive(Debug, Serialize, Deserialize, PartialEq)]
  #[serde(tag = "kind", rename_all = "camelCase")]
  pub enum BrokerMessage {
      Hello(BrokerHello),
      Welcome(BrokerWelcome),
      Request(BrokerRequest),
      Query(BrokerQuery),
      Response(BrokerResponse),
      QueryResponse(BrokerQueryResponse),
      Error(BrokerErrorMessage),
  }
  ```
- **TDD / Verification:**
  - Command: `cargo test -p northstar-broker --test golden_conformance_tests`
  - Unprivileged test: Validates Rust deserialization against all `test/fixtures/rpc-golden/*.json` files; rejects frames > 256KiB; rejects unrecognized JSON fields fail-closed.

---

### Slice 3: Native Endpoints & Kernel Peer Attestation (Unix & Windows)
- **Objective:** Implement native endpoint binding and kernel peer attestation. Unix uses UDS with `0700` parent and `0600` socket permissions. macOS validates both UID/GID and PID (`LOCAL_PEERPID`). Windows constructs a least-privilege DACL, passes `PIPE_REJECT_REMOTE_CLIENTS`, and revalidates PID-to-token SID.
- **Files Touched/Created:**
  - `rust/crates/northstar-broker/src/endpoint/mod.rs`
  - `rust/crates/northstar-broker/src/endpoint/unix.rs` (`SO_PEERCRED` on Linux; `LOCAL_PEERCRED` / `getpeereid` + `LOCAL_PEERPID` on macOS)
  - `rust/crates/northstar-broker/src/endpoint/windows.rs` (Least-privilege DACL, `PIPE_REJECT_REMOTE_CLIENTS`, PID-to-token SID query)
  - `rust/crates/northstar-broker/tests/endpoint_attestation_tests.rs`
- **Platform Attestation Rules:**
  - *Linux*: Retrieve peer credentials via `getsockopt(fd, SOL_SOCKET, SO_PEERCRED)`. Assert `ucred.uid == geteuid()`.
  - *macOS*: Retrieve peer credentials via `getsockopt(fd, SOL_LOCAL, LOCAL_PEERCRED)` or `getpeereid`. Retrieve peer PID via `getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID)`. Revalidate PID process identity. Assert peer UID equals current process UID.
  - *Windows*:
    - Construct an explicit least-privilege security descriptor granting only necessary connect, read, write, and synchronize rights strictly to the current owner SID.
    - Pass `PIPE_REJECT_REMOTE_CLIENTS` during `CreateNamedPipeW`.
    - Retrieve client PID via `GetNamedPipeClientProcessId`. Open client process with `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)`, query `GetTokenInformation(TokenUser)`, and verify client SID equals owner SID. Reject remote or cross-account connections instantly.
- **Research Tasks (Implementation Blockers for Slice 3 Acceptance):**
  - *Task R-1*: Determine and test the exact Windows access mask (excluding `WRITE_DAC`, `WRITE_OWNER`) required for pipe client connection, verified by negative cross-SID and `WRITE_DAC` denial tests.
  - *Task R-2*: Validate macOS `LOCAL_PEERPID` behavior and PID recycling race prevention when client process exits during connection setup.
- **TDD / Verification:**
  - Command: `cargo test -p northstar-broker --test endpoint_attestation_tests`
  - Unprivileged test: Current user connection succeeds; simulated mismatched UID/SID causes immediate socket termination with zero data transmitted.

---

### Slice 4: Memory-Only Grant & Session Admission Engine
- **Objective:** Eliminate client root secrets entirely. The broker generates a root signing key in memory using the OS CSPRNG, zeroized on shutdown with best-effort memory locking. The broker intersects requested capabilities against a single fixed server-owned CLI grant ceiling and issues a 60-second HMAC-SHA256 session token.
- **Files Touched/Created:**
  - `rust/crates/northstar-broker/src/auth.rs`
  - `rust/crates/northstar-broker/src/grants.rs`
  - `rust/crates/northstar-broker/tests/grant_admission_tests.rs`
- **Admission Invariants:**
  - Client sends `BrokerHello` containing client ID, project ID, and requested capabilities (no root secret).
  - Broker verifies peer identity via Slice 3 attestation and asserts `projectId` matches the frozen startup project identity.
  - Intersects requested capabilities with fixed server-owned CLI ceiling. Client-supplied role strings or capability requests can never expand this ceiling.
  - Returns `BrokerWelcome` with 60s session token bound to broker epoch, client ID, session ID, and granted scopes.
  - Subsequent requests require valid, unexpired session token.
- **TDD / Verification:**
  - Command: `cargo test -p northstar-broker --test grant_admission_tests`
  - Unprivileged test: Token expiry enforcement; capability scope violation yields `scope_denied`; epoch mismatch yields `epoch_mismatch`; mismatched `projectId` rejected; token tampering fails constant-time HMAC check.

---

### Slice 5: Bundled-SQLite Receipt Authority & Outcome-Unknown Engine
- **Objective:** Implement durable mutation receipt logging using bundled SQLite (`rusqlite`, exact version locked in `Cargo.lock`). WAL mode, `synchronous=FULL`, macOS `fullfsync`.
- **Files Touched/Created:**
  - `rust/crates/northstar-broker/src/db.rs`
  - `rust/crates/northstar-broker/src/journal.rs`
  - `rust/crates/northstar-broker/tests/sqlite_journal_tests.rs`
- **Schema & Invariants:**
  ```sql
  CREATE TABLE mutation_journal (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      mutation_id TEXT UNIQUE NOT NULL,
      idempotency_key TEXT UNIQUE NOT NULL,
      project_id TEXT NOT NULL,
      owner_identity TEXT NOT NULL,
      operation TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending', 'dispatched', 'settled', 'outcome_unknown')),
      request_digest TEXT NOT NULL,
      receipt_payload TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
  );
  ```
  - `request_digest` stores SHA-256 digest of original validated request only.
  - `receipt_payload` is explicitly bounded to broker frame/result limits and contains only validated, scrubbed receipt data (never raw credentials or unvalidated request bodies). Exact CHECK constraint or length enforcement frozen in Slice 5.
  - `pending` written and synced before external dispatch.
  - `dispatched` committed immediately before irreversible handoff.
  - `settled` updated upon verified execution receipt.
  - On restart / crash recovery: unacknowledged `pending` or `dispatched` records transition conservatively to `outcome_unknown`. Automatic retry is strictly forbidden.
  - ENOSPC / Quota: When journal hits quota or disk is full, new mutations reject with `quota_exceeded`, while read queries (`BrokerQuery`) remain functional.
  - Corrupt database (`PRAGMA integrity_check` fails): Broker refuses to start fail-closed; never clobbers or auto-archives corrupt databases.
- **Research Tasks (Implementation Blockers for Slice 5 Acceptance):**
  - *Task R-3*: Lock exact `rusqlite` version in `Cargo.lock` and provide synthetic fault-injection test proving WAL mode, `synchronous=FULL`, `fullfsync`, and `checkpoint_fullfsync` pragma settings are actively applied.
- **TDD / Verification:**
  - Command: `cargo test -p northstar-broker --test sqlite_journal_tests`
  - Unprivileged test: Simulated power loss / process crash at pending, dispatched, post-effect, and pre-receipt points; verifies duplicate mutation IDs reject with `duplicate_mutation`; verifies recovery maps uncompleted mutations to `outcome_unknown`; verifies ENOSPC allows reads.

---

### Slice 6: Dual Lifecycle Supervision, Single-Owner Lock & Node Host
- **Objective:** Implement dual lifecycle supervision and production topology. Compiled Node host (`src/runtime/broker-host.ts`) resolves root-installed broker from root-owned manifest (never PATH), maps one control descriptor into `northstar-broker`, acquires exclusive single-owner file lock (`broker.lock`), and marks retained descriptors close-on-exec. Broker and Node fate-share on exit.
- **Files Touched/Created:**
  - `src/runtime/broker-host.ts` (production broker lifecycle supervisor: foreground serve & Pi-owned modes)
  - `src/runtime/broker-node-channel.ts` (Node-side private transport)
  - `src/runtime/broker-lock.ts` (exclusive single-owner lock on `broker.lock` with safe stale recovery)
  - `rust/crates/northstar-broker/src/node_channel.rs` (Rust-side executor process manager)
  - `test/runtime/broker-host-composition.test.ts`
  - `test/runtime/broker-lifecycle-lock.test.ts`
- **Lifecycle & Lock Security Rules:**
  - Node spawn explicitly maps only the one control descriptor into the Rust child. The Rust child immediately marks its retained end close-on-exec before spawning any descendants.
  - `broker.lock` ensures only one broker runs per project endpoint. Concurrent starters probe endpoint; if healthy, they reuse it.
  - Stale endpoints are removed only after proving current UID ownership and verifying lock process is dead.
  - Foreground serve stays attached to terminal; Pi-owned child stays attached to Pi lifecycle.
  - Node executor never receives broker root signing key or session tokens.
- **Executor Composition & Authority Boundary:**
  - On the TypeScript host side, `ExecutorListener` binds an owner-only Unix socket (`0600`) within the project's runtime directory (`0700`) and enforces dual peer gating: (a) a single-use 32-byte CSPRNG token file (`0600`) unlinked immediately upon first successful auth, and (b) accepting only the very first connection while awaiting the broker child.
  - On the Rust side, the broker connects to the executor socket and verifies peer UID matches its own EUID (`get_peer_identity`), achieving defense in depth without exposing secrets on argv.
  - Failures before request dispatch are classified as `BeforeDispatch` (triggering fail-closed `runtime_unavailable` replies), whereas communication lost after dispatch is classified as `AfterDispatch` (triggering `runtime_timeout` and transitioning mutations to `outcome_unknown`).
  - Cancellation requests (`cancelAndSettle`) stay local to the host/executor engine without altering wire reply shapes.
- **TDD / Verification:**
  - Command: `node --import tsx --test test/runtime/broker-host-composition.test.ts test/runtime/broker-lifecycle-lock.test.ts`
  - Unprivileged test: Bidirectional message exchange over private pipe; concurrent starters test proving only one owner spawns; stale endpoint refusal test; fate-sharing tests: broker death terminates host, host death terminates broker.

---

### Slice 7: Cancel & Settle Authority Engine
- **Objective:** Implement cancellation authority and settlement semantics through the Rust broker and Node executor, adhering strictly to `runtime-rpc-protocol.ts` wire semantics without interpreting opaque reply payloads.
- **Files Touched/Created:**
  - `rust/crates/northstar-broker/src/engine/cancel.rs`
  - `src/runtime/broker-cancel-settle.ts`
  - `test/runtime/broker-cancel-settle.test.ts`
- **Cancellation Invariants:**
  - Broker authorizes `cancelAndSettle` under `runtime:cancel` capability.
  - Validates request shape: `runIds` duplicate-free array bounded to `1..64`; caller-supplied `settlementWindowMs` bounded to `1..10_000`. Broker forwards value without widening or clamping.
  - Forwarded unchanged across private channel; returns runtime reply only after `validateReply`.
  - Broker treats `RuntimeRpcReply.data` as opaque and never parses or collapses reply data into invented result-state labels.
  - Cancellation, execution failure, and transport loss remain distinct at the broker envelope and journal level.
- **TDD / Verification:**
  - Command: `node --import tsx --test test/runtime/broker-cancel-settle.test.ts`
  - Unprivileged test: Golden fixtures mirrored from external pi-subagents ground truth; verifies pass-through, bounds validation, authorization checks, mutation receipt recording, and `outcome_unknown` mapping on transport loss.

---

### Slice 8: Signed Native Installer & Worker Service Skeleton
- **Objective:** Create the standalone privileged `northstar-worker-service` binary and native installation packages (.pkg, .deb/.rpm, .msi). The installer installs both `northstar-broker` and `northstar-worker-service` plus root-owned manifest.
- **Files Touched/Created:**
  - `rust/crates/northstar-worker-service/Cargo.toml`
  - `rust/crates/northstar-worker-service/src/main.rs`
  - `rust/crates/northstar-worker-service/src/ipc.rs` (root-owned IPC endpoint)
  - `packaging/macos/Distribution.xml`
  - `packaging/linux/northstar-worker-service.service`
  - `packaging/windows/Product.wxs`
  - `test/packaging/installer-spec.test.ts`
- **Service Security Rules:**
  - Endpoint owned by root/SYSTEM (`/var/run/northstar/worker-service.sock` or `\\.\pipe\northstar-worker-service`).
  - Kernel peer attestation: verifies calling process is `northstar-broker` binary matching root-installed path/inode and cryptographic signature/digest.
  - Rejects connections from non-broker processes or unknown users.
  - Closed worker descriptors and execution quotas: no arbitrary root side-effects even from authenticated callers.
- **Research Tasks (Implementation Blockers for Slice 8 Acceptance):**
  - *Task R-4*: WiX Toolset integration in GitHub Actions Windows runners for automated MSI creation.
  - *Task R-5*: macOS `pkgbuild` / `productbuild` notarization workflow integration via CI secrets.
- **TDD / Verification:**
  - Unprivileged test: Validates installer manifest syntax and SHA-256 digest calculation.
  - Privileged test (Tier 2): Clean installer installation, service start, service query, and clean uninstallation.

---

### Slice 9: Per-Job Worker Launch with Capability-Scoped Credentials
- **Objective:** The worker service launches provider workers with per-job identity isolation and minimal capability-scoped credentials. Existing child-env owners (`buildCliEnvironment`, `buildNativeChildEnvironment`, `buildPythonChildEnvironment`) remain authoritative.
- **Files Touched/Created:**
  - `rust/crates/northstar-worker-service/src/isolation/mod.rs`
  - `rust/crates/northstar-worker-service/src/isolation/linux.rs` (systemd `DynamicUser` transient unit)
  - `rust/crates/northstar-worker-service/src/isolation/macos.rs` (bounded leased pool with kill-to-zero)
  - `rust/crates/northstar-worker-service/src/isolation/windows.rs` (AppContainer / Job Object)
  - `rust/crates/northstar-worker-service/src/credentials.rs`
  - `test/security/worker-credentials-isolation.test.ts`
- **Isolation Rules:**
  - *Linux Full Mode*: Spawn via transient systemd unit with `DynamicUser=yes`, `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`, and cgroup tracking.
  - *macOS Full Mode*: Allocate from installer-configured bounded hidden pool. Set up isolated `0700` workdir. On cleanup, perform process-group termination and process enumeration kill-to-zero across the leased UID; if non-zero remains, quarantine identity/workspace permanently and fail closed on pool exhaustion.
  - *Windows Full Mode*: Spawn in dedicated AppContainer or restricted token assigned to a new Job Object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`).
  - *Credentials*: `HOME`, `TMPDIR`, and `USER` set to sandbox paths; `PATH` restricted. Provider credentials passed via inherited pipe/stdin or strict capability allowlists. Secrets never appear in `argv` or logs.
  - *Scrubbing*: Verified process-tree death before identity or workspace release.
- **Research Tasks (Implementation Blockers for Slice 9 Acceptance):**
  - *Task R-6*: Validate `DynamicUser` and cgroup v2 compatibility across targeted Linux distributions (Ubuntu, Debian, Fedora).
  - *Task R-7*: macOS service identity pool allocation and `setsid`/double-fork escape kill-to-zero verification in Tier 2.
- **TDD / Verification:**
  - Unprivileged test: Mocked worker launcher argument parsing and credential allowlist filtering.
  - Privileged test (Tier 2): Verified worker UID differs from host user UID; canary credentials do not leak into parent environment.

---

### Slice 10: UI Automation TCB Integration (Browser & Desktop Drivers)
- **Objective:** Integrate `agent-browser` and `cua-driver` as explicitly approved TCB components running under the user's interactive session account (never via the privileged worker service). Reconcile with AGENTS.md truth: `cua-driver` resolves from sanitized `PATH` and verified against artifact manifest; `agent-browser` resolves from pinned package and manifest.
- **Files Touched/Created:**
  - `src/browser/browser-tcb-launcher.ts`
  - `src/desktop/desktop-tcb-launcher.ts`
  - `test/browser/browser-tcb-security.test.ts`
  - `test/desktop/desktop-tcb-security.test.ts`
- **Security & Integrity Controls:**
  - Drivers execute directly in user session to access display servers, Accessibility APIs, and Chrome companion leases.
  - Binary integrity verified against versioned signed artifact manifest or package-lock integrity; arbitrary path substitution is prohibited.
  - Drivers never receive broker root signing keys or session tokens.
  - Re-validate origin allowlists, `stateId` AX-tree freshness, lease TTLs, and mandatory human confirmation for sensitive inputs.
  - Outputs treated as untrusted evidence.
- **Research Tasks (Implementation Blockers for Slice 10 Acceptance):**
  - *Task R-8*: Define exact source-driven signature verification mechanism for `cua-driver` binary vs `agent-browser` npm package.
- **TDD / Verification:**
  - Command: `node --import tsx --test test/browser/browser-tcb-security.test.ts test/desktop/desktop-tcb-security.test.ts`
  - Unprivileged test: Fake signed-manifest fixtures; mismatch rejects driver launch; drivers operate without broker signing keys; untrusted DOM output framing verified.

---

### Slice 11: Hostile Security Tests & Fault Injection Suite
- **Objective:** Adversarial test suite verifying hard boundaries against malicious workers, peer spoofing, setsid/double-fork escape, and storage corruption. Tests use synthetic canary files (`0600` inside `0700` user directory), never real `~/.ssh` or `~/.aws`.
- **Files Touched/Created:**
  - `test/security/hostile-worker-tamper.test.ts`
  - `test/security/cross-worker-spying.test.ts`
  - `test/security/sqlite-fault-injection.test.ts`
  - `test/security/process-tree-death.test.ts`
- **Adversarial Test Scenarios:**
  1. *Hostile Worker File Access (Tier 2)*: Worker attempts to read synthetic canary file in host user directory -> Kernel denies access (`EACCES`).
  2. *Cross-Worker Spying (Tier 2)*: Worker $A$ attempts to access Worker $B$'s temporary directory, inspect memory via `ptrace`, or send signals -> Denied.
  3. *Socket Tampering (Tier 2)*: Compromised worker running under isolated identity attempts to connect to `northstar-broker` socket -> Kernel peer attestation rejects connection immediately. (Tier 1 tests mock peer UID mismatch only; same-UID dev worker is not isolated).
  4. *macOS Escape & Process-Tree Termination (Tier 2)*: Worker attempts escape via `setsid` and double-fork -> Worker service executes kill-to-zero across leased UID before releasing sandbox identity.
  5. *Corrupt SQLite Recovery (Tier 1)*: SQLite database file corrupted with random bytes -> Broker refuses to start fail-closed; does not overwrite corrupt data.
- **TDD / Verification:**
  - Tier 1 suite runs in standard CI. Tier 2 suite runs in dedicated privileged integration harness.

---

### Slice 12: Packaging, Signing & Tier 2 Integration Proof
- **Objective:** Validate signed platform installer packages (.pkg, .deb/.rpm, .msi) in Tier 2 integration harness across supported targets.
- **Files Touched/Created:**
  - `packaging/release-manifest.json`
  - `scripts/build-native-artifacts.sh`
  - `docs/security/worker-service-deployment.md`
- **Supported Platform Targets (Full Mode):**
  - macOS: arm64 (`darwin-arm64`), x64 (`darwin-x64`) via signed/notarized `.pkg`.
  - Linux: glibc x64 (`linux-x64`), arm64 (`linux-arm64`) with systemd via signed `.deb` / `.rpm`.
  - Windows: x64 (`win32-x64`), arm64 (`win32-arm64`) via signed `.msi`.
  - Unsupported platforms fail closed for stateful capabilities.
- **TDD / Verification:**
  - Tier 2 integration run: clean install via signed package -> start broker explicitly in foreground or session-owned harness -> verify root-owned binaries and manifest -> end-to-end stateful execution -> clean uninstall.

---

### Slice 13: Public Stateful CLI Grammar Unlock & Gate B Sign-off
- **Objective:** Only after all Tier 1 and Tier 2 verification gates pass, unlock public CLI grammar for stateful domains (`jobs`, stateful browser, desktop) and expose explicit `northstar broker serve`.
- **Files Touched/Created:**
  - `src/cli/cli.ts` (unlock stateful commands and `broker serve`)
  - `src/commands/command-registry.ts` (register stateful commands)
  - `plan.md` (mark Gate B criteria satisfied)
- **TDD / Verification:**
  - Tier 1 Command: `node --import tsx --test test/cli/stateful-grammar-closed.test.ts` (verifies grammar stays closed before unlock).
  - Tier 2 Command: End-to-end CLI execution of stateful job submission, cancellation via `northstar-worker-service`, and explicit `northstar broker serve` startup.

---

## 4. Verification Gates Matrix

| Ref | Gate Description | Target / Threshold | Tier |
|---|---|---|---|
| **G1** | Golden RPC Wire Parity | 100% conformance between TS types (v1) and Rust broker (v2 with mandatory `kind`) | Tier 1 (CI) |
| **G2** | Memory-Only Root Key | Zero secret files written to disk; handshake uses peer attestation | Tier 1 (CI) |
| **G3** | SQLite Durability & WAL | Crash during write recovers cleanly; ambiguous dispatch -> `outcome_unknown` | Tier 1 (CI) |
| **G4** | Windows Named Pipe Security | Least-privilege DACL + `PIPE_REJECT_REMOTE_CLIENTS` + SID check | Tier 1 (CI) |
| **G5** | Signed Native Installer | Installs service & broker cleanly; zero npm elevation or `sudo` in CLI | Tier 2 (Privileged) |
| **G6** | Hostile Worker Containment | Worker cannot read synthetic canary files in user directory | Tier 2 (Privileged) |
| **G7** | Cross-Worker Isolation | Concurrent workers cannot inspect each other's memory or files | Tier 2 (Privileged) |
| **G8** | Verified Process-Tree Death | All descendant processes (including `setsid`/double-fork) killed before reuse | Tier 2 (Privileged) |
| **G9** | UI Automation TCB Integrity | Browser/desktop drivers execute under user session with pinned manifests | Tier 1 (CI) |
| **G10**| Fail-Closed Stateful CLI | Stateful commands remain disabled until G1–G9 pass; connects only to live broker | Tier 1 & Tier 2 |
| **G11**| Dual Lifecycle Single Owner | Concurrent starters yield one owner; Pi-owned broker dies with Pi | Tier 1 & Tier 2 |

---

## 5. Rollback, Drain & Recovery Procedures

1. **Service Uninstall & Worker Drain**:
   - Uninstalling `northstar-worker-service` via native package manager signals running workers with SIGTERM, waits for a graceful drain period (default 10s), then issues SIGKILL to the entire process group/cgroup/Job Object.
2. **Stateful Incompatibility Rollback**:
   - If an updated broker detects an incompatible SQLite schema, it terminates fail-closed without modifying the database.
   - Operators can roll back to the previous package release. Unrecognized state files are never deleted or clobbered.
3. **Missing Worker Service Degraded State**:
   - If `northstar-worker-service` is not installed or unavailable, stateful worker execution fails closed with a typed `worker_service_unavailable` error. Stateless commands (28 current command IDs) continue to operate with zero degradation.

---

## 6. Resolved Research Gates

The following research gates have been resolved by authoritative external investigation. Findings are implementation-ready and frozen.

### R-1 (Windows Named Pipe DACL) — Resolved
- **Access mask:** `0x0012019F` (`FILE_READ_DATA | FILE_WRITE_DATA | FILE_CREATE_PIPE_INSTANCE | FILE_READ_EA | FILE_WRITE_EA | FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE`).
- **Excluded:** `WRITE_DAC` (`0x00040000`) and `WRITE_OWNER` (`0x00080000`) — both zero in `0x0012019F`.
- **SDDL ACE fragment:** `(A;;0x12019F;;;<OWNER_SID>)` with DACL protected flag `D:P`.
- **Minimum Windows version:** Vista / Server 2008 for both `PIPE_REJECT_REMOTE_CLIENTS` and `GetNamedPipeClientProcessId`.
- **Negative test:** Cross-SID connect attempt → `CreateFileW` returns `ERROR_ACCESS_DENIED (5)` at OS DACL check; if a privileged bypass reaches the server, application-layer `EqualSid` check disconnects with `DisconnectNamedPipe`.
- **Source:** Microsoft Learn — Named Pipe Security and Access Rights; WinBase.h API reference.

### R-2 (macOS LOCAL_PEERPID) — Resolved
- **Socket options:** `SOL_LOCAL = 0`; `LOCAL_PEERCRED = 1` (returns `xucred` with `cr_uid`); `LOCAL_PEERPID = 2` (returns `pid_t`, advisory).
- **Availability:** macOS 10.8+; confirmed macOS 12+ arm64 and x64.
- **Authoritative check:** Use `LOCAL_PEERCRED` (or `getpeereid`) for UID — kernel-guaranteed. `LOCAL_PEERPID` is advisory / best-effort.
- **TOCTOU residual:** PID recycled between `accept()` and `getsockopt(LOCAL_PEERPID)` if client exits. Mitigation: UID check is authoritative and blocks cross-user impersonation even if PID is recycled, because recycled PID must belong to same UID to pass. Residual risk documented in ADR 0010 R-2.
- **Rust pattern:** `libc` crate `getsockopt(fd, 0, 1, xucred)` for UID; `getsockopt(fd, 0, 2, pid_t)` for PID.
- **Source:** Apple XNU kernel source (`sys/un.h`, `uipc_usrreq.c`); libc crate docs.

### R-3 (rusqlite Version) — Resolved
- **Pin:** `rusqlite = { version = "=0.40.1", features = ["bundled"] }` in `Cargo.lock`.
- **Bundled SQLite:** 3.53.2 (via `libsqlite3-sys` 0.38.1).
- **Pragma sequence at open:**
  ```sql
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  PRAGMA fullfsync = 1;
  PRAGMA checkpoint_fullfsync = 1;
  ```
- **Cross-platform safety:** `PRAGMA fullfsync` is a documented no-op on Linux and Windows (no `F_FULLFSYNC`); returns no error.
- **Verification test:** Read each pragma back after setting; assert `journal_mode = wal`, `synchronous = 2`, `fullfsync = 1`, `checkpoint_fullfsync = 1`.
- **Source:** crates.io rusqlite 0.40.1; sqlite.org pragma documentation; SQLite `os_unix.c`.

### R-6 (Linux DynamicUser) — Resolved
- **Critical finding:** `DynamicUser=yes` is **unsupported** in `systemd --user` (user session) instances across all four target distros (Ubuntu 22.04, Ubuntu 24.04, Debian 12, Fedora 40). It requires the system service manager (root/PID 1) to allocate UIDs from range 61184–65519.
- **Implication for plan:** Correct — `northstar-worker-service` is a root-installed system service and uses `systemd-run` (system manager), not `--user`. Unprivileged CLI processes cannot use `DynamicUser`.
- **cgroup v2:** Not required for `DynamicUser`. All four target distros default to cgroup v2 but cgroup v1 also works.
- **`PrivateTmp`, `ProtectSystem`, `ProtectHome`:** These are implied automatically by `DynamicUser=yes` in system units. Not available in `--user` units without unprivileged user namespaces.
- **Confirmed command (root/system):** `systemd-run --wait --pipe -p DynamicUser=yes -p StateDirectory=slice-worker /path/to/binary`
- **Source:** `systemd.exec(5)` man page; 0pointer.net Dynamic Users blog post (systemd author).

### R-3 Amendment — rusqlite Compile-Proven Versions (Slice 5)
- The researched pin (`=0.40.1`) collided with rustc 1.89's `cfg_select` std macro (`error[E0658]`). Resolved by bumping one patch release.
- **Compile-proven:** `rusqlite 0.40.2` (caret requirement in `Cargo.toml`, exact pin in `rust/Cargo.lock`) + `libsqlite3-sys 0.38.2` (**SQLite 3.49.0** bundled). `cargo build` zero errors, zero warnings; 9/9 durability tests pass.
- The pragma sequence (`WAL` + `FULL` + `fullfsync=1` + `checkpoint_fullfsync=1`) and read-back verification test are proven active by `db_durability_tests`.

### R-4 (WiX Toolset MSI in CI) — Resolved
- **Pre-installed:** `windows-2022` has only WiX v3.14.1. WiX v4+ ships as a .NET tool: `dotnet tool install --global wix --version 4.0.6`.
- **MSI scope:** Installs the Rust binary to `ProgramFiles64Folder` and registers the Windows service (`ServiceInstall` + `ServiceControl`). The named pipe is created by the service at runtime, not by MSI.
- **Version wiring:** `wix build -arch x64 -d CargoVersion="$(cargo metadata …)" -d BinaryPath=… -o dist/… ./installer/broker.wxs`; `Bitness="always64"` required or WiX targets 32-bit.
- **Signing:** Sign the `.exe` before `wix build`, sign the `.msi` after, with `signtool.exe` using a PFX from `WINDOWS_CERT_BASE64` / `WINDOWS_CERT_PASSWORD` secrets plus a DigiCert timestamp.
- **Rust gotcha:** A plain Rust binary crashes under SCM unless it registers a service control dispatcher (e.g. `windows-service` crate) within 30 seconds.
- **Source:** actions/runner-images (Windows2022 spec); FireGiant WiX v4 docs.

### R-5 (macOS pkgbuild/productbuild Notarization) — Resolved
- **Sequence:** `codesign --force --options runtime` (Developer ID Application) → `pkgbuild` (unsigned component) → `productbuild --sign` (Developer ID Installer) → `xcrun notarytool submit --wait` → `xcrun stapler staple` → `spctl --assess --type install`.
- **CI secrets:** `MACOS_CERT_P12_BASE64`, `MACOS_CERT_PASSWORD`, `NOTARY_APPLE_ID`, `NOTARY_APP_PASSWORD`, `NOTARY_TEAM_ID`.
- **Entitlements:** Root launchd daemons need no App Sandbox entitlements; empty dictionary plus `--options runtime`.
- **Gotchas:** `altool` notarization endpoint is dead (Nov 2023) — `notarytool` is mandatory. CI must create an ephemeral keychain and run `security set-key-partition-list` to avoid GUI hangs. Never mix Application vs Installer certificate roles.
- **Source:** Apple Technote TN3147; Apple notarization customization guide.

### R-7 (macOS Service Identity Pool) — Resolved
- **Account ops (root only, installer `postinstall`):** `dscl . -create /Users/_northstar_pool_N` with `UniqueID 451+N`, `UserShell /usr/bin/false`, `NFSHomeDirectory /var/empty`, `IsHidden 1`. Use UID range 450–499 (avoid Apple-reclaimed 300–304 on Sequoia). Hide from login window via `HiddenUsersList` in `/Library/Preferences/com.apple.loginwindow`.
- **Kill-to-zero:** Non-root processes can never escape their UID without `setuid(2)` (requires root), so `setsid`/double-fork orphans remain catchable. Sweep: `pkill -TERM -u UID`, 500 ms grace, then `pkill -KILL -u UID` loop (10 × 100 ms) until `pgrep -u UID` is empty.
- **Pool management:** Static pool of 4–8 accounts created at install time (account creation costs 500–2000 ms — too slow for per-dispatch). Broker holds per-account lock files; on release runs kill-to-zero and scrubs the sandbox before returning the UID to the pool.
- **Source:** ss64 sysadminctl reference; POSIX process semantics.

### R-8 (Driver Signature Verification) — Resolved
- **`cua-driver` (native binary):** Phase 1 (smallest change) — SHA-256 of the resolved `PATH` executable checked against a bundled `artifacts.manifest.json` at launch. Phase 2 — `codesign --verify --strict` (macOS, check Team ID) / `Get-AuthenticodeSignature` (Windows, check Subject CN) to allow in-family updates.
- **`agent-browser` (npm package):** npm cannot re-verify installed files against `package-lock.json` SRI at runtime (tarballs are unpacked). Instead hash the entry file (`dist/index.js`) with SHA-256 at startup and check against `artifacts.manifest.json` (< 5 ms, pure JS).
- **Manifest schema:** `{ manifestVersion, generatedAt, artifacts: { cua-driver: { type: native_binary, version, platforms: { <platform>: { sha256, teamId|subjectName } } }, agent-browser: { type: npm_entry, version, entryFileRelPath, sha256 } } }`.
- **Source:** Microsoft PowerShell security docs (`Get-AuthenticodeSignature`); npm SRI/package-lock semantics.
