# Agent Mode Wide-First Gather — Implementation Plan

> **For agentic workers:** Implement task-by-task in order. Steps use checkbox syntax.

**Goal:** Execute `docs/plans/2026-09-16-agent-mode-wide-gather-design.md` (v2): protocol truthfulness first, evidence-only floor, text-JSON steering, GatherIntent + EvidenceProvenance contracts, specialist gather routes, BudgetEnvelope, structured-v1, legacy deletion last.

**Approach:** Two repos in lockstep. pi-subagents (at `/Users/rhinesharar/pi-subagents`) owns the leaf RPC wire; Atlas owns the controller. Cross-repo contract pinned verbatim below. Build **on top of** the uncommitted pi-subagents working tree (7 modified files + 1 untracked test file, +385/−26: outputModes JSON advertisement, correlationV2, schema size gate, flat JSON validator) — never revert or discard it.

**Riskiest assumption:** that both repos' unit tests can validate the capability handshake without a live cross-repo integration run; if the mocked negotiation shapes drift, phase 7's end-to-end round-trip catches it.

## Cross-repo contract (pinned, wire-mirrored verbatim)

```ts
// RuntimeCapabilitiesV1 gains (pi-subagents src/api/runtime-rpc.ts, Atlas src/runtime/runtime-rpc-protocol.ts mirror):
jsonSchema?: 'flat-v1' | 'structured-v1';
```

- Semantics: `flat-v1` = current flat-primitive-only validator semantics. `structured-v1` = bounded nested subset: `object`, `array`, primitive types (`string`/`number`/`integer`/`boolean`), `properties`, `required`, `items`, `enum`, `minimum`/`maximum`, `additionalProperties`. Bounded: depth ≤ 10, keys ≤ 256, key length 1..128, bytes ≤ existing `maxPromptBytes` limit. Reject-never-clamp, code `invalid_params`, fixed safe messages.
- Negotiate echo: bridge returns `jsonSchema: 'structured-v1'` once structured validation is live. Older/interim runtimes omit the field.
- **Atlas gating rule:** attach `outputSchema` to a leaf call only when the negotiated `jsonSchema === 'structured-v1'`. Otherwise text JSON (client-side parse). `supportsJsonOutput()`/`outputModes` alone is insufficient.
- Fail-closed matrix: new Atlas + old runtime → no wire schema (text JSON). Old Atlas + new runtime → wire schema rejected at start gate (`invalid_params`), never accepted silently. Same-versions → structured JSON mode.
- Existing dirty-diff semantics preserved exactly: v2 start gate on `negotiatedModels.has(modelId)`, token-cap assert before JSON validation, closed-world `additionalProperties:false` check.

## Global constraints

- Never commit, push, merge, or rebase. Worktrees stay dirty/uncommitted unless user later says otherwise.
- Never revert or overwrite the pi-subagents uncommitted changes; extend them.
- Reject-never-clamp at every new validation boundary; fixed safe error messages only (`RUNTIME_RPC_ERROR_MESSAGES` closed set / `LeafFailure` codes); provider text never enters errors.
- Wire-mirrored constants are copied verbatim, same names, same regexes.
- Tests: `npm run typecheck` + repo test suite must pass after every task. Atlas: `npm test`; pi-subagents: `npm test` (unit).
- No new runtime dependencies in either repo.

## Decisions locked (from approved spec v2)

- Width N = N gather actions **total per round**, not per lane. Global envelope `maxGatherActions` + per-lane caps.
- Profile selection code-owned; model never picks width. Deep = explicit job depth; Narrow = deterministic (single normalized required question, no specialist need); Balanced = default.
- [3,2,1] descending width is the benchmark candidate default for Balanced/Deep.
- Round-scoped fetch reserve: 7/4/1 under 12 (operator-lower-only overrides).
- Utility budget role-aware: reserve synthesis + verify/repair capacity before evaluators spend remainder.
- Graph arbitrary DQL/SPARQL deferred out of v1.
- `nextQueries` deleted; evaluator emits typed `nextActions` (with `questionId`); planner carries intents nested in questions (Atlas attaches IDs post-`normalizePlan()`).
- Legacy `runReportLeg`/`runSingleCycle` deleted in the final phase only.

---

### Task 1: pi-subagents — `jsonSchema` dialect capability + structured validator

**Outcome:** Runtime advertises `jsonSchema: 'structured-v1'`; wire schema gate and session validator accept the bounded structured subset for structured dialect and keep flat-v1 semantics otherwise; all existing dirty-diff tests still pass.

**Files (pi-subagents):**
- Modify: `src/api/runtime-rpc.ts` (capability record + dialect constant), `src/extension/runtime-rpc-schemas.ts` (`checkOutputSchema` gains dialect), `src/extension/runtime-rpc.ts` (negotiate echo, per-model dialect binding), `src/runs/runtime/leaf-model-session.ts` (`validateLeafJsonContract` gains dialect + structured subset validation)
- Test: `test/unit/leaf-runtime-contract-extensions.test.ts` (extend), `test/unit/runtime-rpc-contract.test.ts` (extend)

**Interfaces:**
- Produces: negotiate capabilities record with `jsonSchema` field (pinned contract above).
- Produces: session-side structured-schema validation given dialect binding from the negotiate record.

**Checks:**
- Red: structured schema (array-of-object property) + flat dialect → start-gate reject `invalid_params`; session flat validation unchanged.
- Green: structured dialect + bounded nested schema (planner/evaluator-shaped fixtures incl. `items`/`enum`/`minimum`) → passes through start gate and output validation; out-of-bounds depth/keys/bytes rejected; negotiate echoes `jsonSchema: 'structured-v1'`.
- [x] `npm run typecheck` clean; `npm test` green (existing 4 unit files incl. untracked contract-extensions file).

### Task 2: Atlas — force-text guard + negotiation mirror

**Outcome:** Atlas never sends a nested wire schema unless `structured-v1` negotiated; misleading "Flat JSON-mode schema" comments corrected; negotiated caps surfaced with `jsonSchema`.

**Files (Atlas):**
- Modify: `src/runtime/runtime-rpc-protocol.ts` (mirror `jsonSchema` field/constant verbatim), `src/runtime/leaf-runtime-client.ts` (`parseNegotiateCapabilities` gains `jsonSchema`, `getNegotiatedCapabilities()` returns it), `src/web/agent/agent-model.ts:194-207` (gating rule), comments in `SCHEMA_REGISTRY` region
- Test: `test/runtime/*` negotiation tests + `test/web/agent/agent-model.test.ts`

**Checks:**
- Red: negotiated caps without `jsonSchema` + `completeJson` on planner schema → no `outputSchema` forwarded to `runLeaf` (text mode), client-side parse path used.
- Green: negotiated `jsonSchema: 'structured-v1'` → `outputSchema` forwarded. Runtime error path unchanged (`provider_error` for unknown codes).
- [x] `npm run typecheck` + `npm test` green.

### Task 3: Atlas — evidence-only composition + no-model degradation ladder

**Outcome:** Deterministic floor exists and is tested: `composeEvidenceOnlyResult()` renders admitted evidence only; per-role no-model fallbacks (planner → root-plan [existing], evaluator → deterministic stop/gap rules, synthesizer → evidence-only, verify/repair → skipped+marked).

**Files (Atlas):**
- Modify: `src/web/agent/agent-core.ts` (evidence-only compose + synthesis-failure fallback wiring), `src/web/agent/agent-jobs.ts` (read `PI_NORTHSTAR_AGENT_STEERING=0` → strip model deps before `runAgentCore`)
- Test: `test/web/agent/agent-synthesizer.test.ts`, `test/web/agent/agent-adaptive.test.ts` (extend), new `test/web/agent/agent-no-model.test.ts`

**Interfaces:**
- Produces: `composeEvidenceOnlyResult(query, state, warnings, stopReason): AgentResultV1` — later tasks rely on it as the synthesis-failure fallback and the phase-8 replacement for the report leg.
- Consumes: `AgentEvidence` ledger + existing `composeAgentResult`.

**Checks:**
- Red: adaptive run with synthesizer model that throws → result is evidence-only with degraded marker, no report-leg call, no provider prose.
- Green: steering env `0` → no model deps passed, full deterministic run completes with evidence-only output.
- [x] Typecheck + focused tests green; full `npm test` green.

### Task 4: Atlas — steering seams wired in text-JSON mode

**Outcome:** Production jobs get real planner/evaluator/synthesizer/verifier/repair through leaf RPC (text-JSON mode), report leg still present; utility spend measured.

**Files (Atlas):**
- Modify: `src/web/agent/agent-model.ts` (`createAgentModelSeams(provider)` — planner/evaluator/synthesizer/verifier/repairer wrappers over `completeJson` with `SCHEMA_REGISTRY` names + per-role token caps + fixed reasons), `src/web/agent/agent-jobs.ts:1040-1053` (pass seams when leaf provider ready; kill-switch strips them)
- Test: `test/web/agent/agent-model.test.ts`, `test/web/agent/agent-jobs.test.ts`

**Interfaces:**
- Consumes: Task 2 gating (wire schema only on structured-v1 — seams run text-JSON here).
- Produces: `createAgentModelSeams` — Task 10 enables structured schemas through the same seam.

**Checks:**
- Red: job with leaf provider → planner call fires (mock leaf records prompt/role/stage tokens, v1 role `researcher` / v2 role `coverage_planner` per negotiated), evaluator runs per round, synthesis path executes.
- Green: seams absent (no leaf) → today's behavior (root-plan + report leg). Kill-switch → Task 3 ladder.
- [x] Typecheck + tests green; utility-call counts logged in a bench note (`bench/agent-eval/` summary or README note).

### Task 5: Atlas — `GatherIntent` contract + planner/evaluator schemas

**Outcome:** Discriminated intent union replaces `{route, routeArg}`; planner questions carry nested intents (no questionId from model); evaluator emits `nextActions` with `questionId`; token-overlap `resolveQueryRoute` removed from the normal path.

**Files (Atlas):**
- Create: `src/web/agent/agent-gather-intents.ts` (union + `validateGatherIntent` exact-keys/bounds + `compileIntent` arg mapping)
- Modify: `src/web/agent/agent-model.ts` (`AGENT_PLAN_SCHEMA` questions gain nested `intent`; `AGENT_EVALUATION_SCHEMA` `nextQueries` → `nextActions`), `src/web/agent/agent-planner.ts` (`normalizePlan` accepts nested intents; planner prompt updated), `src/web/agent/agent-core.ts` (`applyPlanRoutes` consumes nested intents; evaluator `nextActions` handling; delete `resolveQueryRoute` usage from normal path)
- Test: new `test/web/agent/agent-gather-intents.test.ts`; update `agent-planner.test.ts`, `agent-evaluator.test.ts`

**Interfaces:**
- Produces: `GatherIntent` union + validators — Task 6's evidence contract and Task 7's executor consume it.
- Intents in v1: `web_search`, `research_search`, `github_search`, `social_search`, `video_transcript`, `kg_lookup` (typed selector, no free-text query; no graph).

**Checks:**
- Red: unknown intent kind / extra keys → reject with safe reason; planner emitting `questionId` → rejected by domain validator.
- Green: planner nested intents survive `normalizePlan`; evaluator `nextActions` compile to exact tool args per kind.
- [x] Typecheck + tests green.

### Task 6: Atlas — `EvidenceProvenance` state-contract redesign

**Outcome:** Specialist results gain legal evidence identity; candidates-vs-evidence per route enforced (metadata row cannot ground a scientific conclusion; abstract grounds abstract-scoped claims).

**Files (Atlas):**
- Modify: `src/web/agent/agent-state.ts` (`AgentAcquisitionRoute` union extended: `'research'|'github'|'social'|'video'|'kg'`; locator becomes typed union — `{start,end}` char-range | `{page}` | `{line}` | `{timestamp}` | `{ref}` issue/commit | `{nodeId, field}` KG; source identity: http(s) `canonicalUrl` OR structured `{provider, query, nodeId?}` for non-URL artifacts; http(s) rule retained where URL exists; documentHash + sourceClass + excerpt bounds unchanged), `src/web/agent/agent-acquisition.ts` (per-route admission paths), `src/web/agent/agent-events.ts` (validators updated in same change — canonicalUrl-or-identity for evidence-bearing events, existing events unchanged shape)
- Test: `test/web/agent/agent-state.test.ts`, `test/web/agent/agent-acquisition.test.ts` (extend per-route cases)

**Checks:**
- Red: research metadata row admitted as conclusion-grade evidence → rejected; KG row without node/field locator → rejected.
- Green: GitHub file content + abstract + transcript segment + post body admitted with correct route/locator/hash; candidates (search hits) recorded without admission.
- [x] Typecheck + tests green.

### Task 7: Atlas — gather executor for search-like specialist routes

**Outcome:** `agent-gather.ts` executes `GatherIntent`s against the frozen capability snapshot via existing native tooling; per-route candidates→evidence admission wired into the adaptive GATHER leg; legacy web path remains when executor absent.

**Files (Atlas):**
- Create: `src/web/agent/agent-gather.ts` (deterministic compile + execute + admit; ordered dispatch, `Promise.allSettled`, ledger-order merge)
- Modify: `src/web/agent/agent-core.ts` (GATHER leg calls injected `gatherExecutor` when present; parallel legs preserve existing merge semantics), `src/web/agent/agent-jobs.ts` (build executor from capability snapshot + native tool surface)
- Test: new `test/web/agent/agent-gather.test.ts`; update `agent-adaptive.test.ts`

**Interfaces:**
- Consumes: Task 5 intents, Task 6 provenance, `agent-capabilities.ts` snapshot + admissibility gate.
- Produces: `gatherExecutor(intents, round, ctx): Promise<GatherOutcome>` seam (`AgentCoreDeps.gatherExecutor`).

**Checks:**
- Red: intent for unavailable route (snapshot) → degrade-to-web warning or reject; lane/envelope caps enforced (pre-Task-8 constants placeholder-free: use existing fetch budget until Task 8 lands caps).
- Green: each route executes against stubbed native tool dispatch and admits per Task 6 semantics; journal events emitted per existing event vocabulary.
- [x] Typecheck + tests green.

### Task 8: Atlas — `BudgetEnvelope`, scheduler, lane-aware stop policy

**Outcome:** Global envelope + per-lane caps + round-scoped fetch reserve + descending width schedule + code-owned profiles + role-aware utility reservation + lane-aware exhaustion stop policy.

**Files (Atlas):**
- Modify: `src/web/agent/agent-policy.ts` (`AgentBudgets` gains `maxGatherActions`, per-lane caps, `roundFetchCaps` [7,4,1], width schedule per profile; utility reservation: synthesis+verify/repair guaranteed before evaluator spend; `stopPolicy` lane-aware: stop when the global envelope is exhausted (sufficient by itself — executor planning and stopPolicy share ONE predicate), OR when no admissible lane has headroom, OR when maxFetches is exhausted (kills the whole lane-aware job) — all existing stop reasons retained), `src/web/agent/agent-core.ts` (profile selection code-owned; width schedule dispatch; per-lane counters), `src/web/agent/agent-jobs.ts` (profile derivation: deep from explicit job depth; narrow deterministic)
- Test: `test/web/agent/agent-policy.test.ts`, `test/web/agent/agent-determinism.test.ts` (extend)

**Checks:**
- Red: web-search budget exhausted + github lane headroom → job continues (specialist lanes ride envelope + lane caps, never the scalar search cap).
- Green: width 3 round 1 → exactly ≤3 actions total across lanes; envelope exhaustion stops; evaluator pressure cannot starve synthesis/verify reservation.
- [x] Typecheck + tests green.

### Task 9: structured-v1 enabled end-to-end + bench expansion

**Outcome:** Both repos negotiate `structured-v1`; Atlas sends real schemas; bench/agent-eval extended with github/academic/community/graph-entity/mixed/broad lanes; baseline recorded.

**Files:**
- Atlas: `src/web/agent/agent-model.ts` (final registry schemas active), `bench/agent-eval/run.mjs` + `bench/agent-eval/README.md` (new lanes; baseline JSON)
- pi-subagents: no change expected; contract tests already green from Task 1.

**Checks:**
- Red: round-trip integration — Atlas `completeJson` with structured schema against real negotiate/validate chain (spun from both repos in one test via negotiated fixture) → structured output validated; missing negotiation → text fallback.
- Green: `npm run bench:agent-eval` runs new lanes; `latest.json` written; no grounding regression vs `baseline-v1.json`.
- [x] Both repos typecheck + full tests green; bench table recorded in report.

### Task 10: legacy deletion + final verification

**Outcome:** `runReportLeg`, `deps.report`, `runSingleCycle` deleted; report-leg tests migrated; all suites green.

**Files (Atlas):**
- Modify: `src/web/agent/agent-core.ts` (delete `runReportLeg`/`runSingleCycle`; adaptive path is the only path), `src/web/agent/agent-jobs.ts` (`report` dep removed), related tests migrated to adaptive path
- Test: all `test/web/agent/*` migrated; full suite

**Checks:**
- Red: no reference to `runReportLeg|runSingleCycle|report:` dep remains (`grep` clean); typecheck enforces.
- Green: full `npm test` + `npm run typecheck` green; bench no grounding/latency regression; kill-switch ladder intact.
- [x] Reviewer subagent pass over the full cross-repo diff (disprove-oriented brief), findings verified and fixed.

---

## Remediation wave (post-plan)

Pending-until-final-verification (not part of the ten tasks above):

- [x] web_fetch follow-up intent + wire schema
- [x] fetch-reserve allocation across fetch-capable legs
- [x] research/KG zero-result adapter truthfulness
- [x] native-exception surfacing in buildNativeGatherTools
- [x] CandidatesAccumulated count-only journal telemetry
- [ ] stale outputModes option removal
- [x] stop-policy fetch-awareness follow-up (agent-policy.ts web-lane maxSearches check)

---

## Known unknowns

- Native tool arg shapes for research/social/video/kg dispatch inside `agent-gather.ts` — worker resolves from `src/native-tools.ts` + domain modules at implementation time; pivot signal: a route needing a non-deterministic argument → keep that intent unimplemented in v1 (graph already deferred).
- Exact per-lane cap values — placeholder-free start from envelope defaults in `agent-policy.ts`, values pinned as constants after Task 8 bench run.
- Utility ceiling 8 may need raising — Task 4 measures actual spend; pivot: raise ceiling within `MAX_UTILITY_CALLS` via role-aware reservation, only beyond 16 with user note.

## Execution notes for orchestrator

- Tasks 1, 2, 3 run in parallel (different repos/files; contract pinned above). Tasks 4–10 sequential (Atlas, overlapping files).
- One writer per repo at a time inside parallel batches: Task 1 (pi-subagents) ∥ Task 2+3 (Atlas, disjoint files: runtime/ vs web/agent core — acceptable, no shared file).
- Each task: worker implements → focused checks → reviewer gate (reviewer required for Tasks 1, 2, 6, 8, 10; optional elsewhere).
- Parent verifies: re-run typecheck+tests per repo after each batch; cross-check worker claims against diff.
