# Browser-ops Parity Implementation Plan

This document defines *how* to build it inside Pi-Northstar's architecture:
a single `browser` MCP tool (`src/index.ts`) → `browser()` router (`src/browser-tools.ts`) →
`AgentBrowserAdapter` (`src/agent-browser.ts`) → process runner (`src/agent-browser-process.ts`)
→ `agent-browser` CLI v0.32.0 subprocess.

## Grounding notes (from `agent-browser skills get core --full`, installed v0.32.0)

These facts came directly from the installed CLI's own docs and materially shape the specs below:

- **Snapshot refs** are plain-text `@eN [tag attr="v"] "text"` nodes (or `--json` for structured
  output). `-i` limits to interactive elements, `-c` compact, `-d <n>` depth, `-s <sel>` scope,
  `-u` includes href. Refs are scoped to *the tab that was active when the snapshot ran* and go
  stale on navigation, dynamic re-render, or tab switch.
- **Stale ref errors are already surfaced by the CLI** as `Element not found: @eN`. Our stale-ref
  detection is a two-layer defense: a fast, subprocess-free *preflight* against our own tracked
  snapshot (Gap 4), plus classifying the CLI's own error text as a fallback (Gap 1 envelope).
- **Overlay-blocked clicks are already surfaced by the CLI** as `covered by <div#consent-banner>`
  — the click fails *before dispatch*. Our "overlay blocker detection" therefore does not need a
  novel probe for the blocking case; it needs to classify that known error string. A lighter
  post-click heuristic (new modal appeared after a click that *did* succeed) is the genuinely new
  piece.
- **Semantic locators already exist natively** as `agent-browser find <role|text|label|placeholder
  |alt|title|testid|first|last|nth> <query> <verb> [args] [--exact]`. `semanticAction` (Gap 9) is a
  thin typed wrapper over `find`, not a new interaction engine.
- **Raw multi-command batching already exists** as `agent-browser batch --json --bail` reading a
  JSON array of argv arrays from stdin — already wired via `runBatchStdin()` in
  `agent-browser-process.ts`. `batch` (Gap 11) is exposing that existing primitive as a public
  tool action with per-step result categorization, not new process-execution code.
- **Tabs have stable string ids** (`t1`, `t2`, ...) and optional user labels, never reused within a
  session. This is the natural key for `SessionPageState`'s tab tracking.
- Sessions are namespace-scoped already (`AgentBrowserSession.namespace`, passed as
  `AGENT_BROWSER_SESSION`/`AGENT_BROWSER_NAMESPACE`); `SessionPageStateStore` keys off the same
  namespace so it composes with the existing adapter session lifecycle without new identity
  concepts.

## Conventions used throughout this plan

- All new modules are ESM TypeScript, strict types, no `any`, matching existing style (see
  `src/desktop-contract.ts` / `src/browser-policy.ts` for the house style: flat exported types,
  validate-and-throw functions, small classes with `Map`-backed state).
- Tests live in `test/<module>.test.ts`, use `node:test` + `node:assert/strict`, run via
  `npm test` (`node --import tsx --test test/**/*.test.ts`).
- New tool actions are added to `BrowserAction` in `src/browser-policy.ts`, handled in
  `AgentBrowserAdapter.dispatch()` in `src/agent-browser.ts`, and exposed as parameters on the
  existing single `browser` tool registered in `src/index.ts` — **no new Pi tool registrations**.
  This satisfies "must work as MCP tool responses, not Pi extension registration": the surface
  area is still one tool call in, one `content`/`details` response out.
- `BrowserResult` (Gap 1) is additive over `BackendCallResult`/`AgentToolResult` — existing
  consumers reading `.content`/`.details` continue to work unmodified; this preserves backward
  compatibility while `resultCategory` etc. ride along as new optional-in-practice fields.

---

# Part 1 — Phase 1 & 2 (Foundation + Reliability)

## 1. Structured Result Envelope

**File**: `src/browser-result.ts` (new)

### Purpose

Every existing handler in `agent-browser.ts` returns a bare `BackendCallResult` (`{ content,
details }`) with no machine-readable outcome classification. Callers (agents) have to string-match
error text to decide what to do next. This component adds a categorization layer that every other
Phase 2+ reliability check plugs into (dispatch verification, stale-ref, scroll no-op, overlay
detection all *report through* this envelope rather than throwing ad hoc errors).

### Interface

```ts
import type { BackendCallResult } from './backend.js';
import type { BrowserAction } from './browser-policy.js';

export type ResultCategory = 'success' | 'failure';

export type SuccessCategory =
  | 'inspection'          // read-only: text, html, get_url, get_title, snapshot, tabs, cookies, status
  | 'artifact-unverified' // screenshot captured but not written to a durable path yet
  | 'artifact-saved'      // screenshot/artifact persisted to a caller-visible path
  | 'completed';          // mutation succeeded: navigate, click, type, fill, scroll, wait, set_cookies, close

export type FailureCategory =
  | 'timeout'
  | 'missing-binary'
  | 'stale-ref'
  | 'no-active-page'
  | 'domain-blocked'
  | 'policy-denied'
  | 'dispatch-unverified'
  | 'overlay-blocked'
  | 'invalid-request'
  | 'process-error'
  | 'unknown';

export interface NextAction {
  tool: 'browser';
  args: Record<string, unknown>;
  reason: string;
}

export interface PageChangeSummary {
  mutationKind: 'navigation' | 'dom-mutation' | 'none';
  previousUrl?: string;
  currentUrl?: string;
}

export interface BatchStepResult {
  index: number;
  action: string;
  resultCategory: ResultCategory;
  successCategory?: SuccessCategory;
  failureCategory?: FailureCategory;
  error?: string;
}

export interface BrowserResult extends BackendCallResult {
  resultCategory: ResultCategory;
  successCategory?: SuccessCategory;
  failureCategory?: FailureCategory;
  nextActions?: NextAction[];
  pageChangeSummary?: PageChangeSummary;
  batchSteps?: BatchStepResult[];
}

export interface EnrichContext {
  action: BrowserAction;
  errorMessage?: string;      // present on failure
  previousUrl?: string;
  currentUrl?: string;
}

/** Classify a raw CLI/adapter failure message into a FailureCategory. */
export function classifyFailure(errorMessage: string): FailureCategory;

/** Pick the default SuccessCategory for an action that succeeded. */
export function classifySuccess(action: BrowserAction): SuccessCategory;

/** Build the follow-up suggestions for a given outcome. */
export function suggestNextActions(action: BrowserAction, failureCategory: FailureCategory | undefined): NextAction[];

/** Wrap a raw BackendCallResult with resultCategory/successCategory/failureCategory/nextActions. */
export function enrichResult(result: BackendCallResult, ctx: EnrichContext): BrowserResult;
```

`classifyFailure` matches against known CLI/adapter error substrings, ordered most-specific-first
(mirrors the reference's "ordered chain: timeout → missing-binary → stale-ref → etc."):

| Pattern (case-insensitive substring/regex) | Category |
|---|---|
| `timed out` | `timeout` |
| `executable not found`, `Cannot execute agent-browser` | `missing-binary` |
| `Element not found: @e`, `Ref not found` | `stale-ref` |
| `No active page`, `no open tab` | `no-active-page` |
| `blocked by domain policy` | `domain-blocked` |
| `disabled by policy` | `policy-denied` |
| `covered by <` | `overlay-blocked` |
| `is required`, `Unsupported browser action`, `must be` | `invalid-request` |
| `Process error:`, `Exited with code` | `process-error` |
| (dispatch-verification failure, set internally, not string-matched) | `dispatch-unverified` |
| anything else | `unknown` |

### File placement

New file `src/browser-result.ts`. No changes to `src/backend.ts` (keeps `BackendCallResult` as the
minimal cross-cutting type; `BrowserResult` is browser-domain-specific and extends it).

### Integration points

- `AgentBrowserAdapter.execute()` in `src/agent-browser.ts`: wrap the return value of `dispatch()`
  through `enrichResult()` before returning. `execute()` already knows the validated `request.action`
  after `validateBrowserRequest()`, and knows if a caught exception occurred, so the wiring is:

  ```ts
  const raw = await this.dispatch(request, options);
  return enrichResult(raw, { action: request.action, errorMessage: extractError(raw) });
  ```

  where `extractError(raw)` reads `raw.details.error` (existing convention — every handler already
  puts `{ error: string }` in `details` on failure via `jsonTextResult`).
- The two policy short-circuits inside `execute()` (session-closed, validation-error) also route
  through `enrichResult` for consistency.
- `browser-tools.ts`'s `agentBrowserRoute` needs no change — it already returns whatever
  `adapter.execute()` returns, so `BrowserResult` flows through to `src/index.ts`'s `browser` tool
  handler untouched (which already spreads `result.content`/`result.details`).
- The legacy CDP path (`legacyCdpBrowser`) is explicitly **not** enriched — it is the rollback path
  and stays behavior-frozen per existing test comments ("rollback path").

### Test requirements (`test/browser-result.test.ts`, new)

- `classifyFailure` returns the correct category for one representative string per category in
  the table above, and `'unknown'` for an unmatched string.
- `classifySuccess('text')` → `'inspection'`; `classifySuccess('click')` → `'completed'`;
  `classifySuccess('screenshot')` → `'artifact-unverified'`.
- `enrichResult` on a `details: { ok: true }` result sets `resultCategory: 'success'` and a
  `successCategory` matching the action.
- `enrichResult` on a `details: { error: 'blocked by domain policy...' }` result sets
  `resultCategory: 'failure'`, `failureCategory: 'domain-blocked'`, and a non-empty `nextActions`
  array.
- `enrichResult` is a superset of the input — asserts `result.content` and `result.details` are
  preserved unchanged (backward compatibility guarantee).
- Integration: extend `test/agent-browser.test.ts`'s existing "sensitive actions disabled by
  default" test to also assert `failureCategory === 'policy-denied'` on the enriched result.

### Dependencies

None — this is the foundation. `BrowserAction` type import from `src/browser-policy.ts` only.

---

## 2. Session Page State

**File**: `src/session-page-state.ts` (new)

### Purpose

Track, per session namespace, the most recent interactive-ref snapshot (`@eN` → role/name/editable
metadata) and the active tab target, so that later components (stale-ref preflight, ref-based
click/fill, tab-drift detection) have a single source of truth instead of re-parsing CLI output ad
hoc. Modeled directly on the existing `ObservationStore` pattern in `src/desktop-contract.ts`
(monotonic generation counter + latest-per-key map), which already solves the identical "reject
stale reads/writes" problem for desktop automation in this codebase.

### Interface

```ts
export interface PageRef {
  ref: string;                 // "@e12"
  role?: string;
  name?: string;
  isContentEditable?: boolean;
}

export interface TabTarget {
  tabId: string;                // stable "t1", "t2", ... per CLI convention
  url: string;
  title?: string;
  label?: string;
  pinned: boolean;
}

export interface PageSnapshotRecord {
  token: number;                // monotonic per-namespace update token
  url: string;
  refs: ReadonlyMap<string, PageRef>;
  capturedAt: number;
}

export class StaleRefError extends Error {
  constructor(public readonly ref: string, public readonly detail: string) {
    super(`Stale or unknown ref ${ref}: ${detail}`);
  }
}

export class SessionPageStateStore {
  /** Current snapshot for a namespace, or undefined if none recorded / invalidated. */
  snapshot(namespace: string): PageSnapshotRecord | undefined;

  /**
   * Record a new snapshot, incrementing the namespace's token.
   * If `expectedPriorToken` is provided and no longer matches the stored token
   * (a newer snapshot already landed while this one was in flight), the call
   * is a no-op and the *current* (newer) record is returned — rejects the stale update.
   */
  recordSnapshot(namespace: string, url: string, refs: PageRef[], expectedPriorToken?: number): PageSnapshotRecord;

  /** Drop the tracked snapshot for a namespace (navigation, tab switch, close). */
  invalidate(namespace: string, reason: string): void;

  /** Resolve a ref against the current snapshot; throws StaleRefError if absent/invalidated. */
  resolveRef(namespace: string, ref: string): PageRef;

  /** Token to pass as `expectedPriorToken` when kicking off a new snapshot fetch. */
  currentToken(namespace: string): number;

  setActiveTab(namespace: string, tab: TabTarget): void;
  getActiveTab(namespace: string): TabTarget | undefined;
  pinTab(namespace: string, tabId: string): void;

  /** Full teardown for a namespace (adapter close). */
  clear(namespace: string): void;
}
```

Ordered-update-token semantics: `recordSnapshot` is the only writer of `token`. A caller that
began an async `snapshot` CLI call reads `currentToken(namespace)` *before* dispatching, and passes
it back as `expectedPriorToken` when the result arrives. If another `recordSnapshot` (e.g. from a
concurrent navigate-triggered re-snapshot) already bumped the token past what was expected, the
late write is discarded rather than clobbering fresher data — directly analogous to
`ObservationStore.get()`'s `this.latest.get(resourceKey) !== value.generation` check.

### File placement

New file `src/session-page-state.ts`. Pure in-memory `Map`-backed class, no I/O, no CLI calls —
mirrors `desktop-contract.ts`'s `ObservationStore` in being framework-free and independently
testable.

### Integration points

- `AgentBrowserAdapter` (`src/agent-browser.ts`) gains a module-level singleton
  `const pageState = new SessionPageStateStore();` (matches the existing module-level
  `_adapter`/`_adapterInit` singleton pattern in `browser-tools.ts`) or an instance field — instance
  field is preferable since `AgentBrowserAdapter` already carries per-session identity
  (`this.session.namespace`) and is itself held as a module singleton in `browser-tools.ts`, so a
  private `private readonly pageState = new SessionPageStateStore();` field keeps ownership local.
- `handleNavigate`: after a successful `open`, call `this.pageState.invalidate(this.session.namespace,
  'navigation')` — matches the CLI's own "refs become stale the moment the page changes" contract.
- `handleClose`: call `this.pageState.clear(this.session.namespace)`.
- `handleTabs`: after parsing the `tab list --json` result, call `setActiveTab` for the tab marked
  active in the CLI response.
- Phase 3's ref-extraction (component 7) is the sole writer of `recordSnapshot`.
- Phase 2's stale-ref preflight (component 4) and click dispatch verification (component 3) are the
  primary readers of `resolveRef`.

### Test requirements (`test/session-page-state.test.ts`, new)

Mirrors `test/desktop-contract.test.ts`'s style (dense, one assertion block per behavior):

- `recordSnapshot` then `resolveRef` returns the matching `PageRef`.
- `resolveRef` throws `StaleRefError` for a ref not present in the current snapshot.
- `invalidate` clears the snapshot; a previously-valid ref now throws `StaleRefError`.
- Stale update rejection: capture `currentToken`, call `recordSnapshot` twice (simulating two
  in-flight snapshots resolving out of order), then call `recordSnapshot` a third time passing the
  *first* captured token as `expectedPriorToken` — assert the returned record is the second
  (newer) one, not a regression to data derived from the first.
- `setActiveTab`/`getActiveTab`/`pinTab` round-trip.
- Namespace isolation: two different namespaces recording different snapshots don't leak refs into
  each other's `resolveRef` calls.
- `clear` removes all state (snapshot + active tab) for exactly the given namespace.

### Dependencies

None (Phase 1 foundation, alongside component 1). Consumed by components 3, 4, 7.

---

## 3. Click Dispatch Verification

**File**: `src/click-verification.ts` (new); modifies `src/agent-browser.ts`

### Purpose

`runCommand(['click', selector], ...)` returning `success: true` only means the CLI's own dispatch
attempt didn't throw — for role/xpath/ref-style locators there is still a class of failures where
the event fires on the wrong element (portal-rendered overlays, shadow DOM edge cases) without the
CLI's own pre-dispatch `covered by <...>` check catching it. This adds a DOM-event probe: attach a
marker listener before the click, then confirm afterward that *the intended element* actually
received the event.

### Interface

```ts
export interface ClickVerificationResult {
  dispatched: boolean;
  reason?: 'no-event' | 'wrong-target' | 'probe-error';
}

export type EvalRunner = (expression: string) => Promise<{ success: boolean; data?: unknown; error?: string }>;

/** True for selector syntaxes worth the extra two eval round-trips. */
export function isEligibleForVerification(selector: string): boolean;

/**
 * Arms a one-shot capture-phase listener via eval, expected to be called
 * immediately before the click command, and read back immediately after.
 */
export function armClickProbe(runEval: EvalRunner, selector: string): Promise<void>;
export function readClickProbe(runEval: EvalRunner): Promise<ClickVerificationResult>;
```

`isEligibleForVerification(selector)` matches `/^(role=|xpath=|@e\d+)/` — plain CSS selectors (the
common, already-battle-tested case) are left unverified to avoid doubling round-trip latency and
risk on the well-trodden path; ref-based and semantic-locator clicks (Phase 3/4) are exactly the
cases the reference calls out ("DOM-event probe for xpath/role-gated refs").

Probe script (conceptually — implemented as a single literal, non-interpolated JS string with the
selector passed via a `JSON.stringify`-escaped const, never string-concatenated into the script,
consistent with existing `handleEvaluate`'s "stdin/argv, never inline" discipline):

```js
window.__pi_click_probe__ = { fired: false, target: null };
document.addEventListener('click', (e) => {
  window.__pi_click_probe__ = { fired: true, target: e.target === document.querySelector(SEL) };
}, { capture: true, once: true });
```

Read-back script: returns and deletes `window.__pi_click_probe__`.

Because this is an internal, literal, agent-controlled script (never a user-supplied `expression`),
it must **bypass** the `isSensitiveAction('evaluate')` gate — it is dispatched via
`runBatchStdin`/`runCommand(['eval', ...])` directly from within `handleClick`, not through the
public `evaluate` action path, so the existing policy gate (which only applies to the public
`evaluate`/`set_cookies` actions) is untouched.

### File placement

New file `src/click-verification.ts` for the pure probe-script builders and eligibility check.
Sequencing logic (arm → click → read → classify) lives in `AgentBrowserAdapter.handleClick` in
`src/agent-browser.ts`.

### Integration points

`handleClick` in `src/agent-browser.ts`:

```ts
private async handleClick(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
  const selector = request.selector ? validateSelector(request.selector) : '';
  if (!selector) return jsonTextResult({ error: 'selector is required' });
  await this.ensureSession(options);
  const merged = this.mergeOptions(options);

  const verify = isEligibleForVerification(selector);
  if (verify) await armClickProbe(evalRunner(merged), selector);

  const result = await runCommand(['click', selector], merged);
  if (!result.success) return jsonTextResult({ ok: false, error: result.error });

  if (verify) {
    const probe = await readClickProbe(evalRunner(merged));
    if (!probe.dispatched) {
      return jsonTextResult({ ok: false, error: `Click dispatch unverified: ${probe.reason}`, dispatchUnverified: true });
    }
  }
  return jsonTextResult({ ok: true, selector });
}
```

`dispatchUnverified: true` in `details` is the signal `browser-result.ts`'s `enrichResult` uses to
set `failureCategory: 'dispatch-unverified'` (not string-matched, set structurally — see the
envelope's classification table above).

### Test requirements (`test/click-verification.test.ts`, new)

- `isEligibleForVerification` returns `true` for `role=button[name="Submit"]`, `xpath=//button`,
  `@e12`; `false` for `#submit`, `.primary-btn`, `button.cta`.
- `readClickProbe` returns `{ dispatched: true }` when a mock `EvalRunner` returns
  `{ success: true, data: { fired: true, target: true } }`.
- `readClickProbe` returns `{ dispatched: false, reason: 'wrong-target' }` when `target: false`.
- `readClickProbe` returns `{ dispatched: false, reason: 'no-event' }` when `fired: false`.
- `readClickProbe` returns `{ dispatched: false, reason: 'probe-error' }` when the mock eval
  itself fails.
- Integration (using the existing live-binary test convention from `test/agent-browser.test.ts`):
  a `click` on a `role=` selector against a real `about:blank`-launched session round-trips through
  `handleClick` without throwing (smoke-level; full DOM assertions need a fixture page, out of
  scope for this test file — note as a residual risk for implementation).

### Dependencies

Structured Result Envelope (component 1) for `dispatchUnverified` → `failureCategory` wiring.
Session Page State (component 2) only loosely — ref-based selectors (`@eN`) become eligible once
Phase 3 resolves them, but the probe mechanism itself has no hard dependency on component 2.

---

## 4. Stale Ref Detection

**File**: additions to `src/session-page-state.ts` (helper) + `src/agent-browser.ts` (integration)

### Purpose

Reject a `click`/`fill`/`type` against a `@eN` selector *before* it reaches the CLI subprocess if
our own tracked snapshot shows that ref no longer exists (page navigated, re-snapshotted, or was
never snapshotted) — turning what would otherwise be a CLI round-trip ending in
`Element not found: @eN` into a fast, structured, zero-subprocess failure with an explicit
`nextActions` hint to re-snapshot.

### Interface

```ts
// src/session-page-state.ts addition
const REF_PATTERN = /^@e\d+$/;

/** Returns the tracked PageRef for a selector that looks like a ref, or `undefined` if the
 *  selector isn't ref-shaped (plain CSS/role/xpath selectors pass through untouched). Throws
 *  StaleRefError if it *is* ref-shaped but not present in the current snapshot. */
export function preflightRef(store: SessionPageStateStore, namespace: string, selector: string): PageRef | undefined;
```

### File placement

`preflightRef` lives in `src/session-page-state.ts` next to `SessionPageStateStore` since it only
needs the store's public API — no new file. Call sites are in `src/agent-browser.ts`.

### Integration points

`handleClick`, `handleFill`, `handleType` in `src/agent-browser.ts` each gain, immediately after
selector validation and before `ensureSession`:

```ts
try {
  preflightRef(this.pageState, this.session.namespace, selector);
} catch (err) {
  if (err instanceof StaleRefError) {
    return jsonTextResult({
      ok: false,
      error: err.message,
      staleRef: true,
    });
  }
  throw err;
}
```

`staleRef: true` is the structural signal `enrichResult` uses for `failureCategory: 'stale-ref'`
(in addition to the string-matched fallback for CLI-surfaced `Element not found: @eN` errors —
both paths converge on the same category). `suggestNextActions` for `'stale-ref'` returns
`[{ tool: 'browser', args: { action: 'snapshot' }, reason: 'Refresh element references before retrying' }]`.

### Test requirements (`test/session-page-state.test.ts` additions)

- `preflightRef` returns `undefined` for a plain CSS selector (`#submit`) regardless of store
  state — legacy passthrough behavior preserved.
- `preflightRef` returns the `PageRef` for a ref present in the current snapshot.
- `preflightRef` throws `StaleRefError` for a ref-shaped selector (`@e9`) with no snapshot
  recorded, and for one recorded but since invalidated.
- Integration test in `test/agent-browser.test.ts`: `handleClick`-equivalent call (via
  `adapter.execute({ action: 'click', selector: '@e3' })`) with no prior snapshot returns a result
  whose `details.staleRef === true` and never spawns a subprocess (assert by checking the call
  resolves synchronously fast / mock the process runner if a seam is added — see residual risk
  note below on introducing a runner injection point for pure unit tests).

### Dependencies

Session Page State (component 2), Structured Result Envelope (component 1).

---

## 5. Scroll No-op Detection

**File**: additions to `src/agent-browser.ts` (`handleScroll`); small pure helper inline or in
`src/browser-result.ts`

### Purpose

`scroll` can report CLI success while the viewport didn't actually move (already at scroll extent,
target has no overflow, wrong element scrolled). This is not necessarily an error — being at the
bottom of a page is a legitimate terminal state — so unlike click verification this is a **soft**
classification: the result stays `resultCategory: 'success'` / `successCategory: 'completed'`, but
`pageChangeSummary.mutationKind` is set to `'none'` and a `nextActions` hint is attached so the
agent can decide whether to try a different scroll target.

### Interface

```ts
export interface ViewportPosition { scrollX: number; scrollY: number; }

/** Non-interpolated literal eval expression — safe to run outside the sensitive-action gate. */
export const READ_VIEWPORT_EXPR = 'JSON.stringify({scrollX:window.scrollX,scrollY:window.scrollY})';

export function isScrollNoop(before: ViewportPosition, after: ViewportPosition): boolean;
```

### File placement

`ViewportPosition`, `READ_VIEWPORT_EXPR`, `isScrollNoop` go in `src/browser-result.ts` (colocated
with the other pure classification helpers used to build `PageChangeSummary`) or a small
`src/scroll-verification.ts` if `browser-result.ts` starts feeling crowded — prefer the latter for
symmetry with `click-verification.ts`. **Decision: `src/scroll-verification.ts`.**

### Integration points

`handleScroll` in `src/agent-browser.ts`:

```ts
const before = await readViewport(merged);
const result = await runCommand(['scroll', direction, String(px)], merged);
const after = await readViewport(merged);
if (!result.success) return jsonTextResult({ ok: false, error: result.error });
const noop = before && after ? isScrollNoop(before, after) : false;
return jsonTextResult({ ok: true, scrolled: !noop });
```

`scrolled: false` in `details` is the structural signal `enrichResult` uses to populate
`pageChangeSummary: { mutationKind: 'none' }` and add a `nextActions` suggestion (e.g. "try
`scrollintoview` on a specific element" — deferred to Phase 3/4 command additions, so for now the
hint is generic: re-snapshot and pick a specific element).

### Test requirements (`test/scroll-verification.test.ts`, new)

- `isScrollNoop({0,0},{0,0})` → `true`; `isScrollNoop({0,0},{0,300})` → `false`.
- `isScrollNoop` treats sub-pixel float differences (`{0,299.998}` vs `{0,300}`) as equal (no-op
  detection must not false-positive on rounding).
- Integration test in `test/agent-browser.test.ts`: mock/stub the eval calls to return identical
  before/after positions, assert `details.scrolled === false` on the enriched result.

### Dependencies

Structured Result Envelope (component 1) for the `pageChangeSummary` wiring.

---

## 6. Overlay Blocker Detection

**File**: additions to `src/browser-result.ts` (classification) + `src/agent-browser.ts` (post-click heuristic probe, optional)

### Purpose

Two distinct cases, per the grounding notes:

1. **Click blocked before dispatch** — the CLI already detects this and fails with
   `covered by <div#consent-banner>`. This case is *pure classification*: `classifyFailure` (component 1)
   already maps this pattern to `'overlay-blocked'`. No new probing code needed for this case.
2. **Click succeeded, but a new modal/overlay appeared afterward** (e.g. a confirmation dialog, a
   toast, a paywall) that will block the *next* interaction. This is genuinely new: a lightweight
   post-click heuristic eval that diffs a small overlay-signature snapshot (count of
   `[role=dialog], [aria-modal=true]` elements, or fixed/absolute elements covering >60% of
   viewport area) taken before and after the click.

### Interface

```ts
export interface OverlaySignature { count: number; }
export interface OverlayProbe { appeared: boolean; selectorHint?: string; }

export const OVERLAY_SIGNATURE_EXPR =
  'JSON.stringify({count:document.querySelectorAll("[role=dialog],[aria-modal=true]").length})';

export function detectOverlayAppearance(before: OverlaySignature, after: OverlaySignature): boolean;
```

`BrowserResult` (component 1) gains an optional field:

```ts
export interface BrowserResult extends BackendCallResult {
  // ...existing fields
  overlay?: OverlayProbe;
}
```

### File placement

Signature/diff helpers alongside `isScrollNoop` — same `src/scroll-verification.ts`-style module,
or a dedicated `src/overlay-detection.ts` for clarity since it's conceptually distinct from scroll.
**Decision: `src/overlay-detection.ts`** to keep each reliability check independently testable and
reviewable, matching the one-concern-per-file pattern already used for
`click-verification.ts`/`scroll-verification.ts`.

### Integration points

- `classifyFailure` (component 1) already handles case 1 via the `covered by <` pattern — no
  change needed beyond what's specified in component 1.
- `handleClick` in `src/agent-browser.ts`, case 2: only run the post-click overlay probe when
  `isEligibleForVerification(selector)` is also true (reuse the same eligibility gate as click
  verification — same latency/risk tradeoff reasoning), immediately after a successful (and
  dispatch-verified) click. On `appeared: true`, attach `overlay: { appeared: true }` to `details`;
  `enrichResult` copies it through to `BrowserResult.overlay` and appends a `nextActions` entry
  suggesting a `snapshot` to locate the dismiss control.

### Test requirements (`test/overlay-detection.test.ts`, new)

- `detectOverlayAppearance({count:0},{count:1})` → `true`; `({count:1},{count:1})` → `false`;
  `({count:1},{count:0})` → `false` (a *closing* overlay is not a new block).
- `classifyFailure('click failed: covered by <div#consent-banner>')` → `'overlay-blocked'`
  (belongs to component 1's test file, cross-referenced here since it's the primary detection path
  for case 1).
- Integration test in `test/agent-browser.test.ts`: mock eval returning `count: 0` then `count: 1`
  around a successful click, assert `details.overlay?.appeared === true` on the enriched result.

### Dependencies

Structured Result Envelope (component 1). Reuses `isEligibleForVerification` from Click Dispatch
Verification (component 3) as its eligibility gate.

---

# Part 2 — Phase 3 & 4 (Snapshots + Input Modes)

## 7. Interactive Snapshot Ref Extraction

**File**: new `src/snapshot-parser.ts`; modifies `handleSnapshot` in `src/agent-browser.ts`

### Purpose

Parse `agent-browser snapshot -i --json` output into `PageRef[]` and feed
`SessionPageStateStore.recordSnapshot`, so every later ref-based action (click/fill/type against
`@eN`) has ground truth to preflight against (component 4) and so `snapshot`'s own tool response
can optionally return the compact/annotated form (component 8).

### Interface

```ts
// Exact shape depends on agent-browser's --json snapshot schema; the CLI's own --json flag is
// authoritative. Parse defensively: accept either a flat array of nodes or a nested tree and walk
// it, since the human-readable form is a nested indentation tree (`@e1 [header]` → `@e2 [nav]` →
// `@e3 [a] "Home"`).
export interface RawSnapshotNode {
  ref?: string;          // "e12" or "@e12" depending on CLI --json normalization
  role?: string;          // accessibility role / tag, e.g. "button", "textbox"
  name?: string;           // accessible name / visible text
  editable?: boolean;      // maps to PageRef.isContentEditable
  children?: RawSnapshotNode[];
}

export function parseSnapshotRefs(raw: unknown): PageRef[];
```

`parseSnapshotRefs` walks the tree (or flat array — defend against both shapes since this is
parsing an external CLI's JSON contract that isn't in this repo), normalizes `ref` to always be
`@eN`-prefixed, and flattens into a `PageRef[]` regardless of nesting depth (iframe-inlined refs
included, per the CLI's documented iframe-inlining behavior — no special-casing needed since they
already appear as ordinary `@eN` nodes in the tree).

### File placement

New file `src/snapshot-parser.ts`. `handleSnapshot` in `src/agent-browser.ts` changes from
`runCommand(['snapshot'], merged)` to `runCommand(['snapshot', '-i', '--json'], merged)`, then:

```ts
private async handleSnapshot(options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
  await this.ensureSession(options);
  const merged = this.mergeOptions(options);
  const token = this.pageState.currentToken(this.session.namespace);
  const result = await runCommand(['snapshot', '-i', '--json'], merged);
  if (!result.success) return jsonTextResult({ error: result.error || 'Snapshot failed' });
  const refs = parseSnapshotRefs(result.data);
  const url = extractSnapshotUrl(result.data); // small helper, same file
  this.pageState.recordSnapshot(this.session.namespace, url, refs, token);
  return jsonTextResult(result.data);
}
```

### Integration points

- Feeds `SessionPageStateStore.recordSnapshot` (component 2) using the ordered-token pattern
  described there (`token` captured before the CLI call, passed as `expectedPriorToken` after).
- `handleNavigate`'s existing `invalidate()` call (component 2) and this component's
  `recordSnapshot` call are the only two writers of session page state — keeps the state machine
  simple: navigate invalidates, snapshot repopulates.

### Test requirements (`test/snapshot-parser.test.ts`, new)

- `parseSnapshotRefs` on a flat array of `{ ref: "e1", role: "button", name: "Submit" }` returns
  `[{ ref: "@e1", role: "button", name: "Submit" }]` (normalizes missing `@` prefix).
- `parseSnapshotRefs` on a nested tree (children arrays) flattens all descendant refs regardless
  of depth.
- `parseSnapshotRefs` on malformed/unexpected shapes (`null`, `{}`, a string) returns `[]` rather
  than throwing — defensive parsing since this is an external, undocumented-in-this-repo JSON
  contract.
- `parseSnapshotRefs` sets `isContentEditable` from an `editable: true` node.
- Integration test in `test/agent-browser.test.ts` (live-binary): `adapter.execute({action:
  'navigate', url: 'about:blank'})` then `adapter.execute({action: 'snapshot'})` populates the
  adapter's internal page-state store with at least the refs the CLI reports (assert via a
  subsequent `click` on a `@eN` ref *not* throwing `StaleRefError`, since `about:blank` has no
  interactive elements this may need a `data:` URL fixture — flagged as a residual risk requiring
  a concrete test fixture page during implementation, since the sandbox's domain/URL policy
  restricts navigation to `http`/`https` only per `validateNavigationUrl`).

### Dependencies

Session Page State (component 2). Should land before components 3/4's ref-eligible paths become
exercised end-to-end (though those components' pure logic is independently testable without this).

---

## 8. Compact Snapshot

**File**: additions to `src/snapshot-parser.ts` and `handleSnapshot`

### Purpose

Large pages produce snapshot trees that blow past `maxToolOutputChars` (`tool-output.ts`'s existing
60k-char guard already truncates raw text, but truncation mid-tree is worse than principled
omission). This adds a compaction pass: keep only "high-value" controls (interactive roles:
button, link, textbox, checkbox, radio, combobox, select) and collapse/omit purely structural
wrapper nodes (div/span/section with no accessible name and no interactive descendants), matching
the CLI's own `-c`/`-i` flags conceptually but applied wrapper-side so the *returned* JSON to the
agent is compact even when the underlying page is large.

### Interface

```ts
export interface CompactSnapshotOptions {
  maxRefs?: number;          // default 200 — hard cap before falling back to omission summary
}
export interface CompactSnapshotResult {
  refs: PageRef[];
  omittedCount: number;      // structural/low-value nodes dropped
  truncated: boolean;        // maxRefs cap was hit
}

export function compactSnapshotRefs(refs: PageRef[], options?: CompactSnapshotOptions): CompactSnapshotResult;
```

High-value role allowlist: `button`, `link`, `textbox`, `checkbox`, `radio`, `combobox`, `select`,
`menuitem`, `tab`, `switch` (standard ARIA interactive/widget roles) — everything else is dropped
unless it has a non-empty `name` (headings/labels retained for orientation even if non-interactive).

**Note (scope link to gap-analysis's broader "Snapshot modes" item)**: `--search`/`--filter
role=`/`--viewport`/`--diff` wrapper-side snapshot modes from the gap analysis's Layer 4 are *not*
separately speced here — `compactSnapshotRefs`'s role-allowlist covers the `--filter role=` case
directly, and `--diff` is a natural follow-on once `SessionPageStateStore` retains the *previous*
snapshot (currently it only retains the latest — extending to keep one prior record for diffing is
a small, explicitly-deferred extension, not required for Phase 3 parity on the core ask).

### File placement

Same file as component 7 (`src/snapshot-parser.ts`) — compaction operates purely on the already-
parsed `PageRef[]`, no new CLI interaction.

### Integration points

`handleSnapshot` accepts an optional `compact` flag on `BrowserRequest` (new field, default
`false` to preserve existing behavior exactly for current callers):

```ts
if (request.compact) {
  const compacted = compactSnapshotRefs(refs);
  return jsonTextResult({ url, refs: compacted.refs, omittedCount: compacted.omittedCount, truncated: compacted.truncated });
}
```

`BrowserRequest.compact?: boolean` added in `src/browser-policy.ts`'s `validateBrowserRequest`;
exposed as a new optional parameter on the `browser` tool in `src/index.ts`.

### Test requirements (additions to `test/snapshot-parser.test.ts`)

- `compactSnapshotRefs` drops a `role: 'div'`, no-`name` entry; keeps `role: 'button'`.
- `compactSnapshotRefs` keeps a no-role, `name`-only entry (heading text) for orientation.
- `compactSnapshotRefs` respects `maxRefs`, sets `truncated: true` when the input exceeds it, and
  returns exactly `maxRefs` refs (prioritizing high-value roles first, then named structural nodes).
- `omittedCount` equals `input.length - refs.length` for the non-truncated case.

### Dependencies

Interactive Snapshot Ref Extraction (component 7).

---

## 9. `semanticAction`

**File**: new action handler in `src/agent-browser.ts`; new `src/browser-policy.ts` validation

### Purpose

Per the grounding notes, this is a thin, typed wrapper over the CLI's own
`find <locator> <query> <verb> [args] [--exact]` command — not a new interaction engine. It exists
so callers don't have to hand-build CLI argv (and so the same policy/validation/redaction
discipline applied to `click`/`fill`/`type` also applies here).

### Interface

```ts
// src/browser-policy.ts additions
export type SemanticLocator = 'role' | 'text' | 'label' | 'placeholder' | 'alt' | 'title' | 'testid' | 'first' | 'last' | 'nth';
export type SemanticVerb = 'click' | 'fill' | 'check' | 'uncheck' | 'select' | 'type' | 'hover';

export interface SemanticActionRequest {
  locator: SemanticLocator;
  query: string;             // the locator value, e.g. role name, text, label, css for first/last/nth
  verb: SemanticVerb;
  name?: string;              // --name filter, used with locator: 'role'
  index?: number;             // required for locator: 'nth'
  value?: string;             // for fill/type/select
  exact?: boolean;
}

export function validateSemanticActionRequest(raw: Record<string, unknown>): SemanticActionRequest;
```

`BrowserAction` gains `'semanticAction'`. `BrowserRequest` gains an optional
`semanticAction?: SemanticActionRequest` field.

### File placement

Validation in `src/browser-policy.ts` (alongside existing `validateSelector`/`validateText`
pattern). Handler `handleSemanticAction` in `src/agent-browser.ts`, following the exact structure
of `handleClick`/`handleFill`:

```ts
private async handleSemanticAction(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
  const sa = request.semanticAction;
  if (!sa) return jsonTextResult({ error: 'semanticAction is required' });
  await this.ensureSession(options);
  const merged = this.mergeOptions(options);

  const args = ['find', sa.locator, sa.query, sa.verb];
  if (sa.name) args.push('--name', sa.name);
  if (sa.locator === 'nth' && sa.index !== undefined) args.splice(2, 0, String(sa.index));
  if (sa.exact) args.push('--exact');

  // value payloads (fill/type/select) are sensitive — route via stdin batch, never argv
  const hasValue = ['fill', 'type', 'select'].includes(sa.verb) && sa.value !== undefined;
  if (hasValue) {
    const results = await runBatchStdin([{ args: [...args, sa.value!], sensitive: true }], merged);
    const result = results[0];
    return jsonTextResult(result?.success ? { ok: true } : { ok: false, error: sanitizeErrorMessage(result?.error ?? 'Command failed') });
  }
  const result = await runCommand(args, merged);
  return jsonTextResult(result.success ? { ok: true } : { ok: false, error: result.error });
}
```

Click verification (component 3) applies here too: a `semanticAction` with `verb: 'click'` is
inherently "eligible" (it's a role/text/label locator by construction) — `handleSemanticAction`
reuses `armClickProbe`/`readClickProbe` unconditionally for `verb === 'click'`.

### Test requirements (`test/browser-policy.test.ts` + `test/agent-browser.test.ts` additions)

- `validateSemanticActionRequest` rejects missing `locator`/`query`/`verb`.
- `validateSemanticActionRequest` requires `index` when `locator === 'nth'`.
- `validateSemanticActionRequest` requires `value` when `verb` is `fill`/`type`/`select`.
- Argv-building test (pure, no subprocess): given a `SemanticActionRequest`, assert the constructed
  `args` array matches `['find', 'role', 'button', 'click', '--name', 'Submit']` for a
  role+name+click case, and that fill/type/select values never appear in the argv passed to
  `runCommand` (only in the `runBatchStdin` stdin payload) — regression guard against the exact
  argv-leak class of bug `handleType`/`handleFill` already avoid.

### Dependencies

Click Dispatch Verification (component 3) for the click-verb case. Structured Result Envelope
(component 1) for consistent success/failure classification (`classifySuccess('semanticAction')`
→ `'completed'`).

---

## 10. `job`

**File**: new `src/browser-job.ts`; new action handler in `src/agent-browser.ts`

### Purpose

A constrained multi-step orchestration primitive: `open → click → fill → type → select → wait →
assert → snapshot → screenshot`, run as a single tool call. Unlike `batch` (component 11), which is
a raw CLI passthrough, `job` is implemented by **sequentially invoking this adapter's own validated
per-action handlers in-process** (not the CLI's `batch` subcommand). This is a deliberate
architectural choice: each step gets the same policy gating (`isSensitiveAction`,
`validateNavigationUrl`, selector/text bounds), the same click-verification/stale-ref/overlay
checks, and the same `BrowserResult` enrichment as if it were called standalone — `batch`
intentionally does *not* get this (it's the raw/advanced escape hatch).

### Interface

```ts
export type JobStepKind = 'open' | 'click' | 'fill' | 'type' | 'select' | 'wait' | 'assert' | 'snapshot' | 'screenshot';

export interface JobStep {
  kind: JobStepKind;
  url?: string;               // open
  selector?: string;          // click/fill/type/select/assert
  text?: string;               // fill/type
  values?: string[];           // select
  waitMs?: number;             // wait
  assertText?: string;         // assert: page must contain this text (post-condition, not a locator)
  continueOnFailure?: boolean; // default false — job stops at first failed step
}

export interface JobRequest {
  steps: JobStep[];
  maxSteps?: number;           // default 20, hard cap to bound worst-case runtime
}

export function validateJobRequest(raw: Record<string, unknown>): JobRequest;
```

`BrowserAction` gains `'job'`. `BrowserRequest` gains `job?: JobRequest`.

### File placement

Validation + step-to-single-action mapping in `src/browser-job.ts` (new). Orchestration loop
(`handleJob`) in `src/agent-browser.ts`, calling back into the adapter's *own* `execute()` for each
step — this reuses `enrichResult` per step for free and is the natural source of `BatchStepResult[]`
(component 1's `batchSteps` field):

```ts
private async handleJob(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
  const job = request.job!;
  const steps: BatchStepResult[] = [];
  for (const [index, step] of job.steps.entries()) {
    const stepRequest = jobStepToBrowserRequest(step); // src/browser-job.ts
    const stepResult = await this.execute(stepRequest as unknown as Record<string, unknown>, options) as BrowserResult;
    steps.push({
      index, action: stepRequest.action,
      resultCategory: stepResult.resultCategory,
      ...(stepResult.successCategory ? { successCategory: stepResult.successCategory } : {}),
      ...(stepResult.failureCategory ? { failureCategory: stepResult.failureCategory } : {}),
      ...(stepResult.failureCategory ? { error: String((stepResult.details as { error?: string })?.error ?? '') } : {}),
    });
    if (stepResult.resultCategory === 'failure' && !step.continueOnFailure) break;
  }
  const overallFailed = steps.some(s => s.resultCategory === 'failure');
  return { ...jsonTextResult({ steps }), batchSteps: steps, resultCategory: overallFailed ? 'failure' : 'success' } as BackendCallResult;
}
```

(`enrichResult` in `execute()` will re-wrap this final object; the explicit `resultCategory` set
here is a hint `enrichResult` respects rather than recomputes, since job-level success/failure
isn't derivable from a single `details.error` string the way single-action results are — this
requires a small `enrichResult` extension: if the raw result already carries `resultCategory`,
pass it through instead of inferring.)

### Test requirements (`test/browser-job.test.ts`, new)

- `validateJobRequest` rejects `steps: []`, rejects exceeding `maxSteps`, rejects unknown `kind`.
- `validateJobRequest` requires `url` for `open`, `selector` for `click`/`fill`/`type`/`select`/
  `assert`, `text` for `fill`/`type`.
- `jobStepToBrowserRequest` maps each `JobStepKind` to the correct `BrowserRequest.action` + fields
  (pure mapping test, one case per kind).
- Integration test in `test/agent-browser.test.ts`: a 3-step job where step 2 fails (e.g. click on
  a selector with no session) and `continueOnFailure` is unset stops at step 2 — `batchSteps` has
  exactly 2 entries, `resultCategory: 'failure'`.
- Integration test: same job with `continueOnFailure: true` on step 2 runs all 3 steps regardless
  of step 2's outcome.

### Dependencies

Structured Result Envelope (component 1) — specifically the `batchSteps`/pass-through-resultCategory
extension noted above. Reuses whichever of components 3–9 apply to each step kind transitively
(e.g. a `click` step gets dispatch verification for free since it calls the real `handleClick`).

---

## 11. `batch`

**File**: new action handler in `src/agent-browser.ts`, thin wrapper over existing `runBatchStdin`

### Purpose

Expose the CLI's raw multi-command batching (`agent-browser batch --json --bail`, already fully
implemented as `runBatchStdin` in `src/agent-browser-process.ts` and already used internally by
`handleEvaluate`/`handleType`/`handleFill`/`handleSetCookies`) as a **public** tool action, for
advanced callers who want exact CLI parity and don't need per-step policy re-validation beyond
what the raw CLI itself enforces. This is intentionally the "raw escape hatch" counterpart to
`job`'s "safe, validated, in-process" orchestration.

### Interface

```ts
export interface BatchCommand {
  args: string[];        // raw agent-browser argv, e.g. ["click", "@e1"]
  sensitive?: boolean;    // caller-declared: forces stdin-only transport for this step, never echoed
}

export interface BatchRequest {
  commands: BatchCommand[];
  maxCommands?: number;   // default 20
}

export function validateBatchRequest(raw: Record<string, unknown>): BatchRequest;
```

`BrowserAction` gains `'batch'`. `BrowserRequest` gains `batch?: BatchRequest`.

Because `batch` accepts raw argv strings from the caller, it is classified as a **sensitive
action** by default (added to `SENSITIVE_ACTIONS` in `src/browser-policy.ts`, gated behind
`PI_SEARCH_BROWSER_ALLOW_SENSITIVE=1` like `evaluate`/`set_cookies`) — raw argv is a strictly wider
capability surface than any single typed action and deserves the same opt-in gate `evaluate`
already has.

### File placement

Validation in `src/browser-policy.ts`. Handler `handleBatch` in `src/agent-browser.ts`:

```ts
private async handleBatch(request: BrowserRequest, options: AgentBrowserProcessOptions): Promise<BackendCallResult> {
  if (isSensitiveAction('batch') && options.env?.PI_SEARCH_BROWSER_ALLOW_SENSITIVE !== '1') {
    return jsonTextResult({ error: 'batch disabled by policy. Set PI_SEARCH_BROWSER_ALLOW_SENSITIVE=1 to enable.' });
  }
  const batch = request.batch!;
  await this.ensureSession(options);
  const merged = this.mergeOptions(options);
  const results = await runBatchStdin(
    batch.commands.map(c => ({ args: c.args, sensitive: c.sensitive ?? true })),
    merged,
  );
  const steps: BatchStepResult[] = results.map((r, index) => ({
    index, action: batch.commands[index]!.args[0] ?? 'unknown',
    resultCategory: r.success ? 'success' : 'failure',
    ...(r.success ? {} : { error: sanitizeErrorMessage(r.error ?? 'Command failed') }),
  }));
  return { ...jsonTextResult({ steps }), batchSteps: steps } as BackendCallResult;
}
```

Every command defaults `sensitive: true` (stdin transport, never argv-echoed) unless the caller
explicitly opts a step out — safer default than `job`/single-action handlers because batch argv is
caller-authored and unvalidated beyond shape.

### Test requirements (`test/browser-policy.test.ts` + `test/agent-browser.test.ts` additions)

- `validateBatchRequest` rejects `commands: []`, exceeding `maxCommands`, a command with an empty
  `args` array.
- `isSensitiveAction('batch')` → `true`.
- Integration test: `batch` action without `PI_SEARCH_BROWSER_ALLOW_SENSITIVE=1` returns
  `failureCategory: 'policy-denied'` (reuses the existing "sensitive actions disabled by default"
  test pattern from `test/agent-browser.test.ts`).
- Integration test: with the env flag set, a 2-command batch (`['open','about:blank']`, an
  intentionally invalid third arg) surfaces per-step `batchSteps` with correct `resultCategory`
  per index.

### Dependencies

Structured Result Envelope (component 1) for `batchSteps`. No dependency on `job` (component 10)
or ref/snapshot components — this is a parallel, lower-level primitive.

---

# Part 3 — Phase 5 & 6 (In scope, next up)

**12. Persistent artifact directory + download handling.** Currently `runScreenshot` writes to
`{runtimeRoot}/screenshots/shot-{ts}.png` and deletes it immediately after reading
(`agent-browser-process.ts`'s `cleanupScreenshot`). Parity requires an opt-in persistent artifact
directory (survives across calls within a session) plus a `download` action wrapping the CLI's
own `@ref path` anchor-download flow, an `outputPath` param on `screenshot`/other artifact-producing
actions to persist to a caller-chosen workspace path, and a bounded `artifactManifest` action to
list what's been produced this session. Builds on Structured Result Envelope's `artifact-saved`
vs `artifact-unverified` successCategory distinction (already scoped in component 1).

**13. Redaction layer.** Three near-duplicate `sanitizeErrorMessage` implementations already exist
(`agent-browser.ts`, `agent-browser-process.ts`, and pattern-duplicated logic in `desktop-tools.ts`'s
`normalize()`). Consolidate into one `src/browser-redaction.ts` covering presentation redaction
(cookie/storage values), invocation-arg redaction (mask sensitive flags in any echoed argv, notably
relevant once `batch`/`job` echo `action`/`args` back in step results), and exact-value scrubbing
(strip literal step-argument values, not just token-shaped patterns, from failure messages — the
current regex-based approach only catches token-*shaped* secrets, not arbitrary values the caller
passed as `text`/`fill` payloads that happen to appear verbatim in a CLI error).

**14. Auth profile management.** Wrap `agent-browser auth save --password-stdin` / `auth login` /
`auth list` / `auth show` / `auth delete` as a new set of `browser` actions, all sensitive-gated.
Passwords must go via stdin exclusively (mirrors the `--password-stdin` CLI flag already, so no new
transport risk — this is argv/env hygiene, not new sandboxing).

**15. Recording.** Wrap `agent-browser record start/stop/restart` (ffmpeg-backed WebM). Needs a
sandbox dependency-availability check (ffmpeg presence) surfaced as a clear `missing-binary`-style
failure category rather than an opaque CLI error, and artifact-directory integration (component 12)
for the output path.

# Out of scope

- **Web search companion** — separate extension already exists for this.
- **Electron integration** — `desktop-tools.ts` owns desktop automation via CUA driver; separate subsystem, not browser parity.
- **`qa` preset** — thin composition over `job` once needed, not core parity. Can be added as a fixed `JobStep[]` template later.
- **Snapshot modes** (`--search`, `--filter`, `--viewport`, `--diff`) — deferred, low priority.
- **Doctor/setup passthrough** — operationally useful but out of browser-automation core-ask.

---

# Sequencing summary

```
Phase 1 ✅ (no deps)         1. Structured Result Envelope
                              2. Session Page State
Phase 2 ✅ (deps: 1, 2)       3. Click Dispatch Verification
                              4. Stale Ref Detection
                              5. Scroll No-op Detection
                              6. Overlay Blocker Detection
Phase 3 ✅ (deps: 2)          7. Snapshot Ref Extraction + Compact Snapshot
Phase 4 ✅ (deps: 1, 3)       8. semanticAction
                              9. job (deps: 1, transitively 3-8 per step kind)
                             10. batch (deps: 1 only)
Phase 5   (next)             11. Persistent artifact directory + downloads
                             12. Redaction layer (consolidate 3 duplicate sanitizers)
                             13. Auth profile management
Phase 6   (after)            14. Recording (ffmpeg)
```
