# Approved Web Search Implementation Plan

> **FINAL OVERRIDES (supervisor, binding — supersede any conflicting section below):**
> - Selection/AI controls are environment-only. No NEW JSON mappings for selection/AI
>   policy (`PI_SEARCH_WEB_BACKENDS`, `PI_SEARCH_WEB_PROVIDER_TIMEOUT_MS`,
>   `PI_SEARCH_NATIVE_SUMMARIES`, `PI_SEARCH_NATIVE_ANSWERS`, `PI_SEARCH_KG_ENRICHMENT`,
>   `PI_SEARCH_EXTERNAL_FETCH`, `PI_SEARCH_FETCH_BACKENDS`, `PI_SEARCH_FETCH_PROVIDER_TIMEOUT_MS`).
>   Preserve pre-existing unrelated mappings; add none.
> - No model-facing provider/budget/AI flags. No model authorization-attestation field.
> - Backend provenance IS allowed and retained.
> - Absent/blank allowlist → top-3 configured. Explicit → all runnable concurrent, max 8;
>   reject >8/duplicate/unknown before any calls. Uniform RRF including Codex. No retries.
> - Native summaries/answers env default-on. Firecrawl FETCH summary must also honor
>   `PI_SEARCH_NATIVE_SUMMARIES=0` despite any unconditional format wording below.
> - Search Firecrawl summary-on: max 3 rows, one call. Summary-off: max 10.
> - No known/suspected sensitive/personal excerpt to KG. Gates do not prove absence of
>   sensitivity. Public Person/Organization name/homepage only where safe, no contact selectors.
> - Keep: research isolation, canonical entity compatibility, fixed-vendor credential
>   isolation, DNS/URL public validation, cancellation, response bounds, Python allowlist,
>   untrusted framing.

> **For agentic workers:** Implement task-by-task in order. Use checkbox steps. Behavioral changes use vertical RED→GREEN cycles.

**Goal:** Add bounded environment-selected concurrent web search, uniform deterministic RRF, separately represented provider-native AI, and optional safe public-excerpt knowledge composition.

**Approach:** Freeze small shared contracts first. Keep provider selection environment-only. Reuse existing result, URL, network, knowledge, configuration, and untrusted-content contracts. Avoid generic orchestration framework.

**Riskiest assumption:** Vendor response formats remain compatible with documented schemas. Validate every response defensively; malformed provider output becomes provider failure without destroying valid siblings.

## Baseline

- Branch: `main`
- Initial worktree: clean
- Initial staged files: none
- `HEAD`: `258192212d65db0540d30a979717438c67f70b33`
- `origin/main`: same after `git fetch origin main`
- Target plan path did not exist.
- Before every implementation stage: run `git status --short`; stop on ownership collision.

## Approved behavior

### Search selection

Built-in automatic preference:

```text
tavily → exa → brave → diffbot → firecrawl → jina → searxng → ollama-search → duckduckgo
```

Codex is explicit-only.

- Missing or blank `PI_SEARCH_WEB_BACKENDS`:
  - Filter preference to configured/runnable adapters.
  - Dispatch first three concurrently.
  - No replenishment after dispatch.
- Explicit nonblank `PI_SEARCH_WEB_BACKENDS`:
  - Parse caller order.
  - Reject duplicate, unknown, or more than eight IDs before dispatch.
  - Filter unavailable/unconfigured entries, recording them as unavailable.
  - Dispatch every remaining listed adapter concurrently.
  - Never add unlisted providers.
  - If none runnable, return backend-unavailable failure.
- Maximum provider dispatches/search call: eight.
- Provider deadline default: 12,000 ms.
- No provider retries, including free providers.
- DuckDuckGo uses one HTML-search request directly; remove Instant Answer→HTML second-call behavior.
- Caller abort cancels active requests and launches nothing else.

### Fusion

- Apply RRF uniformly to every fulfilled nonempty ranking, including Codex.
- Deduplicate by existing `normalizeUrl`.
- Stable tie order:
  1. higher RRF score;
  2. earliest selected-provider index;
  3. earliest provider-local rank;
  4. normalized URL lexical order.
- First provider in selected order supplies retained title/snippet for duplicate URL.
- Record all `{backend, rank}` contributors.
- Backend provenance remains visible.
- Provider-native scores remain diagnostic only.

### Native AI

- Environment-only controls; absent/blank means enabled:
  - `PI_SEARCH_NATIVE_SUMMARIES`
  - `PI_SEARCH_NATIVE_ANSWERS`
- Accepted values, case-insensitive: `1`, `true`, `0`, `false`. Reject other nonblank values before dispatch.
- No tool-schema AI toggles.
- Generated text never replaces retrieval snippet.
- Exa summaries: result-URL provenance.
- Tavily answer: supporting-result-set provenance, not claim citations.
- Firecrawl summaries: result-URL provenance.
- Never merge or synthesize answers.
- Empty answer or answer without supporting result URLs is omitted.
- Generated item: maximum 8,000 characters.
- Generated collection: maximum 32 items.

### Knowledge composition

Model-facing optional request:

```ts
knowledge?: {
  entities?: boolean;
  facts?: boolean;
  topics?: boolean;
  sentiment?: boolean;
  enhance?: boolean;
}
```

- Requires `PI_SEARCH_KG_ENRICHMENT=1` plus at least one requested flag.
- No provider selector, budget, contact selector, or authorization-attestation field.
- Analyze only first three fused results with nonempty original retrieval snippets.
- Maximum excerpt length: existing `WEB_ENTITY_CONTENT_MAX` 8,000 characters.
- Never submit summaries, answers, generated text, page fetch content, email selectors, or phone selectors.
- Skip suspected sensitive/personal excerpts without echo:
  - email-like contact text;
  - phone-like contact text;
  - `category:"people"`;
  - obvious personal-profile URLs such as LinkedIn `/in/` or common social-profile hosts.
- Skip result shape:

```ts
{ url: string; reason: 'suspected_sensitive_or_personal' | 'empty_excerpt' }
```

- Detection is defense-in-depth, not proof content is non-sensitive.
- Optional Enhance applies only to normalized Person/Organization entities, maximum three total, one result/entity, name plus validated public homepage only.
- Existing strict `KgEntity`, `KgClaim`, `KgMention`, and aggregate behavior remain authoritative.
- Salience is not supported by current canonical knowledge/provider output. Report:

```ts
salience: {
  status: 'unavailable';
  reason: 'provider_unsupported';
}
```

Never derive or fabricate salience.

## Frozen shared contracts

Create `src/web-search-types.ts` (exact frozen shape; see Task 1 — provider IDs,
`WebProviderSearchInput/Output`, `WebSearchHit`, `WebFusedSearchHit`, `WebGeneratedText`
discriminated union, `WebSearchAdapter`, `WebProviderFailure`, `WebSearchExecution`,
`WebKnowledgeRequest/Result`, `WebFetchAdapterInput`, `WebFetchedPage`, `WebFetchAdapter`,
plus constants `DEFAULT_WEB_SEARCH_PROVIDER_ORDER`, `DEFAULT_WEB_SEARCH_PROVIDER_COUNT = 3`,
`MAX_WEB_SEARCH_PROVIDER_COUNT = 8`, `DEFAULT_WEB_SEARCH_PROVIDER_TIMEOUT_MS = 12_000`,
`MIN/MAX_WEB_SEARCH_PROVIDER_TIMEOUT_MS = 1_000/30_000`, `WEB_GENERATED_TEXT_MAX_CHARS = 8_000`,
`WEB_GENERATED_TEXT_MAX_ITEMS = 32`, `WEB_KNOWLEDGE_MAX_RESULTS = 3`).

Do not add fields to strict `WebArticleV1`. `WebFusedSearchHit`, generated text, contributors, and knowledge remain legacy detail partitions beside unchanged `details.northstar`.

## Environment contract

FINAL OVERRIDE: no NEW JSON mappings for selection/AI policy rows below.
Pre-existing unrelated mappings preserved; new mappings prohibited.

| Environment key | Default | Bounds/values | JSON mapping |
|---|---|---|---|
| `PI_SEARCH_WEB_BACKENDS` | automatic top 3 | CSV, unique known IDs, max 8 | none (override) |
| `PI_SEARCH_WEB_PROVIDER_TIMEOUT_MS` | `12000` | integer `1000..30000` | none (override) |
| `PI_SEARCH_NATIVE_SUMMARIES` | enabled | `0/1/false/true` | none (override) |
| `PI_SEARCH_NATIVE_ANSWERS` | enabled | `0/1/false/true` | none (override) |
| `PI_SEARCH_KG_ENRICHMENT` | disabled | `0/1/false/true` | none (override) |
| `FIRECRAWL_API_KEY` | absent | nonblank secret | fixed-vendor credential (existing pattern) |
| `JINA_API_KEY` | absent | nonblank secret | fixed-vendor credential (existing pattern) |
| `PI_SEARCH_EXTERNAL_FETCH` | disabled | `0/1/false/true` | none (override) |
| `PI_SEARCH_FETCH_BACKENDS` | none | ordered unique CSV subset `firecrawl,jina`, max 2 | none (override) |
| `PI_SEARCH_FETCH_PROVIDER_TIMEOUT_MS` | `15000` | integer `1000..30000` | none (override) |

Precedence stays:

```text
process env → .env → JSON only when current key absent/blank → built-in default
```

(existing precedence text preserved; no new JSON keys are introduced by this plan).
Existing relevant credentials/config remain unchanged: Exa, Tavily, Brave, Diffbot, SearXNG, Ollama, Codex.

## Task 1: Freeze shared contracts

**Files**

- Create `src/web-search-types.ts`
- Create `test/web-search-types.test.ts`

**Checks**

- RED: imports/types/constants unavailable.
- GREEN: provider IDs, discriminated generated text, limits, and adapter contracts typecheck.
- Verify generated answer requires non-citation provenance shape.
- Verify canonical `WebArticleV1` remains unchanged and rejects generated/contributor fields.

```bash
node --import tsx --test test/web-search-types.test.ts test/web-contract.test.ts
npm run typecheck
```

## Task 2: Implement provider selection and native-AI policy

**Files**

- Create `src/web-provider-policy.ts`
- Create `src/web-native-ai.ts`
- Create `test/web-provider-policy.test.ts`
- Create `test/web-native-ai.test.ts`

(Exports, required tests per oracle: missing/blank allowlist → first three configured
preference entries; Codex excluded automatically; explicit order preserved; runnable subset
executes with unavailable recorded; duplicates/unknown/ninth reject before calls; no
replenishment; invalid timeout/boolean fails before calls; timeout composes with caller
abort; AI default-on, opt-out, malformed rejection; generated-text limits, empty removal,
URL dedup.)

## Task 3: Extract Exa and Tavily adapters

**Files**

- Create `src/web-exa.ts`, `test/web-exa.test.ts`
- Create `src/web-tavily.ts`, `test/web-tavily.test.ts`

Exa: `POST https://api.exa.ai/search`, `numResults = min(limit,10)`, snippet from
highlights/text never summary, one request no retry, 1,000,000-byte response max.
Tavily: `POST https://api.tavily.com/search`, `max_results = min(limit,20)`,
`result.content` stays snippet, answer separate with supporting URLs only.
Payload-capture tests assert no key in error/output.

## Task 4: Add optional knowledge composition

**Files**

- Create `src/web-knowledge-composition.ts`, `test/web-knowledge-composition.test.ts`

Uses existing Diffbot adapters through small runtime bindings. No modification to
standalone `kg` behavior. Tests: omitted/disabled gate makes zero calls; top-three
original snippets only; generated text never submitted; email/phone/people/profile
skipped safely with no echo; no email/phone Enhance selectors; Enhance max three;
partial failures preserve search; salience unavailable; sentinel secrets absent.

## Task 5: Integrate search runtime and semantic discovery

**Files**

- Modify `src/web.ts`, `src/web-contract.ts`, `test/web.test.ts`, `test/web-contract.test.ts`

Both `webSearch` and `semanticSourceUrls` call shared selection policy; concurrent
dispatch with composed timeout signals; remove retry helper; uniform fusion; DuckDuckGo
single HTML request; SearXNG/Ollama operator-owned (no public URL validation); attach
`details.results/nativeAi/knowledge/fusion`; canonical articles from core hit fields only;
research path untouched; optional validated `knowledge` on request input.

## Task 6: Tool schema and routing

**Files**

- Modify `src/index.ts`, `test/index.test.ts`

Optional nested `knowledge` booleans on `web_search` only. No provider/budget/AI/fetch-backend
flags. `buildSearchRoute` copies knowledge for non-research; reject knowledge for
`category:"research"` before dispatch.

## Task 7: Configuration, registry, CLI, bootstrap-visible state

**Files**

- Modify `src/local-config.ts`, `src/cli-backend.ts`, `src/providers.ts`,
  `src/capabilities.ts`, `.env.example`, plus corresponding tests.

Env-only wiring (no new JSON mappings per FINAL OVERRIDE). CLI child allowlist forwards
only named web config + provider credentials. Python child allowlist unchanged. Firecrawl/Jina
descriptors/capabilities added. Setup/bootstrap derives configured state, never values.
Diffbot note: ordinary RRF participant. Legacy `SEARCH_WEB_BACKENDS` ignored.

## Task 8: Documentation

**Files**

- Modify `README.md`, `SKILL.md`

Document selection semantics, env vars + bounds, provenance, generated-text separation +
non-citation warning, knowledge privacy gates + false-negative risk, external processing,
no retries, research/`kg` isolation.

## Full verification

```bash
node --import tsx --test \
  test/web-search-types.test.ts \
  test/web-provider-policy.test.ts \
  test/web-native-ai.test.ts \
  test/web-exa.test.ts \
  test/web-tavily.test.ts \
  test/firecrawl.test.ts \
  test/jina.test.ts \
  test/web-knowledge-composition.test.ts \
  test/web-fetch-providers.test.ts \
  test/web-contract.test.ts \
  test/web.test.ts \
  test/index.test.ts \
  test/local-config.test.ts \
  test/cli-backend.test.ts \
  test/providers.test.ts \
  test/capabilities.test.ts \
  test/bootstrap.test.ts \
  test/python-child-env.test.ts \
  test/untrusted-content.test.ts
npm run typecheck
npm test
git diff --check
git status --short
```

Source: oracle run `7c414ad5-4bba-486f-99d3-142a435dc108` (`output-0.log`) with FINAL OVERRIDES applied.
