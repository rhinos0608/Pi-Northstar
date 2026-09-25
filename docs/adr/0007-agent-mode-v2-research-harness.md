# ADR 0007: Agent Mode v2 — deterministic research harness, evidence-first

## Status

Accepted, **amended 2026-09-15 (Revision 2)** — see `docs/plans/2026-09-15-agent-mode-v2-roadmap.md` "Revision 2" for binding corrections: claim/evidence/report IR as the center of the system, strengthened evidence schema (locators, source class, corroboration fingerprints, lifecycle≠stance), stable internal IDs vs edge-rendered src-N, verification authority rules (source_check never a second truth system), effective-capability resolver, deadline/AbortSignal moved into the adaptive-loop phase, formal question completion model (code-promoted grounded), semantic evidence growth, research debt, shadow mode until IR renderer lands, source compiler for the 20-source contract cap, and eval-gate hardening before Phase 1 (metrics must measure support, not structure).

Accepted — adaptive-research direction, 2026-09-15.
Implementation roadmap: `docs/plans/2026-09-15-agent-mode-v2-roadmap.md`.
Baseline at commit `026c24fc03a0229d7525b441a21e795763846681`: typecheck green, focused Agent tests 40/40, suite 2,932 pass / 11 skipped / 0 fail (~47s). This suite is the compatibility floor for all phases.

## Decision

Agent Mode v2 keeps the existing outer contract (`mode:"agent"` → `agent_job` → `agent`, registry, TTL/ownership, canonical JSON, fail-closed RPC, provenance redaction) unchanged, and replaces the machinery behind `AgentResultV1` with a deterministic research harness with an LLM steering wheel.

Spine: **PLAN → GATHER → EVALUATE → REFINE → SYNTHESIZE** (+ VERIFY in Phase 4). The controller is a small state machine; models propose, deterministic code validates and executes; stopping is a hard policy, never a model opinion.

### Load-bearing invariants

1. **Only locally admitted source material can support final factual output.** Provider/report prose never becomes authoritative evidence; a provider-suggested URL must be fetched through Northstar before its content can be admitted.
2. **Evidence-first:** research state is an explicit ledger (`AgentEvidence`: sourceId, canonicalUrl, chunk excerpt + hash, questionIds, round, status, derived corroboratingSourceIds) — not page blobs. No free-form model-assigned confidence in v1–v4; derived confidence only at Phase 9 behind an ablation gate.
3. **reportText and claims share one evidence basis** (Phase 3): claims reference internal evidence IDs mapped to public source IDs; report prose carries deterministic inline citations. The current asymmetry (claims strictly grounded, reportText permissive) is a bug class, not a feature.
4. **Evaluator proposes, code executes.** Evaluator output is a strict schema (`questionUpdates/gaps/conflicts/nextQueries/shouldContinue`); code rejects unknown evidence/question IDs, bounds and dedups next queries, enforces budgets. Evaluator context economy follows pi-research's digest pattern: fresh evidence full once, prior rounds as compact digests.
5. **Stopping is deterministic:** all required questions grounded OR deadline OR budget exhausted OR two consecutive rounds with zero admissible evidence growth OR no non-duplicate next query remains. Evaluator `shouldContinue` is advisory.
6. **Reuse Northstar primitives, never a second stack:** existing `chunkText()`, BM25/vector/RRF, bounded content store (128 entries/128 MiB/1h TTL), URL normalizer, cached `source_check` (verification ladder rung 2), WebSearchLedger normalization/dedup concepts (re-instantiated per job, not coupled to the session ledger), hardened GitHub acquisition.

### Reference provenance

Methodologies studied (researcher maps, 2026-09-15, full findings in roadmap doc):

- [antins-labs/SearchOS](https://github.com/antins-labs/SearchOS) — state-as-system-asset (frontier/evidence/coverage/strategy/budget in one source of truth), coverage-driven dispatch, deterministic stall sensors. Adapted: tiny question set + evidence ledger + gap/conflict + budget inside one controller. **Not** imported: agent hierarchy, DAG scheduler, sensor framework, skill sandbox.
- [Lincoln504/pi-research](https://github.com/Lincoln504/pi-research) — evaluator/synthesizer split with digest-only routing, deterministic citation rebuild + provenance redaction, grounding gate with partial salvage. **Not** imported: researcher fanout, browser pool, LanceDB store.
- [steel-experiments/durable-researcher](https://github.com/steel-experiments/durable-researcher) — derived confidence, post-report verifier with bounded rewrite + best-version restore, ledger-first gating. **Not** imported: Postgres/Absurd, campaign machinery, transcript-replay (Northstar has typed operations, not a conversational loop; Phase 7 uses typed events instead).

No code is vendored from any reference.

### Gather verticals (Phase 8)

Routing uses the availability-gated real toolset, consulted from `src/capabilities.ts:CHANNEL_CAPABILITIES` — web search (plain/batch/agent + research academic category), fetch (dig + cached claim verification), media video vertical (youtube Data API/oEmbed/transcript, bilibili CLI/subtitles), social vertical (twitter, reddit, xiaohongshu, v2ex, etc. — community sentiment/knowledge, threads + comments, lower authority tier by default), kg (Diffbot, token-gated) and graph (DQL/SPARQL, operator-configured) for entity/ontology probing on deep queries only. Semantic ranking = Northstar hybrid retrieval (BM25+vector+RRF) over fetched chunks, internal. A route missing its availability gate degrades to web search; it never fails the job. Planner proposes actions only within the gated union; code routes and validates.

### Sequencing rationale

Grounded synthesis (Phase 3) precedes concurrency (Phase 5) and durability (Phase 7). Scheduling was not the primary correctness hole; the reportText/claims/evidence relationship was. Durability as typed event journal (not transcript replay) is Phase 7 and only where product requires it.

## Consequences

Agent Mode becomes adaptive (decompose → gather → evaluate → refine) while all mutation stays in deterministic code. Benchmarks (Phase 0) measure utility — supported-claim rate, fact coverage, unsupported-prose count, recovery-after-bad-search — not agentness. Concurrency, lifecycle splitting, durability, and specialist lanes each earn entry by passing the prior phase's eval gate.

## Residual risks

- Evaluator/planner quality depends on the structured utility-model seam; fail-closed behavior on schema violations must not become silent degradation (planned fallback = deterministic continue-on-gap policy, not invented coverage).
- Digests compress prior rounds; information lost in a digest cannot resurface in later evaluation. Mitigation: digests carry gaps/conflicts verbatim, capped.
- Heuristic `source_check` (rung 2) can pass weak support; semantic rung is gated to high-value claims to bound cost.
- Phase 9 additions (confidence, conflict edges, dependencies, cross-job memory) may be requested ad hoc before ablation evidence exists; this ADR is the gate to cite when deferring.

## Verification

- Per-phase exit gates defined in the roadmap doc; Phase 0 eval corpus must reproduce v1 measurements before any core change.
- Full suite floor: 2,932 passing maintained each phase.
