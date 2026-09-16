# Agent Mode: Wide-First Gather Design

**Date:** 2026-09-16
**Status:** Draft v2 — pending review (revised after contract-level audit)
**Owner:** Pi (Pi-Atlas)

## Goal

Make Agent Mode wide-first and route-aware: execute gather horizontals deterministically
inside the existing single Atlas controller, replace the scalar search budget with a
descending width schedule plus global envelope + per-lane caps, and turn on real model
steering (planner / evaluator / synthesizer / verifier / repair through pi-subagents leaf
RPC) as the default production path — built on three first-class contracts:
`GatherIntent`, `EvidenceProvenance`, and `BudgetEnvelope`. Clean break — no public
consumers, no compatibility shims.

## Non-goals

- No Lincoln-style researcher fanout: no independent tool-using researcher subagents, no
  duplicated query ledgers, no second scheduling layer. Parallelize acquisition, not
  cognition.
- No evidence-analysis fanout in the first build. Eval-gated future experiment (§ Risks).
- No change to untrusted-content framing, redaction, journal replay, or job lifecycle v2.
- No change to the leaf runtime's security posture: one turn, no tools, no skills, no
  extensions, exact model selection, bounded concurrency (`assertZeroTools`,
  `leaf-host-native.ts:139-156`).
- No arbitrary natural-language DQL/SPARQL execution in v1 (see GatherIntent).

## Context (verified facts)

Current production reality, file-verified this session:

| Fact | Location |
|---|---|
| Adaptive dispatch triggers on `onProgress`; production runs `runAdaptiveCore` without planner/evaluator | `agent-core.ts:264-283`, `agent-jobs.ts:1049` |
| Default budgets: 3 rounds, 4 searches, 12 fetches, 8 utility; ceilings 6/12/24/16 | `agent-policy.ts:12-23` |
| Planner questions capped at 5, truncate-not-reject | `agent-planner.ts:21,82-83` |
| Planner proposes 7 route kinds but only web executes — non-web routes emit `route noted: ... (execution pending Phase 9)` | `agent-core.ts:1093-1161`, `agent-jobs.ts:664-672` |
| Concurrent fetch legs split all remaining fetch budget (floor + remainder to earlier legs) — round 1 can consume all 12 fetches | `agent-core.ts:1420-1428` |
| `runReportLeg` runs unconditionally before compose | `agent-core.ts:1679` |
| Capability snapshot knows which horizontals are live per job; admissibility gate validates proposed routes against the frozen snapshot | `agent-capabilities.ts:275-324, 404-451` |
| Evaluator follow-ups are plain strings; route inferred by token overlap | `resolveQueryRoute()` |
| **JSON mode is chosen purely on `outputModes.includes('json')` and then sends nested schemas unconditionally (`outputSchema: entry.schema`)** | `agent-model.ts:194-207` |
| **Leaf JSON validator accepts only flat primitive-object schemas; array/`items` property → `output_contract_breach`** | `pi-subagents/src/runs/runtime/leaf-model-session.ts:255-306` (`LEAF_JSON_PRIMITIVE_TYPES`, `LEAF_JSON_SCHEMA_KEYS`) |
| **LANDMINE: pi-subagents working tree has uncommitted changes to `leaf-model-session.ts` (+118 lines — the flat validator), `leaf-model-runtime.ts`, and runtime-rpc files. If this work lands without a `jsonSchema` dialect gate and an Atlas-side force-text guard, every steering role call breaches.** | `git diff` in `/Users/rhinesharar/pi-subagents`, verified 2026-09-16 |
| **Evidence identity contract is web-shaped: `AgentAcquisitionRoute = 'search' \| 'fetch' \| 'report-suggested-fetch'` only; `canonicalUrl` must be http(s); locator is `{start,end}` char offsets** | `agent-state.ts:5-14, 112-115` |
| **`AGENT_PLAN_SCHEMA` contains only questions + scope notes — no route/action fields; evaluator schema carries `nextQueries: string[]`** | `agent-model.ts:28-31, 49-69` |
| Negotiated capability record already carries `outputModes` and `correlationV2` as gated capabilities | `leaf-runtime-client.ts:187-195,202-224`, `agent-model.ts:195-207` |
| CLI spawn tax ~300 ms/call; high fanout degrades p50 (measured 2026-09-14, bench/README.md) | `AGENTS.md` residual risks |

Reference inputs (rationale, cited with stated confidence):

- **W&D (parallel tool-call schedule)**: at one BrowseComp operating point, 3 parallel
  calls: 68% vs 66% with ~35.9% lower cost, ~40.6% lower wall time; descending 74 vs
  constant-68 and automatic-72. The paper's descending scheduler operates over a longer
  turn sequence in a homogeneous search/scrape environment, and the paper itself labels
  the scheduler study preliminary. Atlas's [3,2,1] across three heterogeneous rounds is
  an **informed extrapolation and benchmark candidate, not validated architecture**.
- **Lincoln pi-research**: ceilings-not-targets; reactive gap-driven later rounds;
  grounding gate; coordinator burst seeds URLs. Adopted as ideas; researcher-session
  hierarchy rejected.
- **SearchOS / Self-Manager**: system-owned search state and evidence graphs retained;
  isolated subthread benefits acknowledged but overhead-accepted — motivates eval-gating
  evidence-analysis fanout.

## Recommended approach

Keep Pi-Atlas a single deterministic controller. Nail down the three contracts first
(`GatherIntent`, `EvidenceProvenance`, `BudgetEnvelope`), fix protocol truthfulness
before any steering, build the no-model deterministic floor before the model path, and
delete legacy escape hatches last.

## Alternatives considered

1. **Full Lincoln researcher fanout** — rejected: duplicates the evidence ledger's
   state machinery.
2. **Route execution + raised scalar budgets only** — rejected: can't express per-lane
   exhaustion or descending width.
3. **Hybrid tiered decomposition (broad → K angle researchers)** — deferred; revisit
   only if bench ablation shows single-controller plateau on broad-survey cases.

## Design

### 1. Contract: protocol truthfulness (pi-subagents + Atlas) — lands FIRST

Given the dirty pi-subagents checkout (JSON-mode + correlation-v2 work in progress on
`leaf-model-session.ts`, `leaf-model-runtime.ts`, runtime-rpc files), this phase
reconciles with that in-progress work **before it merges**.

- Extend the negotiate capability record with `jsonSchema: 'flat-v1' | 'structured-v1'`.
  - `flat-v1` = today's flat-primitive validator, unchanged semantics.
  - `structured-v1` = the bounded subset Atlas needs: `object`, `array`, primitive
    types, `properties`, `required`, `items`, `enum`, `minimum`/`maximum`,
    `additionalProperties`. Bounded depth/keys/bytes, reject-never-clamp, fixed safe
    errors. Output validation stays deterministic code in pi-subagents.
- Older runtimes omit the field — that is capability negotiation, not a shim.
- **Atlas gating rule (explicit in code, replacing today's line):** send
  `outputSchema` only when `jsonSchema === 'structured-v1'` is negotiated. Absent
  capability, `flat-v1`, or old runtime → **text JSON** (client-side parse) for the
  nested agent schemas. `supportsJsonOutput()` alone is not sufficient and is not used
  for this decision.
- Wire-mirror the negotiated token in Atlas `runtime-rpc-protocol.ts` per the
  correlation-v2 pattern (verbatim names, gated compose).
- Own reviewed diff in pi-subagents.

### 2. Contract: three degradation states (replacing the conflated kill-switch)

Three independent states — the plan's earlier "text-JSON fallback" conflated them:

| State | Meaning | Recovery scope |
|---|---|---|
| **Structured model call** | leaf model + negotiated `structured-v1` schema | schema-strict |
| **Text-JSON model call** | leaf model, prompt-instructed JSON, client-side parse | schema-dialect, not availability |
| **No-model deterministic degradation** | code-only controller, no model call | runtime/provider unavailability |

Text JSON still requires the same leaf model; it cannot recover from runtime/provider
unavailability. Degradation ladder:

- Planner fails/no-model → root-plan fallback (today's behavior), deterministic.
- Evaluator fails/no-model → deterministic stopping + gap rules (existing stop policy
  conditions evaluate without the evaluator's advisory input).
- Synthesizer fails/no-model → `composeEvidenceOnlyResult()` — deterministic renderer
  over admitted evidence only.
- Verify/repair → skipped, marked in result.

`PI_NORTHSTAR_AGENT_STEERING=0` selects the **no-model** ladder for the whole job
(operational kill-switch; remove post-bench). It is one switch with one meaning:
"run without model calls."

### 3. Contract: `GatherIntent` (discriminated union, not `{route, routeArg}`)

The current `{questionId, query, route, routeArg?}` shape cannot compile
deterministically — GitHub repo/file/action selectors, SPARQL vs DQL, academic
source/year constraints, and KG actions each need their own fields. Planner actions
nest intent inside each question (planner cannot predict Atlas-generated questionIds;
Atlas attaches real IDs after `normalizePlan()`, preserving the `applyPlanRoutes()`
index-alignment idea). The evaluator's follow-up actions may carry `questionId` (IDs
are established in the evaluation prompt).

```ts
// v1 intents — each compiles deterministically to exact native-tool arguments
type GatherIntent =
  | { kind: 'web_search'; query: string; limit?: number }
  | { kind: 'research_search'; query: string; source?; yearFrom?; yearTo?; limit?: number }
  | { kind: 'github_search'; scope: 'repo'|'code'|'issues'|'files'; query: string; repoHint?: string }
  | { kind: 'social_search'; platform; query: string; sort? }
  | { kind: 'video_transcript'; videoHint: string }
  | { kind: 'kg_search'; query: string; limit?: number }
  // graph deferred from v1: natural language → arbitrary DQL/SPARQL is not a
  // deterministic compilation step. Revisit as its own capability with a safe
  // bounded compiler (probe/schema/entity lookups only) if a design exists.
```

All intents validate against the frozen per-job capability snapshot
(`gatherActionAdmissibility`); unavailable → degrade to `web` + warning, or reject
when the question demands that route.

### 4. Contract: `EvidenceProvenance` — candidates vs evidence per route

Today's invariant generalizes, it does not dilute. Not every specialist response is
evidence — admission keeps its meaning:

| Route | Candidate | Evidence |
|---|---|---|
| web | search hits | fetched document (existing path) |
| research | search metadata rows | **returned abstract only supports claims limited to that abstract**; title/year rows support metadata claims only, never a paper's scientific conclusion |
| github | search hits | retrieved file/issue/commit content |
| social | discovery results | retrieved post/thread/comment bodies |
| video | search metadata | transcript segments |
| kg/graph | (deferred with route) | explicit returned fields only, with field/node locators and provider/query provenance |

This requires a **state-contract redesign**, not just additions to
`agent-acquisition.ts`: `AgentAcquisitionRoute` extends beyond
`search|fetch|report-suggested-fetch`; locator generalizes from char offsets to a
typed union (char-range, page/line, timestamp, issue/commit ref, KG field/node
locator); `canonicalUrl`'s http(s)-only requirement generalizes to a source
identity that can name non-URL artifacts (provider + query + node id), with the
http(s) rule retained where a URL exists. Journal event validation
(`agent-events.ts` canonicalUrl regex, event field allowlists) updates in the same
change. Stable provenance + document hash + source class stay mandatory for every
admission.

### 5. Planner contract changes together with the controller

`AGENT_PLAN_SCHEMA`, planner prompt, domain validator, and the structured-v1 schema
change in one step: questions carry nested route/action intent (or explicit
`nextActions`), so strict structured mode never formalizes the old schema while the
controller reads route fields outside it. Question cap stays 5
(truncate-not-reject). Evaluator: `nextQueries: string[]` replaced by typed
`nextActions` (GatherIntent + questionId); legacy string compile and
`resolveQueryRoute()` token-overlap inference deleted.

### 6. Contract: `BudgetEnvelope` — global envelope + per-lane caps

Per-lane budgets without a global envelope are a cost multiplier: seven open lanes
outwork the old global cap. Envelope:

- **Width N = N gather actions total per round** (across all lanes), not per lane.
- `maxGatherActions` (global acquisition envelope) + per-lane caps + deadline +
  round-scoped fetch reserve (12 total: round 1 cap 7, round 2 cap 4, round 3 cap
  1 — reservation structural; exact split is a bench concern).
- Stop policy: stop when the global `maxGatherActions` envelope is exhausted (sufficient by itself — `canDispatchAnyAction` in `agent-policy.ts:372-379` refuses at `gatherActionsUsed >= maxGatherActions`, and executor planning (`agent-gather.ts:346-375`) and `stopPolicy()` share that ONE definition), OR when no admissible lane has headroom (per-lane caps gate dispatch: that lane can't dispatch), OR when `maxFetches` is exhausted (kills the whole lane-aware job at `agent-policy.ts:437-439` — stated explicitly). Per-lane caps keep the job lane-aware, but envelope exhaustion is decisive on its own. (The earlier "both ... and" wording was a superseded design iteration; the audit pinned the envelope-sufficient contract.)
- **Utility budget becomes role-aware or reserved.** Planner 1 + three evaluators +
  synthesis 1 already consumes 5 of 8; verification and repair can be starved.
  Guarantee synthesis capacity and reserve verification/repair capacity before
  evaluators spend the remainder. At minimum: benchmark before declaring the ceiling
  unchanged.
- **Profile selection is code-owned; the model never chooses width.** Deep comes from
  explicit job/user depth. Balanced is default. Narrow derives deterministically
  (e.g., one normalized required question, no specialist need). The planner supplies
  work, not scheduler policy.
- Width schedule [3,2,1] is the **initial benchmark candidate** (W&D extrapolation,
  stated confidence), not settled architecture — bench decides whether it holds.
  "Up to" semantics: N gaps → N tasks; no theatrical parallelism.

### 7. Steering wiring and sequencing (revised order)

1. **Protocol truthfulness fix** — `jsonSchema` capability + Atlas gating rule;
   reconcile with the dirty pi-subagents checkout before it merges.
2. **Evidence-only deterministic composition + no-model degradation semantics** —
   `composeEvidenceOnlyResult()` and the §2 ladder land and are tested as the safe
   floor, before any legacy removal.
3. **Steering wired in text JSON first**, `structured-v1` optional — benchmark
   model-call budget consumption here (planner/evaluator/synth/verify/repair actual
   utility spend).
4. **`GatherIntent` + `EvidenceProvenance` contracts** — the real architecture
   boundary.
5. **Search-like specialist routes only**: web/research/github/social/video/kg
   (kg as bounded entity search). Arbitrary graph execution deferred (§3).
6. **Global + per-lane budgeting; [3,2,1] as benchmarked default candidate.**
7. **`structured-v1` enabled** once both repos negotiate correctly.
8. **Remove `runReportLeg` and `runSingleCycle` only after** the evidence-only path,
   steering path, and replay/journal tests have proven stable. Correct the
   "Flat JSON-mode schema" comments in `agent-model.ts`.

`bench/agent-eval` expansion (GitHub/academic/community/graph-entity/mixed/broad
cases) tracks each phase: supported factual coverage, required-question grounding,
contradiction discovery, p50/p95 latency, utility calls by role, tool calls per lane,
estimated token spend.

## Error handling

- Reject-never-clamp at all boundaries for budget overrides, intent shapes, schema
  sizes (`agent-policy.ts:39-68` pattern extended per lane and to the envelope).
- Fixed safe errors only for leaf RPC roles (`RUNTIME_RPC_ERROR_MESSAGES` closed set);
  provider text never crosses.
- Per-action gather failures (allSettled): one failed lane never kills the round;
  warnings surface in the journal.
- Degradation is one-directional within a job: structured → text-JSON on dialect
  failure is allowed; no-model degradation is a whole-job or whole-stage decision —
  the controller never flips back up mid-job.
- Evidence-only partial results are marked (stop reason/warning), never silent.

## Testing and verification

- `structured-v1`: round-trip tests in both repos — Atlas sends bounded nested schema,
  pi-subagents accepts + validates; old/flat runtime negotiates flat or text.
  Includes the force-text guard: nested schema + flat-negotiated runtime must
  produce text mode, never a wire schema.
- No-model ladder: each role's deterministic fallback tested (root-plan, gap-rule
  stop, evidence-only result, skip-verify).
- `GatherIntent`: per-intent unit tests with frozen snapshots (admissible / degraded /
  rejected / envelope-blocked / lane-blocked).
- `EvidenceProvenance`: candidates-never-evidence tests per route (metadata row
  cannot ground a scientific conclusion; abstract can ground abstract-scoped claims).
- Stop policy: global envelope + lane headroom combinations.
- Scheduler: width tables pinned per profile; code-owned profile selection tests.
- Utility role-aware reservation: synthesis/verify capacity guaranteed under
  evaluator pressure.
- Bench before/after each phase; deltas reported.

## Risks and open questions

- **Cross-repo sequencing:** the uncommitted pi-subagents work must be reconciled
  (dialect gate) before merge; Atlas and pi-subagents land the capability together.
- **Cost per job rises** (four+ model calls per job). Bench quantifies; no-model
  switch exists; evaluator model tier is the first knob.
- **Specialist quota/rate limits** interact with lane caps; lane exhaustion must not
  spin retries. Caps pinned as constants, set from bench.
- **`runSingleCycle` deletion** touches existing tests; mechanical but last.
- **Evidence-analysis fanout** deferred; own design if ablation separates.
- Open question (resolve in phase 6): exact evaluator cross-route degradation —
  lean accept-with-warning to preserve evaluator-driven recovery.
