# ADR 0008: Cookie-authenticated fetch (operator-only, host-scoped)

## Status

Accepted — implemented under milestone M7 of the fetch-extraction parity port (see `docs/plans/2026-09-16-fetch-extraction-parity-port.md`).

## Context

The `pi-web-access` reference supports cookie-authenticated fetching: named auth profiles map host allowlists to a cookie source, with per-hop cookie attachment, manual same-origin redirect handling, and cache bypass for authenticated content. Atlas already owns the building blocks — `src/chrome/cookie-jar.ts` (`cookieHeaderForUrl` with HTTPS-only + host-only vs `Domain` + path + expiry + ByteString filtering, `cookieAuthEnvironment`, `COOKIE_ENV_KEYS`), provider→`cookieDomains` in `src/setup/providers.ts:35-47`, per-hop credential stripping + DNS preflight in `src/core/http.ts:42-79` — but `src/web/access/web-access-fetch.ts:1-8` documents "no proxy, no auth profiles". This ADR records the design for closing that gap without adding model-facing tool params.

`src/chrome/chrome-profile-auth.ts` is the browser-companion authorization state machine (TTL/lease), not a cookie reader — it is deliberately not involved. Fetch auth reads the *imported* cookie jar only (see T12).

## Decision

Operator-only configuration; no model input. `PI_FETCH_AUTH_PROFILES` is a JSON object mapping profile names to `{ provider, hosts, cache, redirects }` (decision D3: env JSON, not a config file). Absent env ⇒ the feature is completely inert (no cookie read, no behavior change).

- A URL is authenticated only when its hostname exactly matches a profile host or is a subdomain of it (trailing-dot normalized). A matching profile takes precedence over specialist routing for that host, on the direct-HTTP path only.
- Auth ⇒ direct HTTP only, no provider routing; the auth path bypasses the Scrapling bridge, Diffbot Analyze, and Firecrawl/Jina (T6).
- Content-type scope is HTML + PDF only in v1; anything else rejects with a fixed message (decision D4).
- Hosts outside the provider's `cookieDomains` cannot be configured in v1 — extending the descriptor registry or adding a manual storage-state import path is deferred (decision D6).
- New modules: `src/web/access/web-access-auth-contract.ts` (profile parsing/validation, reject-not-clamp) and `src/web/access/web-access-auth-fetch.ts` (manual redirect loop ≤5 hops, per-hop `validateHttpUrl` + `resolvePublicHostname` before cookie attachment, per-hop `cookieHeaderForUrl`, bounded read, fixed safe errors). `FetchPageRuntime` gains an `authFetch` seam; `ReadablePage` carries `authenticated: { profile, cachePolicy }`; `details.authFetch = { profile, cachePolicy, externalProcessing: false }` (profile *name* only).
- Validation is reject-not-clamp: unknown top-level keys, unknown profile fields, non-`same-origin` redirects, bad `cache`, bad hostname syntax, empty host list, `provider` not in `PROVIDER_DESCRIPTORS` with non-empty `cookieDomains`, or a host outside that provider's `cookieDomains` all throw a fixed message naming only the field — never a value, never a cookie.
- No new tool params: the 5-branch `fetch` schema is unchanged.

## Threat-model-lite (must be test-enforced)

Assets: stored browser cookies (session credentials), fetched authenticated content, operator config.

| # | Threat | Control |
|---|---|---|
| T1 | Cookie exfil via cross-origin redirect | Refuse the hop (`authFetchRedirectGuard`); never fall back to header-stripping for auth'd fetches |
| T2 | Cookie sent to a sibling/attacker host | Exact-host or dot-boundary subdomain match; trailing dot normalized; profile hosts validated against the provider's `cookieDomains` |
| T3 | Plaintext transport / downgrade | `https:` required; any `http:` hop (including https→http) rejects |
| T4 | Cookies attached to a private/reserved target | `validateHttpUrl` + `resolvePublicHostname` per hop *before* cookie attachment; SSRF policy remains the outer boundary |
| T5 | Auth'd content cached / replayed from cache | Default `cache: 'off'`; `cacheFetchForRetrieve` skipped unless `cachePolicy === 'session'`; cache stays memory-only (no disk) |
| T6 | Credentials leaked to third-party renderers | Auth path bypasses Scrapling bridge, Diffbot Analyze, Firecrawl/Jina; no external fetch on auth'd URLs |
| T7 | Expired/stale cookies replayed | `cookieHeaderForUrl` expiry filtering (existing); no new caching of cookie values |
| T8 | Secret in error text/logs | Fixed messages; no cookie, `Set-Cookie`, or full-URL echo; `details.authFetch` carries the profile *name* only |
| T9 | Non-latin1 cookie values | Existing ByteString filter in `cookieHeaderForUrl`; header assembly never bypasses it |
| T10 | Model reads auth'd page text as instructions | Existing untrusted-content fencing (`src/core/untrusted-content.ts`, `fetch` in `EXTERNAL_TOOL_NAMES`); no change, assert the marker still applies |
| T11 | Config injection / silent widening | Reject-not-clamp parsing; unknown keys throw; absent env ⇒ inert; no wildcard hosts |
| T12 | Companion-grant confusion | `chrome-profile-auth.ts` (browser companion TTL/lease) deliberately not involved; fetch auth reads the *imported* cookie jar only |

## Residual risks

- Imported cookie state is a long-lived credential on disk (`~/.pi-northstar/cookies`, 0600).
- Subdomain matching means a compromised subdomain of an allowed host receives cookies.
- DNS rebinding / Chromium DNS TOCTOU remains; container egress is authoritative.

## Consequences

Authenticated fetch becomes possible for operator-configured hosts with defense strictly stronger than the unauthenticated path (refuse-vs-strip on redirects, no external renderers, no cache by default). Operators accept the residual risks above by setting `PI_FETCH_AUTH_PROFILES`.

## Verification

`node --import tsx --test test/web/access/web-access-auth-contract.test.ts test/web/access/web-access-auth-fetch.test.ts test/web/access/web-access-auth-redirect.test.ts test/chrome/cookie-jar.test.ts && npm run typecheck`, plus cache-bypass and no-external-adapter assertions in `test/web/access/web-access-fetch-cache.test.ts` and `test/native-fetch.test.ts`.
