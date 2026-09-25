# Northstar Master Sequencing Plan (2026-09-14)

> **For agentic workers:** Plans only. No production/test/config/README edits, no commits. Each plan owns listed files exclusively. House format follows `docs/plans/2026-09-13-contract-ledger-graph-adapters-implementation-plan.md` (per-task Files/Interfaces/Checks).

**Goal:** Land approved clean-break Northstar work as five focused, independently testable plans with explicit gates.

**Inherited decisions (contract):**
- Clean break. No compatibility adapters, aliases, deprecation branches, mode/action discriminants. No public `media` tool. `src/media/*` stays as internal acquisition.
- Nine-tool budget is a cap (`src/capabilities.ts:21` `MAX_PUBLIC_TOOLS = 9`), not a current count. `PublicToolName` (`src/capabilities.ts:17`) today lists 7 names (`web_search,github,social,media,browser,kg,graph` — missing only `fetch`/`desktop`); registration is conditional (`src/index.ts` diffbot/graphSparql/browser/desktop gates). Freed media slot funds startup-registered poll active only while an unexpired agent job exists.
- Preserve good primitives: `src/search/{bm25,chunker,fusion,vector-index}.ts`, SSRF `src/network-policy.ts`, untrusted framing `src/core/untrusted-content.ts`, unpdf, per-URL isolation, ledger, reject-not-clamp, `buildPythonChildEnvironment()` for Python children.
- Hard ceilings operator-lower-only: image 20MiB/40MP; PDF 25MiB/100pp; video 250MiB/120min/12 keyframes; aggregate 512MiB/fetch; 250k tokens/asset + 1M aggregate preflight only where an authoritative counter exists. Arbitrary OpenAI-compatible endpoints must not claim preflight token enforcement.
- Provider/model identity never model-visible. Policy/auth failure never broadens eligibility.

## Current-state anchors (verified)
- Fetch router mode-discriminated in `src/web/web-fetch-route.ts:81-124`; `buildSemanticSource` at `:342`; re-exported `src/index.ts:883`. Native dispatch `semantic_crawl`/`agentic_browse` in `src/native-tools.ts:70-98`.
- Search router is `buildSearchRoute` in `src/web/web-search-route.ts:189` (public); `buildCanonicalSearchRoute` at `:163` is internal. No `agent` symbol exists.
- Content store is a process-global singleton `Map` in `src/web/access/web-access-content-store.ts:73-76` with `get(responseId)` / `put(entry)` and no owner param.
- GitHub is REST-only single `github-api` backend (`src/github/github-contract.ts:829-842`, `src/github/github-domain.ts:33-34`); fetch via `githubFetch` `:188-201`; `decodeFilePayload` `:304-315` decodes base64 then caps, no pre-decode byte gate, no binary sniff.
- Agent report is sync Tavily SSE (`src/web/web-agent-report.ts:26-37`, `src/web/providers/web-tavily.ts:41-43`); no jobs/poll.
- `SEARCH_CATEGORY_NAMES` (`src/web/web-contract.ts:113-124`) has no `'video'`. CLI env in `src/cli/cli-backend.ts:261` forwards bridge token + PI vars (not reusable for git/ffmpeg children).
- `@google/genai` lock entry is nested under `node_modules/@earendil-works/pi-coding-agent` (`dev:true`), not a root direct dep; hoisting unproven. `unpdf ^1.8.1` present.

## Dependency graph and gates
- [ ] Gate 0 (spikes S1–S4, throwaway probe scripts, not committed): S1 genai 1.52.0 API + token-count + Vertex ADC shape vs official docs; S2 Tavily async/job surface (pivot: none → job wraps sync stream, poll serves byte-stable snapshot); S3 pi-subagents RPC handshake (pivot: none → fail-closed no-op capability record, core runs standalone); S4 ffmpeg presence + transcript sources in `src/media/media.ts` (pivot: none → metadata+transcript only with warnings).
- [ ] Gate 1: shared seams land first — asset/budget/retention contracts (Plan B) + transfer-policy flag (Plan D Task D5 only, lands at Gate 1 ahead of rest of Plan D) + agent-job seam interface (Plan A §seam). Plans C/D-remainder/E build on these; E is not independent.
- [ ] Gate 2 (atomic merge train A+C): Plan A (clean-break contract + job seam) and Plan C (agent runtime) merge together; A alone must not leave a dead `agent_jobs_unavailable` throw on a green gate.
- [ ] Gate 3: Plan D remainder (Tasks D0–D4) green on top of Gate 2 (D5 already landed at Gate 1, exempt from Gate 2 prerequisite).
- [ ] Gate 4: Plan E (GitHub) green on top of Gates 1–2 (needs B ledger + D transfer flag).
- [ ] Every gate: `npm run typecheck` + full `npm test` green; `git status --short` shows plan-owned files only; no staged files left.

## Global constraints (all plans)
- [ ] No compatibility shims; delete removed routes outright including their tests.
- [ ] No Northstar monetary cost control — backend owns cost. Workers must not add spend caps, cost-metering, or cost-based rejects; byte/token admission ceilings above are safety bounds, not cost controls.
- [ ] Reject-not-clamp everywhere schema-visible; canonical UTF-8 byte accounting (`Buffer.byteLength`); replace `capped()` slicing with reject (see Plan A/E tasks).
- [ ] Every child process: fixed argv, `shell:false`, dedicated minimal env (never reuse CLI bridge-token env; `buildPythonChildEnvironment()` for Python only); sentinel leak tests at each spawn site.
- [ ] Negative security tests per plan (matrix in each plan file).
- [ ] `src/index.ts` split ownership: Plan A owns removal lines only; Plan C owns poll-add lines only; sequential merge, no parallel workers.

## Plan files
- [ ] `docs/plans/2026-09-14-northstar-contract-cutover-plan.md` (Plan A)
- [ ] `docs/plans/2026-09-14-northstar-asset-budget-retention-plan.md` (Plan B)
- [ ] `docs/plans/2026-09-14-northstar-agent-runtime-plan.md` (Plan C)
- [ ] `docs/plans/2026-09-14-northstar-multimodal-plan.md` (Plan D)
- [ ] `docs/plans/2026-09-14-northstar-github-acquisition-plan.md` (Plan E)

## Known unknowns (master-level defaults)
- Poll tool name: `agent` is a **proposed default needing approval**, not decided. Pivot: approver renames; seam interface isolates the name to one line.
- Evidence budgets (report chars, source counts, fetch rounds): all numbers in C/D are proposed defaults needing approval; operator-lower-only applies only after approval.
- Session/owner id source for store binding: decided in Plan B Task 1 before any consumer merges (per-entry owner, not per-store id).
