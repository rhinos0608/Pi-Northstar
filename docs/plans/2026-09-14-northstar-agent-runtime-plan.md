# Plan C — Agent Runtime, Jobs, Poll

> **For agentic workers:** Implement task-by-task. Own only listed files. Merges atomically with Plan A (Gate 2). `src/index.ts` ownership: poll-add lines only (A owns removal). No commits.

**Goal:** Deterministic shell/adaptive agent core, parent-owned async jobs, byte-stable poll tool in the freed ninth slot.

## Task C1: Agent contract
**Outcome:** `AgentResultV1`, `AgentJobV1`, evidence budgets, citation/document/lexical contracts exist.

**Files:**
- Create: `src/web/agent/agent-contract.ts` (citation contract: every claim cites sourceIds; document contract: derived docs carry sourceKind+locator+warnings; **lexical contract: BM25 pass over `src/search/bm25.ts`**; byte-stable serialization rule: canonical JSON, identical bytes for identical job state)
- Create: `test/web/agent/agent-contract.test.ts`

**Budgets (proposed defaults, need approval — not decided):** report text 50k UTF-8 bytes, sources ≤20, local route 30 sources / 8 fetch rounds, operator-lower-only after approval. Tests read these from the contract module so approval renames/renumbers touch one file.

**Checks:**
- `node --import tsx --test test/web/agent/agent-contract.test.ts`

## Task C2: Agent core (deterministic shell/adaptive)
**Outcome:** Loop over existing search + fetch + `src/search/fusion.ts` ranking; provider/model opacity (provenance internal only, never model-visible).

**Files:**
- Create: `src/web/agent/agent-core.ts` (implements Plan A `agent-job-seam.ts` interface)
- Create: `test/web/agent/agent-core.test.ts` (mocked search/fetch; provenance redaction asserted)

**Checks:**
- `node --import tsx --test test/web/agent/agent-core.test.ts`

## Task C3: Jobs registry + report routes
**Outcome:** In-memory parent-owned jobs bound to Plan B owner model; opaque Tavily route isolated from measured local route.

**Files:**
- Create: `src/web/agent/agent-jobs.ts` (expiry; only unexpired jobs activate poll; owner-bound entries per B1)
- Create: `src/web/agent/agent-report-route.ts` (opaque Tavily report wrapping `src/web/web-agent-report.ts`; per S2 default Tavily stays synchronous-inside-job, poll serves snapshot)
- Modify: `src/web/web-search-route.ts` (agent branch constructs via seam → jobs registry)
- Create: `test/web/agent/agent-jobs.test.ts`, `test/web/agent/agent-poll-byte-stability.test.ts` (identical bytes across polls for identical state)

**Checks:**
- `node --import tsx --test test/web/agent/`

## Task C4: Poll registration (ninth slot)
**Outcome:** Startup-registered poll tool active only while an unexpired job exists.

**Files:**
- Modify: `src/index.ts` (poll-add lines only; proposed name `agent_poll` — needs approval; execute rejects closed with static pointer when no unexpired job, never lists, never leaks other owners' jobs)
- Modify: `test/index.test.ts` (9-tool budget gate via `assertPublicToolBudget`, no fixed-length assertion)

**Checks:**
- `node --import tsx --test test/index.test.ts test/web/agent/`

## Task C5: RPC capability negotiation (fail-closed)
**Outcome:** pi-subagents runtime RPC negotiated per S3 findings; absent RPC → fail-closed no-op capability record, core runs standalone (negotiation attempted and recorded, not silently skipped).

**Files:**
- Create: `src/web/agent/agent-rpc.ts`
- Create: `test/web/agent/agent-rpc.test.ts` (no-RPC path asserts recorded `negotiated:false` + standalone execution)

**Checks:**
- `node --import tsx --test test/web/agent/agent-rpc.test.ts`

## Negative security tests (this plan)
- Prompt-injection framing on agent inputs/outputs; telemetry redaction (no provider/model/secrets); foreign-owner job access rejected.

## Known unknowns / defaults / pivots
- S2 Tavily async: default sync-inside-job. Pivot: async API exists → report route polls Tavily job, byte-stable snapshot still served.
- S3 RPC: default fail-closed standalone. Pivot: handshake exists → full negotiation.
