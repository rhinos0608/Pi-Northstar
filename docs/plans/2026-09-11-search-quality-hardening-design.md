# Search Quality and Fetch Hardening Design

**Date:** 2026-09-11
**Status:** Approved
**Owner:** Pi

## Goal

Improve web-search duplicate representation, conservative URL identity, fetch presentation quality, and public Node-fetch SSRF checks without changing RRF ranking semantics or adding hidden search behavior.

## Scope

### 1. Richest representation wins

For each normalized URL, keep four concerns separate:

- **Identity:** normalized URL.
- **Ranking:** uniform RRF score and existing deterministic ordering.
- **Representation:** the richest clean provider hit.
- **Provenance:** union of `{backend, rank}` contributors.

The fusion entry becomes conceptually:

```ts
{
  representation,
  score,
  rankingAnchor,
  contributors
}
```

`chooseRepresentation(current, candidate)` is deterministic and independent from score accumulation:

1. Explicit content kind: `full > summary > snippet` (`undefined` means `snippet`).
2. Within one kind, longer clean content wins.
3. Exact richness ties keep the earlier selected provider.

Selecting a richer donor never changes accumulated RRF score, first-discovery provider index, first contributor rank, or final ordering. The surfaced `backend`, title, URL, and snippet identify the representation donor; contributors identify every backend that discovered the URL.

Optional hit metadata may survive the merge:

- publication metadata backfills only when the chosen donor lacks it;
- conflicting publication metadata keeps the chosen donor's value;
- provider-generated URL-attributable summaries remain separate structured evidence and are not converted into retrieval snippets;
- no source-authority prior or richness ranking boost is introduced.

### 2. Conservative URL identity

Keep Northstar's existing URL normalization and additionally remove only unequivocal analytics/click identifiers:

- `gclsrc`
- `dclid`
- `msclkid`
- `_ga`
- `_gl`

Continue removing `utm_*`, `fbclid`, `gclid`, `mc_cid`, and `mc_eid`. Continue preserving ambiguous parameters including `ref`, `source`, `src`, and `pos`. Preserve non-default ports; remove fragments; normalize host case, `www.`, default ports, and non-root trailing slashes through WHATWG URL behavior plus existing rules.

The same normalization remains shared by search fusion and existing URL deduplication consumers.

### 3. Fetch-specific semantic presentation

Add a focused presentation module used by fetch/read/crawl page text before the existing outer tool-output guard.

Behavior:

- Accept Markdown or plain text without changing retrieval-domain objects.
- Recognize headings, fenced code, Markdown tables, list items with continuations, blockquotes, and prose paragraphs.
- Keep fenced code and tables indivisible.
- Prefer complete blocks; when a prose block exceeds remaining space, emit only complete sentences that fit.
- Preserve original rank/order; no reranking or hidden retrieval.
- Remove only confirmed navigation/chrome blocks and sections. Heading-only chrome bodies are not substantive evidence. Code, tables, and blockquotes are exempt from navigation-density filtering.
- Neutralize active Markdown links whose destinations are not absolute HTTP(S); preserve their visible labels.
- Append one explicit truncation marker inside the existing caller `maxChars` bound.
- Keep structured `details` and canonical Northstar envelopes unchanged.
- Keep generic `guardText` unchanged; it remains a final safety bound for arbitrary tool output.

No search-mcp citation syntax is added. A fetched page already has one explicit source URL in structured output, and inventing per-block citation identifiers would add a second public convention without additional provenance.

## 4. Public Node-fetch SSRF hardening

Data flow:

```text
user URL
  → validate HTTP(S), credentials, hostname/literal
  → resolve and reject private/reserved DNS answers
  → fetch with manual redirects
  → repeat validation + DNS for every redirect target
  → bounded response
```

Move initial DNS preflight into the shared redirect-following helper so callers cannot omit it. Existing caller-side duplicate preflights may be removed only when tests prove the shared helper receives the caller's injected resolver and AbortSignal.

Scrapling may follow redirects internally. Before any successful Scrapling result is surfaced, validate its returned final URL statically and resolve its hostname with the same request resolver/signal. A missing final URL falls back to the already validated request URL. A private, malformed, credential-bearing, or non-HTTP(S) returned URL rejects that Scrapling result; it is never surfaced as evidence.

Residual risks remain explicit: validation does not pin Node's connection-time DNS answer, Chromium navigation remains outside this change, and container egress remains authoritative.

## Non-goals

- Safe-search public inputs or capability guarantees before provider semantics are verified.
- Browser redirect/frame interception or post-navigation checks presented as SSRF prevention.
- Automatic query expansion.
- Source/domain authority scores or canonical ranking priors.
- Semantic reranking, content-similarity URL identity, or cross-URL merging.
- New dependencies.
- Changes to `kg`, `graph`, research-source, social, media, GitHub, browser, or desktop public schemas.
- Replacing generic `guardText` with a Markdown parser.

## Compatibility

- Existing web-search request schema and normalized `WebArticleV1` stay unchanged.
- New representation fields are optional internal hit/fusion-detail fields.
- Existing RRF scores, provider ordering, tie ordering, and contributor format stay unchanged.
- Duplicate URLs may surface a different title/snippet/backend when a later provider has a richer representation. This is the intended behavior change.
- Fetch output remains bounded by the same model-facing `maxChars`; truncation becomes semantically cleaner.
- Public fetches gain stricter DNS validation and may reject destinations previously reached only because an initial preflight was omitted.

## Threat requirements

| Boundary | Abuse case | Control | Verification | Residual risk |
|---|---|---|---|---|
| Public Node fetch | Initial hostname resolves private | Shared initial DNS preflight before fetch | Injected private resolver; assert zero fetch calls | DNS TOCTOU; container egress owns containment |
| Redirect | Later target resolves private | Static + DNS validation on every hop | Public first hop → private DNS second hop rejects | DNS TOCTOU |
| Scrapling result | Python follows to private/credential URL | Validate and resolve returned final URL before use | Mock child returns private/malformed final URL; result rejected | Python made the request before post-check; container egress remains authoritative |
| External page text | Markdown link triggers unsafe rendering | Non-HTTP(S) destination neutralized | `javascript:`, `data:`, `file:`, `ftp:` link fixtures | Output is still untrusted evidence |
| Output budget | Large indivisible content causes overflow | Exact `maxChars` enforcement, skip oversized atomic blocks | boundary and multibyte fixtures | Generic outer guard may apply again |

The Scrapling final-URL check prevents unsafe evidence from crossing the application boundary, but cannot retroactively stop Python's redirect request. Full containment still requires container egress controls.

## Alternatives considered

1. **Recommended: additive focused seams** — richest donor selection, narrow normalization vectors, fetch-only presentation, and shared Node DNS preflight. Small, independently testable, no new public options.
2. **Unified formatter/envelope rewrite** — rejected because it would couple ranking, presentation, canonical entities, and citations into a breaking change.
3. **Safe-search and browser interception in the same release** — deferred because provider filtering equivalence and agent-browser interception support are not yet proven.

## Implementation boundaries

- Representation and URL identity: `src/web-representation.ts`, `src/fusion.ts`, `src/web-search-types.ts`, fusion portion of `src/web.ts`, focused tests.
- Fetch presentation: `src/web-presentation.ts`, page-bound/render portions of `src/web.ts`, focused tests.
- SSRF: `src/http.ts`, `src/scrapling-bridge.ts` or the immediate bridge-consumer boundary, focused tests.
- Shared integration changes remain small and are applied after concurrent module work.

Both reference repositories have the same owner. Direct code reuse is permitted, but Northstar's smaller contracts and conventions remain authoritative.

## Verification

- URL test vectors prove safe tracking removal and ambiguous-parameter retention.
- Fusion tests prove representation changes cannot alter RRF score/order anchors.
- Presentation tests prove block atomicity, sentence boundaries, navigation filtering, link neutralization, and exact output bounds.
- SSRF tests prove initial and redirect DNS rejection before corresponding Node fetches and final Scrapling URL rejection before evidence use.
- Full `npm test`, `npm run typecheck`, and `git diff --check` pass.
