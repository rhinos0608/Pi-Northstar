# Pi‑Northstar

> **Give Pi a bounded path from question → evidence → action.**

Pi‑Northstar is a research and computer-use extension for Pi. It combines fused web search, exact-source research, evidence-first agent jobs, GitHub acquisition, social reads, knowledge graphs, browser automation, desktop control, and opt-in media/vision behind a deliberately small model-facing surface.

**Nine public tools maximum. Native Pi tools default to zero and require an operator-owned exact allowlist. Provider choice stays operator-owned. External content stays evidence, never authority.**

`Node 24+` · `MIT` · `Pi extension` · `zero-config web search`

## Why Northstar

| | What you get |
|---|---|
| **Search that can disagree with itself** | Multiple providers run concurrently and merge through deterministic reciprocal-rank fusion instead of pretending one backend is the internet. |
| **Research with source identity intact** | 12 exact academic/public-data sources, deterministic fanout, source-bound cursors, and no silent fallback to generic web. |
| **Agent research with a code-owned spine** | `PLAN → GATHER → EVALUATE → REFINE → SYNTHESIZE → VERIFY/REPAIR`, with models proposing and code deciding what is admissible, grounded, budgeted, and shippable. |
| **Automation with state, not vibes** | Browser refs and desktop observations expire; mutations revalidate state; unknown side-effect outcomes are not blindly retried. |
| **Graceful degradation** | Missing models, providers, credentials, or vision tiers move results toward admitted evidence rather than fabricated equivalence. |

## Quick start

### Install as a Pi package

```bash
pi install git:github.com/rhinos0608/Pi-Northstar
```

Try it for one session without installing:

```bash
pi -e git:github.com/rhinos0608/Pi-Northstar
```

### Clone manually

```bash
git clone https://github.com/rhinos0608/Pi-Northstar.git
cd Pi-Northstar
npm install
pi -e ./src/index.ts
```

Or add `./src/index.ts` as an extension in your Pi settings.

Pi‑Northstar requires **Node.js 24+**. `agent-browser` is optional, so a lean install can skip it:

```bash
npm install --omit=optional
```

Core search/fetch/GitHub/social paths still work. Browser registration requires an available `agent-browser` binary. Desktop is separate again: install Cua Driver `0.7.1` as `cua-driver` on `PATH`, then opt in with `PI_SEARCH_DESKTOP_AUTOMATION=1`.

Zero-config web search works through DuckDuckGo. API keys and local services add more providers, higher quotas, knowledge/graph access, authenticated platform reads, and multimodal processing.

## The public surface

Nine is a **hard ceiling**, not a promise that all nine tools are registered in every process. `kg`, `graph`, `browser`, and `desktop` depend on configuration or local capability.

| Tool | Role |
|---|---|
| `web_search` | Broad web discovery, exact-source research, batch search, or a parent-owned adaptive agent job. |
| `fetch` | Single/multi URL reads, sitemap discovery, cached corpus retrieval, and cached claim checks. |
| `github` | Read-only repository, file, tree, code/repo search, issues, pulls, releases, commits, workflows, and runs. |
| `social` | Canonical platform-native reads for X/Twitter, Reddit, V2EX, XiaoHongShu, Facebook, Instagram, and LinkedIn. |
| `kg` | Diffbot entity search/enhance/text analysis when `DIFFBOT_TOKEN` is configured. |
| `graph` | Native DQL and/or operator-configured SPARQL access without hidden web composition. |
| `browser` | Stateful live-page inspection and interaction via agent-browser or an explicitly authorized user-Chrome companion. |
| `desktop` | Opt-in native window observation and interaction via Cua Driver. |
| `agent_poll` | Reads the canonical snapshot of a job created by `web_search` with `mode:"agent"`. |

Native Pi tools are disabled by default, regardless of configured credentials. Set `PI_SEARCH_NATIVE_TOOLS` to a comma-separated exact list of canonical names (`web_search,fetch,github,social,kg,graph,browser,desktop,agent_poll`) to opt in. Unknown, legacy, internal, duplicate, or malformed names reject at startup. `media` is **not** a tenth model tool. It is an internal/CLI acquisition family used by fetch specialization and native dispatch for YouTube, Bilibili, RSS, and Atom.

### `web_search`

The public shape is intentionally small:

```text
{ query, ...filters }
{ queries: [1..8], ...filters }
{ query, mode: "agent", depth?: "balanced" | "deep" }
```

Plain search accepts `limit` 1–20. `category:"research"` accepts `limit` 1–30 and uses the exact research surface described below. Research cursors require one query and one exact source. Agent mode is single-query only and rejects constraints the job runtime cannot honor end to end, including `limit`, `category`, `yearFrom`, `recency`, and `domains`.

Provider selection is never a model argument. Operators own it through `PI_SEARCH_WEB_BACKENDS`.

### `fetch`

Fetch is a mode-free, presence-selected union. Legacy discriminants such as `mode`, `action`, `source`, `searchQuery`, `followLinks`, and `maxDepth` are rejected.

```text
{ url, query?, topK?, maxChars? }                  direct/read-query
{ urls: [1..8], query?, topK?, maxChars? }         ordered multi-read
{ url, siteMap: true, query?, maxPages? }          sitemap discovery
{ responseId, sourceIds?, offset?, limit?, ... }   cached retrieval
{ responseId, claims: [1..20], sourceIds? }        cached claim check
```

Cached `responseId` operations are **no-network operations** over captured corpus state. They do not silently reacquire mutable remote content.

Specialized readers win before generic page reading: GitHub assets, media URLs, feeds, PDFs, images, authenticated pages, then ordinary pages. The generic readable-page chain is native/Scrapling first, Diffbot Analyze only for eligible recoverable failures, then explicitly gated Firecrawl/Jina external processing.

Security and contract failures are terminal. Fallback can recover execution failure; it cannot route around SSRF, authentication, origin, or schema policy.

Current extraction extras include:

- Next.js RSC/flight rescue for thin `self.__next_f.push` pages.
- A bounded appendix for declared `api-catalog`, `describedby`, `service-desc`, `service-doc`, and `service-meta` links.
- Sniff-verified image MIME plus dimensions/pixels, with optional vision description kept in details rather than merged into page text.
- GitHub issue/PR URL specialization into the existing GitHub read surface.
- Operator-configured cookie-authenticated fetch profiles with HTTPS-only, host-scoped, same-origin rules.
- Opt-in YouTube keyframe evidence via anonymous `yt-dlp`/`ffmpeg` plus optional configured visual synthesis.
- Local PDF extraction with honest degradation for scanned pages; no hidden cloud PDF fallback.

### `github`

GitHub routing is action-specific rather than “clone or REST” globally:

| Action | Preference |
|---|---|
| `repo`, `tree` | hardened clone → REST fallback |
| `file` | REST → hardened clone fallback |
| everything else | REST |

Clone fallback is selective. Invalid input and authentication failures surface directly; they do not become anonymous/public retries. Clone children use private temporary roots, fixed argv with `shell:false`, disabled hooks/LFS/submodules/file protocol, bounded refs/paths, live size monitoring, and an unconditional final cleanup.

### `social`

Social routing is registry-backed and canonical-only. Cursors bind to the backend and request fingerprint that issued them; if that backend disappears, pagination fails instead of hopping providers.

The repository contains a future write vocabulary (`create_post`, `add_comment`, `like`, `follow`), but **this release has no social write dispatch path**. Even a policy-allowed write-shaped request can only reach a dry-run preview. Modelled vocabulary is not granted authority.

### `kg` and `graph`

`kg` is entity-oriented Diffbot acquisition: `search`, `enhance`, and `analyze_text`. `analyze_text` sends supplied text to Diffbot, so do not pass secrets, credentials, or private personal text unless that external transfer is intended.

`graph` exposes the native graph language instead of hiding search composition. DQL uses Diffbot when configured; SPARQL supports bounded SELECT/ASK through the operator-owned `GRAPH_SPARQL_ENDPOINT`. Pagination, schema discovery, and auth semantics remain language-specific. Graph results are not silently corroborated with web/fetch behind your back.

## Search: fusion without provider roulette

When `PI_SEARCH_WEB_BACKENDS` is absent or blank, Northstar walks the automatic preference order and selects the first **three configured** providers. The automatic order is:

`tavily → exa → brave → diffbot → firecrawl → jina → searxng → ollama-search → duckduckgo`

An explicit list can run up to eight configured providers concurrently. Extended explicit-list adapters include Parallel, Parallel MCP, Tinyfish, Querit, Valyu, Bocha, xAI, Mistral, Bright Data, SerpAPI, Serper, xCrawl, and Codex. Duplicate or unknown IDs reject before dispatch.

Every runnable provider is dispatched once. There are no ordinary fanout retries. Results are defensively post-filtered, normalized, deduplicated by normalized URL identity, then merged with deterministic reciprocal-rank fusion. Provider completion order does not become ranking order.

Provider failure and a legitimate zero-result response are different states. If at least one backend serves, other failures remain visible in result details. If every selected backend fails and none serves, the call fails instead of returning a fake empty search.

A session-scoped search ledger also sits in front of paid dispatch. It can coalesce concurrent equivalents, suppress recently repeated successful work, and temporarily block repeated failures. Suppression returns a pointer to prior corpus state; it never masquerades as fresh evidence.

## Research: 12 exact sources

`category:"research"` routes to native research rather than generic web. `source:"all"` fans out in deterministic registry order over:

1. Semantic Scholar
2. OpenAlex
3. PubMed
4. Stack Overflow
5. DataCite
6. ROR
7. GDELT
8. Wikipedia
9. Wikidata
10. arXiv
11. Crossref
12. Hacker News

Source-specific failures, unsupported pagination, and empty results stay distinct. A research request does not silently become generic web search.

## Agent mode: adaptive research, not an opaque report call

`web_search({ query, mode: "agent" })` creates a parent-owned job and returns a pointer. Read it with `agent_poll`.

```text
web_search { query, mode:"agent" }
  → buildSearchRoute()
  → createAgentJob()
  → parent-owned job registry
  → executeAgentJob()
  → PLAN → GATHER → EVALUATE → STOP / REFINE
                          ↓
                 SYNTHESIZE → VERIFY / REPAIR
  → canonical snapshot
  → agent_poll
```

There is **no standalone report leg in the registered public agent path**. Older Tavily report modules still exist as residual/internal code, but public `web_search` agent mode is intercepted before ordinary web backend execution and enters the adaptive controller above.

The controller separates proposals from authority:

- Planner output is validated; invalid output falls back to a deterministic plan.
- Candidate rows are navigation hints, not evidence.
- Evidence enters only through route-specific admission with provenance and question linkage.
- An evaluator can propose `answered`; code promotes a required question to grounded only when admitted linked evidence exists.
- `shouldContinue` is advisory; code-owned stop policy decides whether another round is legal.
- Synthesis proposes evidence-referenced IR that is validated before rendering.
- Verification/repair is bounded, and a repair must beat the current version without regressing evidence support.

When semantic machinery fails, Northstar moves **toward evidence**. It does not invent a prose fallback from ungrounded passages.

### Current gather truth

A job snapshots effective capabilities once. That frozen snapshot is used by planning and execution so admissibility does not wobble mid-job.

Production native specialist execution currently includes **research, GitHub, and KG**, plus the web search/fetch baseline. Social and video have typed gather intents and evidence adapters, but no production specialist tool surface in this cycle. Their capability entries are therefore marked unusable for specialist planning and such intents degrade to web with an explicit warning rather than being falsely advertised as native execution.

Current default policy budgets are:

| Budget | Default |
|---|---:|
| rounds | 3 |
| web-search attempts | 4 |
| fetch attempts | 12 |
| utility/model calls | 8 |
| total gather actions | 6 |

There are also per-lane caps and round-scoped fetch reserves. Budget spend is attempt-based at the dispatch boundary, so a failed provider call does not become “free.” Duplicate/rejected actions that never dispatch are not charged as executed attempts.

`depth:"deep"` widens the gather profile. Without it, policy starts balanced and can deterministically narrow after a valid plan when there is one required question and no servable specialist need.

### No-model mode

`PI_NORTHSTAR_AGENT_STEERING=0` removes planner/evaluator/synthesizer/verifier/repair model calls while preserving acquisition. The deterministic ladder still gathers admitted evidence, applies stop rules, and returns a valid evidence-only result.

This is an execution mode, not an error masquerading as success.

### Optional leaf-runtime steering

Set `PI_NORTHSTAR_LEAF_MODEL` to one exact `provider/model` ID to let a compatible co-installed pi-subagents runtime supply staged planner, evaluator, synthesizer, verifier, and repairer calls. No fuzzy model resolution and no thinking suffixes are accepted.

Negotiation is refreshed per job. A missing/unhealthy leaf runtime leaves acquisition intact and the deterministic ladder remains available.

Structured wire schemas are enabled only when the negotiated capability says `jsonSchema:"structured-v1"`. Advertising an `outputModes` entry containing `json` is **not enough**. Without `structured-v1`, steering runs as text JSON, then Northstar parses it client-side, applies the wire shape gate, and finally applies the domain validator. Structured output is still parsed and validated after the call.

The event bus is trusted in-process module plumbing, not an authenticated security boundary. Correlation metadata routes and observes work; it never authorizes it. Provider/model/token internals stay out of model-visible job snapshots.

## Browser: stateful authority

Browser automation is registered only when configured. Public browsing and loopback debugging have deliberately different network rules.

### Public browsing

- Navigation gets URL, DNS, and SSRF preflight.
- The allowed hostname set is frozen for the session; unrelated hostnames require close/new navigation rather than silent authority expansion.
- Snapshot element refs are stateful. Navigation or invalidation makes old refs stale, and ref-targeting mutations preflight freshness.
- Click dispatch is verified, post-click overlay appearance is detected, and scroll detects no-op outcomes.
- `evaluate`, `set_cookies`, and `batch` require exact `PI_SEARCH_BROWSER_ALLOW_SENSITIVE=1`.
- Cookie observations expose metadata only, never cookie values.

### Loopback debug mode

A validated loopback navigation creates an origin-confined session bound to exact scheme + host + port. Traffic is pinned through the local proxy/DNS path and cross-origin requests are blocked. A different loopback origin requires closing first.

### User Chrome companion

User-Chrome is an alternate backend, not ambient privilege. The loopback bridge requires an operator-pinned extension ID, pairing secret, process-local token, and an explicit user authorization flow through `/chrome authorize`. Authorization expires/revokes; absent or unhealthy authorization falls back to isolated browser behavior.

## Desktop: observe → bind → revalidate → mutate

Desktop automation is opt-in with `PI_SEARCH_DESKTOP_AUTOMATION=1` and uses Cua Driver `0.7.1` from `PATH`.

`observe_window` issues a `stateId` bound to PID, window ID, generation, TTL, and an accessibility-tree fingerprint. Every mutation requires a matching fresh state ID. Before dispatch, the service re-observes the target and rejects stale state.

`type_text` and `press_key` require explicit human TUI confirmation. Headless execution cannot self-approve them. Click and scroll still require fresh state. If mutation transport fails after dispatch may have happened, Northstar reports `OUTCOME_UNKNOWN` rather than replaying a potentially duplicated side effect.

Accessibility trees and screenshots are bounded by node/depth/byte/dimension policy. A screenshot can still contain sensitive data even though capture itself is read-only.

## Internal media + vision

Recognized YouTube/Bilibili/feed URLs are handled through the internal media family rather than adding more public tools. Metadata/transcript acquisition is the base path.

Video frames are additive and opt-in:

```text
recognized video URL
  → metadata / transcript
  → optional PI_VISION_FETCH_VIDEO_FRAMES=1
       → bounded yt-dlp / ffmpeg keyframes
       → bounded image-description tier
  → optional configured video synthesis
  → fetch result with explicit warnings / degradation markers
```

Keyframes are capped and extracted without writing frame files to disk. Missing vision tiers or keyframes do not invalidate truthful metadata/transcript evidence.

Configuring a cloud vision tier sends admitted image/video bytes and description context to that destination. Private/authenticated GitHub content is independently gated by `PI_VISION_PRIVATE_GITHUB_TRANSFER=1` before any cloud vision transfer.

## Configuration

Copy `.env.example` to `.env` or export variables in your shell. Process environment wins over file-loaded configuration.

You do **not** need to configure everything. Start with nothing, then add capabilities you actually want.

| Goal | Useful configuration |
|---|---|
| More web providers | `TAVILY_API_KEY`, `EXA_API_KEY`, `BRAVE_API_KEY`, `SEARXNG_BASE_URL`, or an explicit extended provider key |
| Select web providers | `PI_SEARCH_WEB_BACKENDS`, `PI_SEARCH_WEB_PROVIDER_TIMEOUT_MS` |
| External page fallback | `PI_SEARCH_EXTERNAL_FETCH=1` plus `FIRECRAWL_API_KEY` and/or `JINA_API_KEY` |
| GitHub quota/private reads | `GITHUB_TOKEN` or `GH_TOKEN` |
| Diffbot KG / DQL graph | `DIFFBOT_TOKEN` |
| SPARQL graph | `GRAPH_SPARQL_ENDPOINT`, optional `GRAPH_SPARQL_TOKEN` |
| Agent leaf steering | `PI_NORTHSTAR_LEAF_MODEL`; disable steering with exact `PI_NORTHSTAR_AGENT_STEERING=0` |
| Sensitive browser verbs | exact `PI_SEARCH_BROWSER_ALLOW_SENSITIVE=1` |
| Desktop automation | exact `PI_SEARCH_DESKTOP_AUTOMATION=1` plus `cua-driver` on `PATH` |
| User-Chrome companion | `PI_SEARCH_CHROME_EXTENSION_ID`, optional stable `PI_SEARCH_CHROME_PAIRING_SECRET`, then `/chrome authorize` |
| Video keyframes | exact `PI_VISION_FETCH_VIDEO_FRAMES=1` plus an eligible vision tier |
| Cloud vision for private GitHub | exact `PI_VISION_PRIVATE_GITHUB_TRANSFER=1` |
| Authenticated fetch | `PI_FETCH_AUTH_PROFILES` with provider/host-scoped profiles |

See `.env.example` for the full provider matrix, privacy notes, bounds, and optional local services.

### CLI vs MCP backend

The default `SearchBackend` is a one-shot CLI child process. It pays roughly a few hundred milliseconds of Node + `tsx` startup per call in local benchmarks, but gives strong per-call credential scoping and simple process isolation.

Set `SEARCH_BACKEND=mcp` for long-running/pool deployments where the MCP server is already managed. Public tool contracts do not change with backend choice.

## Setup and status commands

Operator credential acquisition is always user-initiated. Capability discovery may be automatic; login/cookie import is not.

- `/reach-status` reports registry-backed channel availability, quality, and auth state.
- `/reach-setup` plans/installs optional dependencies and exposes explicit login/import operations.
- `/reach-setup import_cookies <provider>` and `/reach-setup login <provider>` are explicit credential/session actions.
- `/chrome authorize` grants a revocable user-controlled Chrome companion lease.

Startup and bare automatic setup do not silently import browser cookies or create logins just to turn a capability green.

## CLI

Call the internal/native surface directly when debugging adapters:

```bash
npm run cli -- call web_search '{"action":"search","query":"pi agent frameworks"}'
npm run cli -- call research '{"action":"academic","query":"retrieval augmented generation","source":"arxiv"}'
npm run cli -- call media '{"platform":"youtube","action":"details","id":"..."}'
```

Use `/reach-status` inside Pi for the operator-facing view. The CLI exposes more internal families than the model-facing nine-tool ceiling, so do not treat CLI vocabulary as public model authority.

## Security model

Northstar assumes remote pages, search results, provider payloads, browser pages, CLI output, and model proposals can all be hostile or wrong.

Every external model-facing tool result is wrapped in a fresh randomized evidence fence. Dangerous invisible/control formatting is removed and suspicious patterns may be flagged, but visible text is not destructively rewritten. This framing is advisory: **it is not the permission system**.

Actual authority lives in code-owned contracts:

- Public/user-provided network targets pass application URL/DNS/SSRF policy before I/O.
- Operator-configured infrastructure such as SearXNG/SPARQL/sidecars is a different trust class; it is not blindly treated as an untrusted public URL.
- Authenticated fetch narrows the legal path: HTTPS only, profile/host scoped, same-origin redirects, no external page processors, opt-in caching.
- Browser authority is session-bound; desktop authority is observation-bound.
- GitHub authentication failure cannot silently fall back to a different visibility contract.
- Child processes receive allowlisted, capability-scoped environments rather than ambient `process.env`.
- CLI JSON output is head-capped; oversized output fails instead of tail-slicing into plausible-looking garbage.
- Native subprocesses use fixed argv with `shell:false`; proxy/credential classes are excluded unless a subsystem explicitly owns a narrower exception.

The deployment/container network remains the outer egress boundary. Application SSRF policy is defense in depth, not a substitute for isolation.

## Architecture in one screen

```text
Pi host
  → src/index.ts
  → public registration ceiling (≤ 9)
  → strict route / domain contract
  → policy + admissibility
  → SearchBackend or native/domain runtime
  → normalized evidence / result envelope
  → untrusted-content framing
  → model
```

A useful mental model is four concentric boundaries:

```text
1. Public vocabulary    small model-facing tool/action surface
2. Domain contracts     exact shapes, capabilities, budgets, provenance
3. Execution adapters   providers, CLI/native/MCP/browser/desktop
4. External world       web pages, APIs, local apps, co-installed runtime
```

### Primary ownership map

| Concern | Owner |
|---|---|
| public tool ceiling + channel metadata | `src/capabilities.ts` |
| extension composition + registration + global framing | `src/index.ts` |
| web-search public shape | `src/web/web-search-route.ts`, `src/web/web-contract.ts` |
| web provider policy + fanout | `src/web/web-provider-policy.ts`, `src/web/web.ts` |
| ranking/fusion | `src/search/fusion.ts` |
| fetch public shape | `src/web/web-fetch-route.ts`, `src/web/access/web-access-contract.ts` |
| URL specialization/read path | `src/native-fetch.ts`, `src/web/web-page-reader.ts`, `src/web/access/*` |
| agent jobs + public snapshot | `src/web/agent/agent-jobs.ts` |
| agent controller | `src/web/agent/agent-core.ts` |
| agent budgets/profile/stop | `src/web/agent/agent-policy.ts` |
| typed gather intents + execution | `src/web/agent/agent-gather-intents.ts`, `src/web/agent/agent-gather.ts` |
| evidence/candidate admission | `src/web/agent/agent-state.ts`, `src/web/agent/agent-acquisition.ts`, `src/web/agent/agent-candidates.ts` |
| model/wire schemas | `src/web/agent/agent-model.ts`, `src/runtime/runtime-rpc-protocol.ts` |
| browser policy/session authority | `src/browser/browser-policy.ts` + browser session modules |
| desktop contract/freshness | `src/desktop/desktop-contract.ts`, `src/desktop/desktop-policy.ts`, `src/desktop/desktop-tools.ts` |
| GitHub routing + clone boundary | `src/github/github-contract.ts`, `src/github/github-domain.ts`, `src/github/github-clone.ts` |
| child credential isolation | `src/cli/cli-backend.ts`, `src/process/*-child-env.ts` |
| external-content trust framing | `src/core/untrusted-content.ts` |

If documentation and implementation disagree, trace from the registered/public entry point. A module merely existing in the tree does not prove the public flow reaches it.

## Known edges, stated plainly

- **CLI startup is not free.** The default one-shot backend intentionally pays a process-start tax per tool call; use MCP for sustained pooled workloads.
- **Clone size enforcement is polled.** A clone can briefly exceed the configured ceiling before the watcher aborts it. The final scan prevents serving an oversized completed clone, but this is not filesystem quota isolation.
- **SSRF preflight has real residuals.** DNS rebinding, redirects, and browser debug proxy behavior still deserve deployment-level review.
- **Untrusted-content fencing is heuristic.** It helps establish a trust boundary; it does not prove content harmless.
- **Social/video specialist agent lanes are deferred.** Their typed intents exist, but current production agent execution does not advertise them as native specialist lanes.
- **Legacy report code remains in the tree.** `src/web/web.ts`, `src/web/web-agent-report.ts`, and `src/web/agent/agent-report-route.ts` contain older report machinery; the registered public agent route does not use it.
- **Vision probing is not proof of a full production model call.** A synthetic credential/model probe can pass while a later real request still fails.
- **Loopback debugging is intentionally narrow.** It does not solve every local TLS/WSS development setup.

## Development

```bash
npm install
npm run typecheck
npm test
```

Useful targeted checks while changing contracts:

```bash
node --import tsx --test test/web/web-search-agent-seam.test.ts
node --import tsx --test test/web/agent/agent-no-model.test.ts
node --import tsx --test test/web/agent/agent-budget-truth.test.ts
node --import tsx --test test/github/github-contract.test.ts
node --import tsx --test test/runtime/leaf-runtime-client.test.ts
```

## The invariant behind the project

> **Models propose. Code validates, admits, grounds, budgets, stops, and ships.**

That rule shows up everywhere: search providers propose rankings, pages provide evidence, planners propose actions, evaluators propose state changes, browser snapshots propose element identity, and desktop observations propose mutation targets. None of those proposals become authority merely because they arrived through a trusted-looking interface.

When adding a feature, ask one question all the way through the stack:

> **Does one meaning survive unchanged from the entry contract to the terminal evidence, result, or side effect, with every authority and budget transition explicit?**

If not, the feature is not wired yet.

## License

MIT. See [`LICENSE`](./LICENSE).
