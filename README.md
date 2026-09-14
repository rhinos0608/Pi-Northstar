# Pi-Northstar

Pi extension that gives your agent real-world reach — web search, page reading, GitHub, social media, video, browser automation, and desktop control. Zero-config works out of the box; API keys unlock more power.

Underneath the nine tools is a small set of shared services — result fusion/ranking, layered config loading, a backend abstraction with ordered fallback, and a reliability envelope around browser and desktop mutations. Each tool is a thin adapter over these services; see [Architecture](#architecture) for what's actually worth evaluating here.

## Architecture

### Shared services

| Service | File(s) | What it does |
|---|---|---|
| **Fusion & ranking** | `src/fusion.ts`, `src/bm25.ts`, `src/vector-index.ts` | Reciprocal rank fusion (RRF) merges rankings from multiple search backends, or from BM25 + embedding scoring in `fetch`; URL normalization dedupes across providers before fusion. |
| **Config loading** | `src/local-config.ts` | Merges process env, a package-local `.env` file, and an optional JSON config into one environment — process env always wins, so shell exports override everything. |
| **Backend abstraction & fallback** | `src/backend.ts`, `src/cli-backend.ts`, `src/mcp-client.ts` | `SearchBackend` is one interface with two implementations (native CLI, default; legacy MCP client). Dispatch paths run single-attempt with ordered fallback, never automatic retry (the former `retryWithBackoff` helper in `src/retry.ts` had no production callers and was removed). |
| **Reliability envelope — browser** | `src/browser-result.ts`, `src/session-page-state.ts`, `src/click-verification.ts`, `src/scroll-verification.ts`, `src/overlay-detection.ts` | Every result carries a structured `resultCategory`/`failureCategory`/`nextActions`; stale `@eN` refs are rejected before they reach the CLI; clicks are verified with a DOM event probe; scrolls and overlay appearances are diffed pre/post action. |
| **Reliability envelope — desktop** | `src/desktop-contract.ts`, `src/desktop-policy.ts` | Accessibility trees are depth/node/screenshot-byte capped and redacted; mutations require a fresh `stateId` from the most recent observation and are never blindly retried after dispatch. |
| **Output guarding** | `src/tool-output.ts` | Every tool result is truncated to a configurable character budget before it reaches the model, with head/tail preservation and a truncation marker. |

### Thin adapters (the nine tools)

Each public tool validates input, calls into the shared services above, and shapes the result for the model — `src/native-tools.ts` (`web_search`/`fetch`), `src/github.ts`, `src/reach-tools.ts` (`social`/`media`), `src/browser-tools.ts` + `src/agent-browser.ts` (`browser`), `src/desktop-tools.ts` (`desktop`). Adding a search provider or social platform is a fetch call plus a descriptor entry, not a new pipeline.

## What you get

| Tool | What it does |
|---|---|
| `web_search` | Canonical action `search`. Plain web search takes `limit` 1–20; `category: "research"` takes `limit` 1–30 and dispatches the 12 exact research sources below (`source: "all"` fans out over all). Exactly one of `query` or `queries[1..8]`: batch queries fan out through the canonical web runtime and fuse in order (one RRF pass over per-query rankings). Optional `includeContent`/`recency`/`domains` refine plain search; `yearFrom` is honored everywhere and intersects with `recency` (later bound wins). Cursors are single-query research-only. `mode: "agent"` returns a provider-generated research report as the tool text (untrusted evidence) with `details.report` carrying provider plus validated/capped sources (Tavily Research first provider; RRF/fusion bypassed; single query only; incompatible with `knowledge` and research categories). No provider selection input: backends are operator-owned (`PI_SEARCH_WEB_BACKENDS`). Results are normalized `article` entities with fusion details — no raw backend passthrough. Out-of-range input is rejected, never silently clamped. |
| `fetch` | Canonical action `read` without a `query` (full readable text of one URL); canonical action `crawl` with a `query` (crawls pages, returns ranked relevant chunks). `maxChars` ≤ 50000 is honored on both paths (default 30000); crawl takes `topK` ≤ 20 and `maxPages` ≤ 25. `siteMap: true` lists discovered same-origin URLs under `url` (optional `query` ranks, `maxPages` caps at default 10/max 25; rejects `searchQuery`/`followLinks`/`topK`/`maxChars`). `urls[1..8]` takes sequential readable reads (no `followLinks`/`siteMap`); with `query`, each URL returns ranked passage-chunks. `action: retrieve`/`source_check` serve the bounded memory corpus only (no network; unknown `responseId` throws with re-run guidance). Out-of-range input is rejected, never silently clamped. |
| `github` | Canonical actions `repo`, `file`, `tree`, `search`, `search_repos`, `trending`, `issues`, `pulls`, `releases`, `commits`, `workflows`, `runs` (REST API only — GraphQL not offered). `workflows`/`runs` are GitHub Actions, read-only (no dispatch/trigger). `GITHUB_TOKEN` or `GH_TOKEN` optional for public reads (harder rate limits without a token); unauthenticated `/search/code` is heavily rate-limited. `list_dir` and `code_search` legacy spellings rejected, never clamped. Results are normalized entities. |
| `social` | Read-only lookup over canonical actions only (unknown/legacy spellings rejected before dispatch). Available: Twitter/X, Reddit, V2EX, XiaoHongShu, Facebook, Instagram (no verified post-detail adapter, no download; `get_post`/`get_thread`/`get_comments` unadvertised on Instagram), LinkedIn (read actions via verified OpenCLI Chrome session). Xueqiu/Xiaoyuzhou are absent — not available or planned providers. |
| `media` | YouTube (official Data API for search/details/hot; keyless unofficial transcript) and Bilibili search, metadata, details, and subtitles. RSS/Atom feed reading. |
| `browser` | Headless browser automation via agent-browser — navigate, click, type, screenshot, snapshot with interactive refs, structured result categories, click verification, stale-ref detection, scroll no-op detection, overlay blocker detection. While `/chrome authorize` grants are live, the same `browser` tool routes allowlisted actions to the user-Chromium companion over the pinned bridge (`PI_SEARCH_CHROME_EXTENSION_ID`, 127.0.0.1:17319); revoke/expiry returns to the isolated backend. |
| `desktop` | Native desktop observation and interaction via Cua Driver (opt-in, disabled by default). |
| `graph` | Native graph access: `query` executes provider-native DQL (`language: 'dql'`, `pageSize` 1..100 default 10, opaque cursor) or SPARQL SELECT/ASK (`language: 'sparql'`, one bounded response, no cursor) with provider-faithful JSON plus shape (`rows`/`facets`/`aggregate`/`scalar`/`object`); `probe` checks cardinality of countable queries; `schema` discovers ontology types/fields (DQL uses 24-hour cache, stale fallback marked `partial`). Registers when `DIFFBOT_TOKEN` or `GRAPH_SPARQL_ENDPOINT` is set (see below); `kg` stays Diffbot-only. |

### Knowledge graph tools (DIFFBOT_TOKEN-gated)

`kg` enters model context only when `DIFFBOT_TOKEN` is set; `graph` enters when `DIFFBOT_TOKEN` or `GRAPH_SPARQL_ENDPOINT` is set — without their credential their schemas are absent (not erroring stubs). Auth resolution: explicit `DIFFBOT_TOKEN` from process env, `.env`, or JSON config wins; only when all three omit it does runtime fall back to a login-shell lookup, which fails closed and never logs the token. See `.env.example` for spend caps (`DIFFBOT_SEARCH_SIZE`, `DIFFBOT_ENHANCE_SIZE`, `DIFFBOT_FALLBACK_BUDGET`) and SPARQL keys.

```ts
kg({ request: { action: 'search', language: 'dql', query: 'type:Person name:"Ada Lovelace"' } })
kg({ request: { action: 'enhance', type: 'Organization', name: 'Acme', fields: 'basic' } })
graph({ action: 'query', language: 'dql', query: 'type:Organization name:"Acme"' })
graph({ action: 'schema', language: 'dql', view: 'types' })
```

Every paid call spends Diffbot credit; read [Diffbot privacy warning](#diffbot-privacy-warning-read-before-installing) before enabling.

#### SPARQL graph access (operator endpoint, no Diffbot needed)

Set `GRAPH_SPARQL_ENDPOINT` (http/https URL, no embedded credentials) plus optional `GRAPH_SPARQL_TOKEN` bearer auth to register `graph` with `language: 'sparql'`. Query supports SELECT/ASK only — SERVICE federation, dataset (FROM/FROM NAMED) clauses, and update forms reject before dispatch. The endpoint is operator config, never model input; redirects reject, the token travels via `Authorization` header only and is redacted from errors, and status output exposes the endpoint host only, never the token. Example: `graph({action:'query',language:'sparql',query:'SELECT * WHERE { ?s ?p ?o } LIMIT 10'})`.

#### Search-attempt ledger (session memory)

One in-memory ledger per extension instance (max 128 entries) coalesces in-flight duplicate searches, suppresses recent order-sensitive near-duplicates of successful searches for 30 minutes (same tokens in a different order still run), and blocks repeated failures for 10 minutes (non-retryable failures block immediately; retryable ones allow one retry). Cursor continuations bypass it, aborts never record a failure, and it stores only query hashes plus safe filter options — never result bodies, errors, or secrets. Suppressed/blocked calls return a short static pointer instead of re-dispatching.

### Research sources (exact-source guarantee)

Research exposes a single canonical action, `search`, over exactly 12 sources —
there is never DuckDuckGo/generic-web substitution: `semantic_scholar`,
`openalex`, `pubmed`, `stackoverflow`, `datacite`, `ror`, `gdelt`, `wikipedia`,
`wikidata`, `arxiv`, `crossref`, `hackernews` (`source: "all"` fans out over
all in registry order). Unsupported or unknown sources return an explicit safe
error instead of substituted results. `yearFrom` is the only model-facing filter (`web_search` param, honored on plain search and intersecting with `recency`); `yearTo`/`author`/`doi`/`venue` are research-backend capabilities, not `web_search` params. An unsupported filter
surfaces per-source rather than being silently dropped. `source` is research-only; `yearFrom` is honored on plain search and intersects with `recency` (later bound wins). Results carry a
canonical `details.northstar` envelope (schema `pi-northstar.result` v1)
beside the legacy `{query, source, results}` fields; per-source failures
surface as `partial`/`error` status with `errors[]`, not silent empty results.
Continuation `cursor` values are opaque, bound to one exact source + query +
`yearFrom` (max 4096 chars), rejected for `source: "all"` and non-research
categories, and never store provider URLs. `source: "all"` does not support
pagination; a pinned source whose page is valid-empty stops cleanly with no
further selection.

### Platform terms, authorization, and routing

Reddit and YouTube tool paths run only official, keyless, and degraded
capability-declared backends — there is no generic web/archive fallback tier.
Please read this before using cookie-based paths:

- **Terms of service.** Reddit and YouTube prohibit unauthorized automated
  access/scraping; neither platform's terms permit scraping merely because a
  logged-in session or cookie is used. Using `social`/`media` in a way that
  bypasses official APIs, or replaying session cookies, may violate those
  terms and can lead to account locks, IP blocks, or other enforcement.
- **Session cookies are bearer credentials.** A stored or exported Reddit
  cookie can fully impersonate the logged-in account. Pi-Northstar only sends
  cookies to fixed canonical Reddit hosts, rejects redirects, filters stored
  cookies by host/path/expiry/secure, and never forwards cookies to external
  CLIs, archives, search children, or scrapers — but **you** are responsible
  for what you paste into `REDDIT_COOKIE` and for protecting cookie state
  (`~/.pi-northstar/cookies/`, stored plaintext with `0600` perms).
  Use throwaway/dedicated accounts for any cookie-based fallback.
- **No web fallback tier.** There is no `PI_SEARCH_PLATFORM_WEB_FALLBACK`
  behavior: YouTube `search`/`hot` require `YOUTUBE_API_KEY`, and `details`
  falls back only to keyless oEmbed (limited fields, details-only — see media
  ordering below). The social path has no archive or generic web fallback —
  only capability-declared backends run. Cookie ingestion/login happen only
  through explicit `/reach-setup import_cookies <provider>` or
  `/reach-setup login <provider>`; first start and bare `/reach-setup auto`
  never import cookies, and no environment variable triggers cookie import.
  `/reach-setup import_cookies <provider>` remains the per-provider consent
  path, and `PI_SEARCH_BROWSER_AUTOMATION=0` remains the kill switch for
  explicit import/login. Xueqiu/Xiaoyuzhou are absent — not available or
  planned providers — and LinkedIn is available via its verified OpenCLI read
  backend, which authenticates through its own Chrome session and never
  imports stored cookies.

### Canonical social surface (Stage 2)

`social` is canonical-only and read-only in practice. Registry (`src/capabilities.ts` +
`src/social-contract.ts`) is source of truth for platforms, actions, and
backends; unknown/legacy spellings (read/post/subreddit/note/topic/...) throw
`unsupported_action` before dispatch. No archive or generic web fallback runs
in the social path — only capability-declared backends run.

- **Platforms:** Twitter/X, Reddit, V2EX, XiaoHongShu, Facebook, Instagram,
  LinkedIn available (LinkedIn read actions via verified OpenCLI Chrome
  session). Xueqiu/Xiaoyuzhou are absent — not available or planned.
- **Canonical actions per platform:**
  - twitter: search, get_post, get_thread, get_comments, get_comment_replies,
    get_profile, get_user_posts, get_followers, get_following, get_feed,
    get_trending, get_saved, get_notifications
  - reddit: search, get_post, get_thread, get_comments, get_comment_replies,
    get_profile, get_user_posts, get_user_comments, get_feed, get_trending,
    get_saved, get_community, get_community_posts
  - xiaohongshu: search, get_post, get_comments, get_profile, get_user_posts,
    get_followers, get_following, get_feed, get_saved, get_notifications
  - facebook: search, get_profile, get_feed, get_notifications, get_community
  - instagram: search, get_profile, get_user_posts, get_followers,
    get_following, get_trending, get_saved (no verified post-detail adapter;
    no post read, no download, no mutation)
  - v2ex: get_topic, get_thread, get_comments, get_profile, get_trending,
    get_community, get_community_posts, get_notifications
  - linkedin: search, get_profile, get_user_posts, get_feed
- **Normalized envelopes:** results render from validated `social_*` entities
  only and carry additive `details.northstar` (schema `pi-northstar.result`
  v1, entities + pagination + per-source status). `content` never renders raw
  backend payloads.
- **Routing:** scoped cookie-jar/session first when action completeness is
  equal, anonymous/keyless before optional API keys otherwise; cursor-capable
  preferred; platform preference breaks ties; cursors pin backend (no
  switching). `/reach-status [family] [action]` reports capability-aware
  eligibility, active backend, and usability for the requested action.
- **Auth is opt-in and live behavior unverified:** cookie ingestion/login only
  through explicit `/reach-setup import_cookies <provider> [endpoint]` or
  `/reach-setup login <provider> [port]` — never startup or env auto-import.
  Startup and bare-auto never import cookies; no environment variable triggers
  cookie import. `PI_SEARCH_BROWSER_AUTOMATION=0` remains
  the kill switch for explicit import/login. Explicit Pi cookie import/login
  supports only the current genuine consumers Reddit, Bilibili, and YouTube.
  Twitter, Xiaohongshu, Facebook, Instagram, and LinkedIn use their
  CLI/OpenCLI-owned
  authenticated sessions and therefore are not Pi cookie-import targets;
  TWITTER_AUTH_TOKEN/TWITTER_CT0 and imported Twitter/Xiaohongshu cookies do
  not configure active Stage 2 reads. Live authenticated reads remain opt-in and
  unverified — confirm via `/reach-status social <action>` and tool behavior,
  never assume a provider is unlocked.
- **Write boundary (deny-by-default, Stage 8):** `social` remains read-only in practice — no provider currently supports writes, and no write capability is available in this release. Gate lives in `src/social-write-policy.ts` / `src/social-write-contract.ts`: `PI_SEARCH_SOCIAL_WRITE` kill switch defaults off (only the exact string `'1'` enables), the per-provider write allowlist is empty, and every write-shaped request returns a denied result or a dry-run preview with zero side effects. Future adapters (OpenCLI session CLIs) require upstream verification before any action is allowlisted. Permanently forbidden: downloads, archives, destructive actions (delete/follow-at-scale), generic-web substitution. Any future write path stays user-initiated only, like explicit `/reach-setup import_cookies` / `login` — never startup/env auto.

Source ordering, YouTube (`media`):

1. Official YouTube Data API v3 when `YOUTUBE_API_KEY` is set (`search`,
   `details`, `hot` — captions endpoints are OAuth-only, so the Data API
   never serves `transcript`).
2. Keyless `www.youtube.com/oembed` for `details` only (limited fields:
   title, author, thumbnail — never used for `search` or `hot`).
3. Keyless unofficial `youtube-transcript` backend for `transcript` only
   (watch-page + timedtext adapter; degraded, may break without notice).
`search`/`hot` without a key fail closed with an explicit error — there is no
web-search/web-fetch fallback tier. `details` tries the Data API first when `YOUTUBE_API_KEY` is set; keyless oEmbed runs only when keyless or after Data API failure; when both are unavailable it
fails closed.

YouTube `transcript` is served only by the unofficial keyless adapter above;
stored YouTube cookies (via explicit `/reach-setup import_cookies youtube`)
can be attached to the watch-page fetch for consent-gated videos. Pi-Northstar
uses no third-party transcript services, never routes automatic calls to
`yt-dlp`, and never scrapes transcripts outside this adapter. An **OAuth management dashboard**
for these services is future, deferred work — this release adds no dashboard,
redirect endpoint, token storage, schema field, or tool.

### Reddit and YouTube examples

```ts
social({ platform: 'reddit', action: 'search', query: 'self-hosting', limit: 10 })
social({ platform: 'reddit', action: 'get_post', url: 'https://www.reddit.com/r/example/comments/POST_ID/' })

media({ platform: 'youtube', action: 'search', query: 'WebAssembly GC' }) // requires YOUTUBE_API_KEY; no web fallback
media({ platform: 'youtube', action: 'details', url: 'https://youtu.be/VIDEO_ID' }) // Data API first when YOUTUBE_API_KEY is set (limited fields); keyless oEmbed only when keyless or after Data API failure
media({ platform: 'youtube', action: 'hot' }) // requires YOUTUBE_API_KEY; no web fallback
media({ platform: 'youtube', action: 'transcript', url: 'https://youtu.be/VIDEO_ID' }) // keyless unofficial adapter; may break; never yt-dlp
```

Inspect `details.backend` and `details.northstar`: social results carry the
normalized `pi-northstar.result` envelope with validated entities. YouTube
results report `youtube-data-api` (full), `youtube-oembed` (degraded,
details-only, limited fields), or `youtube-transcript` (degraded,
transcript-only, unofficial).

## Diffbot privacy warning (read before installing)

Setting `DIFFBOT_TOKEN` routes paid traffic to Diffbot endpoints. Read this before installing or enabling.

- **External transmission.** Queries, page URLs, enhancement selectors, and `analyze_text` input text are sent to Diffbot over HTTPS: `llm.diffbot.com` (web search, Bearer auth), `kg.diffbot.com` (DQL search, Enhance, `?token=`), `nl.diffbot.com` (`analyze_text` POST, `?token=`), `api.diffbot.com` (Analyze-GET page fallback, `?token=`). Do not submit text you are not authorized to share.
- **Sensitive selectors supported — you control them.** `enhance` accepts `email`/`phone` selectors when you supply them; they are transmitted as given. Submit only selectors you hold consent to process.
- **NLP authorization guidance (advisory).** `analyze_text` (1–100000 chars, rejected outside, never clamped) can extract entities, facts, sentiment, and topics — including email/phone. Obtain user authorization before submitting sensitive text. This guidance is documented, not enforced in code.
- **Advisory limitation.** `kg` output is framed as untrusted evidence; consent and safety notes are advisory and never authorize actions or secret access. Without `DIFFBOT_TOKEN` nothing changes: unconfigured backends are skipped silently.
- **No logs/cache.** Token never logged; no response persistence or disk cache. Token and sensitive selectors (email/phone) redacted from errors (500-char slice). Token reaches only the in-repo Node CLI worker (`src/cli.ts` via `buildCliEnvironment`); never third-party CLIs, MCP servers, or Python children.
- **Credit/spend controls.** Every paid call spends Diffbot credit; no automatic paid retries (retryable transport 5xx/timeout only) and no account quota probe — monitor spend in the Diffbot dashboard. `DIFFBOT_FALLBACK_BUDGET` (default 3, max 25 per fetch, 0 disables) is enforced on the Analyze fallback path and rejects out-of-range, never clamps. Operator limits are defaults/caps consumed on every `kg` call: `DIFFBOT_SEARCH_SIZE` (default 10, cap 50 per provider), `DIFFBOT_ENHANCE_SIZE` (default 1, cap 10 per provider), `DIFFBOT_NLP_MAX_CHARS` (100000 hard cap), `DIFFBOT_MAX_PROVIDERS` (default 3, cap 8). `resolveDiffbotSpend` validates once per call and rejects out-of-range before any paid call, never clamps. See `.env.example`.

### What Diffbot adds

- `web_search`: Diffbot joins as one more backend (`name: 'diffbot'`, source label `diffbot`); results enter RRF fusion, never primary-weighted. Request schemas unchanged.
- `fetch`: Analyze-GET (`fields=allContent,links`) is recoverable fallback only after native/Scrapling exhaustion (network/upstream/blocked/timeout/empty); never on policy/input/abort/size/security/contract failures. Target URL validated first. Success marks envelope `degraded` (execution-path only, `qualityImpact: 'not_assessed'`).
- `kg` tool (new, lowercase): actions `search` (entity-returning DQL, `language: 'dql'` fixed; facet/report/export/collection/crawl modes return `unsupported_option`), `enhance` (type `Person`/`Organization` + at least one selector from `id`/`name`/`url`/`email`/`phone`/`location`/`description`, plus Person-only `employer`/`title`/`school`; portable `fields`/`maxEntities`/`includeRelationships`/`includeEvidence`/`confidenceThreshold`), `analyze_text` (booleans `extractEntities`/`extractFacts`/`extractSentiment`/`extractTopics`, `language` ISO 639-1 or `auto`; mention spans bounds-checked, invalid dropped). `enhance` applies Atlas-owned `fields` projection (`basic`/`contact`/`professional`/`all`), explicit relationship predicates only (`includeRelationships: false` suppresses them, never invents), per-entity evidence statuses (`provided`/`not_requested`/`provider_unsupported`/`unavailable`), and confidence filtering that retains rows with missing confidence. Output carries aligned groups, claims, and conflicts with provider trace tags and no raw upstream payload. Output envelope `pi-northstar.knowledge-result` v1 (`ok`/`empty`/`partial`/`degraded`/`error`). Error codes: `invalid_input`, `unsupported_option`, `cursor_invalid`, `pagination_not_supported`, `transport_invalid_response`, `contract_invalid_response`, `semantic_invalid_response`, `invalid_entity`, `response_too_large`, `upstream_error`. Opaque cursors (single-provider only; explicit multi-provider fanout returns one bounded page, no cursor). Routing: providers omitted → highest-priority capable configured provider with sequential fallback on recoverable transport/contract/semantic failures only, never same-provider paid retry; explicit providers → concurrent with per-provider `unsupported_option` partitions, never silently skipped. Non-goals (excluded): account, crawl, bulk, bulk enhance, facets, reports, exports, collections, persistence/cache, adjudication, provider-native options, enhance `refresh`.
- `graph` tool: actions `query` (`language: 'dql'` fixed, `pageSize` 1..100 default 10 sizes one transport page without rewriting query text, opaque cursor bound to query/pageSize), `probe` (1..32 countable queries, per-query `hits`, partial failures preserved), `schema` (`types`/`fields`/`search`/`describe`, no refresh control). Output envelope `pi-northstar.graph-result` v1 (`ok`/`empty`/`partial`/`error`) with provider provenance in `source`. Provider selection is internal (no `provider` input). `kg` stays the portable entity abstraction and is unchanged. Examples: `graph({action:'query',language:'dql',query:'type:Organization name:"Acme"'})`, `graph({action:'probe',language:'dql',queries:['type:Person name:"Ada"']})`, `graph({action:'schema',language:'dql',view:'types'})`. Diffbot receives DQL/schema requests when configured; no hidden calls, retries, exports, or control-plane operations. Non-goals: crawl/jobs, Ask, exports, provider-branded tools.
- Status: native adapters landed (`src/diffbot-transport.ts`, `src/diffbot-search.ts`, `src/diffbot-extract.ts`, `src/diffbot-kg.ts`, `src/knowledge-contract.ts`); `web_search`/`kg`/registry wiring registered. No behavior without `DIFFBOT_TOKEN`.
- Canonical docs: [overview](https://www.diffbot.com/docs/) · [authentication](https://www.diffbot.com/docs/authentication) · [Extract/Analyze](https://www.diffbot.com/docs/extract/article) · [DQL](https://www.diffbot.com/docs/dql/post) · [Enhance](https://www.diffbot.com/docs/enhance/post) · [Web Search](https://www.diffbot.com/docs/web-search/post) · [NL process text](https://www.diffbot.com/docs/natural-language/process-text).

## Vision / multimodal privacy warning (read before enabling)

Image/PDF/video understanding sends content off-machine. Read this before setting any `PI_VISION_*`, `GEMINI_*`, `GOOGLE_*`, or Vertex vision variable.

- **What leaves the machine.** Every vision call sends the admitted image/PDF/video bytes plus the OCR/description text derived from them to the operator-configured destination: the `PI_VISION_OPENAI_COMPAT_BASE_URL` endpoint (loopback or cloud), Google (`GEMINI_API_KEY` / `GOOGLE_GENAI_API_KEY` Developer API or `GOOGLE_VERTEX_PROJECT` / `GOOGLE_CLOUD_PROJECT` Vertex), or the Gemini web session (`PI_VISION_GEMINI_WEB_ENABLED=1`). Do not submit content you are not authorized to share.
- **Explicit opt-in only.** Nothing leaves the machine until the operator configures a destination: unconfigured tiers are skipped and pipelines degrade to native evidence with warnings. `gemini-web` is additionally gated behind the exact value `PI_VISION_GEMINI_WEB_ENABLED=1` (disabled default, last resort) and `vision-private-gate` behind `PI_VISION_PRIVATE_GITHUB_TRANSFER=1`.
- **Private GitHub content needs the independent flag.** Public transfer is authorized by configuring the destination endpoint/credential, but private or authenticated GitHub content additionally requires the exact value `PI_VISION_PRIVATE_GITHUB_TRANSFER=1`. Without it, private content never reaches any cloud vision endpoint — calls degrade to native evidence with warnings.
- **Synthetic probe first.** Each exact model ID is probe-gated with a tiny synthetic image before any user content is sent; text-only / non-vision models reject fail-closed and never receive user bytes.
- **Policy/auth failure never broadens eligibility.** A failure drops the failed tier (fail-closed subset); it never unlocks a tier the operator did not configure.

## Quick start

Two ways to bring Pi-Northstar into `pi`:

### Install as a Pi package (recommended)

```bash
pi install git:github.com/rhinos0608/Pi-Northstar
```

This clones the repo into `~/.pi/agent/git/` (or `.pi/git/` with `-l` for a project-local install), runs `npm install`, and registers the extension in settings for you. To try it for one session without installing anything: `pi -e git:github.com/rhinos0608/Pi-Northstar`. See `pi`'s [package docs](https://github.com/earendil-works/pi) for update/remove commands.

### Clone and wire up manually

```bash
git clone https://github.com/rhinos0608/Pi-Northstar.git Pi-Northstar
cd Pi-Northstar
npm install
```

Add it to `~/.pi/agent/settings.json` (or `.pi/settings.json` for a project-local extension):

```json
{
  "extensions": {
    "pi-northstar": "./src/index.ts"
  }
}
```

Or run it directly for a quick test:

```bash
pi -e ./src/index.ts
```

### About that `npm install`

Requires Node.js ≥ 24. The floor comes from the `browser` tool chain, not the core tools: the optional `agent-browser` npm dependency declares `engines: { node: ">=24.0.0" }`, and `package.json` (`engines: { node: ">=24.0.0" }`) plus CI (`node-version: 24` in `.github/workflows/ci.yml`) pin the whole package to it. The core tools (`web_search`, `fetch`, `github`, `social`, `media`) use portable APIs behind the `node --import tsx` loader (which only needs Node ≥ 20.6), so there is no newer-`URL`/`fetch`-API reason you must be on 24 for them — but 24 is the only tested/supported runtime, so upgrade rather than polyfill. `web_search`, `fetch`, `github`, `social`, and `media` have no native dependency — `npm install` (or `npm install --omit=optional`) is enough to use them. `browser` is the one tool backed by a native binary: `agent-browser` (~86 MB) is an **optional** npm dependency, so `npm install` downloads it by default, but nothing else in the package needs it. Skip it with:

```bash
npm install --omit=optional
```

Skipping it leaves the other five tools unaffected; `browser` is not registered until an agent-browser binary is available — see [Browser automation](#browser-automation) to install it separately or point at an existing one.

`desktop` is separate again: it drives a native Cua Driver binary that was never an npm dependency at all, downloaded and put on `$PATH` by hand. It is not registered until `PI_SEARCH_DESKTOP_AUTOMATION=1` — see [Desktop automation](#desktop-automation).

If the agent-browser download is slow or fails:
- Check network/proxy settings: `npm config get proxy`, `npm config get https-proxy`
- Verify internet connectivity to GitHub (where binaries are hosted)
- Use `npm install --verbose` to see download progress
- If stuck, try clearing npm cache: `npm cache clean --force && npm install`

That's it — web search works immediately via DuckDuckGo with zero configuration. If a file-backed `codex login` session is available, Pi-Northstar detects it automatically for explicit `codex` selection (merged through uniform RRF, never automatic).

## Configuration

Set variables in your shell profile (`.zshrc`, `.bashrc`) or a package-local `.env` file. Process environment wins over `.env`. See `.env.example` for every available variable.

### API keys

All optional. DuckDuckGo covers web search without any keys.

```bash
export GITHUB_TOKEN="ghp_..."           # GitHub API (or GH_TOKEN; optional — public reads work keyless with harder rate limits)
export EXA_API_KEY="..."                # Exa semantic search
export BRAVE_API_KEY="..."              # Brave Search API
export TAVILY_API_KEY="..."             # Tavily AI-native search
export YOUTUBE_API_KEY="..."            # YouTube Data API
export REDDIT_CLIENT_ID="..."           # Reddit API
export REDDIT_CLIENT_SECRET="..."       # Reddit API
export REDDIT_USER_AGENT="pi-northstar/0.1"
export SEARXNG_BASE_URL="https://..."   # Self-hosted SearXNG
```

Diffbot is paid and external — read [Diffbot privacy warning](#diffbot-privacy-warning-read-before-installing) before setting any `DIFFBOT_*` variable:

```bash
export DIFFBOT_TOKEN="..."                # Diffbot APIs (off when unset; see .env.example for spend caps)
```

Explicit `DIFFBOT_TOKEN` from process env, `.env`, or JSON config wins; only when all three omit it does runtime fall back to a login-shell lookup, which fails closed and never logs the token.

### Codex/ChatGPT search

Pi-Northstar automatically checks `CODEX_ACCESS_TOKEN`, then `${CODEX_HOME:-~/.codex}/auth.json` created by `codex login`. Codex runs only when `codex` appears in an explicit `PI_SEARCH_WEB_BACKENDS` list, as one more backend merged through uniform RRF with URL-dedup — never automatic, never primary-first. Only search query is sent; conversation history and project files are not included.

```bash
export CODEX_ACCESS_TOKEN="..."       # Optional override
export CODEX_ACCOUNT_ID="..."         # Optional account routing
export CODEX_HOME="$HOME/.codex"       # Optional auth-file location
```

`PI_SEARCH_WEB_BACKENDS` is the exclusive override and is exact. If set, Codex runs only when `codex` appears in list. The legacy `SEARCH_WEB_BACKENDS` variable was removed and is no longer read.

> **Limited-support notice:** This integration uses undocumented, reverse-engineered ChatGPT/Codex search endpoint. It is best-effort, not official OpenAI integration, and may change, become unavailable, or be limited by account eligibility and usage limits. Usage may be governed by OpenAI/ChatGPT terms and policies. Confirm your intended use complies with those terms before enabling or relying on it.

### Backend selection

```bash
export PI_SEARCH_WEB_BACKENDS="tavily,exa,brave"  # Explicit ordered set; omit or leave blank for automatic top 3
```

Search backends in automatic preference order: `tavily`, `exa`, `brave`, `diffbot`, `firecrawl`, `jina`, `searxng`, `ollama-search`, `duckduckgo` (`duckduckgo` always configured; `codex` is explicit-only, never automatic). Selection is environment-only — there are no model-facing provider flags:

- Missing or blank `PI_SEARCH_WEB_BACKENDS` dispatches the first 3 configured backends in preference order concurrently, with no replenishment.
- An explicit list runs every runnable listed backend concurrently (max 8) in caller order; unknown IDs, duplicates, and lists over 8 reject before any call. Unavailable entries are recorded, never silently replaced.
- Every fulfilled non-empty ranking — including Codex — merges through uniform RRF with URL-dedup; backend provenance (`backend`, per-result contributors) stays visible in results. No provider retries.
- Provider deadline: `PI_SEARCH_WEB_PROVIDER_TIMEOUT_MS`, default `12000`, integer `1000..30000`; malformed values reject before dispatch. Caller abort cancels in-flight requests.
- Agent report deadline: `PI_SEARCH_WEB_AGENT_TIMEOUT_MS`, default `300000`, clamped to `300000` by the 300s CLI-backend route ceiling (larger values are ineffective); malformed values reject before dispatch. `mode: "agent"` runs one streaming Tavily Research POST (`{input, model, stream: true}`, SSE `text/event-stream` consumed incrementally, no polling) under that single deadline; report text caps at 50000 chars and sources at 20 validated/deduped entries. Report model: `TAVILY_RESEARCH_MODEL`, `mini|pro|auto`, default `pro`; blank defaults, malformed values reject before fetch. No model-facing report knobs. Provider failures throw a neutral provider-attributed error immediately. MCP-server deployments forward the deadline via `SEARCH_MCP_FORWARD_ENV_JSON`.

### Native AI (environment-only, default on)

Provider-native summaries and answers are controlled only by `PI_SEARCH_NATIVE_SUMMARIES` and `PI_SEARCH_NATIVE_ANSWERS` (`1`/`true`/`0`/`false`, default on; anything else rejects before dispatch). There are no model-facing AI toggles. Generated text never replaces retrieval snippets: summaries carry result-URL provenance, Tavily answers carry supporting-result-set provenance (never claim citations), empty answers or answers without supporting URLs are dropped, items cap at 8000 chars / 32 per call. Firecrawl search and fetch summaries honor `PI_SEARCH_NATIVE_SUMMARIES=0` (no summary requested, none emitted). Jina emits no generated text.

### Optional knowledge composition (web_search only)

`web_search` accepts an optional `knowledge` object with five optional booleans — `entities`, `facts`, `topics`, `sentiment`, `enhance` — gated at runtime by `PI_SEARCH_KG_ENRICHMENT=1` plus at least one `true` flag (unknown keys, non-boolean values, or all-false reject as `invalid_request`). Rejected for `category: "research"`; standalone `kg` behavior is unchanged. Only the first 3 fused results with non-empty original snippets are analyzed (max 8000 chars each); generated text, page-fetch content, and contact selectors are never submitted. Excerpts that look like email/phone, `category:"people"`, or personal-profile URLs (e.g. LinkedIn `/in/`) are skipped without echo — detection is defense-in-depth and never proves content is non-sensitive. Optional `enhance` covers at most 3 normalized Person/Organization entities by name plus validated public homepage only, never contact selectors. Output is framed as untrusted evidence, never generated AI presented as fact.

### External fetch fallback (Firecrawl/Jina, environment-gated)

Setting `FIRECRAWL_API_KEY` / `JINA_API_KEY` sends queries and admitted public URLs to fixed vendor hosts only (`api.firecrawl.dev`, `s.jina.ai` / `r.jina.ai`) plus vendor-side external page processing. No cookies, browser state, or caller headers are forwarded. Do not submit URLs or text you are not authorized to share.

- Fetch fallback runs only when `PI_SEARCH_EXTERNAL_FETCH=1`/`true` (default off) **and** `PI_SEARCH_FETCH_BACKENDS` names an ordered unique subset of `firecrawl,jina` (max 2; blank means no attempts; duplicates/unknown/>2 reject before any call). Attempts run sequentially in listed order, stop at the first valid non-empty page, one request per adapter, no retries.
- Cost caps: Firecrawl search takes `min(limit,3)` with summaries on, `min(limit,10)` with summaries off (one call, never a second unsummarized call); Jina search takes `min(limit,5)`; every paid call spends vendor credit with no quota probe — monitor vendor dashboards. Fetch bounds: 1,000,000-byte vendor response max, 50,000-char retained page content, fetch provider timeout `PI_SEARCH_FETCH_PROVIDER_TIMEOUT_MS` default `15000` integer `1000..30000`.
- Targets pass local public-URL validation plus system-DNS preflight before the vendor receives them; policy/URL/DNS/caller-abort/size/404/410 failures never reach vendors. Vendor-side redirect hops after handoff cannot be constrained locally (residual risk). External success after native exhaustion is marked `degraded` (`qualityImpact: 'not_assessed'`).
- Research (`category: "research"`) never touches generic web providers or external fetch vendors, and external fetch never runs inside the research path.

```bash
export PI_SEARCH_BROWSER_ALLOW_SENSITIVE="1"              # Enable evaluate/set_cookies
export PI_SEARCH_DESKTOP_AUTOMATION="1"                   # Enable desktop tool
```

### Research source keys (optional)

Pi convention names, not vendor-standard names. All research sources work
unauthenticated; these keys only raise provider quota limits.

```bash
export SEMANTIC_SCHOLAR_API_KEY="..."   # Semantic Scholar Graph API quota
export OPENALEX_API_KEY="..."           # OpenAlex mailto pool
export NCBI_API_KEY="..."               # PubMed E-utilities optional key
export NCBI_EMAIL="you@example.com"     # PubMed contact (recommended)
export STACKEXCHANGE_KEY="..."          # Stack Exchange API quota
```

### Bootstrap control

```bash
export PI_SEARCH_BOOTSTRAP="off"         # Skip startup automation
export PI_SEARCH_AUTO_INSTALL="0"        # Skip startup installs
export PI_SEARCH_ALLOW_INSTALL="0"       # Disable all install execution
export PI_SEARCH_BROWSER_AUTOMATION="0"  # Disable all browser features (kill switch for explicit import/login)
export PI_SEARCH_CHROME_EXTENSION_ID="abcdefghijklmnopqrstuvwxyzabcdef"  # Companion extension id pinning the user-Chrome bridge origin (unset = user-chrome unavailable, isolated backend only)
```

First start and bare `/reach-setup auto` never import browser cookies —
no environment variable triggers cookie import.
`/reach-setup import_cookies
<provider> [endpoint]` remains the explicit per-provider consent path.
Xueqiu/Xiaoyuzhou are absent providers. Explicit Pi cookie import/login
supports only Reddit, Bilibili, and YouTube; Twitter, Xiaohongshu, Facebook,
Instagram,
and LinkedIn use their CLI/OpenCLI-owned authenticated sessions and are not
Pi cookie-import targets.

### Output & state

```bash
export PI_SEARCH_MAX_TOOL_OUTPUT_CHARS="60000"   # Truncation limit
export PI_SEARCH_STATE_DIR="$HOME/.pi-northstar"     # State directory
export PI_SEARCH_COOKIE_BROWSER="chrome"         # chrome, brave, or edge
export PI_SEARCH_COOKIE_STALE_MS="43200000"      # Cookie re-import window (12h)
export BROWSER_CDP_ENDPOINT="http://127.0.0.1:9222"  # Cookie import via local CDP (explicit import_cookies only)
```

## Embedding & semantic search

Pi-Northstar has two layers of semantic capability:

### 1. Built-in semantic retrieval (`fetch` with query)

When you call `fetch` with a `query` parameter, Pi-Northstar performs **hybrid search**:

1. **URL discovery** — queries configured search backends under the environment-only selection policy above (automatic top 3 in preference order when `PI_SEARCH_WEB_BACKENDS` is absent/blank; explicit lists run all runnable entries concurrently, max 8; `codex` explicit-only); every fulfilled ranking merges through uniform RRF with URL-dedup
2. **Page fetching** — optionally uses Scrapling (Python stealth browser) for JS-rendered pages and anti-bot bypass, falls back to plain HTTP
3. **Chunking** — sentence-boundary-aware text splitting with overlap
4. **BM25 ranking** — Okapi BM25 lexical scoring (TF saturation, IDF weighting, length normalization)
5. **Embedding ranking** — vector similarity via embedding sidecar (if configured)
6. **RRF fusion** — merges BM25 and embedding rankings into final results

#### Site-wide crawling with `followLinks`

Set `followLinks: true` to crawl the entire site starting from `url`. The tool performs a bounded BFS across same-domain pages, extracts and indexes all content, then returns only the passages most relevant to your `query`.

```
fetch({ request: { mode: "crawl", source: { type: "url", url: "https://example.com", followLinks: true }, query: "pricing tiers" } })
```

- **`followLinks` requires both `url` and `query`** — site-wide crawls always use semantic packing; raw page dumps are not supported
- **Same-domain only** — external links are ignored; subdomains (`sub.example.com`) are excluded
- **`maxPages`** — controls total pages crawled (default 10, max 25)
- **`maxDepth`** — hardcoded at 3 levels deep, preventing runaway crawls
- **URL dedup** — fragments, tracking params, trailing slashes normalized before enqueue
- **Non-HTML content** — skipped automatically (PDFs, images, archives)
- **Graceful degradation** — link extraction uses Scrapling's CSS selector engine when available; falls back to regex-based extraction from raw HTML
- **Output** — limited to the most relevant `topK` chunks (default 8) via the same BM25+embedding RRF pipeline

Every layer degrades gracefully: no Python → plain HTTP fetch, no sidecar → BM25-only, no backends → DuckDuckGo fallback.

```
fetch({ request: { mode: "crawl", source: { type: "search", searchQuery: "React 18 concurrent rendering" }, query: "How does React concurrent rendering work?" } })
```

- `query` — what you want to find in the crawled pages
- `searchQuery` — what to search the web for (required with `query` when `url` omitted; no default — `query` alone does not discover)
- `topK` — how many chunks to return (default 8, max 20)
- `maxPages` — how many pages to crawl (default 10, max 25)
- `maxChars` — output budget honored on both fetch paths (`read` and `crawl`), default 30000, max 50000

Out-of-range `limit`/`topK`/`maxPages`/`maxChars` values are rejected, never silently clamped.

Without a `query`, `fetch` (canonical `read`) returns the full readable text of a URL (plain extraction, no semantic processing).

### 2. Embedding sidecar (semantic search)

Pi-Northstar can connect to an embedding service for **vector-based semantic search** in `fetch`.

Configure the sidecar (works with any OpenAI-compatible embedding API — LM Studio, Ollama, OpenAI, etc.):

```bash
export EMBEDDING_SIDECAR_PROVIDER="openai"          # Provider identifier
export EMBEDDING_SIDECAR_BASE_URL="http://localhost:1234"  # Embedding service endpoint
export EMBEDDING_SIDECAR_API_TOKEN="sk-..."         # Auth token (optional for local services)
export EMBEDDING_SIDECAR_DIMENSIONS="768"            # Embedding vector dimensions
```

When `EMBEDDING_SIDECAR_BASE_URL` is set, `fetch` with query automatically uses BM25 + embedding RRF fusion for ranking. No Python process is spawned — it talks directly to your external embedding service.

#### Local Python sidecar (alternative)

If you don't have an external embedding service, Pi-Northstar can spawn a local Python sidecar:

```bash
pip install fastapi uvicorn sentence-transformers
export PI_SEARCH_EMBEDDING_ENABLED=1
export PI_SEARCH_EMBEDDING_MODEL=all-MiniLM-L6-v2  # 384 dims, 22MB
```

Pi-Northstar auto-spawns the sidecar on first use and manages its lifecycle.

#### Stealth browser mode (Scrapling)

If the Scrapling Python package is installed, Pi-Northstar uses it **automatically** for `fetch` — no configuration needed. It provides:

- JS-rendered page content (SPA, React, Angular sites)
- Cloudflare Turnstile/Interstitial auto-solve
- Anti-fingerprinting (canvas noise, WebRTC leak prevention, CDP detection bypass)
- Stealth browser via Patchright

```bash
pip install "scrapling[fetchers]"
scrapling install  # download browsers + system deps
```

Pi-Northstar auto-detects Scrapling on startup. If installed, `fetch` and `agentic_browse` use it automatically. If not installed, falls back to plain HTTP.

Optional proxy:
```bash
export PI_SEARCH_SCRAPLING_PROXY="http://user:pass@host:port"
```

### 3. GitHub actions

Canonical actions: `repo`, `file`, `tree`, `search`, `search_repos`, `trending`, `issues`, `pulls`, `releases`, `commits`, `workflows`, `runs` (REST API only — GraphQL not offered). `workflows` (list/get GitHub Actions workflows) and `runs` (list/get workflow runs, or list a run's jobs with `jobs: true`) are read-only — no `workflow_dispatch` trigger. Results are normalized entities. Out-of-range input is rejected, never clamped. `list_dir` and `code_search` legacy spellings are unsupported.

```
github({ request: { action: "releases", repository: "owner/repo" } })
```

`GITHUB_TOKEN` or `GH_TOKEN` is optional: public reads work keyless with harder rate limits. Unauthenticated `/search/code` is heavily rate-limited; `issues`/`pulls`/`releases`/`commits` work keyless for public repos.

## CLI

The CLI is a thin JSON-in/JSON-out wrapper — useful for testing and scripting:

```bash
npm run cli -- status
npm run cli -- config
npm run cli -- call web_search '{"query":"pi agent extensions"}'
npm run cli -- call fetch '{"url":"https://example.com"}'
npm run cli -- call fetch '{"query":"error handling patterns","searchQuery":"Rust error handling best practices"}'
npm run cli -- call social '{"platform":"reddit","action":"get_community_posts","community":"python"}'
npm run cli -- call media '{"platform":"rss","url":"https://example.com/feed.xml"}'
npm run cli -- call reach_setup '{"action":"plan"}'
```

All CLI output is JSON: `{ "ok": true, "data": { "content": [...] } }`.

## Slash commands

User-facing setup and status commands (not LLM tools):

- `/reach-status [family] [action]` — inspect channels and backends, e.g. `/reach-status social` or `/reach-status social get_post`. The optional action is validated against the canonical registry; unknown/legacy spellings are rejected.
- `/reach-setup [action]` — `auto`, `status`, `plan`, `install_core`, `install_all`, `install_channels`, `import_cookies`, `login`

## Browser automation

`browser` tool provides headless browser control via **agent-browser** (core path) with reliability checks matching [pi-agent-browser-native](https://github.com/fitchmultz/pi-agent-browser-native). A legacy CDP fallback exists but is **deprecated** — use agent-browser.

> Privacy: optional paid backends (Diffbot) transmit queries/URLs/selectors/text externally — see [Diffbot privacy warning](#diffbot-privacy-warning-read-before-installing).

### Installation

`agent-browser` is an **optional** npm dependency (`optionalDependencies` in `package.json`), not required by any other tool. By default `npm install` downloads the native binary (~86 MB) alongside everything else, so `browser` works immediately with no extra setup:

```bash
npm install
# agent-browser binary downloads automatically
```

If you installed with `npm install --omit=optional`, or the optional install failed for your platform, `browser` is not registered. Fix it with any of:

```bash
npm install agent-browser         # install just the optional dependency
npm install -g agent-browser      # or use a system-wide install already on PATH
export BROWSER_EXECUTABLE_PATH="/path/to/agent-browser"  # or point at a specific binary
```

Resolution order: `BROWSER_EXECUTABLE_PATH` if set (exact path, no fallback) → otherwise `node_modules/.bin/agent-browser` → `node_modules/agent-browser/bin/agent-browser.js` → first `agent-browser` found on `PATH`.

### Capability matrix

#### Reliability checks (Phase 1–2, implemented)

| Check | What it does | Signal |
|-------|-------------|--------|
| **Structured result envelope** | Every result carries `resultCategory` (success/failure), `successCategory` (inspection/completed/artifact-saved), `failureCategory` (timeout/stale-ref/dispatch-unverified/overlay-blocked/etc), and `nextActions` with exact recovery steps | `details.resultCategory`, `details.failureCategory`, `details.nextActions` |
| **Click dispatch verification** | After clicks on `@eN` refs and `role=`/`xpath=` selectors, installs a capture-phase DOM event probe; fails the result if no click event reached the page | `details.dispatchUnverified: true` |
| **Stale ref detection** | Tracks per-session `@eN` ref snapshots; rejects mutations on stale refs before the CLI runs | `failureCategory: 'stale-ref'`, `nextActions: [snapshot refresh]` |
| **Scroll no-op detection** | Compares pre/post viewport position; flags when scroll had no effect | `details.scrolled: false`, `details.noop: true` |
| **Overlay blocker detection** | Counts `[role=dialog]`/`[aria-modal]` elements before/after clicks; flags when a modal appeared | `details.overlay: { appeared: true }` |
| **Session page state** | Per-session ref snapshot tracking, tab target tracking, invalidation on "No active page", stale update rejection via monotonic tokens | `details.refSnapshot`, `details.refSnapshotInvalidation` |

#### Snapshot & input modes (Phase 3–4, implemented)

| Feature | What it does |
|---------|-------------|
| **Interactive snapshot refs** | `snapshot` parses `@eN` refs from agent-browser output, records role/name/isContentEditable metadata per session |
| **Compact snapshot** | `compact: true` keeps high-value roles (button, link, textbox, checkbox, radio, combobox, select, menuitem, tab, switch), drops structural divs without names |
| **semanticAction** | Locator shorthands — `click`/`fill`/`check`/`select` with `role`/`text`/`label`/`placeholder`/`alt`/`title`/`testid` locators, compiled to agent-browser `find` commands |
| **job** | Constrained multi-step orchestration (max 20 steps: open/click/fill/type/select/wait/assert/snapshot/screenshot), sequential execution with reliability checks per step |
| **batch** | Raw multi-command stdin batching, per-step `batchSteps[]` result categories |

#### Actions

| Action | Parameters | What it does |
|--------|-----------|------|
| `status` | none | Check browser backend and session state |
| `tabs` | none | List open browser tabs |
| `navigate` | `url: string` | Navigate to a URL (public HTTP/HTTPS only) |
| `text` | none | Extract visible text from the current page |
| `html` | none | Get raw HTML of the current page |
| `screenshot` | none | Capture a PNG screenshot of the page |
| `snapshot` | `compact?: boolean` | Take interactive snapshot with `@eN` refs for click/fill |
| `click` | `selector: string` | Click an element — with dispatch verification on eligible selectors |
| `type` | `selector: string`, `text: string` | Type text into an input field, with stale-ref preflight |
| `fill` | `selector: string`, `text: string` | Fill a form field, with stale-ref preflight |
| `scroll` | `x?: number`, `y?: number` | Scroll by pixel offset, with no-op detection |
| `wait` | `selector?: string`, `waitMs?: number` | Wait for selector or milliseconds |
| `get_url` | none | Get current page URL |
| `get_title` | none | Get current page title |
| `close` | none | Close the current tab |
| `cookies` | `urls?: string[]` | Read cookie metadata (values never exposed) |
| `set_cookies` | `cookies: Array<...>` | Set cookies (requires `PI_SEARCH_BROWSER_ALLOW_SENSITIVE=1`) |
| `evaluate` | `expression: string` | Run JavaScript in page context (requires `PI_SEARCH_BROWSER_ALLOW_SENSITIVE=1`) |
| `semanticAction` | `{ verb, locator, query, value, ... }` | Click/fill/check/select with role/text/label locators |
| `job` | `{ steps: [...] }` | Multi-step orchestration with per-step reliability |
| `batch` | `commands: string[][]` | Raw multi-command batching (requires sensitive flag) |

### Examples

```bash
# Navigate and snapshot with interactive refs
browser({ action: "navigate", url: "https://example.com" })
browser({ action: "snapshot" })
# Returns @e1, @e2, @e3... refs for follow-up clicks
browser({ action: "click", selector: "@e2" })

# Semantic action — click by role/name
browser({ semanticAction: { verb: "click", locator: "role", query: "button", value: "Submit" } })

# Multi-step job with reliability
browser({ job: { steps: [
  { kind: "open", url: "https://example.com" },
  { kind: "fill", selector: "@e1", text: "hello" },
  { kind: "click", selector: "@e2" },
  { kind: "snapshot" }
] } })

# Extract text
browser({ action: "text" })

# Evaluate JavaScript
browser({ action: "evaluate", expression: "document.title" })
```

### Backend selection

agent-browser is the browser backend. It provides reliability checks, snapshot refs, and session management.

### Security

- Public user-controlled fetch/browser URLs accept only HTTP(S), reject credentials, private/reserved literals, localhost, metadata, and Docker hostnames; browser sessions also run system-DNS preflight and frozen domain allowlisting (defense-in-depth, not complete SSRF containment)
- Configured local SearXNG/Ollama/embedding/sidecar/CDP/setup endpoints remain operator-owned paths and are not routed through public URL validation
- Residual risks: DNS rebinding and Chromium DNS TOCTOU after preflight, unrestricted redirects in some fetch paths, and debug-server outbound proxying; container egress remains authoritative outer boundary. See ADR 0003.
- `evaluate`, `set_cookies`, and `batch` are disabled by default; enable with `PI_SEARCH_BROWSER_ALLOW_SENSITIVE=1`
- Cookies return metadata only (name, domain, path, expiry, flags) — values are never exposed
- Error messages sanitized: token/password/secret/authorization patterns stripped (≤2000 chars)
- External tool text (`web_search`, `fetch`, `github`, `social`, `media`, `browser`) is framed as untrusted evidence with a per-result fence token and heuristic injection flags; visible content is never redacted, and framing does not authorize actions or secret access
- Security enforcement is external through containerization and other extensions

### Loopback-only debug mode

When navigating to a loopback address (`localhost`, `127.x.x.x`, `[::1]`), the browser session enters **loopback-only mode**: network is confined to that exact origin (scheme + host + port). All other traffic is blocked — public internet, RFC1918, metadata endpoints, different loopback ports.

```bash
# Navigate to a local dev server — enters loopback-only mode automatically
browser({ action: "navigate", url: "http://localhost:3000" })

# All browser actions work normally within the confined session
browser({ action: "snapshot" })
browser({ action: "click", selector: "@e1" })

# Close to exit loopback mode
browser({ action: "close" })
```

How it works:
- A local enforcing proxy starts on an ephemeral port before the browser launches
- The proxy resolves DNS once at startup and pins the result (prevents DNS rebinding)
- HTTP, WebSocket, and HTTPS CONNECT requests are checked against the pinned origin
- `AGENT_BROWSER_ALLOWED_DOMAINS` blocks cross-domain navigation and sub-resources
- CDP backend fails closed on loopback targets (clear error message)
- Same loopback origin reuses the adapter; different origins are rejected
- Browser capabilities (click, type, fill, evaluate, etc.) remain unchanged

Limitations:
- Cross-port HMR is blocked by design (only same-port HMR allowed)
- Container egress remains the outer defense boundary
- The debug server itself can still proxy outbound traffic (outside browser boundary)

Batch and job commands cannot target loopback URLs — use top-level `navigate` to enter loopback mode.

## Desktop automation

`desktop` tool provides native desktop observation and interaction via [Cua Driver](https://github.com/trycua/cua).

> Privacy: optional paid backends (Diffbot) transmit queries/URLs/selectors/text externally — see [Diffbot privacy warning](#diffbot-privacy-warning-read-before-installing).

### Installation

Cua Driver is optional and disabled by default. To enable:

1. Download [Cua Driver v0.7.1](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.7.1) for your platform:
   - **macOS**: Download `cua-driver-aarch64-apple-darwin` (Apple Silicon) or `cua-driver-x86_64-apple-darwin` (Intel)
   - **Linux**: Download `cua-driver-x86_64-unknown-linux-gnu`
   - **Windows**: Download `cua-driver-x86_64-pc-windows-msvc.exe`

2. Make it executable and place it on your `$PATH` (typically `/usr/local/bin`):

```bash
chmod +x cua-driver
sudo mv cua-driver /usr/local/bin/
```

3. Grant permissions (one-time, OS-dependent):
   - **macOS**: First run prompts for Accessibility (System Settings > Security & Privacy)
   - **Linux**: May require `sudo` or xinput permissions
   - **Windows**: Run as Administrator the first time

4. Enable the tool:

```bash
export PI_SEARCH_DESKTOP_AUTOMATION="1"
```

Optionally configure the driver path:

```bash
export CUA_DRIVER_PATH="/usr/local/bin/cua-driver"
```

### Capabilities

`desktop` supports these actions:

| Action | Parameters | What it does |
|--------|-----------|------|
| `status` | none | Check Cua Driver health and permissions |
| `list_apps` | none | List running applications |
| `list_windows` | none | List open windows across all apps |
| `observe_window` | `pid: number`, `windowId: string`, `includeScreenshot?: boolean` | Get accessibility tree (AX) for a window; optionally screenshot |
| `click` | `pid: number`, `windowId: string`, `x: number`, `y: number`, `stateId: string` | Click at coordinates (requires fresh state ID) |
| `type_text` | `pid: number`, `windowId: string`, `text: string`, `stateId: string` | Type text (requires fresh state ID) |
| `press_key` | `pid: number`, `windowId: string`, `key: string`, `stateId: string` | Press a key (e.g., "Return", "Escape") |
| `scroll` | `pid: number`, `windowId: string`, `deltaX?: number`, `deltaY?: number`, `stateId: string` | Scroll by pixel delta (requires fresh state ID) |
| `wait` | `pid: number`, `windowId: string`, `predicate?: {text?, role?}`, `timeoutMs?: number` | Poll until text/role appears in AX tree (default 30s timeout) |

### Examples

```bash
# Check driver health
desktop({ action: "status" })

# List windows
desktop({ action: "list_windows" })

# Observe a window's accessibility tree
desktop({ action: "observe_window", pid: 1234, windowId: "main-window", includeScreenshot: false })

# Observe with screenshot
desktop({ action: "observe_window", pid: 1234, windowId: "main-window", includeScreenshot: true })

# Interact (requires stateId from observe_window response)
desktop({ action: "click", pid: 1234, windowId: "main-window", x: 100, y: 200, stateId: "state-123" })
desktop({ action: "type_text", pid: 1234, windowId: "main-window", text: "hello", stateId: "state-123" })

# Wait for text to appear
desktop({ action: "wait", pid: 1234, windowId: "main-window", predicate: { text: "Save" }, timeoutMs: 5000 })
```

### State IDs

Mutations (click, type, press_key, scroll) require a fresh `stateId` from the most recent `observe_window` call. After each mutation, you must call `observe_window` again to get a new state ID before the next mutation. This ensures:

- State consistency: AX tree matched to real state
- Atomicity: mutations are serialized and never retried after dispatch
- Isolation: transport loss yields `OUTCOME_UNKNOWN` (no blind retries)

### Screenshots

- Optional via `includeScreenshot: true` in `observe_window`
- Returns as inline base64 image content
- **Sensitive**: screenshots can expose PII/credentials — close sensitive apps before capturing; the extension does not close apps on your behalf
- Returns PNG with window content, resolution capped at 10 000×10 000 pixels (desktop screenshot via Cua Driver). Browser (`screen‑shot`) screenshots are capped at 8 000×8 000 pixels (configured in agent-browser adapter).

### Observations

- AX (Accessibility) tree is AX-only by default; includes element names, roles, values, but not visual pixel data
- Tree depth capped at 32 levels; node count capped at 1 000
- Redacts sensitive fields: passwords, tokens, secrets, paths
- Screenshot bytes capped at 10 MB (prevents large binaries)
- Tool outputs additionally bounded via guardText (default 60k chars); strings >10k chars go through guardText with a 60k cap (head+tail kept) after secret redaction; data/details payloads exceeding 120k chars are replaced with a guardText-bounded summary

### Permissions

Cua Driver relies on OS-level permissions. The extension does not request, revoke, or monitor them:

- **macOS**: macOS may show an Accessibility prompt; grant access in System Settings > Privacy & Security > Accessibility.
- **Linux**: X11 or Wayland permissions vary by desktop.
- **Windows**: Some actions may require Administrator privileges.

Permissions are user-owned and persist across sessions. Session shutdown cannot revoke grants.

### Security & Privacy

- Not registered by default — set `PI_SEARCH_DESKTOP_AUTOMATION=1` to register it
- Observation is AX-only by default; screenshots require explicit opt-in
- Screenshots and AX trees can expose sensitive information — only use with trusted applications
- Mutations are serialized per window; transport loss is not retried
- Confirmation tiers: type_text/press_key require explicit human confirmation in TUI and fail closed headless; scroll/click ungated — operator must close sensitive apps
- Redaction is applied to output (passwords, tokens, paths removed before AI sees them)

## Package contract

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```
