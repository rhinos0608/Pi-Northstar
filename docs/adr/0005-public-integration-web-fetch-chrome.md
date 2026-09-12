# ADR 0005: Public integration — web batch fields, discriminated fetch, user-Chrome bridge

## Status

Accepted — public integration wave, 2026-09-12

## Decision

Wire the already-built runtime slices through the public surface (`src/index.ts` only):

- `web_search` takes exactly one of `query` or `queries[1..8]` plus optional
  `includeContent`/`recency`/`domains` (existing `limit`/`category`/`source`/
  `yearFrom`/`cursor`/`knowledge`/`mode` kept). `yearFrom` is honored on plain
  search and intersects with `recency` (later bound wins). Cursors stay
  single-query research-only. No provider selection input exists anywhere:
  backends remain operator-owned (`PI_SEARCH_WEB_BACKENDS`). Batch order rides
  the canonical web runtime (one RRF pass over per-query rankings).
- `fetch` is discriminated at the schema: normal fetch (`url`/`urls`/
  `searchQuery`+`query`), `action: retrieve`, `action: source_check`.
  Retrieve/source_check serve the bounded memory corpus only (no network).
- One multi-companion bridge (`ChromeBridgeServer`, literal 127.0.0.1:17319)
  starts lazily on first `/chrome` use — zero import-time side effects. Stable
  extension identity is operator-pinned via `PI_SEARCH_CHROME_EXTENSION_ID`;
  unset means user-chrome is unavailable and the `browser` tool stays isolated.
  `/chrome authorize [family] [ttl]` selects over live bridge instances plus
  OS-default detection (fixed read-only queries, absolute paths, no shell,
  sanitized env): Chromium OS default selects the sole family match,
  non-Chromium/unknown defaults require the explicit user slash-command
  family; same-family ambiguity always fails closed; no inventory is ever
  fabricated. The `browser` tool routes to user-Chromium only while the shared
  singleton grant is live, otherwise isolated. Companion lease renews over the
  bridge every 30s (send-first: local lease renews only on companion ack).
  Shutdown revokes then stops the server.
- Gemini stays out of web search (deferred for future video understanding).

## Consequences

Model-facing `web_search` truth now matches the runtime: `yearFrom` on plain
search behaves as the post-filter always did; multi-query batches are
first-class. `/chrome authorize` fails fast with selection guidance instead of
timing out against an empty registry. The bridge listener only exists after
explicit `/chrome` use with a configured extension id.

## Residual risks

- Per-query fan-out multiplies provider calls (≤8 queries × ≤8 backends);
  operator timeout/budget caps are the only bound.
- OS-default detection is best-effort; headless/unknown defaults fall back to
  requiring the explicit family argument.
- DNS rebinding / Chromium DNS TOCTOU per ADR 0003 still apply to companion
  navigation (frozen-host + DNR mitigate, not eliminate).

## Verification

`test/index-integration.test.ts` (route XOR/batch/fields, selection, bridge
lifecycle), updated `test/index.test.ts` schema/guidance assertions,
`test/contract.test.ts` tool/command surface, `tsc --noEmit`, `npm pack`
dry-run file list, `git status`/`git diff --stat` scope check.
