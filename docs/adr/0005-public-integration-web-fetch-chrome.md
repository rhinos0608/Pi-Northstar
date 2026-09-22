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
  has zero import-time side effects. User-Chrome onboarding is split cleanly:
  `/chrome-install [family]` refreshes the packaged unpacked extension into a
  stable per-user directory and opens the browser-owned extension manager;
  Chrome still owns the final local-extension confirmation. Then
  `/chrome-authorize [family] [ttl]` handles trust and control. That explicit
  authorization command alone arms the one-shot first-pair handoff: the bridge
  supplies either its generated secret or the configured stable secret to a
  fresh companion.
  The first valid `chrome-extension://` registration pins its origin
  (trust-on-first-use), receives the steady-state secret once, and every later
  `/register`, `/next`, and `/result` requires the pinned origin plus that
  secret. Model-triggered callers cannot open this bootstrap window, and an
  unused window is disarmed when the `/chrome-authorize` discovery attempt
  ends. Setting `PI_SEARCH_CHROME_EXTENSION_ID` adds an optional strict origin pin; setting
  `PI_SEARCH_CHROME_PAIRING_SECRET` supplies a stable steady-state secret that
  the explicit authorization handoff can provision to a fresh companion.
  `/chrome-authorize [family] [ttl]` selects over live bridge instances plus
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
first-class. `/chrome-authorize` briefly waits for the installed companion to
register, then fails with selection guidance rather than timing out against an
empty registry. The pairing window is armed only for that explicit
user-command attempt, whether the steady-state secret is generated or
configured, and closes on success, cancellation, or no companion; rerunning
the command rearms it. The listener
itself may remain available for an existing paired/authorized bridge.
`/chrome-authorize` auto-finds the OS-default Chromium family and the first
valid companion auto-attaches.

## Residual risks

- Per-query fan-out multiplies provider calls (≤8 queries × ≤8 backends);
  operator timeout/budget caps are the only bound.
- OS-default detection is best-effort; headless/unknown defaults fall back to
  requiring the explicit family argument.
- DNS rebinding / Chromium DNS TOCTOU per ADR 0003 still apply to companion
  navigation (frozen-host + DNR mitigate, not eliminate).
- First-pair bootstrap is bounded TOFU, not cryptographic extension
  authentication. During the explicitly user-armed `/chrome-authorize`
  discovery window, a malicious same-user loopback process could forge a
  `chrome-extension://` Origin and race the real companion for the one-shot
  registration. After pairing, every register/poll/result requires the
  steady-state pairing secret. Eliminating the first-pair race would require a
  browser-visible pairing ceremony, native messaging, or another independent
  trust anchor rather than another forgeable HTTP header.

## Verification

`test/index-integration.test.ts` (route XOR/batch/fields, selection, bridge
lifecycle), updated `test/index.test.ts` schema/guidance assertions,
`test/contract.test.ts` tool/command surface, `tsc --noEmit`, `npm pack`
dry-run file list, `git status`/`git diff --stat` scope check.
