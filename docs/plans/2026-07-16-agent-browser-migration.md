# Agent-browser Migration Implementation Plan

> **For agentic workers:** Implement task-by-task in order. Track progress with checkboxes. Do not commit.

**Goal:** Replace public custom-CDP browser automation with exact-pinned agent-browser through bounded Pi adapter while preserving cookie setup and rollback.

**Architecture:** `browser-tools` calls closed adapter; adapter builds fixed commands for injected process runner; runner owns environment, private directories, output caps, cancellation, and session cleanup. Legacy CDP remains selectable for one release. Cookie import/login persistence remains separate.

**Tech stack:** TypeScript, Node.js >=24 (pending approval), TypeBox, Node test runner, `agent-browser@0.32.0` (pending approval).

## Global constraints

- ADR 0001 must be approved before dependency or behavior changes.
- Preserve user-owned `src/github.ts` and `src/native-tools.ts`; do not edit, format, stage, or overwrite them.
- One writer only. Browser worker completes implementation and reviewer pass in active worktree before desktop worker starts. Parent owns shared-file handoff; desktop worker reads current post-browser files and applies additive edits—never parallel branches or merge-by-overwrite.
- No shell, `npx`, raw upstream pass-through, auto-install, upgrade, plugins, providers, profiles, restore, dashboard, or chat.
- Never expose cookie values, typed secrets, expressions, screenshot base64, raw stdout/stderr, or inherited secrets.
- Manual Chrome/browser checks are gated and reported unverified when unavailable.

---

### Task 1: Approval and exact package gate

**Files:** `package.json`, `package-lock.json` only after approval.

**Produces:** exact dependency/version/runtime evidence.

- [ ] Record `git status --short`; assert dirty user files remain unchanged.
- [ ] Run `npm view agent-browser@0.32.0 version engines license dist.integrity --json`; compare to ADR.
- [ ] Inspect package scripts/postinstall and license at exact tarball/version; trace native release-asset URL, record downloaded binary SHA-256, and compare against separately reviewed known-good hash before execution.
- [ ] After approval, add exact `"agent-browser": "0.32.0"` and approved Node engine floor; regenerate lockfile non-interactively.
- [ ] Resolve installed executable and verify `--version` returns `0.32.0` without launching browser.
- [ ] Run `npm audit --audit-level=high` and record package-size/postinstall impact.

### Task 2: Characterize current contract before switching

**Files:** modify `test/browser.test.ts`, `test/cdp.test.ts`, `test/index.test.ts`, `test/bootstrap.test.ts`.

**Produces:** compatibility tests for all current actions/inputs, opt-out, status, errors, loopback endpoint, and setup storage state.

- [ ] Add table-driven cases for 13 legacy actions and every public field.
- [ ] Lock `PI_SEARCH_BROWSER_AUTOMATION` false-value behavior and status no-launch behavior.
- [ ] Lock loopback-only endpoint parsing and provider-domain cookie filtering.
- [ ] Add secure target behavior tests: cookie metadata only and sensitive-action classification. These should fail against legacy implementation for documented reason.
- [ ] Run `node --import tsx --test test/browser.test.ts test/cdp.test.ts test/index.test.ts test/bootstrap.test.ts`; capture expected red failures only for new secure contract.

### Task 3: Add closed browser policy

**Files:** create `src/browser-policy.ts`; create `test/browser-policy.test.ts`.

**Produces:** validated `BrowserRequest`, action schemas, URL/domain policy, sensitive classification, stable errors.

- [ ] Define discriminated union for legacy actions plus approved `snapshot | fill | wait | get_url | get_title`; reject unknown fields/actions.
- [ ] Bound selector, text, expression, scroll, wait, URL, cookie count/size, and output inputs.
- [ ] Validate public HTTP(S), no URL credentials, public DNS results, private/reserved IPv4/IPv6, mapped IPv6, and metadata destinations.
- [ ] Add optional `allowedDomains`; default to navigation hostname; validate explicit public hostname patterns; freeze sorted set per owned session; fail closed on non-allowlisted redirects/subresources/WS/workers/beacon/WebRTC; keep legacy endpoint loopback validator separate.
- [ ] Add DNS-rebinding residual-risk test with mutable resolver/fake connection. Require deployment egress deny for high-assurance private-network containment.
- [ ] Classify `evaluate` and `set_cookies` as sensitive; normalize `cookies` metadata-only policy. No per-call UI confirmation — security is external.
- [ ] Add negative tests for localhost variants, RFC1918, CGNAT, link-local, loopback, mapped IPv6, metadata, credentials, DNS-private, oversized input, stale fields, and unknown actions.
- [ ] Run `node --import tsx --test test/browser-policy.test.ts` until green.

### Task 4: Add injectable agent-browser process runner

**Files:** create `src/agent-browser-process.ts`; create `test/agent-browser-process.test.ts`.

**Produces:** `AgentBrowserProcessRunner.run(request, options)` and `closeSession(session, options)`.

- [ ] Write fake-executable tests first for fixed argv, stdin, `shell:false`, executable/version check, private dirs, and minimal environment.
- [ ] Test inherited hostile `AGENT_BROWSER_*`, `npm_config_*`, proxy, token, cookie, `NODE_OPTIONS`, `NODE_PATH`, `GIT_CONFIG_*`, `SSL_CERT_*`, loader/preload, and user/project config cannot affect child.
- [ ] Test incremental stdout/stderr hard caps, malformed/multiple JSON, nonzero exit, sanitized error, timeout, abort, TERM/KILL escalation, and close deadline.
- [ ] Implement random private runtime root and fixed config/session paths with POSIX permissions.
- [ ] Implement bounded stream collection before concatenation; validate JSON success/error envelope.
- [ ] Implement cancellation and owned-session cleanup without retrying state-changing command; reap only owned child/process group and verify unique namespace has no live daemon or stale sidecars after close.
- [ ] Run `node --import tsx --test test/agent-browser-process.test.ts` until green.

### Task 5: Add typed agent-browser adapter

**Files:** create `src/agent-browser.ts`; create `test/agent-browser.test.ts`.

**Consumes:** policy union and process runner.

**Produces:** `AgentBrowserAdapter.execute(request, options)`, `status()`, `close()`.

- [ ] Write mapping tests for all 13 legacy actions and approved additions.
- [ ] Define exact command mapping and normalized result per action; no raw upstream envelope.
- [ ] Preserve `type` semantics; use `fill` only for explicit fill action.
- [ ] Normalize text/HTML/title/URL/tabs/snapshot/click/scroll/wait/close results.
- [ ] Return screenshot as image content plus media type, width, height, and byte length only; enforce byte/dimension cap before constructing Pi result and document Pi session retention.
- [ ] Return cookie metadata without values; require policy authorization for sensitive actions. No per-call UI confirmation.
- [ ] Make status executable/version-only and close idempotent.
- [ ] Test stable session, public/setup isolation, details sanitization, and unsupported upstream shape.
- [ ] Run `node --import tsx --test test/agent-browser.test.ts` until green.

### Task 6: Integrate browser route, backend flag, setup, and docs

**Files:** modify `src/browser-tools.ts`, `src/index.ts`, `src/bootstrap.ts`; conditionally `src/providers.ts`; modify `README.md`, `SKILL.md`, `test/contract.test.ts`, and affected tests.

**Produces:** public compatible browser tool with dual backend flag.

- [ ] Route owned automation under `PI_SEARCH_BROWSER_BACKEND`; unset defaults `agent-browser`, explicit `cdp` routes legacy loopback endpoint only. Isolate runtime roots/namespaces and test concurrent backend use has no port/state collision.
- [ ] Keep `PI_SEARCH_BROWSER_AUTOMATION` kill switch across public and setup paths.
- [ ] Keep default-browser cookie import. Migrate headed setup login only when provider-domain/session-cookie filtering tests prove parity; otherwise retain existing setup CDP and document boundary. Honor custom login port on legacy path; emit deprecation warning for agent-browser path and remove no earlier than `0.2.0`.
- [ ] Add approved action schemas/descriptions without raw passthrough.
- [ ] Update README/SKILL with security-positive breaking cookie/eval changes, endpoint deprecation, install, status, session, domain additions, screenshot/Pi retention, setup, and rollback behavior. Note security is external (containerization/other extensions).
- [ ] Assert contract tool names remain stable and prohibited aliases are absent.
- [ ] Run focused browser/setup/index/contract tests until green.

### Task 7: Review and verification gate

- [x] Run `node --import tsx --test test/browser*.test.ts test/agent-browser*.test.ts test/cdp.test.ts test/bootstrap.test.ts test/index.test.ts test/contract.test.ts` — all 11 referenced test files exist; `npm test` covers them (754 pass, 0 fail, 6 skipped).
- [x] Run `npm test` — 754 pass, 0 fail, 6 skipped.
- [x] Run `npm run typecheck` — tsc --noEmit clean, no errors.
- [x] Run `npm audit --audit-level=high` — 8 vulnerabilities reported (4 moderate, 4 high), all in transitive dependencies (hono, ip-address, protobufjs, undici, brace-expansion, fast-uri), none in project source. Fixes available via `npm audit fix` for non-breaking; `--force` needed for undici.
- [x] Run `npm pack --dry-run` — 52 files, 532.7 kB unpacked; required adapter/docs ship; no private runtime artifacts in tarball.
- [x] Run `git diff --check` — clean, no whitespace errors.
- [ ] Fresh compatibility reviewer checks action/input/output/errors and rollback — needs independent reviewer pass, not verifiable in automated session.
- [ ] Fresh security reviewer checks process/env/config, URL/DNS, secrets, screenshots, and daemon cleanup — needs independent security reviewer pass. Confirmation gates out of scope (external security).
- [ ] Fix confirmed blockers one at time with regression test; repeat review until pass or three rounds — no blockers found in automated verification; pending independent review passes.
- [ ] If safe environment exists, run gated live public open/snapshot/click/fill/wait/get/screenshot/close, strict-domain blocks, abort cleanup, session isolation, setup cookie fixture, and rollback — no browser environment available in this session; mark unverified.

> **Note:** The last four items require either an independent human reviewer or a live browser environment, neither of which is available in this automated verification pass. They remain unchecked with honest status notes.

### Task 8: Deferred CDP contraction

**Gate:** separate approval after one-release burn-in and zero-usage evidence.

- [ ] Name owner, release/date, success and abort criteria.
- [ ] Remove only obsolete high-level public CDP primitives/tests/docs.
- [ ] Retain cookie persistence/filtering and required setup/loopback migration code.
- [ ] Repeat full compatibility/security verification before deleting rollback flag.
