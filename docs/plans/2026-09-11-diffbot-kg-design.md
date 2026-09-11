# Diffbot Knowledge Graph Design (Approved)

> **Status: Approved.** Do not reopen product choices. Implementation plan: `docs/plans/2026-09-11-diffbot-kg-implementation-plan.md`.

**Goal:** Native TypeScript Diffbot adapters in Pi-Northstar: Diffbot-backed `web_search`, Analyze-GET fallback for direct read/semantic fetch, new lowercase `kg` tool (`search`/`enhance`/`analyze_text`), `pi-northstar.knowledge-result` v1 envelope. CLI (`diffbot-cli` checkout) is semantic reference only, never runtime dependency.

**Authority order:** canonical Diffbot docs > this design > CLI behavior. CLI divergences from docs lose.

## 1. Non-goals (excluded)

Account, crawl, bulk, bulk enhance, facets, reports, exports, collections, persistence/cache, adjudication, provider-native options, enhance `refresh`. No account quota probe. No automatic paid retries.

## 2. Sources

- Overview: https://www.diffbot.com/docs/
- Auth: https://www.diffbot.com/docs/authentication
- Extract/Analyze: https://www.diffbot.com/docs/extract/article
- DQL search: https://www.diffbot.com/docs/dql/post
- Enhance: https://www.diffbot.com/docs/enhance/post
- Web Search: https://www.diffbot.com/docs/web-search/post
- Crawl create (excluded, boundary ref): https://www.diffbot.com/docs/crawl/create
- Bulk create (excluded, boundary ref): https://www.diffbot.com/docs/bulk/create
- NL process text: https://www.diffbot.com/docs/natural-language/process-text
- Account (excluded, boundary ref): https://www.diffbot.com/docs/account
- CLI reference: `/Users/rhinesharar/diffbot-cli/bin/diffbot.js`, `/Users/rhinesharar/diffbot-cli/SKILL.md`

## 3. Transport and security contract

- `DIFFBOT_TOKEN` only. No other token env. Never forward token to unrelated CLI/Python children (all three Python spawn sites in `src/scrapling-bridge.ts`, `src/sidecar-manager.ts` keep `buildPythonChildEnvironment()`; Diffbot fetch uses undici `fetch`, never child process).
- Fixed hosts: `llm.diffbot.com` (web search, Bearer), `kg.diffbot.com` (DQL search, Enhance, `?token=`), `nl.diffbot.com` (analyze_text POST), `api.diffbot.com` (Analyze GET fallback, `?token=`). No host override option in v1.
- Bounded bodies (`safeResponseJson`/`safeResponseText` caps), per-request timeout + `AbortSignal` cancellation on every call.
- No redirects with credentials: Bearer/`?token=` requests use `fetchJsonNoRedirect` semantics (`src/http.ts`); redirect hop rejects, never follows. Analyze-GET target fetch validates target URL first via `validateHttpUrl` + `resolvePublicHostname`; Diffbot-side fetching does not bypass target validation.
- No logs/cache: token never logged; no persistence of responses; no disk cache.
- Error/output redaction: token and sensitive selectors (email/phone) redacted from errors/output. Error messages slice to 500 chars max following `src/web.ts` pattern.
- HTTP-200 error-envelope validation: Diffbot returns application errors inside 200 OK (`error`/`errorCode` fields, cf. CLI `apiRequest`). Every 200 body checked for `error`/`errorCode` before treating as success.
- No automatic paid retries: `retryWithBackoff` only on retryable transport (5xx, ECONNREFUSED, timeout); never retry `unsupported_option`, policy/input/abort/size/security/contract failures, HTTP-200 error envelopes, or `response_too_large`.

## 4. web_search integration

- Diffbot joins existing `web_search` in `src/web.ts` as one more `WebSearchBackend` (`name: 'diffbot'`), alongside codex/duckduckgo/searxng/brave/exa/tavily/ollama-search. Entry in `WEB_BACKEND_PREFERENCE.search` (exact rank fixed in implementation plan Task 5.1).
- Request: `POST https://llm.diffbot.com/api/v1/web_search` with `Authorization: Bearer <token>`, body `{text, size, maxTokens?}`. (CLI uses legacy GET `?text=&size=&maxTokens=`; docs authority is POST — v1 uses POST.)
- `configured()` true iff `DIFFBOT_TOKEN` set. Unconfigured: backend skipped silently (existing behavior for unconfigured backends); no behavior change without token.
- Existing `dedupeBy`/`normalizeUrl`, `collectBackendOutcome`, `composePrimaryFirst`, RRF fusion reused as-is. Source label `diffbot`. No primary weighting (unlike codex): Diffbot results enter RRF rankings, never `primary`.
- `buildSearchRoute` in `src/index.ts` unchanged (request schema unchanged).

## 5. Analyze GET fallback (direct read + semantic fetch)

- Recoverable fallback only, after native/Scrapling exhaustion. Eligibility: network/upstream error, blocked response, timeout, empty/unusable content. Never: policy/input/abort/size/security/contract failures.
- Target URL validated first (`validateHttpUrl` + `resolvePublicHostname`), same as `fetchReadablePage` in `src/web.ts`.
- Request: `GET https://api.diffbot.com/v3/analyze?url=&token=&fields=allContent,links` (fields `allContent,links` fixed in v1).
- Existing chunk (`src/chunker.ts`)/BM25 (`src/bm25.ts`)/embedding (`src/embedding-client.ts`)/RRF (`src/fusion.ts`) pipeline unchanged; fallback supplies page text only.
- Shared per-fetch fallback budget: default 3, operator configurable, hard ceiling 25, zero disables. Counts Analyze-GET calls per fetch invocation.
- Successful fallback marks envelope `degraded` (execution-path degradation only), outcome metadata `path: 'fallback'`, `provider: 'diffbot'`, safe primary failure recorded, `qualityImpact: 'not_assessed'`. `degraded` never implies content-quality judgment.

## 6. kg tool (new, lowercase)

- Tool name `kg`, actions `search`/`enhance`/`analyze_text`. Registered in `src/index.ts` next to `web_search`/`fetch`/`social`/`media`; dispatched via `src/native-tools.ts` (`dispatchNativeTool` switch, wrapped by `callNativeTool` + `guardResult`).
- Public request uses portable intent only. No `nativeOptions` in v1 — automatic routing accepts only portable semantics.
- Explicit allowlist mismatches (e.g. unknown `fields` value, unsupported provider for an action) return per-provider `unsupported_option` partition while capable providers run; never silently skip.

## 7. Capability registry and routing

- Internal capability registry drives routing: new `src/knowledge-capabilities.ts` (or extension of `src/capabilities.ts` — plan fixes exact file) mapping action → capable providers with priority order.
- `providers` omitted: deterministic highest-priority capable configured provider; sequential fallback only on recoverable transport/contract/semantic failures, never same-provider paid retry; no hidden fanout.
- `providers` explicit: matching configured providers run concurrently; incompatible provider gets typed `unsupported_option` partition + aggregate partial; never silently skip.
- Provider descriptor evolution is additive: multiple Diffbot channels added while legacy singular channel behavior remains (`src/providers.ts`, `src/capabilities.ts`).

## 8. search (DQL)

- `language: 'dql'` fixed in v1. Entity-returning DQL only.
- Reject with `unsupported_option`: facet/report/export/collection/crawl modes (detect `from`/`filter`-as-facet, `format` beyond json, collection/crawl syntax).
- Results normalized/deduped (`normalizeUrl`, first-wins), then RRF across providers.
- Cursor: opaque, encoded not signed. Auto/single-provider mode issues cursor and accepts it. Explicit multi-provider fanout: one bounded page, no cursor. Cursor payload `{v: 1, provider, fingerprint, adapterCursorV, state}` — includes schema version, provider, request fingerprint (query+providers+limit hash), adapter cursor version, typed state. Treated hostile: validate every field on decode; mismatch → `cursor_invalid`/`pagination_not_supported`, never trust.

## 9. enhance

- Selectors: type `Person`/`Organization` + at least one of `id/name/url/email/phone/location/description`, plus Person-only `employer/title/school`. Enforced before dispatch.
- Portable options: `fields` (Atlas-owned enum `basic`/`contact`/`professional`/`all`, projection client-side; omitted/`all` preserves everything), `maxEntities`, `includeRelationships` (false suppresses linked-entity relationship predicates; omitted surfaces explicit ones only, never invents), `includeEvidence`, `confidenceThreshold` 0..1 (filters only rows with explicit numeric confidence below threshold; missing confidence is retained). No `refresh`, no `threshold` passthrough, no `search` passthrough.
- Spend: operator defaults/caps consumed per call (`searchDefault`/`searchCap` from `DIFFBOT_SEARCH_SIZE`, `enhanceDefault`/`enhanceCap` from `DIFFBOT_ENHANCE_SIZE`, NLP cap from `DIFFBOT_NLP_MAX_CHARS`); explicit values above the operator cap reject with `invalid_input` before any paid call, never clamp.

## 10. analyze_text (NLP)

- Input 1..100000 chars (reject outside, never clamp). Options: `extractEntities`/`extractFacts`/`extractSentiment`/`extractTopics` booleans, `language` ISO 639-1 or `auto`.
- Request: `POST https://nl.diffbot.com/v1/?fields=&token=` body `[{content, lang?}]` (CLI-confirmed shape).
- Description text summarizing this endpoint requires user authorization before sensitive text submission; capabilities retained including email/phone extraction. Consent guidance advisory, documented in privacy docs (section 14).
- Mention spans exposed only when validated against original input (offset/length bounds-check; invalid spans dropped row-level).

## 11. Aggregation invariants

- Aggregation does not imply conflict resolution; alignment does not imply arithmetic; normalization is information-preserving within public contract.
- Never invent specificity, collapse ambiguity, infer unsupported relationships, or turn absence into negation.
- `claim.confidence` (provider claim), `alignment.confidence` (cross-provider alignment), future `evidence.strength` stay distinct fields; never merged or renamed into one.
- Alignment basis: `provider_id` / `canonical_url` / `email` / `phone` / `external_identifier` / `typed_identity`; strength `exact` / `strong` / `heuristic`.
- Evidence = traceable provider-supported provenance where available. `evidenceStatus`: `provided` / `not_requested` / `provider_unsupported` / `unavailable`.
- Unknown ontology terms namespaced (`diffbot:<term>`), never raw upstream payload in contract output.

## 12. Invalid-response taxonomy

- `transport_invalid_response` (non-JSON/unreadable body, transport-level): allows auto failover.
- `contract_invalid_response` (JSON but shape violates contract): allows auto failover.
- `semantic_invalid_response` (shape-valid but content unusable, e.g. empty entities when entities expected): allows auto failover.
- `invalid_entity`: row-level; valid siblings survive (partial); all-invalid allows fallback to next provider.
- `response_too_large`/security failures: never retry, never failover-escalate.
- Maps onto existing `NorthstarErrorCode` additively; no existing codes renamed.

## 13. Knowledge output (action-specific)

- New envelope `pi-northstar.knowledge-result` v1 (`src/knowledge-contract.ts` or `src/knowledge-result.ts` — plan fixes exact file): schema/version/status/request/data/pagination/sources/errors/notes, mirroring `src/result-contract.ts` patterns. No raw upstream payload in contract.
- `search`: ranked entities.
- `enhance`: aligned entity groups + provider-traced claims + conflicts + per-entity evidence (`provided`/`not_requested`/`provider_unsupported`/`unavailable`) + per-provider partitions. No raw upstream payload in contract output.
- `analyze_text`: ontology-normalized entities + mentions + facts + topics + sentiment + partitions.
- kg text output wrapped by `wrapUntrustedText` (`src/untrusted-content.ts`); `kg` added to `EXTERNAL_TOOL_NAMES`. Consent guidance advisory, documented.

## 14. Spend defaults, ceilings, privacy

- Defaults (per provider unless noted, all consumed): search 10, enhance 1, NLP 100000 chars, explicit `providers` 3, extract (Analyze fallback) 3. Operator configurable via `DIFFBOT_*` env; `resolveDiffbotSpend` validates once per `kg` call and rejects out-of-range before any paid call, never clamps.
- Hard ceilings: search 50/provider, enhance 10/provider, NLP 100000, providers 8, extract 25.
- Privacy docs warning precedes installation docs: Diffbot receives URLs/text; full selectors retained (email/phone sent when user supplies them); kg text wrapped by untrusted-content marker; consent advisory documented, not enforced in code.

## 15. Additive evolution

- Existing `web_search`/`fetch` request schemas unchanged. No behavior without `DIFFBOT_TOKEN`. Provider descriptor evolves additively for multiple channels; legacy singular channel behavior remains. Legacy detail fields preserved; knowledge envelope attaches additively under `details.northstar` via `northstarTextResult`.

## 16. Excluded from v1 (recheck gate)

Account, crawl, bulk, bulk enhance, facets, reports, exports, collections, persistence/cache, adjudication, provider-native options, enhance refresh. Any implementation task touching these rejects at review.
