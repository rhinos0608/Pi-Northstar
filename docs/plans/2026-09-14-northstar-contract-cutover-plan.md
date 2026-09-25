# Plan A — Clean-Break Fetch / Media / Search Contract

> **For agentic workers:** Implement task-by-task. Own only listed files. Stop before crossing ownership. No commits. Merges atomically with Plan C (Gate 2); A alone never lands green with a dead agent route.

**Goal:** Mode-free 5-branch fetch union, public media removal, `category:'video'`, `mode:'agent'` routed to the agent-job seam (runtime lands in Plan C).

## Task A1: Fetch union + router rewrite
**Outcome:** Router accepts exactly the approved 5 branches, rejects legacy discriminants and filesystem paths.

**Files:**
- Modify: `src/web/web-fetch-route.ts`
- Modify: `src/web/web-contract.ts` (remove crawl/read inference `resolveWebActionForTool` query-path rule; keep reject-not-clamp)
- Create: `test/web/web-fetch-route-contract.test.ts`

**Interfaces (approved union, `additionalProperties:false` throughout):**
1. `{url, query?, topK?, maxChars?}` — single-URL query path, served by new `buildReadQueryFetchRoute` over `agentic_browse` read (not `semantic_crawl`, not `fetch` legacy read).
2. `{urls[1..8], query?, topK?, maxChars?}` — extends existing `buildMultiCrawlFetchRoute` (`:131`) shape; **no `maxPages`** on this branch.
3. `{url, siteMap:true, query?, maxPages?}` — unchanged sitemap branch.
4. `{responseId, sourceIds?, offset?, limit?, findText?}` — retrieve branch.
5. `{responseId, claims[1..20], sourceIds?}` — claim-check branch; rejects `offset`/`limit`/`findText` with explicit throw naming the offending field.
- Delete: `buildCrawlUrlFetchRoute` (`:98`), `buildCrawlSearchFetchRoute` (`:114`), `buildSemanticSource` (`:342`) + its re-export in `src/index.ts:883`.
- Reject: `mode`, `action`, `source`, `searchQuery`, `followLinks`, `maxDepth` (crawl depth dies with crawl branches), filesystem paths (HTTP(S)/GitHub asset URLs only).

**Checks:**
- Red/green: `node --import tsx --test test/web/web-fetch-route-contract.test.ts`
- Type: `npm run typecheck`

## Task A2: Schema cutover (`src/index.ts` removal half)
**Outcome:** Public fetch schema mirrors the router exactly; media tool registration deleted.

**Files:**
- Modify: `src/index.ts` (fetch schema `:393-401` → 5-branch union; delete media registration `registerExpansionTools` ~`:762-783` and `buildMediaRoute` export `:885-892`; update `promptGuidelines` strings referencing crawl/followLinks/search-backed crawl)
- Modify: `test/index.test.ts`, `test/contract.test.ts`

**Checks:**
- `node --import tsx --test test/index.test.ts test/contract.test.ts`
- Assert budget gate (`assertPublicToolBudget`) still passes; assert **no fixed-length** tool-count assertion (registration is conditional; count varies).

## Task A3: Capabilities + category vocabulary
**Outcome:** Registry reflects media-as-internal-acquisition; `'video'` exists as provider-neutral discovery category.

**Files:**
- Modify: `src/capabilities.ts` (re-mark `rss`/`youtube`/`bilibili` channels `publicTool` away from `'media'` to internal-acquisition; fix `PublicToolName` (`src/capabilities.ts:17`) — current 7-name union (`web_search,github,social,media,browser,kg,graph`) omits only `fetch`/`desktop`; final set is 8 (`web_search,fetch,github,social,kg,graph,browser,desktop`, `media` removed) + new poll = 9 within `MAX_PUBLIC_TOOLS`; do not assert fixed length)
- Modify: `src/web/web-contract.ts` (`SEARCH_CATEGORY_NAMES` + `'video'`, cap reuses `WEB_SEARCH_LIMIT_MAX=20`)
- Modify: `src/public-tool-schemas.ts` (category enum follows `SEARCH_CATEGORY_NAMES`)
- Modify: `test/capabilities.test.ts`, `test/web/web-contract.test.ts`, `test/public-tool-schemas.test.ts`

**Checks:**
- `node --import tsx --test test/capabilities.test.ts test/web/web-contract.test.ts test/public-tool-schemas.test.ts`

## Task A4: Native dispatch cleanup + claim-check preserved
**Outcome:** `semantic_crawl`/`agentic_browse` public dispatch removed; internal claim-check implementation kept.

**Files:**
- Modify: `src/native-tools.ts` (remove `semantic_crawl` `:93-94` and `agentic_browse` `:97-98` dispatch cases + `NativeToolName` `:70` entries)
- Modify: `test/web/access/web-access-cache-retrieve-source-check.test.ts` (**update to new union — old `mode`/`action` payloads must reject**, not stay green as-is)
- Convert: `test/media/*` to internal-acquisition tests (no public tool surface)

**Checks:**
- `node --import tsx --test test/web/access/web-access-cache-retrieve-source-check.test.ts test/native-tools.test.ts`

## Task A5: Agent-job seam (unblocks Plan C, satisfies atomic gate)
**Outcome:** `mode:'agent'` returns a job-pointer envelope defined by a seam interface; Plan C implements the runtime. No `agent_jobs_unavailable` throw ships on the green gate.

**Files:**
- Create: `src/web/agent/agent-job-seam.ts` (interface: `createAgentJob(params): AgentJobPointer`; `AgentJobPointer = { jobId: string }`)
- Modify: `src/web/web-search-route.ts` (`buildSearchRoute` `:189` routes `mode:'agent'` to seam; internal `buildCanonicalSearchRoute` `:163` untouched for non-agent paths)
- Modify: `src/web/web-agent-report.ts` (demote to internal provider; no direct route)
- Create: `test/web/web-search-agent-seam.test.ts` (asserts job-pointer shape, Tavily sync path not called inline)

**Checks:**
- `node --import tsx --test test/web/web-search-agent-seam.test.ts test/web/web-search-route.test.ts`

## Task A6: Truncation → reject (`capped` removal, fetch scope)
**Outcome:** Never truncate values merely to pass admission.

**Files:**
- Modify: `src/web/web-contract.ts` (`WEB_ENTITY_CONTENT_MAX`/`WEB_PAGE_CONTENT_MAX` length checks become reject with UTF-8 byte accounting), `src/native-fetch.ts` envelope paths
- Create: `test/web/web-admission-reject.test.ts`

**Checks:**
- `node --import tsx --test test/web/web-admission-reject.test.ts`

## Negative security tests (this plan)
- Redirect/token leakage on fetch acquisition paths; legacy `mode`/`action` payloads rejected; prompt-injection framing (`untrusted-content.ts`) on all new text surfaces.

## Known unknowns / defaults / pivots
- RSS/Atom reads move to fetch read branch (HTTP). Pivot: if `web-access-specialization.ts` lacks RSS handling → add internal RSS specialization, no new tool.
- Poll tool name `agent`: proposed default, needs approval; isolated to seam + Plan C registration.
