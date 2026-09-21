# Northstar redesign staged plan

Status: audited rewrite for the CLI-first hard cut.
Baseline: e4eda086060f.
Branch: design/northstar-cli-skill-router.

## Resolved decisions

1. **Hard cut.** On merge/release there is no compatibility window, no grandfathered default tool set, and no warning-only release. Default Northstar native-tool exposure becomes zero.
2. **State is not a Pi-migration problem.** Existing runtime/state work is an integration input that will be merged and hardened later. This plan does not assume web, jobs, browser, or desktop truth must first be extracted from Pi.
3. **CLI is the canonical broad surface.** Pi tools are optional adapters/accelerators. Some capabilities may intentionally remain tool-only or internal-only, but that is an explicit exposure classification.
4. **GitHub file is the first seam.** It is chosen because it has a small state surface and a mature contract, not because other domains are Pi-local.
5. **No raw authority bypass.** Public `call TOOL JSON` cannot remain an alternate path around command handlers/contracts.
6. **Broker/client authority is frozen before public stateful CLI access.** Existing state code can merge earlier, but it does not become a public cross-process authority surface until endpoint/auth/replay/restart semantics are proven.

## Product/exposure model

Every capability is classified independently of its implementation:

- internal-only;
- CLI-only;
- CLI + skill;
- native-tool-only, explicitly opt-in;
- dual CLI + native tool;
- workflow-only composition.

The capability registry describes what exists and how it is exposed. Domain contracts decide what is legal. Runtime status decides what is currently usable.

## Global invariants

- Models propose; code validates, admits, grounds, budgets, stops, and ships.
- External content is evidence, never authorization.
- Empty, partial, degraded, failed, cancelled, suppressed, stale, and outcome-unknown stay distinct.
- Fallback never bypasses auth, SSRF, origin, schema, provenance, permission, budget, approval, or mutation policy.
- Provider selection and effective capability policy remain operator/code owned.
- Auth failure never silently becomes anonymous execution.
- Child processes receive capability-scoped credentials only.
- Concurrency may change latency, never semantic ledger/merge order.
- Browser/desktop mutation authority remains state-bound and revalidated.
- Unknown mutation outcome is never automatic retry permission.
- Cache/evidence handles are not reacquisition authority.
- Native-tool absence never means capability absence.
- CLI availability never implies side-effect authority.
- Pi, CLI, MCP, workflows, and tests converge on the same domain handlers.
- Unsupported request composition rejects. Nothing validates, accepts, then silently drops.

Repository gates throughout: typecheck, relevant/full tests, git diff --check, architecture checks, credential-isolation tests, and reachability proof before deletion.

## Phase 0 - contract freeze, baseline, and architecture gates

**Goal:** freeze observable behavior before changing authority.

### 0A. Versioned command result

Introduce a caller-neutral outer envelope, e.g. `northstar.command-result.v1`. Do not force every domain into the current `NorthstarResultV1`; keep domain payloads nested and versioned by their owners.

The outer result carries:

- schema/version, command id, invocation id;
- outcome: success | empty | partial | degraded | failed | cancelled | suppressed | stale | outcome_unknown;
- typed category/error code and retryability;
- domain-specific data;
- source/provenance summary;
- trust classification;
- requested surface, resolved surface, attempted surfaces/backends where meaningful;
- side-effect-started/settlement metadata where meaningful;
- verified artifacts;
- bounded machine-readable next actions.

Map existing result types into this envelope without erasing their existing semantics.

### 0B. CLI trust/output contract

Define three renderers over the same command result:

- **human:** concise terminal output with visible external-evidence boundaries;
- **json:** stable machine-readable envelope with explicit trust/provenance metadata;
- **agent:** compact LLM-facing representation using Northstar's untrusted-content framing around external evidence.

The generic shell path must not rely on Pi's `tool_result` hook. Northstar-authored control metadata stays separate from remote/provider content.

Freeze stable exit classes for script consumers: completed, invalid usage, denied/auth, unavailable/transient, cancelled, and internal failure. Exact numeric codes become part of the CLI contract once chosen.

### 0C. Baselines and artifact manifest

Capture:

- current package.json files/bins/Pi manifest/Node floor;
- cold CLI startup and Pi extension load time;
- CodeScene hotspot scores;
- source/test size;
- public capability/reachability/owner matrix;
- current child credential scopes;
- npm pack contents.

Add an expected packed-artifact manifest test and architecture rules:

- capabilities/contracts cannot import Pi adapter code;
- runtime cannot import Pi rendering/TUI;
- commands cannot import CLI presentation;
- workflows may consume capabilities/commands, not vice versa;
- providers do not own operator policy.

**Exit gate:** result/trust contracts and baselines are committed before the first migrated command.

## Phase 1 - canonical stateless command seam

**Goal:** prove one semantic owner across direct, Pi, and CLI callers.

Create:

- command/capability registry;
- caller-neutral `CommandContext`;
- handler interface;
- result mapper/validator;
- exposure metadata.

### 1A. First slice: `github.file`

Route the existing GitHub file contract/execution path through a caller-neutral handler. Do not duplicate request validation.

Required mapping:

- invalid_request -> failed/invalid_input, terminal;
- authentication_required -> failed/authentication_required, terminal;
- exact-file not_found -> failed/not_found, not empty;
- rate_limited -> failed/rate_limited with retry metadata;
- malformed/upstream -> typed failure;
- cancellation -> cancelled;
- clone/REST degradation or fallback remains observable.

Preserve current backend preference and auth semantics. Invalid request and auth remain terminal; eligible execution/upstream failures may use the existing backend fallback chain.

### 1B. Parity and bypass closure

Route the Pi GitHub-file path through the same handler.

Test parity across:

- direct handler;
- Pi adapter;
- CLI renderer.

For a migrated command, `callNativeTool` may not be an alternate owner. If legacy raw-call plumbing temporarily remains for unmigrated commands, migrated ids resolve through the registry first.

Test public/private file, bad token, invalid request, not found, rate limit, malformed upstream, cancellation, scoped child env, secret non-disclosure, all three output modes, and result version validation.

**Exit gate:** GitHub file has one contract/handler path and no caller-specific semantic fork.

## Phase 2 - compiled CLI and private worker boundary

**Goal:** make Northstar a real installed command surface without turning the public CLI into internal RPC.

Ship:

- `northstar` primary binary;
- `pi-northstar` binary alias;
- compiled `dist/`;
- source maps if desired;
- no production tsx/Jiti dependency for normal commands;
- domain/leaf `--help`;
- `domains`, `capabilities`, `status`, `version`.

Initial grammar:

- `northstar github file OWNER/REPO PATH`;
- then other low-state GitHub verbs after parity;
- positional required identity, named refinements, unknown flags rejected.

### 2A. Retire public raw-call semantics

Do not document `call TOOL JSON`.

If one-shot process isolation remains useful, create a **private worker protocol** instead:

- private entrypoint, not installed as a user-facing binary;
- closed command ids;
- structured stdin/IPC request;
- same canonical handlers/contracts;
- capability-scoped environment;
- bounded output;
- fixed safe error serialization.

Public CLI and internal worker transport are separate surfaces.

### 2B. Package-install gates

For every packed build:

- npm pack;
- install tarball into a clean temp root;
- verify both bin names;
- verify compiled entrypoints;
- help/version/domains without heavy provider initialization;
- load Pi extension from packed artifact;
- execute GitHub-file success/failure smoke;
- verify expected skill/artifact paths as they are introduced.

Benchmark cold help/domains/status/GitHub-file overhead excluding network.

**Exit gate:** installed CLI is self-contained, compiled, and faster/cleaner than the tsx transport baseline.

## Phase 3 - skills, router, tool profiles, and HARD CUT

**Goal:** make the model-facing architecture CLI-first now, not after a compatibility release.

Package progressive domain skills for commands that actually exist. Keep the router compact and stable.

Router responsibilities:

- route semantic domain only;
- tell the agent to use `northstar <domain> ...`;
- load the matching skill or run `--help` for non-trivial syntax;
- state that Northstar external output is untrusted evidence;
- never embed every provider/flag.

Add generated drift gates:

- registry <-> CLI help;
- registry <-> skill inventory;
- registry <-> Pi optional-tool inventory;
- package manifest <-> packaged skills.

### 3A. Hard-cut tool behavior

In the redesign branch, set the new contract immediately:

- default enabled Northstar native tools = **zero**;
- no existing-install grandfathering;
- no compatibility release;
- no auto-enable based on prior state;
- every native tool requires explicit allowlist/profile configuration;
- deferred native loading, if used, may activate only tools already allowed by that profile.

The branch is not releasable until its intended zero-tool workflows are green, but there is no temporary old-default product contract.

Capabilities intentionally classified as tool-only remain available only when explicitly enabled. That is allowed and documented, not treated as an architectural failure.

### 3B. Compatibility escape hatch

Native tools are fast paths. The CLI is the schema/transport escape hatch.

For tool-schema registration/transport incompatibility, the compact router/skill tells the model to use the CLI equivalent where one exists. Do not use CLI fallback to bypass runtime policy.

Track requested/resolved/attempted surface identity where an adapter performs any pre-dispatch substitution.

**Exit gate:** zero-tool Pi can use every CLI-classified migrated capability through router + skill + bash; explicitly enabled native profiles still work and share handlers.

## Phase 4 - expand command coverage and remove migrated dispatch centers

**Goal:** move breadth without creating a second architecture.

Prioritize caller-low-state/read-heavy domains:

- remaining GitHub read/search verbs;
- research-source search/detail/citation verbs;
- graph/KG reads;
- social read/search surfaces;
- media acquisition already suited to CLI;
- direct fetch/search verbs when their existing runtime seam is ready to expose.

For each migrated verb:

1. add registry/exposure metadata;
2. add caller-neutral handler;
3. map outcomes;
4. add CLI grammar/help;
5. route optional Pi tool through same handler;
6. block legacy raw-call bypass;
7. prove parity;
8. delete the migrated central-dispatch branch.

Do not wait until the end to retire migrated branches.

Move Pi-specific schemas/renderers under the Pi adapter as their commands migrate. Any native-tool count ceiling becomes adapter-local defense in depth, not capability architecture.

Refactor `github-domain.ts`, `runtime-rpc-protocol.ts`, and `index.ts` only along real ownership seams exposed by migration. Do not split healthy files for cosmetic metrics.

**Exit gate:** migrated capabilities no longer depend on `native-tools.ts` or core-owned Pi schemas.

## Phase 5 - integrate and harden existing runtime/state work

**Goal:** merge the existing state/runtime implementation into the new command architecture. This is integration and authority hardening, not extraction from Pi.

The existing worktree/runtime code can merge before or during this phase. Public cross-process stateful CLI use is gated on the authority contract below.

### 5A. Broker/client authority contract

Default transport:

- local IPC only;
- Unix-domain socket on macOS/Linux, named pipe on Windows;
- owner-only runtime directory;
- validate endpoint owner/mode before connecting or deleting stale endpoints;
- no default TCP listener.

Authentication:

- high-entropy broker root secret stored owner-only;
- OS peer identity where available as additional evidence;
- handshake issues short-lived opaque client/session token;
- token bound to broker epoch, client/session identity, granted capability scope, expiry, and relevant project scope;
- broker restart rotates epoch and invalidates old client tokens;
- provider workers never receive broker root auth.

Clients do not self-authorize providers, credentials, hosts, mutations, or transfer classes. Canonical domain policy revalidates every request.

### 5B. Replay/idempotency/restart rules

- monotonic request sequencing per authenticated connection;
- duplicate mutation ids reject, never replay;
- idempotent/read requests may use explicit bounded idempotency cache;
- job submission returns durable job id;
- transport loss after job submit -> query status, never blind resubmit;
- transport loss after possible mutation dispatch -> outcome_unknown;
- incompatible broker version fails closed;
- stale endpoint cleanup requires ownership proof;
- corrupted state/config refuses rather than regenerating over unknown data.

Hard tests: wrong owner/mode, expired/stolen token, replay, oversized frame, malformed method, capability escalation, cross-project scope attempt, credential-name injection, restart during read, restart during job submit, transport loss during mutation.

### 5C. Evidence, ledger, search, and fetch

Wire the already-decoupled state/evidence implementation through the broker/command seam.

Public guarantees:

- private bounded evidence store;
- TTL/count/byte limits;
- provenance and privacy class;
- response handle is not remote reacquisition authority;
- deterministic passage lookup;
- authenticated-content storage policy;
- deterministic RRF/order;
- zero results distinct from failure;
- suppression distinct from fresh evidence.

Provider health, if enabled, may reorder only an already-authorized provider set and must be scoped narrowly enough to avoid cross-project/auth/capability poisoning.

Fallback classes are explicit. Auth, invalid request, SSRF/origin denial, privacy-transfer denial, and strict-provider selection remain terminal.

### 5D. Jobs and adaptive research

Integrate the existing durable job state behind the same runtime.

Canonical states distinguish queued, running, settling/partial if needed, succeeded, failed, cancelled, and outcome-unknown where applicable.

CLI:

- `northstar jobs status ID`;
- `northstar jobs cancel ID`;
- `northstar jobs result ID`;
- domain-specific start commands.

Pi may subscribe/wake but does not define job truth.

Move adaptive research conceptually under `workflows/research-agent` and keep ordinary search/fetch/GitHub/source handlers independent.

Preserve frozen capability snapshot, multi-dimensional budgets, attempt charging, candidates-vs-evidence admission, deterministic evidence-only floor, bounded verification/repair, exact source-class semantics, and deterministic journals.

Bound planner/structured-output repair attempts and deadlines.

### 5E. Browser runtime

Integrate stateful browser commands without pretending they are stateless.

Ownership:

- Northstar-created session -> Northstar owns lifecycle/cleanup;
- caller-explicit external/upstream session -> Northstar does not silently own/close it.

Preserve URL/DNS/SSRF admission, frozen host/origin authority, ref freshness, explicit navigation transitions, sensitive-action gates, loopback confinement, and user-Chrome authorization leases.

Launch-scoped options that cannot affect a live session fail with typed fresh-session recovery rather than being silently ignored.

Generic CLI screenshots/traces/downloads return verified artifact metadata. Capable adapters may inline images.

Authenticated background use may employ isolated seed-profile -> per-job clone only after explicit operator authorization. Never mutate the user's live browser profile for convenience.

### 5F. Desktop/computer-use runtime

Keep strongest authority last.

Preserve:

`observe -> bind -> revalidate -> mutate`.

Read-only observe/list/screenshot may be CLI-exposed. Sensitive keyboard mutations remain human-approved.

Approval is a runtime/operator authority event, not a CLI boolean. Bind approval to exact operation digest, target/state generation, client/session identity, expiry, and one use.

Changed args/state, newer observation, expiry, reconnect/replay invalidate approval.

Ambiguous post-dispatch transport loss remains outcome_unknown and never auto-retries.

**Exit gate for Phase 5:** all stateful public commands share the same runtime authority semantics across CLI and optional Pi adapters; hostile-client/restart/credential/staleness tests pass.

## Phase 6 - release parity and public-surface closure

**Goal:** make the hard-cut branch shippable.

Build a matrix for every existing Northstar capability and mark it as one of:

- CLI + skill;
- explicit native-tool-only;
- dual CLI/native;
- workflow-only;
- internal-only;
- intentionally removed.

No capability may remain accidentally reachable only through legacy dispatch.

Release gates:

- zero-tool Pi workflows green for every CLI-classified capability;
- explicit native profiles green for native classifications;
- package/skill/help drift gates green;
- packed install smoke green;
- broker-required surfaces pass hostile-client/restart suite;
- generic-shell trust framing verified;
- no public `call TOOL JSON`;
- docs/AGENTS ownership map matches reachable code.

This is the hard cut. There is no migration window after merge.

## Phase 7 - delete obsolete authority

**Goal:** finish the inversion instead of keeping a fossil layer.

Delete after zero-import/reachability proof:

- remaining migrated `native-tools.ts` branches and then the dispatcher;
- core ownership of public Pi schemas;
- duplicate capability/provider/config registries;
- legacy raw-call public grammar;
- old state adapters superseded by the integrated runtime;
- unreachable report/agent paths;
- monolithic root skill detail superseded by domain skills;
- permanent `agent_poll` tool if runtime events/CLI job inspection make it unnecessary.

Split the runtime RPC hotspot into protocol/codec/client/server/errors where that reduces mixed responsibility.

Update AGENTS.md owner map at the same commit as final authority deletion.

## Phase 8 - aggressive provider/capability expansion

**Goal:** prove new functionality no longer taxes default model context.

Now add aggressively:

- lightweight SERP-only routes separate from extraction-heavy providers;
- additional official-SDK-backed providers;
- richer Semantic Scholar/OpenAlex/arXiv citation/full-text verbs;
- Parallel refinements;
- optional cloud-browser backends if authority matches policy;
- async crawl/batch submit/status/cancel;
- targeted N-usable-provider fusion;
- scoped adaptive provider health;
- richer evidence-store queries;
- new social/media/platform nouns and verbs.

Every addition declares:

- capability contract;
- exposure class;
- evidence class;
- credential/privacy class;
- side effects;
- fallback/error classes;
- rate/cost policy;
- persistence/artifact behavior.

Default answer to “does this need permanent native-tool exposure?” is **no**.

## Phase 9 - cross-harness validation and release discipline

Validate:

| Host | Expected surface |
| --- | --- |
| Human terminal | CLI |
| Pi, zero Northstar tools | router + skills + bash CLI |
| Pi, explicit native profile | direct adapter over same handlers |
| Claude Code / Codex / OpenCode-style host | skills + shell CLI |
| local-model coding harness | compact router + staged `--help` |
| scripts/CI | JSON CLI |
| future MCP client | adapter over same handlers/runtime |

Measure:

- always-resident router tokens;
- loaded skill tokens;
- native schema tokens when enabled;
- calls-to-success;
- malformed command rate;
- help-recovery rate;
- CLI cold start;
- broker overhead;
- research grounding/source diversity;
- browser stale-ref recovery;
- small-vs-frontier model routing performance;
- CodeScene health on touched hotspots.

A host adapter is complete only if removing it from a core/CLI build leaves core dependency direction intact.

## First implementation slice

Implement **only `github.file`** through the new seam.

Deliverables:

1. `CommandResultV1<T>` plus runtime validator.
2. Human/JSON/agent renderers and trust/provenance contract.
3. Registry entry for `github.file`.
4. Caller-neutral handler over current GitHub contract/domain path.
5. Explicit error/outcome mapping.
6. Pi GitHub-file path routed through that handler.
7. `northstar github file OWNER/REPO PATH`.
8. Compiled CLI entry and `pi-northstar` alias.
9. Guard ensuring migrated GitHub-file cannot bypass via legacy raw call.
10. Scoped credential/child-env tests.
11. auth/invalid/not-found/rate/upstream/cancel tests.
12. tri-mode output tests.
13. npm-pack clean-install smoke.
14. cold-start and Pi/handler/CLI parity measurements.

Do not redesign the whole GitHub domain in this slice.
Do not migrate web search merely because the registry exists.
Do not build new broker authority before the first seam survives audit.

## Review gates

### Gate A - after the first slice

Audit:

- result taxonomy completeness;
- actual Pi-independence of handler;
- shared code rather than caller imitation;
- credential/process isolation;
- raw-call bypass closure;
- package/cold-start behavior;
- generic-shell trust framing.

Only then expand stateless/low-state verbs.

### Gate B - before public stateful CLI exposure

Audit the integrated runtime/broker authority contract:

- endpoint ownership;
- root/client authentication;
- capability/project scope;
- token expiry;
- replay/idempotency;
- broker epoch/restart;
- cancellation/settlement;
- mutation ambiguity;
- credential dispatch;
- corrupted-state behavior;
- hostile-client tests.

Existing runtime state can already be merged. This gate controls **public cross-process authority**, not whether state code is allowed to exist.

**Gate B Status (2026-09-21): Tier-1 Implementation COMPLETE; Tier-2 Privileged Proof OPEN.**
- Tier-1 complete across 13 slices: Rust `northstar-broker` + TS v2 wire protocol (`BROKER_PROTOCOL_VERSION = 2` with mandatory `kind`), Unix peer attestation scaffolding (`SO_PEERCRED`/`getpeereid`/`LOCAL_PEERPID`) & Windows DACL frozen at ACE `0x0012019F`, memory-only HMAC grants (60s TTL), bundled SQLite receipts (`rusqlite 0.40.2` / `SQLite 3.49.0`, WAL/FULL/fullfsync, 4-state journal, BEGIN IMMEDIATE), dual lifecycle supervision + single-owner lock (`broker.lock`), settle engine, scoped workers, TCB manifest gate (verify-if-enrolled on driver launch), installer skeleton + release CI, and additive unregistered grammar (`broker.serve`, `jobs.status`).
- Research gates R-1..R-8 resolved (R-3 amended to compile-proven versions).
- Evidence: TS 3995 pass/0 fail, Rust 78 pass/0 fail, typecheck + cargo clean, hostile suites green.
- Stateful public CLI REMAINS CLOSED: 28 stateless IDs unchanged; `broker.serve` and `jobs.status` exist but unregistered.
- Tier-2 privileged integration proof is OPEN and explicitly out-of-scope for this machine: `docs/tier2-proof.md` is the handoff (signed installers, per-job multi-user isolation, kill-to-zero, live socket denial, Authenticode/spctl checks on privileged runners).
- Residual risk register: PID-recycling TOCTOU (UID check authoritative), lock-liveness TOCTOU (advisory), model-text-must-never-spawn-broker (negative tests present), unenrolled-manifest-equals-status-quo until Slice-12 packaging enrollment.
- Phase 7 residual removal is running separately; Phase 9 release gates still require Tier-2 proof + stateful unlock registration.

## Definition of done

The redesign is complete when:

- capability existence no longer implies native-tool registration;
- default Northstar native-tool exposure is zero;
- CLI + skills are sufficient for the broad portable surface;
- native tools are explicit optional adapters;
- tool-schema/transport incompatibility has a documented CLI escape path;
- core/runtime/commands are host-neutral;
- raw public call dispatch is gone;
- stateful authority is runtime-owned and tested independently of host UI;
- every old authority center is either deleted or has a narrow, explicit adapter role;
- adding a new provider/platform verb does not materially increase default model context.
