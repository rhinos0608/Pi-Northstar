# ADR 0006: Strict tool contracts, search-attempt ledger, and portable graph adapters

## Status

Accepted — contract/ledger/graph-adapters wave, 2026-09-13

## Decision

Generate strict model-facing parameter schemas from contract vocabulary,
keep one session-memory search-attempt ledger at the extension layer, and
execute graph queries through a provider-neutral adapter seam with no query
translation. The public surface stays at nine tools maximum, enforced in
code (`MAX_PUBLIC_TOOLS`, `src/capabilities.ts:21`;
`assertPublicToolBudget`, `src/capabilities.ts:24`, wired as a fail-closed
registration wrapper in `src/index.ts:238-244`).

### Strict schemas mirror runtime contracts (`src/public-tool-schemas.ts`)

Each builder derives enums, bounds, and required/optional shapes from the
already-registered contract source so schema cannot drift from runtime
validation:

- `buildWebSearchParameters` — single `{query}` | batch `{queries[1..8]}` |
  agent `{query, mode:"agent"}` union; research cap (30) is schema-visible,
  plain cap (20) stays runtime-enforced per category.
- `buildSocialParameters` — one branch per advertised platform/action from
  `selectorSpecFor`; `anyOf` selectors expand into explicit alternatives
  (each selector directly, or canonical `url`), mirroring
  `src/github/github.ts`.
- `buildDesktopParameters` — one branch per `DESKTOP_ACTION_CONTRACT` action;
  required/allowed fields generate from the contract table.
- `buildGraphParameters` — query/probe/schema branches per language; SPARQL
  query carries no `pageSize`/`cursor`.
- `buildBrowserParameters` — one branch per action with bounds mirroring
  `src/browser/browser-policy.ts`; `semanticAction` nests the closed
  locator/verb union (`{ locator, query, verb, name?, index?, value?,
  exact? }`, index only under `nth`, value only under `fill`, name only
  under `role`).

Runtime validation remains defense-in-depth; web reject-on-overflow and
social clamp-on-overflow behavior are unchanged.

### Search-attempt ledger (`src/web/web-search-ledger.ts`, wired `src/index.ts`)

One `WebSearchLedger` per extension instance (long-lived session memory).
Policy:

- Memory-only, bounded (`MAX_LEDGER_ENTRIES = 128`, LRU eviction).
- Successful single-query searches suppress near-duplicates for 30 minutes
  (`SUCCESS_SUPPRESS_MS`); fuzzy match requires unigram Jaccard ≥ 0.85 over
  hashed tokens (`NEAR_DUPLICATE_JACCARD`) **and** bigram Jaccard ≥ 0.5 over
  adjacent token pairs (`NEAR_DUPLICATE_BIGRAM_JACCARD`). The bigram gate
  makes suppression order-sensitive: same-token reorderings such as
  'Alice acquired Bob' vs 'Bob acquired Alice' share no bigrams, so both
  run. Batch entries suppress only on exact canonical
  match. Cursor continuations (paged research reads) bypass the ledger.
- Failures: non-retryable codes (`invalid_response`, `response_too_large`)
  block immediately; retryable codes (`timeout`, `upstream_error`) allow one
  retry, then block — all within a 10-minute window (`FAILURE_BLOCK_MS`).
- In-flight duplicates coalesce onto the leader promise; if the leader fails,
  followers re-begin through the retry budget rather than inheriting the
  failure.
- Abort-safe: caller abort and pre-dispatch validation errors call
  `ledger.cancel`, dropping in-flight tracking without recording a failure.
- Ledger stores only SHA-256 hashes, outcome state, counters, safe filter
  options, and failure codes — never result bodies, raw upstream errors,
  query text, or secrets. Suppressed/blocked calls return static pointer
  text (`priorSearchResult`), no bodies.

### Adapter seam with no-AST rule (`src/graph/graph-adapter.ts`)

`GraphAdapter` is orchestration interface only: `executeQuery`,
`probeCardinality`, `fetchSchemaSnapshot`. Adapters execute provider-native
query strings verbatim — no query translation, no universal AST, no
cross-provider rewriting. Probe returns portable cardinality (per-query
`hits`, partial failures preserved). Schema snapshots are raw provider
payloads; the four portable views (types/fields/search/describe) derive in
orchestration. `kg` stays Diffbot-only outside this seam. DQL keeps opaque
pagination (`adapterCursorV`, fingerprint-pinned cursors); SPARQL v1 returns
one bounded response without cursor. Existing DQL cursors remain valid.

### SPARQL scope and trust boundary (`src/sparql/`)

- Query supports SELECT/ASK only; SERVICE federation and update forms
  (`INSERT`/`DELETE`/`LOAD`/`CLEAR`/`CREATE`/`DROP`, …) reject with
  `unsupported_option` before dispatch.
- Endpoint is operator-configured env-only (`GRAPH_SPARQL_ENDPOINT`,
  optional `GRAPH_SPARQL_TOKEN`), never model input. Validation: http/https
  scheme, no embedded credentials, trimmed; blank means unconfigured (no
  error). Operator endpoints may be loopback; transport uses manual redirects
  (3xx rejects).
- Optional bearer token travels via `Authorization` header only and is
  redacted from every error string (500-char slice). Provider status exposes
  endpoint host only, never the token (`GRAPH_SPARQL_TOKEN` excluded from
  status key names).
- `graph` registers when Diffbot (DQL) **or** the operator SPARQL endpoint is
  configured; `kg` stays Diffbot-only. Per-language auth still fails closed
  at dispatch when its credential is missing.

### Nine-tool budget

Code-enforced: at most nine model-facing tools
(`web_search`, `fetch`, `github`, `social`, `media`, `browser`, `kg`,
`graph`, `desktop`), with conditional registration (desktop, kg, graph,
browser) meaning the live count is ≤ 9. Policy (not code-enforced): the
10–12 range is headroom rationale for keeping the surface small enough to
fit model context and review; at 15+ tools the surface requires profiles or
a retrieval/describe redesign instead of silent growth (per approved plan).

### Reference provenance

- Browser reliability checks match
  [pi-agent-browser-native](https://github.com/fitchmultz/pi-agent-browser-native).
- Research source design takes input from
  [pi-web-research](https://github.com/wynainfo/pi-web-research) (MIT
  license; this repo is also MIT per `package.json`). No code is vendored:
  Northstar deliberately diverges with a request-level failure ledger and no
  host ledger, since search and fetch are separate tools here.

## Consequences

Model-facing schemas cannot drift from runtime contracts without touching
the shared builder. Repeated paid searches within a session collapse to a
static pointer instead of re-dispatch. A second graph provider (SPARQL) is
reachable with no new public tool and no query-language coupling.

## Residual risks

- Ledger suppression is heuristic (fuzzy match); a genuinely new query near
  an old one can suppress within 30 minutes.
- SPARQL operator endpoint is trusted config: loopback allowed, but DNS
  rebinding/TOCTOU and container-egress limits per ADR 0003 still apply.
- The 10–12 / 15+ budget policy is advisory; only the max-nine gate fails
  closed in code.

## Verification

- `grep`/read cross-check of every documented name, path, constant, and
  command against source (see Task 11 checks).
- Suites covering the wave: `test/public-tool-schemas.test.ts`,
  `test/web/web-search-ledger*.test.ts`,
  `test/graph/graph-language-contract.test.ts`,
  `test/diffbot/diffbot-graph-adapter.test.ts`,
  `test/sparql/sparql-*.test.ts`, `test/setup/sparql-config.test.ts`,
  `test/index.test.ts`, `test/index-integration.test.ts`,
  `test/contract.test.ts`.
