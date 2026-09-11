# Diffbot KG Implementation Plan

> **For agentic workers:** Implement task-by-task in order within your owned files only. Track progress with checkboxes. Do not commit. Do not touch files outside your ownership table. Design: `docs/plans/2026-09-11-diffbot-kg-design.md` (Approved).

**Goal:** Native TypeScript Diffbot adapters: Diffbot-backed `web_search`, Analyze-GET fallback for direct read/semantic fetch, new lowercase `kg` tool (`search`/`enhance`/`analyze_text`), `pi-northstar.knowledge-result` v1 envelope.

**Stack:** TypeScript, `diffbotFetch` via `src/diffbot-transport.ts`, `src/fusion.ts` RRF, `src/result-contract.ts` envelope patterns, `src/chunker.ts`/`src/bm25.ts`/`src/embedding-client.ts` pipeline. Zero new npm dependencies.

**Transport (done, read-only):** `src/diffbot-transport.ts` + `test/diffbot-transport.test.ts` already exist. All HTTP adapters (Workers B, C, D) import `diffbotFetch`, `DiffbotError`, `redactDiffbotError`, `resolveDiffbotSpend`, host consts from it. No worker edits those two files.

**Canonical docs (authority):** https://www.diffbot.com/docs/ · auth https://www.diffbot.com/docs/authentication · Analyze https://www.diffbot.com/docs/extract/article (GET) · DQL POST https://www.diffbot.com/docs/dql/post · Enhance POST https://www.diffbot.com/docs/enhance/post · Web Search POST https://www.diffbot.com/docs/web-search/post · NL https://www.diffbot.com/docs/natural-language/process-text. CLI reference only: `diffbot-cli/bin/diffbot.js` (local checkout, not a runtime dependency).

**Delivery status (2026-09-11):** code landed per ownership table; unit-tested with mocked transport only. No live Diffbot integration testing performed; no paid calls made for verification.

**v1 HTTP surface (all via `diffbotFetch`, `?token=` except Bearer web_search):**
- DQL search: `POST https://kg.diffbot.com/kg/v3/dql?token=` JSON body `{type:'query', query, size, from?, filter?}` (canonical DQL POST; legacy GET query-string form is **not** used).
- Enhance: `POST https://kg.diffbot.com/kg/v3/enhance?token=` JSON body `{type, <selectors>, size?, filter?}` (canonical Enhance POST — same enrichment query as JSON body instead of query-string params; no `refresh`/`threshold`/`search` passthrough).
- Web search: `POST https://llm.diffbot.com/api/v1/web_search` Bearer, body `{text, size, maxTokens?}`.
- analyze_text: `POST https://nl.diffbot.com/v1/?fields=&token=` body `[{content, lang?}]`.
- Analyze fallback: `GET https://api.diffbot.com/v3/analyze?url=&fields=allContent,links&token=` (Extract API stays GET).

---

## Global Constraints

- Touch only files listed in your ownership table. No `.pi`/config commits.
- `npm test` green after each task. `npm run typecheck` clean after each task.
- No behavior without `DIFFBOT_TOKEN`. Existing `web_search`/`fetch` schemas unchanged.
- Token/selectors redacted in errors (500-char slice max, existing `src/web.ts` pattern). No token in logs/cache/child env.
- Reject-on-out-of-range everywhere (spend, limits, chars); never clamp.
- `git diff --check` clean before handoff. No commits.

## Spend / env (single truth, consumed)

> All five limits are consumed: `resolveDiffbotSpend` validates once per `kg` call (plus `searchDiffbot` web-search cap check and per-fetch Analyze budget) and rejects out-of-range before any paid call, never clamps.

| Var | Default | Ceiling | Meaning |
|---|---|---|---|
| `DIFFBOT_TOKEN` | unset (feature off) | — | auth |
| `DIFFBOT_SEARCH_SIZE` | 10 | 50/provider | DQL/web-search size |
| `DIFFBOT_ENHANCE_SIZE` | 1 | 10/provider | enhance size |
| `DIFFBOT_NLP_MAX_CHARS` | 100000 | 100000 | analyze_text cap |
| `DIFFBOT_MAX_PROVIDERS` | 3 | 8 | explicit providers cap |
| `DIFFBOT_FALLBACK_BUDGET` | 3 | 25, 0 disables | per-fetch Analyze-GET budget |

---

## Worker ownership (non-overlapping, no shared files)

| Worker | Owns (exclusive) |
|---|---|
| A transport | DONE — `src/diffbot-transport.ts`, `test/diffbot-transport.test.ts` (read-only for all others, no edits) |
| B diffbot-search | `src/diffbot-search.ts`, `test/diffbot-search.test.ts` |
| C diffbot-extract | `src/diffbot-extract.ts`, `test/diffbot-extract.test.ts` |
| D diffbot-kg | `src/diffbot-kg.ts`, `test/diffbot-kg.test.ts` |
| E normalize+aggregate | `src/knowledge-normalize.ts`, `src/knowledge-aggregate.ts`, `test/knowledge-normalize.test.ts`, `test/knowledge-aggregate.test.ts` |
| F knowledge-domain | `src/knowledge-contract.ts`, `src/knowledge-domain.ts`, `test/knowledge-contract.test.ts`, `test/knowledge-domain.test.ts` |
| G web surface | `src/web.ts` (Diffbot backend block only), `src/web-contract.ts` (`WEB_BACKEND_PREFERENCE.search` entry only), `test/web.test.ts` (Diffbot cases only) |
| H registry+config | `src/capabilities.ts` (Diffbot channel entries only), `src/providers.ts` (Diffbot descriptors only), `src/local-config.ts` (DIFFBOT_* mappings only), `src/cli-backend.ts` (DIFFBOT_* allowlist only) |
| I docs surface | `README.md` (Diffbot privacy block only), `SKILL.md` (Diffbot privacy block only), `.env.example` (DIFFBOT_* block only) |
| J dispatcher | `src/index.ts` (kg registration only), `src/native-tools.ts` (kg dispatch only), `src/untrusted-content.ts` (kg entry only), `test/index.test.ts` + `test/native-tools.test.ts` (kg cases only) |

Cross-file imports allowed (read-only); edits only inside owned files. Merge order: A(done) → F → E → B/C/D (parallel) → G → H/I (parallel) → J.

Stale names (`knowledge-search`, `knowledge-enhance`, `knowledge-nlp`, `diffbot-analyze-fallback`, `diffbot-web-search`) are retired — no worker creates them.

---

## Phase 1: Knowledge domain (Worker F, transport exists)

### Task 1.1: contract + domain

**Files:** `src/knowledge-contract.ts` (exists — verify/extend only), `src/knowledge-domain.ts` (create), `test/knowledge-contract.test.ts`, `test/knowledge-domain.test.ts`

**Produces:** `pi-northstar.knowledge-result` v1 envelope, action validators, cursor codec, claim/alignment/evidence types, provider routing.

- [ ] Envelope consts `KNOWLEDGE_RESULT_SCHEMA='pi-northstar.knowledge-result'`, version 1; `buildKnowledgeResult` mirroring `src/result-contract.ts` status precedence (`ok/empty/partial/degraded/error`); `validateKnowledgeResult` fail-closed.
- [ ] Action validators: `validateKgSearch` (`language: 'dql'` fixed v1; DQL string required; reject facet/report/export/collection/crawl modes → `unsupported_option`), `validateKgEnhance` (type Person|Organization + ≥1 selector from id/name/url/email/phone/location/description + Person-only employer/title/school; portable options `fields` Atlas enum / `maxEntities` / `includeRelationships` / `includeEvidence` / `confidenceThreshold` 0..1), `validateKgNlp` (text 1..100000; booleans extractEntities/Facts/Sentiment/Topics; language ISO 639-1 or auto).
- [ ] Cursor codec: `encodeKgCursor({v:1, provider, fingerprint, adapterCursorV, state})` base64url; `decodeKgCursor` validates every field, hostile input → `cursor_invalid`; explicit fanout never issues cursor.
- [ ] Types: `KgClaim{confidence}`, `KgAlignment{basis, strength, confidence}`, `KgEvidence{status: provided|not_requested|provider_unsupported|unavailable, provenance?}`; unknown ontology terms `diffbot:<term>` namespaced.
- [ ] Row parser: `parseKgEntity` — invalid row → `invalid_entity`, siblings survive.
- [ ] `src/knowledge-domain.ts`: routing — providers-omitted → highest-priority capable configured provider, sequential fallback on recoverable transport/contract/semantic failures only (never same-provider paid retry); explicit providers → concurrent + per-provider `unsupported_option` partitions; never silently skip.

**Tests:** envelope precedence; all-invalid → error; enhance missing-selector rejection; NLP 0/100001-char rejection; cursor tamper/hostile-field rejection; `unsupported_option` for facet DQL; routing: omitted-picks-highest, explicit-mismatch partitions, recoverable-failure fallback.

**Acceptance:**
```bash
node --import tsx --test test/knowledge-contract.test.ts test/knowledge-domain.test.ts
npm run typecheck
```

---

## Phase 2: Normalize + aggregate (Worker E, after F)

### Task 2.1: pure normalization/aggregation helpers

**Files:** create `src/knowledge-normalize.ts`, `src/knowledge-aggregate.ts`, `test/knowledge-normalize.test.ts`, `test/knowledge-aggregate.test.ts`

**Produces:** URL normalization/dedupe, entity normalization, RRF ranking, cross-provider alignment assembly. Pure functions — no HTTP, no `diffbotFetch`.

- [ ] `src/knowledge-normalize.ts`: `normalizeKgEntity` (ontology terms → `diffbot:<term>` namespace; never raw upstream payload), entity dedupe via `normalizeUrl` first-wins, mention-span bounds-check against source input (invalid spans dropped row-level).
- [ ] `src/knowledge-aggregate.ts`: RRF ranking via `rrfMerge` (`src/fusion.ts`); alignment assembly on `provider_id/canonical_url/email/phone/external_identifier/typed_identity` with strength `exact/strong/heuristic`; `claim.confidence` vs `alignment.confidence` kept distinct; `evidenceStatus` per contract; aggregation never invents specificity, collapses ambiguity, infers relationships, or turns absence into negation.

**Tests:** first-wins dedupe; RRF ordering smoke; alignment tiers; span bounds-check drops; confidence fields never merged.

**Acceptance:**
```bash
node --import tsx --test test/knowledge-normalize.test.ts test/knowledge-aggregate.test.ts
npm run typecheck
```

---

## Phase 3: HTTP adapters (Workers B + C + D parallel, after E)

All three import `diffbotFetch` + host consts from `src/diffbot-transport.ts` (read-only), validators from Worker F, pure helpers from Worker E. No edits outside owned files.

### Task 3.1: DQL search (Worker B)

**Files:** create `src/diffbot-search.ts`, `test/diffbot-search.test.ts`

- [ ] `searchDiffbotDql`: `POST {KG_HOST}/kg/v3/dql?token=` via `diffbotFetch` (JSON body `{type:'query', query, size, from?, filter?}` — canonical POST, never GET query-string form); `data[]` → normalize (Worker E) → dedupe → RRF; single-provider cursor in/out (`from` round-trips through opaque cursor state), explicit fanout one bounded page no cursor.
- [ ] Response `hits` preserved for pagination; facet-shaped responses (`facet: true`) → `unsupported_option`, never misread as entities.

**Acceptance:**
```bash
node --import tsx --test test/diffbot-search.test.ts
npm run typecheck
```

### Task 3.2: Analyze fallback (Worker C)

**Files:** create `src/diffbot-extract.ts`, `test/diffbot-extract.test.ts`

- [ ] `diffbotAnalyzeFallback`: `GET {API_HOST}/v3/analyze?url=&fields=allContent,links&token=` via `diffbotFetch`; target URL pre-validated (`validateHttpUrl` + `resolvePublicHostname`); eligibility gate (network/upstream/blocked/timeout/empty only; never policy/input/abort/size/security/contract); budget `DIFFBOT_FALLBACK_BUDGET` default 3 / ceiling 25 / 0 disables; success marks outcome `path:'fallback' provider:'diffbot' degraded qualityImpact:'not_assessed'`.
- [ ] Fallback supplies page text only; chunk/BM25/embedding/RRF pipeline unchanged.

**Acceptance:**
```bash
node --import tsx --test test/diffbot-extract.test.ts
npm run typecheck
```

### Task 3.3: Enhance + analyze_text (Worker D)

**Files:** create `src/diffbot-kg.ts`, `test/diffbot-kg.test.ts`

- [ ] `enhanceDiffbot`: `POST {KG_HOST}/kg/v3/enhance?token=` via `diffbotFetch` (JSON body `{type, <validated selectors>, size?, filter?}` — canonical POST, never GET query-string form); selectors pre-validated by Worker F; explicit-allowlist mismatch → per-provider `unsupported_option` partition, capable run.
- [ ] `analyzeDiffbotText`: `POST {NL_HOST}/v1/?fields=&token=` body `[{content, lang?}]` via `diffbotFetch`; fields string built from extract booleans; ontology-normalize + span bounds-check via Worker E helpers; unknown terms `diffbot:` namespaced.

**Acceptance:**
```bash
node --import tsx --test test/diffbot-kg.test.ts
npm run typecheck
```

---

## Phase 4: web_search surface (Worker G, after B)

### Task 4.1: Diffbot `WebSearchBackend`

**Files:** modify `src/web.ts` (Diffbot block only); modify `src/web-contract.ts` (`WEB_BACKEND_PREFERENCE.search` entry only); modify `test/web.test.ts` (Diffbot cases only)

- [ ] Append `{name:'diffbot', configured: env => Boolean(DIFFBOT_TOKEN), search: searchDiffbot}` to `SEARCH_BACKENDS` (`src/web.ts:70`); `searchDiffbot` delegates to Worker B's DQL-POST adapter for `text` queries (`POST https://llm.diffbot.com/api/v1/web_search` Bearer, body `{text, size, maxTokens?}`; map `search_results[]` → `{title, url: pageUrl, snippet: content, source:'diffbot'}`); enters RRF rankings only, never primary.
- [ ] `src/web-contract.ts`: add `'diffbot'` so the array reads exactly `['codex', 'tavily', 'exa', 'brave', 'searxng', 'diffbot', 'ollama-search', 'duckduckgo']` (diffbot after keyed providers, before keyless `ollama-search`/`duckduckgo`).
- [ ] No `buildSearchRoute` change (`src/index.ts:379`).

**Acceptance:**
```bash
node --import tsx --test test/web.test.ts
npm test
```

---

## Phase 5: Registry + docs surface (Workers H + I parallel, after G)

### Task 5.1: Registry, providers, config (Worker H)

**Files:** per ownership table only.

- [ ] `src/capabilities.ts`: Diffbot channel entries (knowledge actions, backends, provider caps); legacy channels untouched.
- [ ] `src/providers.ts`: Diffbot descriptors (`DIFFBOT_TOKEN`, loginFlow `env_var`/`api_key` per existing convention, risk low); additive only.
- [ ] `src/local-config.ts`: `['diffbot.token','DIFFBOT_TOKEN']`, `['diffbot.searchSize','DIFFBOT_SEARCH_SIZE']`, `['diffbot.enhanceSize','DIFFBOT_ENHANCE_SIZE']`, `['diffbot.nlpMaxChars','DIFFBOT_NLP_MAX_CHARS']`, `['diffbot.maxProviders','DIFFBOT_MAX_PROVIDERS']`, `['diffbot.fallbackBudget','DIFFBOT_FALLBACK_BUDGET']` in `mappings` (`:10`).
- [ ] `src/cli-backend.ts`: same six keys in `allowed` array.

**Acceptance:**
```bash
npm run typecheck
```

### Task 5.2: README/SKILL/.env (Worker I) — done (this change)

- [x] `.env.example`: operator-limits comment states defaults/caps + reject-before-paid-call; stale non-consumption wording removed.
- [x] Privacy warning precedes installation docs in both `README.md` and `SKILL.md`; NLP authorization guidance retained as advisory.
- [x] Canonical links corrected to POST for DQL/Enhance/Web Search; Analyze stays GET.
- [x] Enhance semantics documented: Atlas-owned `fields` projection, explicit relationship-only behavior, evidence statuses, confidence filtering retaining missing confidence, aligned groups/claims/conflicts, no raw payload.
- No live Diffbot integration testing claimed.

### Task 5.2 original scope (superseded by the above — Worker I)

**Files:** `README.md` (Diffbot privacy block only), `SKILL.md` (Diffbot privacy block only), `.env.example` (DIFFBOT_* block only)

- [ ] `.env.example`: `# ── Diffbot ──` block with six vars + ceilings comment.
- [ ] Privacy warning precedes installation docs in both `README.md` and `SKILL.md`: Diffbot receives URLs/text; full selectors retained (email/phone sent when user supplies them); kg text wrapped by untrusted-content marker; consent advisory documented, not enforced in code.

**Acceptance:**
```bash
git diff --check
```

---

## Phase 6: Dispatcher (Worker J, last)

### Task 6.1: Tool registration + dispatch

**Files:** per ownership table only.

- [ ] `src/index.ts`: register `kg` tool (actions search/enhance/analyze_text, portable intent schema, no nativeOptions); `web_search`/`fetch` schemas unchanged.
- [ ] `src/native-tools.ts`: `kg` case in `dispatchNativeTool` switch; routing via Worker F domain (omitted → highest-priority capable configured, sequential fallback on recoverable transport/contract/semantic failures only, never same-provider paid retry; explicit → concurrent + `unsupported_option` partitions); `guardResult` wrap; kg text via `wrapUntrustedText`.
- [ ] `src/untrusted-content.ts`: add `'kg'` to `EXTERNAL_TOOL_NAMES` (`:14`).

**Acceptance:**
```bash
node --import tsx --test test/index.test.ts test/native-tools.test.ts
npm test
npm run typecheck
git diff --check
git status --porcelain
```

---

## Final verification gate (parent/coordinator)

```bash
npm test
npm run typecheck
node --import tsx --test test/diffbot-transport.test.ts test/knowledge-contract.test.ts test/knowledge-domain.test.ts test/knowledge-normalize.test.ts test/knowledge-aggregate.test.ts test/diffbot-search.test.ts test/diffbot-extract.test.ts test/diffbot-kg.test.ts
git diff --check
git status --porcelain
```

Green gate + no staged files + no commits = done. Excluded-surface recheck: grep diff (TypeScript-aware, case-insensitive) for `\baccounts?\b|\bcrawl(ing|er|s)?\b|\bbulk(-enhance|\s+enhance)?\b|\bfacets?\b|\breports?\b|\bcollections?\b|\brefresh\b|\badjudicat[a-z]*\b|\bnativeOptions\b|\bpersist[a-z]*\b|\bformat\s*=\s*csv\b|--export|/v4/|\bexporting\b` — any hit outside tests rejects. (Bare `export`/`cache` intentionally excluded: every TS file uses the `export` keyword, and "no cache" comments would false-reject.)

## Risks

- DQL/Enhance POST shapes follow canonical docs (`/dql/post`, `/enhance/post`); CLI uses legacy GET — docs win, envelope validation catches drift.
- DQL mode detection heuristics (facet vs entity query) under-match → fail-closed `unsupported_option` preferred over silent wrong results.
- NLP mention-span offsets from upstream untrusted; bounds-check drops bad spans row-level.
- Multi-provider enhance alignment false positives; strength tiers + never-infer rule bound damage.
