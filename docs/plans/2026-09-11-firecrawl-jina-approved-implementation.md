# Approved Firecrawl and Jina Implementation Plan

> **FINAL OVERRIDES (supervisor, binding — supersede any conflicting section below):**
> - Selection/AI controls are environment-only. No NEW JSON mappings. No model-facing
>   provider/budget/AI flags. Backend provenance IS allowed.
> - Firecrawl FETCH summary must honor `PI_SEARCH_NATIVE_SUMMARIES=0`: when disabled,
>   the scrape request MUST NOT include the summary format and the adapter MUST emit
>   no generated summary item — despite any unconditional `formats: ["markdown",
>   {type:"summary"}]` wording below. Conditional format, conditional item.
> - Search: Firecrawl summary-on → `limit = min(requestedLimit, 3)`, one search call,
>   no second unsummarized call; summary-off → `limit = min(requestedLimit, 10)`.
> - No model authorization-attestation field; no sensitive/personal excerpts to KG.
> - Keep: research isolation, canonical entity compatibility, fixed-vendor credential
>   isolation, DNS/URL public validation, cancellation, response bounds (1,000,000-byte
>   vendor response max; 50,000-char retained page content; 8,000-char generated item),
>   Python allowlist, untrusted framing. No retries.

> **For agentic workers:** Run after shared contracts from approved web-search plan.
> Firecrawl and Jina workers own disjoint adapter files. Runtime integration remains
> single-owner under web-search plan.

**Goal:** Add Firecrawl/Jina search and environment-gated ordered external page-fetch fallback behind existing `web_search` and `fetch` tools.

**Approach:** Fixed vendor endpoints, strict response normalization, local public-target admission before remote fetch, no credential/header/cookie forwarding, one request per adapter attempt, no retries.

**Riskiest assumption:** Remote vendors control their own redirect behavior after receiving an admitted public URL. Local validation cannot verify vendor-side redirect hops.

## Dependencies

Consumes frozen contracts from:

```text
src/web-search-types.ts
src/web-provider-policy.ts
src/web-native-ai.ts
src/http.ts
src/network-policy.ts
src/web-contract.ts
```

No new dependency.

## Official API evidence

- Firecrawl Search: `POST https://api.firecrawl.dev/v2/search`
  - official schema supports `sources:["web"]`, `highlights`, and `scrapeOptions.formats:[{type:"summary"}]`.
- Firecrawl Scrape: `POST https://api.firecrawl.dev/v2/scrape`
  - official schema supports `formats:["markdown",{type:"summary"}]`, `onlyMainContent`, and response `data.markdown`/`data.summary`.
  - Answer appears only when question format requested; this integration never requests question format.
  - OVERRIDE: summary format/item conditional on `PI_SEARCH_NATIVE_SUMMARIES` (see header).
- Jina Search: `GET https://s.jina.ai/?q=<encoded-query>`
  - `Accept: application/json` returns five structured entries.
- Jina Reader: `GET https://r.jina.ai/<validated-public-url>`
  - `Accept: application/json` returns URL/title/content.
- No live paid calls used while planning.

## Bounds

### Search

- One external request per selected Firecrawl/Jina search adapter.
- Firecrawl:
  - summaries on: `limit = min(requestedLimit, 3)`;
  - summaries off: `limit = min(requestedLimit, 10)`;
  - web source only;
  - provider deadline from shared search policy, default 12 seconds.
- Jina Search:
  - service returns five entries;
  - accept `min(requestedLimit, 5)`;
  - no AI summary/answer representation;
  - provider deadline from shared search policy.
- Both count toward global maximum eight provider search calls.
- No retry or second unsummarized Firecrawl call.

### Fetch

- Existing request `maxChars`: unchanged `1..50000`.
- Vendor response bytes: maximum 1,000,000.
- Vendor page content retained: maximum 50,000 characters.
- Generated Firecrawl fetch summary: maximum 8,000 characters, emitted only when
  `PI_SEARCH_NATIVE_SUMMARIES` is enabled (override).
- Provider timeout: `PI_SEARCH_FETCH_PROVIDER_TIMEOUT_MS`, default 15,000, range `1000..30000`.
- Maximum external providers: two.
- Attempts sequentially in exact `PI_SEARCH_FETCH_BACKENDS` order.
- No retry.

## Task 1: Firecrawl adapter

**Files**

- Create `src/firecrawl.ts`
- Create `test/firecrawl.test.ts`

**Exports**

```ts
export const FIRECRAWL_SEARCH_ENDPOINT =
  'https://api.firecrawl.dev/v2/search';
export const FIRECRAWL_SCRAPE_ENDPOINT =
  'https://api.firecrawl.dev/v2/scrape';
export const FIRECRAWL_SEARCH_RESULT_MAX = 10;
export const FIRECRAWL_SEARCH_SUMMARY_RESULT_MAX = 3;
export const firecrawlSearchAdapter: WebSearchAdapter;
export const firecrawlFetchAdapter: WebFetchAdapter;
```

### Search request

Summary enabled:

```json
{
  "query": "<query>",
  "limit": "min(requestedLimit,3)",
  "sources": ["web"],
  "highlights": true,
  "scrapeOptions": {
    "formats": [{ "type": "summary" }],
    "onlyMainContent": true
  }
}
```

Summary disabled:

```json
{
  "query": "<query>",
  "limit": "min(requestedLimit,10)",
  "sources": ["web"],
  "highlights": true
}
```

Transport: `POST`, `Authorization: Bearer <FIRECRAWL_API_KEY>`, JSON content type,
fixed endpoint, redirects rejected, composed timeout/caller signal, one request.

Normalization: require object, `success === true`, `data.web` array; accept only HTTP(S)
row URLs; `description`/highlights supply original snippet; `summary` supplies separate
generated item only; drop malformed siblings; invalid container rejects; never expose raw
payload, request ID, or token.

### Fetch request

Before vendor call:

1. `validateHttpUrl(target)`.
2. `resolvePublicHostname(target.hostname, signal, lookup)`.
3. Only then call fixed Firecrawl endpoint.

```json
{
  "url": "<validated-public-url>",
  "formats": ["markdown", { "type": "summary" }],
  "onlyMainContent": true,
  "timeout": "<bounded-provider-timeout-ms>"
}
```

OVERRIDE: when `PI_SEARCH_NATIVE_SUMMARIES` is disabled, `formats` is `["markdown"]`
only and no summary item is emitted.

Explicit exclusions: no question format; no answer; no actions; no screenshot/raw
HTML/JSON; no caller headers; no cookies; no proxy; no browser state; no
`skipTlsVerification`; no unsupported retention promise.

Response: require `success === true`; content from `data.markdown`; summary from
`data.summary` as separate generated item (override-gated); title from bounded
`data.metadata.title`; resolved URL only if valid HTTP(S), else submitted URL; ignore
unexpected answer.

### Firecrawl tests

Exact endpoints/method/headers/payload; summary-on ≤3 rows one request; summary-off ≤10;
summary never snippet; fetch formats conditional per override (markdown+summary vs
markdown-only); private/reserved/credentialed URL rejected pre-call; DNS private answer
rejected pre-call; caller cookie/header absent; redirect rejected; 402/429/5xx no retry;
oversize/malformed rejected safely; abort propagation; sentinel token absent.

## Task 2: Jina adapter

**Files**

- Create `src/jina.ts`, `test/jina.test.ts`

**Exports**

```ts
export const JINA_SEARCH_ENDPOINT = 'https://s.jina.ai/';
export const JINA_READER_PREFIX = 'https://r.jina.ai/';
export const JINA_SEARCH_RESULT_MAX = 5;
export const jinaSearchAdapter: WebSearchAdapter;
export const jinaFetchAdapter: WebFetchAdapter;
```

Search: `GET https://s.jina.ai/?q=<encodeURIComponent(query)>`, `Accept: application/json`,
bearer key, fixed origin, redirects rejected, one request no retry, require JSON envelope
with `data` array, HTTP(S) URLs, slice `min(requestedLimit,5)`, `generatedText: []`.
Reader: validate + DNS preflight, then `GET https://r.jina.ai/<validated-public-url>`;
no `X-Set-Cookie`/caller auth/headers; require object `data` with nonempty `content`;
map bounded title/url/content; `backend:"jina"`, `externalProcessing:true`.

## Task 3: Ordered external-fetch policy

**Files**

- Create `src/web-fetch-providers.ts`, `test/web-fetch-providers.test.ts`

Gate requires `PI_SEARCH_EXTERNAL_FETCH=1/true`. Blank backend list → no attempts.
Reject duplicate/unknown/>2 IDs pre-call. Skip unconfigured with diagnostic; sequential;
stop at first valid nonempty page; no concurrent extraction. Eligible native failures:
transport/network, non-caller timeout, 401/403/429, retryable 5xx, empty/unusable
extraction. Ineligible: policy/URL/DNS/caller-abort/size/404/410/sparse-text/disabled.

## Task 4: Runtime integration handoff

Owned by web-search runtime worker, not adapter workers. Files: `src/web.ts`, `test/web.test.ts`.
Sequence in `fetchReadablePage`: Scrapling → plain validated fetch → existing Diffbot
Analyze fallback → gated Firecrawl/Jina order. Native/Diffbot success unchanged; policy/
size/404/410 failures never reach vendors; external metadata on result; `agenticBrowse`
and semantic crawl inherit via `fetchReadablePage`; `src/native-tools.ts` unchanged;
external success after native exhaustion = degraded outcome; Firecrawl summary separate;
Jina emits none; untrusted framing preserved.

## Task 5: Registry/config integration handoff

Owned by config/registry worker from web-search plan. Firecrawl channel/provider
(backends `firecrawl-search`/`firecrawl-scrape`, actions `search`/`read`, key
`FIRECRAWL_API_KEY`, no cookies, external-processing warning); Jina channel/provider
(backends `jina-search`/`jina-reader`, actions `search`/`read`, key `JINA_API_KEY`,
no cookies, external-processing warning). Singular channels + additive web membership,
matching Diffbot pattern. Env-only wiring; no new JSON mappings (override).

## Security acceptance

Credentials only to fixed vendor host; target validated + DNS-preflighted pre-call; no
cookies/browser-state/caller-headers/proxy/caller-auth forwarded; external content
untrusted; zero retries; vendor redirect/retention residual risk; no claim preflight
constrains vendor hops.

## Focused verification

```bash
node --import tsx --test \
  test/web-search-types.test.ts \
  test/firecrawl.test.ts \
  test/jina.test.ts \
  test/web-fetch-providers.test.ts \
  test/web.test.ts \
  test/index.test.ts \
  test/local-config.test.ts \
  test/cli-backend.test.ts \
  test/providers.test.ts \
  test/capabilities.test.ts \
  test/bootstrap.test.ts \
  test/python-child-env.test.ts \
  test/network-policy.test.ts \
  test/untrusted-content.test.ts
npm run typecheck
npm test
git diff --check
git status --short
```

## Exact worker ownership and execution order

1. **Contracts — first, exclusive:** `src/web-search-types.ts`, `test/web-search-types.test.ts`
2. **Concurrent after contracts:** Policy/AI, Exa/Tavily, Firecrawl, Jina, Knowledge, Fetch routing (disjoint files)
3. **Config/registry — after adapter exports stabilize**
4. **Runtime — one owner only** (`src/web.ts`, `src/web-contract.ts`, tests)
5. **Tool/schema — after runtime** (`src/index.ts`, test)
6. **Docs — last** (`README.md`, `SKILL.md`)

No worker owns `src/native-tools.ts`, standalone knowledge modules, research adapters, network policy, Python environment code, or unrelated files.

Risks: vendor-side fetch redirects (High); sensitive-text detection false negatives (Medium, dual-gated); Firecrawl schema drift (Medium); explicit-8 cost (Medium); ordering/recall changes (Low, intentional).

Source: oracle run `7c414ad5-4bba-486f-99d3-142a435dc108` (`output-0.log`) with FINAL OVERRIDES applied.
