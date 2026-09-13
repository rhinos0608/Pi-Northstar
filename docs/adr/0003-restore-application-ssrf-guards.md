# ADR 0003: Restore application SSRF guards for public URLs

## Status

Accepted — Scope A, 2026-07-17

## Decision

Restore defense-in-depth application checks for user-controlled public fetch and browser URLs.
`src/network-policy.ts` uses Node's `net.BlockList` for private/reserved address ranges and
system DNS lookup for preflight. HTTP(S) validators reject credentials, private/reserved
literals, localhost, metadata endpoints, and known Docker hostnames.

Browser sessions freeze exact or wildcard allowed domains and reject cross-domain navigation.
Loopback browser access is a narrow exception created only by `browser-tools`: it starts
`LoopbackProxy`, pins the exact loopback origin, and constructs an adapter with immutable
`loopbackMode`. No generic private-network bypass or validator option exists.

Configured local SearXNG, Ollama, embedding, sidecar, CDP, and setup paths remain operator-owned.
`unsafeFetchJson` intentionally bypasses public URL validation for those configured endpoints.

## Residual risks

These controls do not claim complete SSRF containment:

- DNS rebinding can change a hostname after preflight.
- Chromium performs its own DNS resolution, creating DNS TOCTOU after application checks.
- Redirect-following paths may reach a target not covered by initial validation.
- Scrapling Python engine resolves DNS and follows redirects on its own: Node
  preflight (before spawn) plus final-URL revalidation (fail closed, never
  served or fallen back) cannot guarantee no packet reached an internal
  address. The static `fetcher` path additionally enforces safe redirects;
  browser-engine fetchers (`dynamic`/`stealthy`) get only suffix-matched
  `blocked_domains` (CIDR ranges are not expressible there). A configured
  Scrapling proxy is operator-owned and can relay anywhere.
- A loopback debug server can proxy outbound traffic from its own process.
- Container egress restrictions remain authoritative outer containment.

## Consequences

Public literal and direct DNS targets receive application-layer blocking without dependencies.
Some legitimate private-looking URLs now fail unless they are configured operator endpoints or
use the narrow loopback browser mode. Browser allowlists may require explicit CDN/IdP domains.

## Verification

Focused tests cover boundary addresses, IPv4-mapped IPv6, metadata hostnames, DNS mixed answers,
fail-closed DNS behavior, HTTP/browser validators, frozen domain matching, and loopback adapter
routing. Full containment and real container network isolation remain unverified here.
