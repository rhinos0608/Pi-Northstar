# Agent Mode v2 — Adaptive Research Harness Roadmap

Date: 2026-09-15. Status: approved direction, execution delivered (Phases 0–9 + review loop closed; see RESULTS sections below).
Supersedes: initial brainstorm sketch (PLAN→GATHER→EVALUATE→REFINE→SYNTHESIZE kept as spine; ordering revised).
Baseline verified at commit `026c24fc03a0229d7525b441a21e795763846681` — clean tree, `npm run typecheck` passes, focused Agent tests 40/40, full suite 2,932 pass / 11 skipped / 0 fail in ~47s. This is the compatibility floor.

## Core decision (see ADR 0007)

Agent Mode v2 = deterministic research harness with an LLM steering wheel. Not a multi-agent framework. Preserve outer contract (`mode:"agent"` → job → poll, registry, TTL, canonical JSON, fail-closed RPC) unchanged; change machinery behind `AgentResultV1`.

Spine: PLAN → GATHER → EVALUATE → REFINE → SYNTHESIZE (+ VERIFY later).

Priority dependency chain:
**evidence ledger → chunk-level gather → planner/evaluator loop → grounded synthesizer → verifier → concurrency → lifecycle/durability → specialist capabilities.**

Key reordering vs original plan:
1. Grounded final synthesis (reportText/claims parity) comes BEFORE parallelism and durability. Primary correctness hole: opaque provider prose becomes reportText ungoverned by the claims support invariant; fallback claim = first sentence of a passage rather than answer-bearing sentence; agent core uses whole-page BM25 while normal Northstar retrieval has chunk-level machinery.
2. Typed event journal much later; state introduction early.
3. Converge Agent Mode onto existing Northstar primitives (chunker, BM25/vector/RRF, content store 128 entries/128MiB/1h TTL, WebSearchLedger dedup concepts, cached `source_check`, hardened GitHub acquisition) — never a second research stack.

## Reference repos — what was mapped (researchers, 2026-09-15)

Full researcher maps exist in session history only; condensed findings retained here.

### antins-labs/SearchOS (python, SOCM metaphor)
- Single `search_state.json` = FrontierMemory + EvidenceGraph (EvidenceNode + SUPPORT/CONFLICT/REFINE edges) + CoverageMap (entity×attr cells, MISSING/FILLED/UNCERTAIN/HARD, conflict on value disagreement) + StrategyMemory (anti-patterns, FailureMemory post-mortem distillation) + budget. Caps: MAX_FRONTIER_DEPTH=5, CAP=200, attempts=3.
- Six-step loop: Explore → Schema → Dispatch (scheduler: priority, deps, dedup, 429-recycle, max 8 parallel) → Extract (judge middleware = sole SOCM writer, dual FILL/DISCOVER) → Assess (state-diff per agent report) → Synthesize (coverage self-audit; deterministic citation table LLM cannot rewrite).
- Sensors enforce soft prompt limits: DispatchRoundSensor (hard-block enqueue at max), CoverageStallSensor (3 no-growth rounds → block dispatch), LoopSensor (5 modes, remind-then-mark), WriterTriggerSensor, premature-end nudge (max 2 resumes).
- Steal: state-as-system-asset principle; coverage-driven recall-first dispatch; stall/dispatch-round hard stops (trivial weight); post-mortem failure memory (adapt: per-job deadEnds only).
- Reject: sub-agent hierarchy, DAG scheduler, sensor framework, judge extraction middleware, skill sandbox executor.

### Lincoln504/pi-research (npm @lincoln504/pi-research)
- Quick path: single researcher session, no rounds. Deep path: coordinator plan → search burst → N parallel researchers (cap 3) → router per round → terminal synthesizer.
- **Digest-only routing**: router reads fresh reports FULL once, prior rounds as compact `COVERAGE DIGEST {Goal,Covered,Unsubstantiated,Gaps,Sources}` blocks — evaluator context stays ~linear. Router never writes; synthesizer reads full corpus once at end.
- Deterministic citation rebuild (`ensureCitedLinks` renumbers [1..N], redacts unverified inline URLs, weak/no-source notices); grounding gate + partial salvage (>50-char grounded partials kept with truncation banner); run-cap semaphore (slot files, PID liveness, fail-open); cache-layout discipline (byte-identical researcher system prompt, per-researcher data in user message).
- Steal: evaluator/synthesizer split; digest pattern; citation rebuild + provenance hardening; grounding gate; query-history dedup.
- Reject: researcher-agent fanout, browser cluster pool, LanceDB knowledge store, cross-process state manager.

### steel-experiments/durable-researcher (Postgres/Absurd)
- Durability = transcript-is-state: every completed model turn = durable step; resume = replay messages + project to derived state (notes, visited URLs, requiredClaims) — LLM unaware of crash.
- Claim ledger: `record_claims{text, sourceUrl, excerpt}` → `ResearchClaim` status + `independentCorroboration`; confidence DERIVED (mechanical, from corroboration count + source tier + recency + contradictions), never self-assigned. Syndication guard: identical excerpt >40 chars counts once across hosts.
- Post-report citation verifier: parse [n] groups, LLM excerpt grounding, 0.7 threshold, MAX_REWRITES=2, **best-report restore** if rewrite regresses. Borderline-band adversarial passes (refuter quorum) gated to narrow band.
- Mode-adaptive loop: classify lookup/extraction/survey/synthesis → different prompts/tools/budgets/stop rules per mode.
- Prefetch/scout turn economy: pipeline browses as searches complete; scout fuses search+browse top-3 into one call.
- Steal: derived confidence; verifier ladder with rewrite cap + best-restore; ledger-first gating in evaluate; mode classification (defer decision); URL normalize dedup.
- Reject: Postgres/Absurd dependency, campaign pulses, fan-out ledger merge, quorum verifier.
- Docs-vs-code contradictions found (code wins): source ceiling standard 50 not 20; DEPTH_CONFIG iterations 2/5/10; prompts at root `prompts/` not `src/prompts/`.

## Phase gates

| Phase | Objective | Principal changes | Exit gate |
|---|---|---|---|
| 0. Freeze baseline | Make capability changes measurable | Agent eval corpus, adversarial fault fixtures (round-1 superficially-plausible-but-incomplete), telemetry counters, snapshot current suite as floor | v1 measurements reproducible |
| 1. Evidence-first core | Replace page/report blobs with research state | `agent-state.ts`, chunk evidence via existing `chunkText()`, canonical URLs (existing normalizer), per-job query ledger, retain fetch responseIds; source discovery ≠ evidence admission — provider prose never authoritative; fetch suggested URLs through Northstar | Every internal finding traces to fetched evidence |
| 2. Adaptive loop | Add PLAN + EVALUATE + REFINE | Structured planner (2–5 questions, strict schema; skip for trivial lookups), evaluator schema validated by code, deterministic stop policy | System recovers from deliberately bad first searches |
| 3. Grounded synthesis | report and claims share one evidence basis | Evidence-only synthesizer (no live search, no provider oracle), citation renderer, claims reference evidence IDs → mapped to public source IDs | report prose cannot outrun evidence |
| 4. Verification/repair | Catch unsupported synthesis | Ladder: structural checks → cached source_check → semantic verifier (ambiguous/high-value only) → ≤1 repair → re-verify; best-version guard preserves best-scoring report; strict on numerics/quotes/dates/comparisons | Bounded repair improves support, never silently degrades |
| 5. Controlled concurrency | Latency without semantics change | 2–3 independent gather legs, Promise.allSettled; deterministic task IDs pre-dispatch; merge in task-order/source-order (completion order must not determine serialized state) | Deterministic outputs despite completion ordering |
| 6. Job lifecycle v2 | Long jobs | Split run-deadline vs retention TTL vs poll visibility TTL; owner-gated byte-stable progress projection {stage, round, questionsAnswered/Total, searchesUsed, fetchesUsed}; AbortSignal through controller | Polling safe over long runs |
| 7. Durable execution | Survive process loss where required | Typed event journal (JobCreated, PlanAccepted, SearchCompleted, FetchCompleted, EvidenceAdmitted, EvaluationAccepted, RoundClosed, SynthesisCompleted, VerificationCompleted, JobReady), project state from events; event sink optional initially, live state authoritative until projection stable | Interrupted run resumes without repaying completed work |
| 8. Capability-aware research | Use more of Northstar, typed, across verticals | Closed `GatherAction` union (WebSearch/Fetch/ResearchSearch/MediaVideo/Social/Github/Kg/Graph); availability-aware routing via `CHANNEL_CAPABILITIES`; planner proposes, code validates/routes; social vertical = community sentiment/knowledge mining (threads+comments), video vertical = youtube/bilibili search+details+transcripts (media tool); browser automation much later, policy-controlled | Specialist lanes improve benchmark subsets |
| 9. Eval-driven advanced | Complexity only when evidence says | Derived confidence (independent source count, contradictions, verification outcome — never raw 0.93), conflictsWith edges, dependsOn only if multi-hop failures observed, cross-job memory deferred entirely, kg/graph entity/ontology maps for deep queries only | Each mechanism clears ablation gate |

## Core state shapes (Phase 1–2)

```ts
interface AgentEvidence {
  id: string;
  sourceId: string;
  canonicalUrl: string;
  excerpt: string;        // chunk, not whole page
  excerptHash: string;
  questionIds: string[];
  round: number;
  status: 'active' | 'conflicting' | 'rejected';
  corroboratingSourceIds: string[]; // derived, never LLM-stated
}
```
No free-form model-assigned confidence initially (Phase 9 derives it).

Evaluator output schema (Phase 2) — evaluator proposes, code validates + executes; every "answered" must point at admissible evidence IDs; unknown IDs rejected; nextQueries bounded + deduped; budgets enforced:
```json
{ "questionUpdates": [{"questionId","status","evidenceIds"}],
  "gaps": [], "conflicts": [], "nextQueries": [], "shouldContinue": false }
```

Evaluator context economy (pi-research pattern): goal, questions/statuses, previous queries, compact digest of prior rounds, FULL evidence added this round only, gaps/conflicts, budget remaining.

Hard stop gates (evaluator's shouldContinue is advisory only): all required questions grounded OR deadline OR search/fetch/model budget exhausted OR two rounds zero admissible evidence growth OR no non-duplicate next query remains.

## Gather verticals (Phase 8 — grounded in the actual toolset)

| Vertical | Tool / surface | Real capabilities (verified in `src/capabilities.ts` + reach-tools) | Availability gates |
|---|---|---|---|
| Web search | `web_search` | plain/batch/agent + `research` category (12 academic/public-data sources: arxiv, pubmed, crossref, openalex, semantic_scholar, datacite, ror, gdelt, wikipedia, wikidata, stackoverflow, hackernews) | Always available; research category is first-class |
| Fetch / dig | `fetch` | single/batch/sitemap reads, cached claim verification (`responseId` slice), siteMap discovery | Always available; SSRF policy applies |
| Video | `media` (youtube, bilibili) | youtube: search/details/hot via Data API + keyless oEmbed fallback + transcript (cookie-gated); bilibili: search/details/hot via `bili` CLI + subtitles via OpenCLI | youtube needs `YOUTUBE_API_KEY` for search/details; bilibili needs `bili` CLI probe pass, cookies optional; transcript paths need cookie import |
| Social | `social` | twitter, reddit, xiaohongshu, facebook, instagram, v2ex, linkedin — search/threads/comments/profiles for community sentiment/knowledge | Per-platform CLI install + cookies; probe before dispatch |
| KG entity probe | `kg` | Diffbot DQL entity search/enhance | Only when `DIFFBOT_TOKEN` set (conditional registration) |
| Graph probe | `graph` | Diffbot DQL + operator SPARQL (SELECT/ASK only) | Only when configured; operator endpoint trusted config |
| Semantic | internal hybrid retrieval (BM25+vector+RRF) over fetched chunks per question — not a public tool | Always available once Phase 1 evidence-first core exists |

Methodology defaults (user-rough, reality-adjusted):
- Web search starts every deep query; research category for academic-shaped questions.
- fetch digs into surfaced resources; evidence admitted only from fetched content.
- Semantic (hybrid chunk retrieval) preferred for evidence ranking when Phase 1 lands.
- Social vertical: targeted sentiment/community-knowledge mining — search platform, pull threads + comments, admit as evidence with community-source class (lower authority tier by default; valuable for sentiment, prevalence, practitioner knowledge).
- Video vertical: search + transcript retrieval when transcripts available (youtube API/bilibili subtitles); transcripts become fetchable excerpts in evidence ledger.
- kg/graph: entity probing + unknowns discovery + ontology map ONLY for deep/synthesis-tier queries (adds per-query cost + depends on configured tokens); code validates all proposed queries. Availability always consulted before route admission — a route missing its gate degrades to web search, never fails the job.

Planner must emit `GatherAction` proposals only within the availability-gated union; evaluator sees which verticals were used per round for budget/diversity reasoning.

## File layout (final shape)

```
src/web/agent/
  agent-contract.ts       public v1 result/job contract (unchanged)
  agent-state.ts          questions, evidence, gaps, conflicts, counters
  agent-policy.ts         budgets, stop rules, deterministic validation
  agent-planner.ts        query -> bounded research questions
  agent-gather.ts         search/fetch/chunker/retrieval integration
  agent-evaluator.ts      fresh evidence -> coverage/gaps/next queries
  agent-synthesizer.ts    evidence-only final synthesis
  agent-verifier.ts       source_check + semantic verification/repair
  agent-model.ts          structured utility-model/leaf seam
  agent-core.ts           small controller/state machine
  agent-jobs.ts           existing shell, later progress/durability hooks
  agent-rpc.ts            capability seam (unchanged)
  agent-events.ts         later, Phase 7 only
```
Never add: scheduler.ts, broker.ts, worker.ts, explore-agent.ts, writer-agent.ts, generic graph library.

## Current-behavior notes (verified pre-roadmap)

- `runAgentCore()` single cycle: one search → ≤8 sequential fetches → whole-page BM25 → RRF(fetch order, BM25) → one opaque report leg → compose sources+claims → AgentResultV1.
- Claims validation strict (must cite known source IDs); reportText ungoverned — divergence risk.
- Fallback claim on validation failure = first sentence of fetched passage (weak grounding).
- WebSearchLedger (exact coalescing, token+bigram near-dup suppression, bounded retry blocking, cached responseId reuse) exists at extension/session layer; agent jobs bypass it — reuse normalization/dedup concepts in a per-job ledger, do not couple controller to UI/session ledger.
- Cached source_check exists (heuristic support check) — reuse as verification ladder rung 2.

## Phase 0 design (verified seams — scout 2026-09-15)

- Eval lane lives in `bench/agent-eval/` (matches `bench/cli-spawn-bench.mjs` + `npm run bench:*` convention, tsx-imported). New script `bench:agent-eval`.
- v1 measured as-is: counters injected by wrapping `AgentCoreDeps` (`agent-core.ts:27-38`) — search/fetchText/report wrappers count calls, durations, URLs. **Zero prod-code change in Phase 0.**
- Metrics: factCoverage (expected-fact claims with valid citations; report-only coverage reported separately), supportedClaimRate, citationPrecision, unsupportedProse (deterministic heuristic scorer: report sentences with fact-like tokens not covered by claims), duplicateFetchRate, recoveryAfterBadSearch, contradictionDiscovery (v1 expect 0), call counts, latency, graceful-failure behavior.
- Case schema: `{ id, query, expectedFacts[{id,text,match}], providers{search,fetch,report scripted}, fault? (empty_search | plausible_incomplete | fetch_failures | report_error | claim_validation_fail), expectations? }` — deterministic fake providers, template from `test/web/agent/agent-core.test.ts:11`.
- Adversarial fixtures: round-1 superficially-plausible-but-incomplete provider content — the set v2 must beat v1 on.
- First green run commits `bench/agent-eval/baseline.json` = reproducible v1 measurement (the exit gate).

### Verified unwired-free scaffolding (scout-confirmed, exploit in Phase 1+)

- `validateAgentResult` (`agent-contract.ts:137`) has **zero prod callers** — tests only. Phase 1 must wire it as the admission gate.
- `chunkText` (`src/search/chunker.ts:140`, 2048/512/100 defaults), `normalizeUrl` (`src/search/fusion.ts:6`), content store (`src/web/access/web-access-content-store.ts:76`), cached `source_check` (`src/web/access/web-access-cached-source-check.ts:26`), `WebSearchLedger` (`src/web/web-search-ledger.ts:188`) — all exist, none wired to agent (`agent-jobs.ts:100-117` calls `callNativeTool` direct; agent dedup is a raw-URL `seen` set at `agent-core.ts:124-133`).
- `redactProvenance` (`agent-core.ts:45-60`) already provider-opaque incl. secret-stem stripping.
- Retry/fallback exists everywhere (fetch skip L88-90, report degrade-to-local L119-121, `leafReportWithFallback` L226-270, inFlight coalescing L274-282) with **no counters** — Phase 0 wrapper counters are the first telemetry.
- Fail-closed job admission: `UNSUPPORTED_AGENT_JOB_FIELDS` (`agent-jobs.ts:66`) rejects limit/category/yearFrom/recency/domains.

### Phase 0 RESULTS (verified 2026-09-15, parent re-ran all checks)

`npm run bench:agent-eval` exit 0, 11 cases, baseline.json written. `npm run typecheck` exit 0. Agent tests 40/40 via `node --import tsx --test` (NOT vitest — test files are node:test; vitest errors "No test suite found" on this repo's agent tests). diff = package.json + new bench/agent-eval/; src/test untouched.

Baseline v1 numbers: factCoverage 0.636 (7/11; all 3 adversarial plausible_incomplete cases score 0.00 — the target v2 must beat), supportedClaimRate 1.0, citationPrecision 0.909 (single miss = fetch_failures case: claim cites report-suggested source never locally fetched — the discovery≠admission gap, direct Phase 1 justification), reportOnlyFactMatch 0 (scripted fixtures; real-world reportText outrun unmeasurable in fake lane — Phase 3 target), unsupportedProse 1 (year-token heuristic edge, documented), duplicateFetchRate 0, graceful 11/11, contradictionDiscovery 0 (no mechanism, as designed), calls 11/16/11, latency ~3ms total.

Exit gate MET. Phase 0 closed.

## Revision 2 (2026-09-15 — verdict on architecture, supersedes conflicting text above)

Direction approved; six load-bearing issues must be fixed BEFORE deep build-out. Where this section conflicts with earlier text, this section wins.

### R1. Phase 0 gate must actually measure what it names (reopen as Phase 0b, blocks Phase 1)

- Rename structural metrics to what they measure: factCoverage→structuralFactMatch (OR-token alternatives let entity name satisfy a fact without the value); supportedClaimRate→claimCitationValidity (IDs exist ≠ sources support text); citationPrecision→fetchCoverageOfCitations (fetched ≠ supports).
- Add real claim↔evidence support metric: fixtures DECLARE ground-truth supporting source + excerpt per fact; claimSupportRate = claims covering a fact whose cited source == declared supporting source AND value tokens match. (Deep Research Bench FACT-style statement-URL support, implemented deterministically on fixtures.)
- Adversarial providers must be query-sensitive/stateful: first search returns plausible-but-incomplete universe; a correctly targeted follow-up (keyword-gated) exposes the missing/contradictory source. Without hidden recoverable evidence, Phase 2 cannot demonstrate its purpose.
- contradictionDiscovery fixture: two scripted sources conflict on a value; v1 scores 0 by design (no mechanism), v2 must detect.
- baseline-v1.json immutable; runs write latest.json + deltas. Gate on explicit thresholds/deltas, not regenerated files.
- Eval splits into lanes: (A) deterministic fixture suite (exists, fast invariant/fault lane — extend with prompt-injection fixtures); (B) frozen-corpus quality lane (realistic research tasks, added when planner/evaluator/synthesizer models enter, repeated trials mandatory — single-run agent quality is noisy); optional live lane later. References: Deep Research Bench / RetroSearch (frozen web), emmmdty/deep-research-agent (deterministic-vs-live lane split).

### R2. Evidence model strengthened (Phase 1)

AgentEvidence gains: documentHash, locator {start,end} from chunkText (never hash-only), acquisitionRoute, sourceClass (official|docs|repo|academic|news|community|unknown), and corroboration fingerprint (near-identical excerpt detection across URLs/domains — syndication guard, defined NOW so Phase 9 confidence can't be inflated by mirrors). Lifecycle separated from semantic stance: status: admitted|rejected|superseded (admission lifecycle) × supports/contradicts propositions (stance is per-claim edge, not evidence status). Two conflicting legitimate sources both remain admitted. Stable internal IDs derived from stable inputs (content hash + canonical URL), never array position; public src-N rendered only at the edge. Internal source identity order-independent (concurrency-safe, Phase 7 replay-ready).

### R3. Report = compiled view of claim/evidence IR (Phase 3, highest-leverage redesign)

Synthesizer emits bounded ReportBlock{sectionId, prose, evidenceIds} / DraftClaim units; deterministic code renders reportText, citations, claims, and source list from that IR. Grounding enforced by construction, not post-hoc prose detection. Public AgentResultV1 unchanged. Enables surgical repair (Phase 4): target failed blocks/claims only.

### R4. Verification authority rules (Phase 4)

Ladder: structural → deterministic numeric/date/quote/polarity checks against the EXACT admitted excerpts → semantic entailment over those exact excerpts only for ambiguous cases. Three-way verdict: supported|refuted|not_enough_evidence. Compound claims fail clause-by-clause (all material clauses must be supported; YuResearchAgent convergence). source_check can nominate or cross-check passages, but any new passage it finds must be admitted as evidence before supporting prose — never a second truth system. Repair gate: best-version selection rejects citation rebinding, loss of previously supported findings, contradiction growth, deletion-as-score-gaming, reduced required-question coverage.

### R5. Runtime capability = effective snapshot, not CHANNEL_CAPABILITIES (Phase 8)

Registry is build-time truth; reach-tools.ts holds the real action-aware env/auth/CLI/probe availability logic. Extract a shared effective-capability resolver: {action, usable, quality, reason, backend}[]; snapshot per job (or per round); GatherActions validated against the SAME snapshot; degradation to web recorded explicitly ("specialist route unavailable: <reason>"), never silently equivalent.

### R6. Deadline/abort moves INTO Phase 2

Hard execution deadline + cooperative AbortSignal propagation are prerequisites of the adaptive loop — iterative refine loops cannot be introduced while their stop mechanism is deferred to Phase 6. UI progress, TTL splitting, durability stay in Phase 6.

### Additional binding rules

- Formal question model (Phase 2): stable question IDs, required|optional, answerability; evaluator may propose answered but code promotes to grounded only via the evidence-support gate. Stop condition "all required grounded" is a code verdict, not an LLM opinion.
- Semantic evidence growth (Phase 2 stall sensor): growth = new admissible non-duplicate item that changes question coverage, adds genuinely independent corroboration, exposes or resolves a conflict. Adding chunks/pages does not reset the stall counter.
- Adaptive-query dedup (Phase 2): hard "no duplicate next query" uses exact normalized query+question+route identity; WebSearchLedger-style fuzzy suppression is advisory/scoped to same intent+retry, NOT a blanket gate — research follow-ups legitimately differ by one decisive constraint.
- Shadow mode (Phases 1–2): build and eval the evidence ledger + adaptive loop internally; production AgentResult producer switches only when the Phase 3 evidence-backed renderer lands. Do not ship sophisticated state under a still-free-form report authority.
- Source compiler (Phase 3): deterministic pre-synthesis selection of ≤20 sources (contract cap) maximizing required-question coverage, directness, independence, diversity; synthesizer sees only evidence whose sources can legally ship — prevents late truncation orphaning grounded claims.
- Research debt (Phase 2 terminal state): budget/stall/deadline termination preserves unresolved required questions, conflicts, capability failures; V1 warnings/report wording must make partial reports visibly partial.
- Prompt-injection fixtures (Phase 0b/1): retrieved text never acquires action authority; fixtures with instructions to alter queries, disclose secrets, ignore evidence rules, fabricate citations go into the architecture test suite now — importance grows as more retrieved text reaches steering models.

### Revised phase gates v2

| Phase | Objective | Exit gate |
|---|---|---|
| 0b. Eval gate hardening | Fix metric semantics, stateful adversarial providers, contradiction fixture, immutable baseline, injection fixtures, lane definitions | Metrics measure support, not structure; recovery is achievable in-fixture; baseline immutable |
| 1. Evidence-first core | Strengthened AgentEvidence (R2), typed acquisition results (not fetchText():string — preserve responseIds/locators), wire validateAgentResult as admission gate, per-job query ledger (R2 identity rules), canonical URL dedup | Every finding traces to fetched evidence with locator + route + class |
| 2. Adaptive loop | PLAN/EVALUATE/REFINE + hard deadline + AbortSignal + formal question model + semantic growth + research debt | Recovers from deliberately bad first searches under a hard deadline; stop conditions are code-enforced |
| 3. Grounded synthesis via IR | ReportBlock IR → deterministic renderer, source compiler, shadow-mode cutover | report prose cannot outrun evidence BY CONSTRUCTION; production producer switches here |
| 4. Verification ladder | R4 rules, surgical block repair, best-version gate | Bounded repair improves support, never silently degrades |
| 5. Concurrency | 2–3 legs, deterministic merge in task order | Deterministic outputs despite completion ordering (stable internal IDs make this tractable) |
| 6. Lifecycle v2 | TTL split, progress projection (abort/deadline already in Phase 2) | Polling safe over long runs |
| 7. Durable execution | Typed event journal (stable IDs make replay natural) | Interrupted run resumes without repaying completed work |
| 8. Capability-aware gather | Effective-capability resolver (R5), typed GatherAction, verticals per availability snapshot | Specialist lanes improve benchmark subsets; degradations recorded |
| 9. Eval-gated advanced | Derived confidence (now possible: fingerprints + sourceClass stored since Phase 1), conflicts edges, dependencies, memory | Each mechanism clears ablation gate |

### Reference additions (validation mapping)

| Reference | Take |
|---|---|
| YuResearchAgent | hybrid deterministic/semantic verification, clause-wise compound claims, guarded revision |
| Deep Research Bench / II | citation-support measurement (FACT), quality eval separated from implementation invariants |
| RetroSearch / FutureSearch DRB | frozen-corpus repeatability for retrieval-agent comparison |
| emmmdty/deep-research-agent | deterministic-pipeline vs live-quality lane split, fault-injection/recovery |
| SAGE | failure case: replanning must stay hard-bounded — adaptive DAG unbounded expansion |

### Phase 0b RESULTS (verified 2026-09-15, parent re-ran all checks)

13 cases, exit 0, `latest.json` written; `baseline-v1.json` checksum unchanged through run (6e9d7de…9044e1). typecheck 0, agent tests 40/40. Renamed metrics reproduce baseline values: structuralFactMatch 0.636, claimCitationValidity 1.0, fetchCoverageOfCitations 0.909. NEW honest numbers: **claimSupportRate 0.538** (vs claimCitationValidity 1.0 — the structural-vs-support gap, the number Phase 1 must close); fault-contradiction present with contradictionDiscovery 0 (v2 must detect); adv-injection present (fabricated-URL + instruction assertions pass, enforced architecturally from Phase 2); adversarial cases now query-sensitive (targeted follow-up exposes hidden/contradictory source — recovery achievable in-fixture, plannerHint recorded). Exit gate MET. Phase 0b closed.

### Phase 1 RESULTS (closed 2026-09-15)

Delivered: agent-state.ts (AgentEvidence with locator/documentHash/sourceClass/route/fingerprint, lifecycle≠stance, stable hash ids, reject-not-drop admission with caps: excerpt 4096B, MAX_EVIDENCE=256, MAX_QUERIES=128, MAX_QUERY_BYTES=2048, MAX_QUESTIONS=64; questions with required/answered/grounded + promoteToGrounded validation + groundedBy linkage; exact-identity query ledger + advisory similarity), agent-acquisition.ts (typed fetch acquisition, responseId preserved, MAX_FETCH_CONTENT_BYTES=256KiB truncation flag, hoisted documentHash), agent-core.ts wiring (validateAgentResult live at boundary with unthrowable degrade → minimal valid result; fetched-citation invariant: claims citing never-fetched sources dropped + sanitized deduped warnings; provider-array caps 64; sanitizeForWarning ANSI/CSI/OSC/C1/zero-width/bidi). 67/67 agent tests (29 new). typecheck 0.

Bench (corrected aggregates): structuralFactMatch 0.808 (was 0.636), claimCitationValidity 1.0, fetchCoverageOfCitations 1.0 (measured, was hardcoded 0.909), claimSupportRate 0.731, graceful 13/13. Adversarial cases now recover 0.5–1.0 vs 0.00 baseline (invariant forces fallback to fetched sources). fault-fetch-failures structuralFactMatch 0 = intended invariant (claim citing never-fetched source honestly dropped).

Review loop: 3 rounds. R1 BLOCK (degrade-invalid, unbounded admit, hash bypass) → fixed. R2 BLOCK (P0 degrade-throw on non-string text; unbounded provider arrays; sanitizer gaps; snapshot bounds) → fixed. R3 no findings (output truncated pre-verdict; parent independently verified the critical chunker slice-exact claim — chunker.ts:95-135 all levels construct chunks as exact text.slice(start,end) pairs, so unconditional locator-excerpt identity is safe).

### Phase 2 RESULTS (closed 2026-09-15)

Delivered (split across 5 concurrent file-disjoint workers): agent-policy.ts (resolveBudgets reject-not-clamp, stopPolicy 6-reason deterministic order with advisory-only evaluator stop, semanticGrowth with fingerprint-distinct coverage/corroboration/conflict criteria, detectConflicts advisory-only with documented recall limits), agent-planner.ts (normalizePlan allowlist + recomputed ids + fallbackPlan + byte-capped sanitized goal in prompt), agent-evaluator.ts (buildEvaluatorContext with FENCED untrusted evidence excerpts (per-id <<<>>> markers, defanged, single-lined, reuse of cleanUntrustedText), PREVIOUS QUERIES sanitized+truncated, validateEvaluation sanitize-before-length, code-executes/proposes-only), agent-model.ts (AgentModelClient seam, scripted fake in test helpers), agent-state.ts caps (goal 2048 throw, question 2048 reject, queries 128/2048B, questions 64), agent-core.ts (runSingleCycle refactor byte-identical legacy + runAdaptiveCore: PLAN→gather→evaluate→growth→stopPolicy; deadline throw; AbortSignal; research-debt warning; code-only promoteToGrounded; query seam sanitization).

Tests: 137 agent tests; full suite 3040 pass / 0 fail. Bench v2 lane: all 13 cases run both v1 and v2 with scripted planner/evaluator; gates 16/17 — v2>=v1 everywhere, adv-laptop/api recovery 1.0, fault-contradiction contradictionDiscovery 0→1 (root cause found: fixture bodies under chunker minChars=100 admitted zero evidence — padded). Remaining gate miss: adv-plausible-pricing v2==1.0 — fallback claims take first sentence per passage so the $79 value never enters a claim; structural, Phase 3 renderer fixes.

Review loop: R1 correctness CLEAN-with-notes (P2 duplicate fetch, linkage default, rounds display off-by-one, detectConflicts evadability noted), security BLOCK (P1 unfenced untrusted excerpts + unsanitized nextQueries loop; P2 goal bounds) → F1/F2 fixed (F2 debug found real root cause of contradiction miss = chunker minChars, not token overlap). R2 focused: CLEAN, 3 P2 polish notes carried to Phase 3 (C1 strip sharing in fence path, benign-Unicode query test pin, sanitizeGoal intent note). Real-model wiring gated on the P1 fencing/sanitization fixes — now clear.

### Phase 3 RESULTS (closed 2026-09-15)

Delivered (3 concurrent file-disjoint workers + cross-repo): agent-synthesizer.ts (SynthesisClaimUnit/ReportBlock/SynthesisOutput IR with recomputed deterministic ids + dedupe + alias maps, validateSynthesisOutput allowlist with orphan tracking, compileSourceSet ≤20 by coverage×3+directness+independence with normalizeUrl grouping + deterministic tiebreak, renderResultFromIR with [src-N] inline markers + ORPHANED_CITATION_TOKEN, buildSynthesisPrompt fenced/capped), agent-core.ts synthesis stage (compile-first ordering, block-aware truncation to AGENT_REPORT_MAX_BYTES, fail-closed fallback on invalid IR, drop/orphan/debt warnings), leaf-runtime contract extensions in pi-subagents (JSON output mode reusing output_contract_breach, outputModes ['text','json'], live assertOutboundTokenCap, correlation v2 negotiate-gated two-shape union, role-registry export — 89/89 affected suites, 4 pre-existing unrelated fails stash-verified), Pi-Atlas consumer side (LeafRunOptions outputSchema, correlation v2 compose/validate capability-gated v1-forever, createLeafModelClient with 3 domain schemas + role caps 2048/2048/4096 + fence-strip text fallback, negotiated caps surfaced record-level, AGENTS.md addendum).

Grounding now enforced BY CONSTRUCTION: provider report text replaced by IR-rendered report when seam present; empty-citation blocks rejected; orphaned citations tokened; bench 30/30 gates (adv-plausible-pricing 0.50→1.00 via v3 IR — first-sentence fallback superseded). Tests: 166 agent, full suite 3064/0.

Review loop: Phase 3a review BLOCK (P0 empty-claimUnitIds uncited prose shipped; P1 prompt/compile divergence, invisible drops, bench over-citation; P2 dupes, 64KB truncation, grouping) → all fixed → verified 30/30. Consumer-seam review: CLEAN (wire-mirror byte-identical both repos, v1-forever single-flight holds, no provider-text/snapshot leaks, fence-strip anchored) with 6 P2 notes (normalized-value/message drift, Atlas-stricter schema bounds — self-limiting fail-closed, display-only ownerPattern, negotiated race unreachable, silent text-fallback observability).

### Phase 4 RESULTS (closed 2026-09-15)

Delivered (3 file-disjoint workers): agent-verifier.ts (three-way verdict ladder: structural → deterministic numeric/quote/date checks against exact admitted excerpts → semantic rung gated to ambiguity + high-value signals, clause-wise compound judgments, slot-aligned refutation: numbers conflict only with shared unit (`$`/`%`, percent≡%) or context-keyword overlap in window; ambiguous separators (EU 1.000) → not_enough_evidence never refuted; polarity mismatch → NEE signal never refutation alone; deterministic refutation always wins over model verdicts; semantic merge requires length + normalized clause-text alignment else rejected; claim text fenced via fenceEvidenceExcerpt under untrusted label; MAX_VERIFIED_CLAIMS_PER_REPORT=20 fail-closed with 'capped' method), agent-core.ts VERIFY+REPAIR stage (utility-budget-exact counting, ≤1 repair pass over failed claim slots only, slot-bound citation: repaired evidence must be subset of failed slot's checkedAgainst — paraphrase rebinding closed, sole-grounded-support deletion guard regardless of percentage, positional splice with ambiguity pre-reject, wasted-repair budget guard, best-version gate rejects on equal score = keep incumbent, deterministic prompt build). Bench v4 lane: 16 cases (13 shared + repair-regression + numeric-lie), verdicts summary, repairEvents, 47/47 gates, seam detector via repairer invocation (deterministic wins legitimately bypass verifier model calls — detector rationale recorded).

Tests: 231 agent (verifier 52), full suite 3108+ / 0 fail (flakes pre-existing, pass solo). Bench 47 PASS / 0 FAIL / 0 SKIP, seamWired true, repairAppliedTotal 2, repairRejectedTotal 1.

Review loop: R1 BLOCK (P0 slot-blind same-magnitude false refutation — '99 seats' vs unrelated '100 attendees'; P1 splitter/numeric/negation/index-merge/unfenced prompts/paraphrase rebinding/20% deletion) → fixed across two concurrent workers → verified. R2 pending on final phase delta (rolled into end-of-roadmap whole-diff loop).

### Phase 5 RESULTS (closed 2026-09-15)

Delivered (2 file-disjoint workers): agent-core.ts gather region (pre-dispatch ledger-order leg IDs; single query → sequential path verbatim; multi-query → Promise.allSettled dispatch with floor-split total-maxFetches allocation (remainder to earlier legs); merge strictly in leg-id order — counters increment once per leg, passages/admissions/warnings in ledger order, warning strings identical to sequential; abort/deadline checked pre-dispatch and post-settle pre-merge, mid-flight abort settles all legs then throws, no half-written counters; failed searches count like sequential) + agent-adaptive.test.ts (6 concurrency tests: delay-invariance snapshot equality, leg-failure isolation, total maxFetches exact, maxSearches exact, mid-round abort, sequential byte-equality) + test/web/agent/agent-determinism.test.ts (completion-order-invariance property suite: delay permutations [30/5/15] canonical-JSON equal, failure-order invariance, overlapping-URL dedup determinism, zero-vs-delayed equality; overlap probe — passes under sequential today, real gate once legs wired).

Known semantics note: floor-split fetch allocation can under-allocate a leg that would have eaten the whole budget sequentially; fixture flows (1–3 hits/query) produce identical evidence sets; bench 47/47 confirms no fixture drift.

Tests: 242 agent; full suite 3140/0 fail. Bench 47 PASS / 0 FAIL / 0 SKIP, deterministic.

### Phase 6 RESULTS (closed 2026-09-15)

Delivered (2 concurrent workers + consolidation): agent-core.ts (AgentProgress {stage,round,questionsAnswered,questionsTotal,searchesUsed,fetchesUsed} + AgentCoreDeps.onProgress — fires at plan/gather(sequential per query, concurrent per leg)/evaluate/synthesize/verify/done/failed, counts monotonic, best-effort try/catch, absent = byte-identical; isAdaptive also true on onProgress alone; adaptive deadline default derived from AGENT_RUN_DEADLINE_MS when caller passes none) + agent-jobs.ts (TTL split: AGENT_RUN_DEADLINE_MS 30min/cap 2h enforced at drive; AGENT_RESULT_RETENTION_TTL_MS 24h terminal pollability; AGENT_POLL_VISIBILITY_TTL_MS 5min in-flight staleness; prune drops jobProgress+jobDeadlines+inFlight) + agent-contract.ts single-sourced constants with AGENT_JOB_TTL_MS = max(run, retention) = 24h derived (compat name kept; stale 1h assertion removed) + snapshot gains optional progress (counts only, fixed field order, byte-stable double-poll test, owner-gated).

Tests: agent 254/254; full suite 3152/0 fail (3163 total). Bench 47 PASS / 0 FAIL / 0 SKIP.

Review: targeted reviewer CLEAN (leak-free counts-only projection, byte-stable canonicalJson, throw swallowed at every site incl. callback errors, TTL split > consistent, prune complete, bestVersion tie-reject enforced, no missed ship branch, seam narrow) — 2 P2 notes carried forward: (a) type-mask hides progress-type drift — export shared progress type, drop cast; (b) isAgentJobSnapshotStale skips prune() while snapshot path prunes (registry lingers until next prune).

### Phase 7 RESULTS (closed 2026-09-15)

Delivered: agent-events.ts (10 typed events — JobCreated/PlanAccepted/SearchCompleted/FetchCompleted/EvidenceAdmitted/EvaluationAccepted/RoundClosed/SynthesisCompleted/VerificationCompleted/JobReady — counts/ids/hashes only, exact-keys per type, query 512B/URL 2048B caps, 256KiB journal cap reject-not-truncate, fail-closed projection fold, replay monotonicity + JobCreated-first + JobReady-last), agent-research.ts (footnote allowlist validation, recomputed rf- ids, grounded source+locator checks, gaps cap, deterministic prompt — 9/9), agent-jobs.ts journal sink (per-job journal, JobCreated/JobReady real, stage events derived from onProgress + recording wrappers for exact query/url/byteLength, __getAgentEventJournal owner-gated, sink-absent = byte-identical snapshots proven).

Documented gaps (todo #14): PlanAccepted.questionIds synthetic placeholders, some counts 0 (shell lacks core detail), failed fetches undercount. Projection treats as opaque.

Tests: agent 299/299 at close. Full suite 3197+/0 fail. Bench 47/47.

### Phase 8 RESULTS (closed 2026-09-15)

Delivered (3 workers): agent-capabilities.ts (effective-capability resolver — build-time registry ≠ job-time reality: youtube API-key/cookie tiers, bilibili CLI probe + cookie tiers, social per-platform CLI/cookie gates, kg DIFFBOT_TOKEN-gated, graph DQL/SPARQL tiers, web/research/github always full; probe injection deterministic, no network; frozen per-job snapshot; deterministic byte-capped prompt format; gatherActionAdmissibility → allowed:false + degradeTo:'web' + explicit reason — R5's never-silent-equivalence), agent-core.ts (AgentGatherRoute on plan questions, applyPlanRoutes validates routes by index, unavailable/invalid → 'route degraded: <v> unavailable (<reason>)' + force web, admissible non-web → 'route noted (execution pending Phase 9)' + ledger route, capabilities block appended to planner prompt when snapshot present, no-snapshot = byte-identical prompt), agent-jobs.ts (snapshotForJob(process.env) once per job into deps.capabilitiesSnapshot).

Tests: agent 305/305; full suite 3203/0. Bench 47/47. Rebase-verified post-churn.

### Phase 9 RESULTS (closed 2026-09-15 — ablation-honest)

Delivered: agent-policy.ts deriveEvidenceConfidence (pure, deterministic, admitted-only, internal-only: +0.35/distinct fingerprint cap 2, +0.1 authority-class cap 0.2, −0.15/conflict pair, +0.15/verified fingerprint cap 0.3, clamp [0,1]) — NO public API shipped (AgentResultV1 unchanged). Bench v5 ablation lane: 16 computed gates + 3 ablation gates. Ablation INCONCLUSIVE (fixture corpus insufficient — value-symmetric slots, uniform class ties): helper does NOT advance to public exposure until a separating corpus exists (multi-sentence lie/truth slots, mixed source classes). Deferred permanently per rule: cross-job memory, dependsOn edges (no multi-hop failures observed), conflicts-edges beyond detectConflicts.

Bench totals at Phase 9 close: 63 gates PASS / 0 FAIL (3 v5 ablation SKIP = honest). Full suite 3212/0 fail. Typecheck 0.

## END-OF-ROADMAP REVIEW LOOP (closed 2026-09-15 — CLEAN)

Whole-diff attack loop, 3 rounds, 4 fresh-context reviewers per round (correctness/cross-phase, security/injection, contract/cross-repo-parity, determinism/state-honesty), each briefed to disprove and hunt new findings, not confirm fixes.

Round 1: BLOCK — 12 P1s + 1 P0 (unfenced repair/leaf/gap prompts, warning sanitize bypass, phantom searches, journal order/skew/zero-counts, dedup linkage loss, host outputSchema parity, TTL 3-arg, seam options). Fixed by 4 concurrent file-disjoint workers.
Round 2: BLOCK — 9 P1s + 1 P0 (deadline debt swallowed, leaf prompt still unfenced, snapshot pollution via merge markers, unbounded unions, arrival-order leaks, cap-blocks-dedup, orphan undercount, seam options). Fixed by 3 workers + 1 follow-up.
Round 3: 3 CLEAN/OK + determinism P1 → micro-fix round (sort-then-slice, mergedCount subtraction, RRF tiebreak, strip-list doc) → final targeted sign-off: **CLEAN, no issues found**.

Final state: typecheck 0 both repos; Pi-Atlas agent tests 346/346, full suite 3,244/0 fail (3,255 total); bench 63 gates PASS / 0 FAIL / 3 honest ablation SKIPs, byte-identical across runs minus documented volatile fields; pi-subagents affected suites green, wire parity byte-identical.

## JOURNAL FIDELITY CLOSE-OUT (2026-09-15)

Real ids/counts flow core→jobs via AgentProgressDetail (planQuestionIds, admittedEvidence detail with hashes/fingerprints, evaluation counts). PlanAccepted carries real q- ids (synthetic fallback only for foreign producers); EvaluationAccepted real counts with legacy fallback; EvidenceAdmitted now live (per-batch, real ev- ids, hashes, fingerprints). Fidelity reviewer: OK with notes (no content leak, snapshot bytes unchanged, no P0/P1; 4 P2 notes — dead admittedEvidenceIds payload, mixed-journal union edge only reachable by foreign producers, merge-linkage questionIds not journaled, silent per-event drop — all documented code comments / follow-up-grade). Security sweep: CLEAN — all 7 prompt surfaces fenced, event payloads byte-capped + validated, detail ids/hashes only.

Final supervisor verification: agent suites 349/349 (fidelity files 111/111), full suite 3,247/0 fail (3,258 total), bench 63 PASS / 0 FAIL, identical-deps determinism probe byte-identical.

## Execution protocol

Long-running orchestration; compaction carries continuity via this doc + ADR + todos. Parent orchestrates; workers implement; researcher/scout/reviewer per phase as needed. One writer at a time on agent module files. Each phase: design first (durable doc update), then implement, then eval-gate before next phase.
