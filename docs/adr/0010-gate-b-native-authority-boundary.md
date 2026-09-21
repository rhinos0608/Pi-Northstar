# ADR 0010: Gate B native authority boundary — standalone Rust security sidecar, peer identity attestation, SQLite receipt authority, and opt-in signed native installer worker service

## Status

Accepted (approved by user for native broker architecture, peer-identity admission, memory-only signing keys, bundled SQLite durability, dual lifecycle ownership, and opt-in signed native installer worker service). Specific per-platform service mechanics, installer UX, and public stateful CLI grammar are proposed and remain gated on Tier 2 verification.

## Context

Northstar's redesign establishes a CLI-first architecture where model-facing tools are optional adapters over a shared command engine. Under Gate B (Phase 5 of `plan.md`), the runtime must support stateful operations—long-running background jobs, state queries, cancellation, browser sessions, and desktop automation—without compromising host security, leaking user credentials, or conflating privilege domains.

Currently:
1. `src/runtime/broker-*.ts` implements an uncomposed, prototype local broker in TypeScript using Node.js `net.Server`. It is internal migration code and not production composed.
2. The internal prototype protocol uses `BROKER_PROTOCOL_VERSION = 1` and framed JSON (`BROKER_MAX_FRAME_BYTES = 256KiB`, `BROKER_TOKEN_TTL_MS = 60s`).
3. Peer authentication in `broker-server.ts` relies on non-standard, best-effort `socket.getPeerCredentials?.()`, which is incomplete across Node versions, absent on Windows named pipes, and fails to provide reliable kernel-backed attestation.
4. The prototype `BrokerStateStore` persists JSON documents (`broker-state.json`) via `writeFile` + `rename` without WAL guarantees, atomic transaction receipts, or durable fsync boundaries across platforms.
5. In Node.js, the broker and provider worker child processes run under the invoking user's ambient account (same-UID). Hostile Northstar-spawned provider workers (such as untrusted Python sidecars, scrapers, or compromised media parsers) running under the user's UID can inspect, ptrace, or tamper with user files, SSH keys, credentials, and local broker sockets unless strict isolation is enforced.

### Breaking protocol version cut & frozen envelope shape

This native authority boundary introduces a breaking envelope and handshake change:
- **Broker Envelope**: Version is bumped to `BROKER_PROTOCOL_VERSION = 2`.
- **Closed Wire Discriminator**: Every message variant in `BrokerMessage` has a mandatory `kind` discriminator string:
  - `hello`: `{ version: 2, kind: "hello", clientId: string, projectId: string, requestedCapabilities: BrokerCapability[] }`
  - `welcome`: `{ version: 2, kind: "welcome", epoch: string, clientId: string, sessionId: string, token: string, expiresAt: number, capabilities: BrokerCapability[], projectId: string }`
  - `request`: `{ version: 2, kind: "request", token: string, epoch: string, sessionId: string, sequence: number, projectId: string, request: RuntimeRpcV1Request }`
  - `query`: `{ version: 2, kind: "query", token: string, epoch: string, sessionId: string, sequence: number, projectId: string, query: { method: "submissionReceipt", requestId: string } }`
  - `response`: `{ version: 2, kind: "response", sequence: number, reply: RuntimeRpcReply }`
  - `queryResponse`: `{ version: 2, kind: "queryResponse", sequence: number, receipt?: JobSubmissionReceipt }`
  - `error`: `{ version: 2, kind: "error", code: BrokerErrorCode }`
- **RPC Payload**: `RUNTIME_RPC_VERSION = 1` remains canonical ground truth as defined in `src/runtime/runtime-rpc-protocol.ts`.
- Legacy v1 TypeScript broker clients and envelopes are internal/migration artifacts; they are incompatible and **never accepted** by the v2 native broker. Golden fixtures cover broker-v2 envelopes enclosing `runtime-rpc-v1` payloads.

### Threat model and scope

- **In Scope**:
  - Hostile or compromised Northstar-spawned provider workers executing untrusted remote code or processing adversarial payloads.
  - Cross-worker snooping, secret extraction, and workspace tampering between concurrent or sequential jobs.
  - Transport loss, system crashes, or power interruptions during mutation dispatch.
  - Replay attacks, duplicate mutations, and unauthorized capability escalation.
- **Explicitly Excluded**:
  - Arbitrary non-Northstar malware or rootkits already running under the user's account or possessing system root privileges. If the user's ambient interactive session is already compromised by third-party malware, host security is assumed forfeit.
  - Hardware side-channels and kernel zero-day privilege escalations.

### Authoritative source links

- **Node.js Net v24 API**: [Node.js v24.x IPC & Unix Domain Sockets / Windows Named Pipes](https://nodejs.org/docs/latest-v24.x/api/net.html)
- **Microsoft Named Pipe Security & Client Impersonation**: [Named Pipe Security and Access Rights (Windows API)](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights) and [CreateNamedPipeW API](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createnamedpipew) (`PIPE_REJECT_REMOTE_CLIENTS`)
- **SQLite Official Durability & WAL**: [Write-Ahead Logging (WAL)](https://www.sqlite.org/wal.html), [Atomic Commit in SQLite](https://www.sqlite.org/atomiccommit.html), and [PRAGMA synchronous / fullfsync](https://www.sqlite.org/pragma.html#pragma_synchronous)
- **Apple App Sandbox & Process Isolation**: [App Sandbox Design Guide & Inheritance](https://developer.apple.com/library/archive/documentation/Security/Conceptual/AppSandboxDesignGuide/AboutAppSandbox/AboutAppSandbox.html)
- **systemd Dynamic Users**: [systemd Dynamic Users and Sandboxing](https://systemd.io/DYNAMIC_USERS/)
- **npm Platform Targeting**: [npm package.json `os` and `cpu` configuration](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#os)

## Decision

We establish an immutable native authority boundary for all stateful Northstar execution. Production/release stateful CLI claims remain gated until Gate B passes all acceptance criteria. The source tree may expose an unsigned local/development broker/jobs surface for unprivileged end-to-end validation, provided ordinary job commands are connect-only, broker startup remains explicit, and the local surface is not represented as privileged isolation or release proof.

The architecture rests on the following foundational decisions:

### 1. Standalone native Rust broker (`northstar-broker`)

Runs as a separate unprivileged process under the invoking user's account.
- Owns the public local IPC endpoint, peer admission, grant intersection, replay protection, monotonic sequence tracking, bundled-SQLite receipt authority, and requests to the privileged worker service.
- Endpoint and startup freeze project identity (`projectId`). Client-supplied `projectId` values in handshake and subsequent requests must match the frozen project identity exactly; client-supplied project identifiers are routing checks and never grant authority.
- The root signing key is generated in heap memory at startup using the operating system CSPRNG. It is zeroized on shutdown, with memory locking (`mlock` / `VirtualLock`) applied best-effort. If memory locking is unavailable in the environment, this residual is accepted. The root signing key **never leaves Rust broker memory**: it is never written to disk, never sent to clients, and never sent to the Node executor.
- Public handshake requires **no client root secret**. Admission is based strictly on kernel-level peer attestation (verifying the connecting process PID/UID/SID matches the expected owner) plus a single, fixed server-owned CLI grant ceiling. Client ID, role strings, and requested capabilities are untrusted labels/requests and can never broaden this ceiling. Upon successful attestation, the broker issues a short-lived (60s TTL) epoch-bound HMAC session token.
- Pi or executor authority travels exclusively through the private inherited channel, never through the public IPC handshake.
- Public CLI commands connect only to an existing healthy broker endpoint (or run `northstar broker serve` explicitly); if absent or unhealthy, standard CLI invocations return a typed unavailable error and never automatically spawn or detach background authority.

### 2. Dual lifecycle ownership & single-owner lock

The broker operates under an explicit dual lifecycle model:
- **Foreground Terminal CLI**: An explicit foreground command (`northstar broker serve`) starts the broker attached to the terminal; it never detaches, logs to stderr, and terminates cleanly on SIGINT/SIGTERM.
- **Session-Owned Pi Harness**: When a Pi session requires stateful capabilities, the Pi extension may launch and manage the compiled broker-host as a direct child process; the broker remains attached to the Pi session lifecycle and terminates automatically when Pi exits. Startup is code-owned and activates only when an authorized stateful path requires it; no background daemons or login-time services are installed.
- **Exclusive Single-Owner Lock**:
  - Each project runtime endpoint (`~/.northstar/runtime/<projectId>`) is protected by an exclusive advisory file lock (`broker.lock`).
  - When either starter (CLI foreground serve or Pi session host) initiates, it first probes for an existing healthy, compatible broker on the endpoint. If a compatible broker is present, the starter connects/reuses the endpoint and does not launch a second instance.
  - Stale or incompatible endpoints follow an owner-validated fail-closed recovery protocol: endpoints are removed only after proving current UID ownership and absence of a live lock-holding process; blind deletion or arbitrary takeover is prohibited.
- **Executor Authority Binding**:
  - The compiled Node host that launched the running broker instance remains its sole trusted executor over the private inherited channel.
  - Sibling Pi sessions or concurrent CLI processes connect over the public IPC endpoint and are subject to the fixed public grant ceiling.

### 3. Private Node executor channel & production topology

Trusted compiled Node.js host (`src/runtime/broker-host.ts`) runs as the normal user and owns existing JavaScript command handlers and domain policy.
- Production startup topology:
  1. Production resolves and verifies the root-installed `northstar-broker` binary using a root-owned manifest (never searching ambient `PATH`). In an unpackaged source checkout only, local development may resolve the fixed Cargo target under `rust/target/{release,debug}`; it still never searches ambient `PATH` or accepts a caller-selected executable.
  2. The Node host creates a private control channel (anonymous pipe or socketpair created close-on-exec by default). Node explicitly maps only the one designated child descriptor into the Rust broker process during `spawn`.
  3. The Rust broker process immediately marks its retained descriptor close-on-exec before spawning any descendants.
  4. Node composes internally from `src/index.ts` behind closed stateful registration. No production `tsx` is permitted.
- Death and Fate-Sharing:
  - If the Node executor dies, the Rust broker immediately terminates all in-flight work, maps pending/dispatched transactions to `outcome_unknown`, and shuts down.
  - If the Rust broker dies, the Node host terminates and closes local resources.
  - Sibling CLI processes connect only to the active broker; they never launch background authority.
- Protocol Conformance:
  - `src/runtime/runtime-rpc-protocol.ts` remains canonical ground truth for RPC messages (`RUNTIME_RPC_VERSION = 1`). Cross-language golden fixtures enforce strict Rust wire conformance.
  - There is **no authoritative TypeScript fallback**. The TS v1 broker is internal migration code. If native binaries cannot execute, stateful capabilities are unavailable while stateless commands remain fully operational.

### 4. Bundled-SQLite receipt authority & durability

State storage is managed exclusively by the Rust broker using bundled SQLite (via `rusqlite`, exact version locked in `Cargo.lock` during implementation).
- Configuration: Write-Ahead Logging (`PRAGMA journal_mode=WAL`), `PRAGMA synchronous=FULL`, and macOS `PRAGMA fullfsync=ON` / `PRAGMA checkpoint_fullfsync=ON`.
- Storage is owner-only (`0700` directory, `0600` database file). An integrity check (`PRAGMA integrity_check`) runs upon opening.
- Schema:
  - `sequence INTEGER PRIMARY KEY AUTOINCREMENT`
  - `mutation_id TEXT UNIQUE NOT NULL`
  - `idempotency_key TEXT UNIQUE NOT NULL`
  - `project_id TEXT NOT NULL`, `owner_identity TEXT NOT NULL`, `operation TEXT NOT NULL`
  - `state TEXT NOT NULL CHECK(state IN ('pending', 'dispatched', 'settled', 'outcome_unknown'))`
  - `request_digest TEXT NOT NULL` (SHA-256 digest of original validated request only)
  - `receipt_payload TEXT` (explicitly bounded to broker frame/result limits; contains only validated, scrubbed receipt data, never raw credentials or unvalidated request bodies)
  - `created_at INTEGER NOT NULL`, `updated_at INTEGER NOT NULL`
- State Transitions:
  - Persist `pending` before dispatch.
  - Commit `dispatched` immediately before irreversible external handoff.
  - Settle to `settled` after verified acknowledgment.
  - Upon restart: unacknowledged `pending` or `dispatched` records map conservatively to `outcome_unknown` unless non-dispatch is provable. Auto-retry is strictly forbidden.
- Eviction & Quotas: Zero automatic eviction until a separately approved retention fence is implemented. When quota or disk space is exhausted, new mutations reject with a typed error while read queries remain functional.
- Corruption Handling: Corrupt database files fail closed. The broker never clobbers, regenerates, or automatically archives corrupt state files.

### 5. Opt-in signed native installer for worker service (`northstar-worker-service`)

To prevent naming collisions with the User-Chrome companion, the privileged helper is named `northstar-worker-service`.
- **Distribution via Native OS Installers Only**:
  - Full Gate B production mode requires a signed native OS installer package that installs **both** `northstar-broker` (non-root executable, root-owned immutable install path) and `northstar-worker-service` (root-owned daemon), plus a root-owned executable manifest.
  - macOS: Signed and notarized installer package (`.pkg`).
  - Linux: Signed distribution package (`.deb` / `.rpm`).
  - Windows: Signed Windows Installer package (`.msi` via WiX).
  - The Node npm package serves strictly as client, executor, and installer locator; it **never** contains the production broker in `optionalDependencies`.
  - In development and unprivileged Tier 1 CI, unsigned Cargo builds may run test endpoints, but `northstar-worker-service` remains strictly unavailable. Development workers running under ambient same-UID would pass owner peer attestation and are not considered isolated.
- **Never Elevated via npm or Node**: `npm postinstall`, `sudo northstar`, and Node scripts are strictly forbidden from writing system state or invoking elevation.
- **Worker Service Endpoint & Authorization**:
  - Listens on a root-owned endpoint with kernel peer attestation.
  - Verifies that the calling process is an attested `northstar-broker` binary matching root-installed path/inode (or Windows image path) and cryptographic signature/digest.
  - Operates on closed, allowlisted worker descriptor IDs and a root-owned executable manifest. Arbitrary executable paths, shell execution, arbitrary environment variables, and root execution are rejected. Even an authenticated caller cannot trigger arbitrary root side-effects.
  - Multi-user scoped with resource limits and execution quotas.

### 6. Proposed per-job worker isolation (not shared UID)

Provider workers must not share a static UID across jobs, as shared identities allow cross-job snooping and secret extraction. Mechanics are proposed pending Tier 2 proof:
- **Linux Full Mode**: Per-job transient systemd units using `DynamicUser=yes`, private `/tmp`, private runtime/home directories, and process tracking via cgroups and `pidfd`. Systems lacking systemd or dynamic user support fail closed for isolated worker mode.
- **macOS Full Mode**: Signed installer provisions an installer-configured, bounded pool of hidden, unprivileged service identities. Allocation leases one UID per concurrent job with a private `0700` workdir/home. On cleanup, root worker service performs process-group termination plus UID-wide process enumeration and kill-to-zero, repeating until no process with the leased UID remains, then scrubs the workspace. If zero processes cannot be proven, the identity and workspace are permanently quarantined and the pool fails closed upon exhaustion. Tier 2 tests must explicitly verify containment against `setsid` and double-fork escape attempts.
- **Windows Full Mode**: Per-job AppContainer or restricted tokens with a dedicated Job Object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`).
- **Lifecycle & Scrubbing**: An isolation identity and workspace are never reused until verified process-tree termination (`pidfd`, kill-to-zero, Job Object) and comprehensive filesystem scrub.

### 7. Capability-scoped worker credentials

Workers receive minimal capability-scoped credentials:
- Existing child environment owners (`buildCliEnvironment`, `buildNativeChildEnvironment`, `buildPythonChildEnvironment`) remain authoritative.
- `HOME`, `TMPDIR`, and `USER` are redirected to per-job sandbox paths; `PATH` is fixed and restricted.
- Credentials are provided via inherited file descriptor, private stdin, or credential helper. Provider-required environment variables are admitted strictly from existing capability allowlists only when protocol requires.
- Credentials never appear in command-line arguments (`argv`), logs, persistent state, or crash reports. Broker root and session signing keys are never passed to workers. Live canary token tests enforce secret containment.

### 8. UI automation adapters as trusted user-session components (TCB)

Browser automation (`agent-browser`) and desktop automation (`cua-driver`) require active GUI sessions, TCC accessibility permissions, display server handles, or live Chrome profile leases.
- User explicitly approved signed and hash-pinned browser and desktop drivers as part of the Trusted Computing Base (TCB).
- **Execution Domain**: UI adapters execute directly under the user's interactive session account—**never via the privileged worker service**.
- **Resolution & Security Controls**:
  - Never receive broker root signing keys or session tokens.
  - `cua-driver` resolves strictly as the fixed `cua-driver` command from the sanitized, controlled `PATH` (no `CUA_DRIVER_PATH` or user-selected path) and is verified against the versioned signed artifact manifest before execution.
  - `agent-browser` resolves from its pinned optional package / package-lock integrity and platform artifact manifest. Arbitrary path substitution is prohibited.
  - Retain strict origin controls, domain allowlisting, lease timeouts, fresh ref preflights, `stateId` AX-tree fingerprinting, and mandatory human confirmation for sensitive keyboard/mouse inputs.
  - Remote pages and DOM outputs are treated as untrusted external evidence.

### 9. Cancellation authority & pass-through wire semantics

- The broker authorizes `cancelAndSettle` requests under the `runtime:cancel` capability.
- Validates the existing request shape strictly against `src/runtime/runtime-rpc-protocol.ts`: duplicate-free array of `runIds` bounded to `1..64`, and caller-supplied `settlementWindowMs` bounded to `1..10_000`. The broker never widens or clamps these values.
- The broker records the request as a mutation in the SQLite journal, forwards it unchanged across the private channel to the runtime executor, and returns the runtime reply only after `validateReply`.
- At this protocol layer, `RuntimeRpcReply.data` is opaque. The broker never interprets, parses, or collapses reply data into invented result-state labels.
- Cancellation, execution failure, and transport loss remain strictly distinct at the broker envelope and journal levels (e.g., successful cancel reply vs failed RPC reply vs `outcome_unknown` on transport severance).

## Alternatives rejected

1. **Client root-secret handshake**:
   - *Rejected*: Exposing root keys to clients or storing secret files on disk allows in-scope hostile Northstar pre-isolation workers to read or steal root authority from the user's filesystem. Kernel peer attestation establishes caller identity without shared disk secrets, while arbitrary non-Northstar ambient malware remains out of scope.
2. **Node-API in-process addon**:
   - *Rejected*: In-process addons share Node's address space and UID. Memory corruption crashes the entire runtime, and compromised threads gain ambient access to V8 heap memory and process credentials.
3. **npm postinstall elevation (`sudo northstar`)**:
   - *Rejected*: Package managers must never execute arbitrary root code or modify system daemon configurations during package install or runtime execution.
4. **Static shared service UID (`_northstar`)**:
   - *Rejected*: A single shared service account allows sequential or concurrent jobs to inspect each other's residual files, read memory via debug syscalls, or steal credentials across tasks.
5. **Deprecated Apple Seatbelt (`sandbox_init` / `/usr/bin/sandbox-exec`)**:
   - *Rejected*: Apple has formally deprecated Seatbelt APIs. They are private, unsupported, and brittle across macOS updates.
6. **Pure TypeScript broker fallback**:
   - *Rejected*: Maintaining two diverging authority engines creates security parity drift. If native binaries cannot run, stateful operations fail closed.

## Distribution and platform packaging targets

Full Gate B production mode requires native Tier 2 execution proof across:
- **macOS**: arm64 (`darwin-arm64`), x64 (`darwin-x64`) via signed/notarized `.pkg`.
- **Linux**: glibc x64 (`linux-x64`), arm64 (`linux-arm64`) with systemd full mode via signed `.deb` / `.rpm`.
- **Windows**: x64 (`win32-x64`), arm64 (`win32-arm64`) via signed `.msi`.
Systems with musl, non-systemd Linux, or lacking supported isolation mechanics fail closed for stateful operations.

## Verification gates

Gate B is accepted only when all of the following are satisfied:
1. **Tier 1 (Unprivileged / CI)**:
   - Clean `cargo test` across the Rust broker workspace.
   - Cross-language golden tests proving `runtime-rpc-protocol.ts` (v1) and Rust broker (v2 with mandatory `kind`) models are 100% wire-compatible.
   - Zero root-secret files written to disk; handshake succeeds via peer attestation alone.
   - Mock attestation tests: verifies simulated UID/SID mismatch, expired token, tampered signature, and grant ceiling enforcement.
   - SQLite WAL + FULL sync durability tests: synthetic power-loss/crash preserves uncorrupted database; ambiguous dispatch correctly maps to `outcome_unknown`.
   - SQLite ENOSPC / quota test: write failure rejects new mutations while read queries continue to work.
   - Windows Named Pipe rejects remote clients and non-owner SIDs.
2. **Tier 2 (Privileged / Native Integration)**:
   - Native installer cleanly installs and uninstalls `northstar-broker` and `northstar-worker-service`.
   - Hostile worker file access test: Provider worker under per-job isolation attempting to read synthetic `0600` canary files in a `0700` user directory receives `EACCES`.
   - Hostile worker socket rejection test: Compromised worker under per-job isolation attempting to connect to the broker endpoint is rejected by kernel peer attestation.
   - Cross-worker isolation test: Concurrent worker $A$ cannot read worker $B$'s temporary files, memory, or pipes.
   - macOS process-tree kill-to-zero test: Worker attempting escape via `setsid` or double-fork is terminated down to zero processes before identity reuse.
   - Canary token test: Provider credentials injected into worker cannot be observed in parent broker memory or other jobs.
   - Dual lifecycle tests: concurrent starters yield a single owner; Pi-owned broker terminates on Pi exit; foreground serve terminates on signal.
