# Search Quality and Fetch Hardening Implementation Plan

> **For agentic workers:** Implement this plan task-by-task. Use vertical test-first cycles. Do not commit. Preserve existing graph changes and all other worktree content.

**Goal:** Decouple duplicate-URL ranking from displayed representation, improve fetch truncation at semantic boundaries, and close shared Node-fetch DNS-validation omissions.

**Approach:** Build three independently testable seams concurrently: representation selection/URL normalization, fetch-only presentation, and shared HTTP/Scrapling hardening. Integrate each through small existing `web.ts` regions, then run adversarial whole-diff review. No public safe-search/browser work in this release.

**Riskiest assumption:** Existing page content retains enough paragraph/Markdown structure for block-aware truncation to improve output without changing retrieval. Plain one-line text must still degrade safely to sentence boundaries.

## Decisions to review

Approved in `docs/plans/2026-09-11-search-quality-hardening-design.md`:

- Richest donor selection changes representation only; RRF score/order anchors remain unchanged.
- Explicit richness order is `full > summary > snippet`, then clean text length, then earlier selected provider.
- Only unequivocal tracking parameters are stripped; `ref`, `source`, `src`, and `pos` remain identity-bearing.
- Semantic presentation is fetch-specific; generic `guardText` and canonical structured details remain unchanged.
- Initial Node DNS validation moves into the shared redirect helper.
- Safe search and browser redirect/frame work are deferred.

Changing these boundaries requires renewed user approval.

## Known unknowns

1. **Current provider richness labels**
   - Default: unlabeled results are snippets. Only adapters with explicit semantic evidence may label `summary` or `full`.
   - Pivot: if no current adapter can honestly emit richer kinds, length still selects the richer snippet and the optional contract supports future adapters without invention.

2. **Plain-text structure quality**
   - Default: split on blank lines and sentence boundaries; preserve Markdown blocks when present.
   - Pivot: if focused fixtures show HTML flattening destroys every boundary, improve `stripHtml` block-newline preservation inside the presentation task only.

3. **Scrapling prevention ceiling**
   - Default: post-validate final URL at the first Node boundary with the request resolver/signal.
   - Containment: document that Python may already have followed the redirect; do not claim prevention or build a proxy.

## Global constraints

- Node `>=24`, TypeScript `5.9`; no dependencies.
- Existing `kg`, `graph`, research, social, media, GitHub, browser, and desktop schemas stay unchanged.
- Existing web-search request schema and canonical `WebArticleV1` stay unchanged.
- No query expansion, authority prior, semantic reranker, safe-search input, or browser interception.
- No retries, extra provider calls, hidden fetches, or new spend.
- External content remains untrusted and bounded.
- No commit, push, merge, branch operation, or destructive cleanup.

## File ownership

### Create

- `src/web-representation.ts` — content-kind richness and deterministic donor selection with metadata backfill.
- `src/web-presentation.ts` — Markdown/plain block parsing, navigation filtering, link neutralization, and exact-budget truncation.
- `test/web-representation.test.ts`
- `test/web-presentation.test.ts`

### Modify

- `src/fusion.ts`, `test/fusion.test.ts` — conservative normalization vectors only.
- `src/web-search-types.ts` — optional internal representation metadata only.
- `src/web.ts`, `test/web.test.ts` — fuse donor selection and fetch presentation integration in separate regions.
- `src/http.ts`, `test/http.test.ts` — initial and per-hop DNS preflight in the shared helper.
- `src/scrapling-bridge.ts` and/or `src/web.ts` bridge-consumer boundary, `test/scrapling-bridge.test.ts` and/or `test/web.test.ts` — returned final-URL validation with injected request DNS context.
- `README.md` — brief behavior/security note only if existing architecture statements become inaccurate.

---

### Task 1: Richest representation and conservative URL identity

**Outcome:** Duplicate normalized URLs keep uniform RRF consensus/order while surfacing the richest deterministic donor and complete contributor provenance.

**Files:**
- Create/test: `src/web-representation.ts`, `test/web-representation.test.ts`
- Modify/test: `src/fusion.ts`, `test/fusion.test.ts`, `src/web-search-types.ts`, fusion region of `src/web.ts`, fusion tests in `test/web.test.ts`

**Interfaces:**
- `WebSearchHit` gains optional `contentKind?: 'snippet' | 'summary' | 'full'` and optional publication metadata; omission means snippet.
- `chooseRepresentation(current, candidate)` returns a donor plus allowed metadata backfill without score/rank inputs.
- `fuseWebSearchRankings` retains current RRF accumulation and sort keys; only stored representation may change.

**Checks:**
- Red: focused tests demonstrate current first-selected snippet wins over richer later representation and missing normalization vectors do not collapse.
- Green: `node --import tsx --test test/fusion.test.ts test/web-representation.test.ts test/web.test.ts` passes richness, tie, metadata, provenance, score, and ordering assertions.

- [ ] Add normalization vectors for `gclsrc`, `dclid`, `msclkid`, `_ga`, `_gl`, plus explicit retention tests for `ref`, `source`, `src`, `pos`.
- [ ] Implement minimal richness helpers and deterministic donor selection.
- [ ] Integrate donor replacement without modifying accumulated score, first provider index, contributor order, or final sort.
- [ ] Keep provider-generated summaries in existing structured `generatedText`; do not copy them into snippets.
- [ ] Verify no existing adapter is mislabeled as summary/full.
- [ ] Run focused tests and `npm run typecheck`.

---

### Task 2: Fetch-only semantic presentation

**Outcome:** Oversized fetched content ends at complete blocks/sentences, unsafe Markdown links are inert, and confirmed navigation chrome does not consume evidence budget.

**Files:**
- Create/test: `src/web-presentation.ts`, `test/web-presentation.test.ts`
- Modify/test: page text bounding/render region of `src/web.ts`, focused fetch/crawl cases in `test/web.test.ts`
- Keep unchanged: `src/tool-output.ts` behavior and tests except integration expectations genuinely affected downstream.

**Interfaces:**
- One function accepts untrusted page text plus `maxChars` and returns `{ text, shown, truncated, omittedChars }` compatible with current `boundPageText` callers.
- Output length never exceeds `maxChars`.
- Atomic code/table blocks are emitted whole or skipped; prose may reduce only to complete sentences.

**Checks:**
- Red: fixtures expose mid-paragraph truncation, unsafe active links, and heading-only chrome retention.
- Green: `node --import tsx --test test/web-presentation.test.ts test/web.test.ts test/tool-output.test.ts` passes exact-bound, atomicity, sentence, navigation, sanitization, and unchanged-details assertions.

- [ ] Port only required block/sentence/link/navigation concepts from search-mcp; omit citations, artifacts, source tiers, transcript specialization, and ranking logic.
- [ ] Treat malformed/unclosed fences safely and deterministically.
- [ ] Exempt code, table, and blockquote blocks from navigation-density removal.
- [ ] Neutralize non-HTTP(S) links while preserving visible labels.
- [ ] Append one truncation marker within the character budget.
- [ ] Integrate at `boundPageText`; do not parse arbitrary tool output in `guardText`.
- [ ] Run focused tests and `npm run typecheck`.

---

### Task 3: Shared Node DNS and Scrapling result hardening

**Outcome:** Every public Node fetch validates initial and redirect DNS answers through one choke point, and unsafe Scrapling final URLs cannot cross into evidence.

**Files:**
- Modify/test: `src/http.ts`, `test/http.test.ts`
- Modify/test: `src/scrapling-bridge.ts` or immediate consumer in `src/web.ts`, `test/scrapling-bridge.test.ts` or `test/web.test.ts`

**Interfaces:**
- `fetchJson`/`fetchText` keep signatures; existing optional `lookup` reaches initial and redirect resolution.
- Final Scrapling URL validation uses the same caller signal/resolver at the first Node trust boundary.

**Checks:**
- Red: injected initial private DNS resolver currently reaches mocked fetch; mocked Scrapling private final URL currently reaches page output.
- Green: `node --import tsx --test test/http.test.ts test/network-policy.test.ts test/scrapling-bridge.test.ts test/web.test.ts` proves zero Node fetch on initial-private DNS, per-hop checks remain, abort propagates, and unsafe bridge URLs are withheld.

- [ ] Move initial `resolvePublicHostname` into `fetchFollowingRedirects` before its first fetch.
- [ ] Remove only proven duplicate caller preflights; preserve injectable lookup and signal semantics.
- [ ] Validate returned final URL statically and via DNS before surfacing Scrapling content.
- [ ] Use safe errors that do not expose credentials or internal resolved addresses beyond existing policy behavior.
- [ ] Keep loopback/operator-owned unsafe fetch paths unchanged.
- [ ] Run focused tests and `npm run typecheck`.

---

### Task 4: Integration, documentation, and review loop

**Outcome:** The three seams coexist without public-contract regression and the full repository passes adversarial review.

**Files:**
- Resolve shared integration only in already named files.
- Modify `README.md` only where architecture/security behavior changed.

**Interfaces:**
- No new public tool input.
- Legacy `details.results`, `details.fusion`, generated text, and canonical envelope remain present.

**Checks:**
- Focused combined suite passes.
- Full suite, typecheck, and diff checks pass.
- Fresh reviewer reports no confirmed corrective findings.

- [ ] Review full diff for hidden query expansion, authority scoring, safe-search fields, browser interception, new network calls, or unrelated refactors.
- [ ] Run final verification gate.
- [ ] Loop worker fixes and fresh reviewer checks until pass; escalate to oracle on round 5 if needed.

## Final verification gate

```bash
node --import tsx --test test/fusion.test.ts test/web-representation.test.ts test/web-presentation.test.ts
node --import tsx --test test/http.test.ts test/network-policy.test.ts test/scrapling-bridge.test.ts
node --import tsx --test test/web.test.ts test/tool-output.test.ts
npm test
npm run typecheck
git diff --check
git status --short
```

Success means zero failed tests/type errors/whitespace errors, no staged files or commits, existing graph work preserved, and reviewer pass.
