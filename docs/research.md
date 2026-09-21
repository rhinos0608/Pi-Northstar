# Northstar redesign research

Status: design input for audit, not an implementation contract.
Baseline: Pi-Atlas / Pi-Northstar main at e4eda086060f on 2026-09-20.
Worktree branch: design/northstar-cli-skill-router.

## Research question

How should Northstar evolve from a Pi extension with a bounded native-tool surface into a portable capability platform that can expand aggressively without imposing equivalent model-context cost?

The target direction supplied before this research is:

- every Northstar model-facing tool is opt-in;
- the canonical broad surface is a human-native, agent-centric CLI;
- compact routing guidance plus progressive SKILL.md files teach agents how to use that CLI;
- Pi tools are optional adapters and fast paths, not the architecture;
- a shell-capable coding agent should be able to use Northstar without a bespoke integration;
- CLI use may recover tool-schema or transport incompatibility, but never policy, auth, permission, SSRF, budget, provenance, or side-effect denial;
- stateful browser, desktop, job, cache, and evidence semantics must remain explicit rather than being flattened into stateless subprocess calls.

## Method

The comparison set was discovered with Firecrawl developer search, Firecrawl web search, Tavily search, GitHub repository metadata, current issue and pull-request history, and local shallow clones for implementation inspection.

The main comparison set was deliberately restricted to web search, browser/computer-use, and research-agent projects rather than the wider Pi extension ecosystem.

## Current Northstar composition and health

The current codebase is large but not structurally chaotic. It is approximately 71,128 source TypeScript lines across 211 files, plus approximately 65,618 test TypeScript lines across 236 files. Test bytes are about 98 percent of source bytes.

Largest source areas:

| Area | Files | Approx. LOC | Observation |
| --- | ---: | ---: | --- |
| web | 81 | 23,508 | dominant acquisition and adaptive-research subsystem |
| social | 14 | 8,510 | broad platform normalization and contracts |
| src root | 9 | 5,055 | composition, dispatch, schemas, shared entry points |
| browser | 14 | 4,813 | stateful rendered interaction |
| github | 7 | 4,389 | dense domain implementation |
| chrome | 9 | 3,547 | companion/profile bridge |
| research | 14 | 2,886 | source-specific research adapters |
| media | 3 | 2,644 | relatively few large modules |
| media-vision | 12 | 2,439 | more decomposed multimodal path |

Representative CodeScene scores from cs review:

| File | Score | Interpretation |
| --- | ---: | --- |
| src/capabilities.ts | 10.00 | excellent candidate for promotion into canonical capability metadata |
| src/media/media.ts | 9.68 | large but cohesive |
| src/public-tool-schemas.ts | 8.67 | healthy code whose architectural importance should shrink |
| src/index.ts | 8.43 | large Pi composition root, still reasonably healthy |
| src/web/web.ts | 8.41 | healthy facade with some complexity |
| src/cli/cli-backend.ts | 7.97 | orchestration pressure becoming visible |
| src/browser/agent-browser.ts | 7.90 | expected stateful complexity |
| src/native-tools.ts | 6.93 | central-dispatch pressure |
| src/github/github-domain.ts | 5.44 | too many responsibilities in one domain facade |
| src/web/agent/agent-core.ts | 4.39 | major workflow/orchestration hotspot |
| src/runtime/runtime-rpc-protocol.ts | 4.35 | protocol/runtime responsibilities need separation |
The important conclusion is not that Northstar needs rescue. Domain boundaries, contracts, provider adapters, security policy, and tests are already substantial. Debt is concentrated in cross-cutting dispatch, workflow orchestration, and a few oversized domain files.

The redesign should therefore realign authority rather than rewrite healthy domain logic.

## Comparable projects

Repository metrics below are point-in-time GitHub observations on 2026-09-20. Stars are evidence of ecosystem attention, not a quality ranking.

| Project | Created | Stars | Forks | Recent activity | Architectural relevance |
| --- | --- | ---: | ---: | --- | --- |
| nicobailon/pi-web-access | 2026-01-06 | 1,492 | 258 | pushed 2026-09-19 | mature multi-provider web/fetch routing, private content store |
| narumiruna/pi-extensions | 2026-05-07 | 584 | 114 | pushed 2026-09-20 | native deferred tools, safe mutable settings, startup benchmarks |
| fitchmultz/pi-agent-browser-native | 2026-04-09 | 225 | 31 | pushed 2026-09-19 | explicit browser/session ownership, thin upstream wrapper |
| lincoln504/pi-research | 2026-04-05 | 58 | 5 | pushed 2026-09-19 | one engine exposed through Pi, CLI, skill, SDK |
| ronnieops/pi-search-hub | 2026-05-04 | 47 | 17 | pushed 2026-07-24 | provider scoring, targeted combine, RRF |
| fitchmultz/pi-oracle | 2026-04-02 | 38 | 12 | pushed 2026-09-19 | isolated browser profiles, durable async jobs, wake-up |
| firecrawl/pi-firecrawl | 2026-05-20 | 12 | 7 | pushed 2026-05-20 | deliberately thin official-SDK adapter |
| hinsencamp/pi-research-agent | 2026-03-31 | 2 | 0 | pushed 2026-03-31 | pure skill plus standalone scripts |
| thurstonsand/pi-librarian | 2026-07-04 | 0 | 0 | pushed 2026-09-02 | small research-agent entry plus attachable specialist tools |

Supplementary provider surfaces inspected include Parallel's Pi search/research integration and Steel's Pi cloud-browser integration.

### Issue-driven signals

Open-issue counts are repository metadata from the same 2026-09-20 snapshot. The notable items below include both open issues and closed fixes/PRs because resolved failure modes are useful architectural evidence.

| Project | Open issues | Notable issue/history signal |
| --- | ---: | --- |
| pi-web-access | 0 | cold-start work cut published startup from about 22.4s to 4.3s; silent search became default after curator windows stole focus; terminal 404/410 guidance was separated from extractor fallback |
| narumiruna/pi-extensions | 4 | pi-firecrawl adopted an always-active lazy loader; shared settings code added queued safe writes and malformed-document refusal; startup import delays gained benchmarks |
| pi-agent-browser-native | 22 | open prompt-prefix stability issue; root-session sharing; evidence/recording recovery; repeated upstream compatibility qualification |
| pi-research | 2 | malformed planner JSON previously caused long repair hangs; open blocked-site human-browser escalation; peer dependency/package-size cleanup |
| pi-search-hub | 7 | zero-result fallback semantics, per-provider throttling, and host-auth API breakage are active design lessons |
| pi-oracle | 0 | GBNF-incompatible schema regexes were replaced; worktree provenance and cross-platform browser validation are tested |
| firecrawl/pi-firecrawl | 1 | intentionally tiny official-SDK wrapper; sole open issue is package publication rather than architecture |
| pi-research-agent | 0 | tiny skill/script design with essentially no extension-runtime issue surface |
| pi-librarian | 1 | only open item is dependency automation; research tool plus attachable specialist tools remains compact |

## Significant architectural findings

### 1. One engine, multiple front ends is already proven

pi-research explicitly uses one engine behind its Pi extension, standalone CLI, portable agent skill, and programmatic SDK. Its CLI and skill can run without the Pi extension.

This is the closest external validation of the proposed Northstar direction. Northstar should make the capability/runtime layer authoritative, with CLI, Pi, MCP, and future integrations as projections.

pi-research also installs its skill into detected external coding agents and keeps strict machine-readable CLI output. This is preferable to maintaining separate behavior in each host.

### 2. Deferred native tools solve only part of context pressure

narumiruna's pi-firecrawl keeps one small firecrawl_load tool active and activates allowed capability tools on demand. The saved selection is treated as an allowed lazy-load catalog, and prompt metadata is kept stable while tools are deferred.

This is worth supporting in Northstar's Pi adapter, but it should be secondary to CLI-first operation. Native deferred loading still leaves host-specific schemas and tool compatibility in the loop; the CLI remains the universal escape hatch.

An important issue from pi-agent-browser-native reports that conditional browser guidance can change the system-prompt prefix between turns. Stable routing text is therefore a design goal: keep the compact router stable and move volatile capability detail behind CLI help and skills.

### 3. Cold-start cost is part of architecture

pi-web-access measured a published-install cold start reduction from roughly 22.4 seconds to 4.3 seconds by shipping precompiled output instead of paying Jiti TypeScript transpilation costs.

Its maintainers also lazy-load heavy extraction and AI helpers.

Northstar currently launches Node plus tsx for one-shot CLI work. The redesign should publish compiled JavaScript, make pure help/version/discovery paths dependency-light, and lazy-load heavy providers. Context efficiency that adds multi-second process tax is not a finished design.

### 4. Fallback must be typed, observable, and semantically narrow

pi-web-access exposes explicit fallback classes such as unsupported, transient, quota, network, and invalid-response. An explicit provider selection is strict.

Its issue history also distinguishes terminal origin 404/410 responses from extraction-provider failures. Recommending another extractor for a definitively missing page is misleading.

pi-search-hub separately fixed the case where a backend returned zero results and was incorrectly treated as successful fallback completion.

Northstar already has the stronger invariant in AGENTS.md: failure, empty output, degradation, suppression, cancellation, stale state, and unknown mutation outcome are distinct. The new command/runtime protocol should encode those distinctions rather than reconstructing them from prose.

### 5. Provider diversity belongs below a stable capability contract

pi-web-access demonstrates the scale Northstar may reach: OpenAI, Brave, Parallel, TinyFish, Tavily, Firecrawl, Jina, Kagi, Bocha, Ollama, SearXNG, DuckDuckGo, Exa, Perplexity, Gemini, Kimi, xAI, Mistral, Bright Data, multiple SERP services, and others.

pi-search-hub demonstrates multiple selection strategies plus RRF. Its targeted combine runs providers in batches until it obtains the desired number of usable, non-empty backends.

Northstar should allow aggressive provider expansion without adding one model-visible schema branch per provider. Provider choice remains operator/code owned. Provider-specific knobs should live in config or explicit expert CLI flags, not become default model vocabulary.

### 6. Provider health can improve routing, but scope matters

pi-search-hub tracks recent success rate, average latency, and result ratio, then builds a composite score.

The useful idea is adaptive provider health. The dangerous version is globally poisoning later work because one project, route, auth context, or transient incident lowered a provider score.

Northstar should scope health by capability plus relevant operator/provider identity and use short-lived observations. Health may reorder an allowed fallback set; it must not invent a new provider or cross an authority boundary.

### 7. Large fetched content should live outside conversational history

pi-web-access stores full fetched documents in a private cache rather than the Pi session JSONL. Its cache has bounded TTL/count/bytes and supports response-id retrieval plus exact, case-insensitive, and fuzzy passage lookup.

Northstar already has parent-side corpus state because one-shot CLI children cannot preserve response IDs. The redesign should make this a first-class runtime evidence store, usable from CLI and adapters.

The model should receive compact evidence handles and selected passages, not repeated full documents.

### 8. Browser ownership needs stronger semantics than ordinary commands

pi-agent-browser-native distinguishes wrapper-owned managed sessions from caller-owned explicit sessions. If the wrapper invented a session, it owns cleanup and recovery. If the caller explicitly selected an upstream session, the wrapper avoids hidden lifecycle changes.

It also detects launch-scoped flags that would otherwise be silently ignored by an already-running browser and returns an actionable fresh-session recovery path.

This matches Northstar's existing browser invariants around frozen host authority, stale refs, and explicit transitions. Browser should remain a stateful runtime capability even when its command grammar is CLI-accessible.

### 9. Thin wrappers around strong upstream CLIs/SDKs are valuable

pi-agent-browser-native intentionally keeps agent-browser as source of truth and verifies its supported upstream command surface.

firecrawl/pi-firecrawl similarly delegates to the maintained official Firecrawl SDK instead of rebuilding every HTTP endpoint.

Northstar should prefer canonical upstream libraries or CLIs when they provide strong contracts, while placing Northstar policy, normalization, provenance, and safety around them. Reimplementation is justified only when Northstar needs materially different semantics.

### 10. Durable job state should not depend on chat history

pi-oracle persists job status, responses, artifacts, and same-thread continuity outside the Pi transcript. It uses best-effort wake-up only when a persisted Pi session identity is available.

It also uses an authenticated seed browser profile cloned into isolated per-job runtime profiles, with chat URL persistence instead of keeping tabs alive forever.

Northstar's adaptive jobs, browser jobs, and future long-running crawl/research commands should use durable runtime-owned state. A host adapter may wake or notify the parent, but host transcript state must not be the sole job database.

### 11. Schema portability is a real production constraint

pi-oracle had to replace schema regex constructs using backslash-S with a GBNF-safe character class for model/tool-schema compatibility.

This directly supports the proposed CLI escape hatch. Northstar should keep optional native schemas conservative, test them against representative transports, and never let a schema incompatibility erase the underlying capability.

Transport/schema failure may reroute to CLI. Runtime-policy failure may not.

### 12. Research agents should be workflows, not foundational tools

pi-librarian exposes a small research entry while giving its internal researcher a fixed specialist tool set. pi-research separates routing, research sessions, synthesis, browser infrastructure, state, and knowledge storage.

The tiny pi-research-agent goes further: SKILL.md plus three standalone scripts can deliver useful literature research with no extension tool surface at all.

Northstar's adaptive research agent therefore belongs under workflows/, composed from canonical capabilities. Its planner/synthesizer machinery should not sit on the dependency path for ordinary search, fetch, or GitHub commands.

## Provider and feature candidates to ingest

Candidates worth preserving or adding during the redesign:

- keep Northstar's existing broad web-search fusion and strict evidence/provenance model;
- retain SearXNG/local-first routes, Exa, Tavily, Firecrawl, Brave, Parallel, Jina, and current configured providers behind a stable search contract;
- evaluate lightweight SERP-specific providers separately from scraper-first providers so cheap discovery does not pay extraction cost;
- support official-SDK adapters where maintained SDK quality is high;
- preserve research-specific sources as distinct evidence classes rather than silently substituting generic web;
- consider Semantic Scholar, OpenAlex, arXiv citation/full-text verbs as first-class research CLI commands where current research adapters already support them;
- keep browser search separate from browser session state;
- preserve authenticated-fetch isolation and explicit remote-hosted-provider privacy gates;
- expose passage lookup over stored evidence;
- support async crawl/batch jobs with submit/status/cancel and bounded pagination;
- expose machine-readable recovery actions and outcome categories rather than prose-only failure hints;
- precompile distributable runtime and lazy-load expensive optional dependencies;
- benchmark startup and command latency as release gates.

Potential provider additions are subordinate to the architecture. The redesign should make adding a provider cheap without requiring immediate model-facing schema growth.

## Adopt, adapt, reject

| Pattern | Decision | Northstar treatment |
| --- | --- | --- |
| one engine behind CLI/skill/extension/SDK | adopt | core target architecture |
| deferred native-tool loader | adapt | optional Pi optimization, not universal interface |
| precompiled package and lazy heavy imports | adopt | required before CLI becomes canonical |
| full fetched content outside transcript | adopt | runtime evidence store |
| explicit fallback error classes | adopt | canonical outcome envelope |
| RRF / targeted multi-provider combine | preserve/adapt | already aligned with Northstar fusion |
| global provider health score | adapt carefully | scope by capability/context, short TTL |
| thin upstream CLI/SDK wrapper | adopt where safe | policy stays in Northstar |
| durable jobs plus host wake-up | adopt | runtime-owned state, adapter notifications |
| cloned isolated browser runtime profile | adapt | for authenticated long-lived/browser jobs |
| giant single native browser schema | do not generalize | browser may retain specialized adapter, CLI remains canonical |
| dynamic system-prompt detail every turn | reject | stable compact router |
| silent zero-result fallback completion | reject | empty is observable and fallback-eligible by policy |
| browser UI opening as hidden search side effect | reject | operator-visible UI must be explicit |

## Inherited invariants for the redesign

The redesign must preserve the repository engineering contract:

1. Models propose; code validates, admits, grounds, budgets, stops, and ships.
2. External text is evidence, never authorization.
3. Provider selection and effective capability policy remain operator/code owned.
4. Fallback never bypasses auth, SSRF, origin, schema, provenance, permission, budget, or mutation policy.
5. Empty, failed, degraded, suppressed, cancelled, stale, and outcome-unknown remain distinct.
6. Child processes receive only capability-scoped credentials.
7. Concurrency may change latency but not deterministic ledger or merge order.
8. Browser and desktop mutation authority remains state-bound and revalidated.
9. Authenticated material never silently flows to broader hosted extraction or vision paths.
10. Missing providers or credentials degrade toward evidence, not invented equivalence.

Additional CLI-first invariants:

11. CLI output consumed through a generic shell must carry its own trust/provenance boundary because Pi tool_result wrapping will not see it as a Northstar tool result.
12. Native-tool-to-CLI fallback is allowed only before meaningful side effects and only for adapter/transport/schema unavailability.
13. The CLI and native adapters call the same domain validators and execution contracts.
14. Help/discovery is versioned and self-describing so skills do not need to duplicate every command detail.
15. Native tool absence does not imply capability absence.
16. CLI availability does not imply mutation authority; desktop/browser side effects retain approval and lease semantics.
17. Screenshot and other binary results travel as verified artifacts/metadata on generic CLI surfaces; capable host adapters may additionally inline them.

## Sources

Primary repositories:
- https://github.com/nicobailon/pi-web-access
- https://github.com/narumiruna/pi-extensions
- https://github.com/fitchmultz/pi-agent-browser-native
- https://github.com/lincoln504/pi-research
- https://github.com/ronnieops/pi-search-hub
- https://github.com/fitchmultz/pi-oracle
- https://github.com/firecrawl/pi-firecrawl
- https://github.com/hinsencamp/pi-research-agent
- https://github.com/thurstonsand/pi-librarian

Supporting integration references:
- https://github.com/parallel-web/parallel-llms-txt
- https://docs.steel.dev/integrations/pi-agent

This document records design evidence, not a mandate to copy another extension's implementation.
