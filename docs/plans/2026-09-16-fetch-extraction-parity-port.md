# Fetch-extraction parity port: pi-web-access → Pi-Atlas

Planning artifact. Read-only reference: `/tmp/pi-web-access`. Target: `/Users/rhinesharar/Pi-Atlas`.
Capability matrix that scopes this work: `/tmp/parity/matrix.md` (+ `core-flow.md`, `target-paths.md`, `atlas-surface.md`).
No target files were modified while planning; every Atlas seam below was read directly.

## 0. Scope and binding constraints

In scope (gaps internal to the fetch dispatch only):

1. GitHub issues/PRs dedicated route.
2. Next.js RSC flight-data rescue in the page-reader path.
3. Data-URI sanitization of fetch output.
4. Declared-links appendix (Link header + HTML `rel` allowlist).
5. Remote image handling via existing `asset-acquire` + sniff/dims.
6. Scanned-PDF degraded marking behind the local unpdf path (**local-only; cloud/datalab/Gemini PDF backends are OUT of scope**).
7. Cookie-authenticated fetching with per-host auth profiles (highest risk).
8. Video frames + video analysis (YouTube HTTP(S) only), anonymous yt-dlp/ffmpeg, operator-configured VLM synthesis.

Explicitly out of scope (parent decisions):

- Hosted/cloud PDF backends (Datalab, Gemini PDF) — never ported.
- Local-video-file analysis through `fetch` — see D1 below (deferred; `callReachTool('video')` verified YouTube-only: no `file://`/`isVideoFile`/extension handling anywhere in `src/media/media.ts`).
- Disk-persisted fetch cache — cache stays memory-only (`src/web/access/web-access-content-store.ts:1-7`). **No milestone below adds disk persistence; verify in review.**
- The 5-branch `fetch` tool schema (`src/index.ts:417-423`) is unchanged: **no new tool params**. Everything new is automatic and operator-gated, or an internal route decision.
- No new runtime dependencies (Atlas deps: `@google/genai`, `@modelcontextprotocol/sdk`, `tsx`, `unpdf`; `agent-browser` optional). The reference's `linkedom`-based DOM code must be re-implemented dependency-free.

Cross-cutting invariants every milestone must preserve:

- SSRF outer boundary: `src/network-policy.ts` (`assertPublicHostname`, `resolvePublicHostname`) + `validateHttpUrl` (`src/core/http.ts:13-19`) on the seed URL **and every redirect hop**; per-hop DNS preflight; no new unvalidated network path.
- Child processes: deny-by-default env (`src/process/native-child-env.ts:buildNativeChildEnvironment`, `src/process/python-child-env.ts`), fixed argv arrays, `shell: false`, no `process.env` inheritance.
- Style: small modules, contracts in dedicated `*-contract.ts` files, reject-not-clamp bounds, fixed safe error strings (no URL/cookie echo), tests named after the source module under `test/<domain>/`.
- Verification commands available: `npm run typecheck`, `npm test`, and targeted `node --import tsx --test test/<path>.test.ts`.

Ordering rationale: pure local ports first (low risk, no new egress), then wiring into the dispatch, then the authenticated path, then the video path, then docs and the final sweep.

---

## M1. Data-URI sanitization (pure port)

**Port source:** `/tmp/pi-web-access/data-uri-sanitize.ts:394-404` (`sanitizeInlineDataUris`), marker format `:300-304`, caps `:9-11`, omission shape `:16-27`, boundary/detection helpers `:41-90`; applied on every result at `/tmp/pi-web-access/extract.ts:1457-1465`.

**Create**
- `src/core/data-uri-sanitize.ts` — dependency-free text transform (`node:crypto` only, already used across `src/core`). Export `sanitizeInlineDataUris(text: string, sourcePath: string): { text: string; omissions: DataUriOmission[] }`, the `DataUriOmission` interface, and caps (`MAX_DATA_URI_HEADER_CHARS`, `MAX_MIME_CHARS`, `MAX_MARKER_SOURCE_CHARS`) verbatim from the reference. Marker text is Atlas-branded: `[pi-northstar inline data URI omitted; ordinal;source;mime;encoding;encodedBytes;decodedBytes;sha256;retrieval=not-retained]`. Never redact thumbnails/frames (no such fields exist in Atlas fetch output — state that in the module header).

**Modify**
- `src/native-fetch.ts` — single choke point: wrap the existing `dispatchFetch` body in an inner function and sanitize every returned `BackendCallResult` text once before return (`dispatchFetch` is the model-visible MCP path: `src/index.ts:426` → `callSearchMcpTool` → `callNativeTool` → `dispatchFetch`). Thumbnails/frames are untouched by construction.

**Tests**
- `test/core/data-uri-sanitize.test.ts` — base64 + percent-encoded forms, header >1024 chars, non-`data:` schemes untouched, `data:` inside prose/code, idempotence, `retrieval: not-retained` marker, no ordinal leakage across calls.
- Extend `test/native-fetch.test.ts` — a fetch result containing an inline `data:` URI returns the marker, not the payload.

**Verify:** `node --import tsx --test test/core/data-uri-sanitize.test.ts test/native-fetch.test.ts && npm run typecheck`

**Risk:** low. Watch: do not sanitize inside `details` envelopes that carry citations (only `content` text).

---

## M2. Declared-links appendix

**Port source:** `/tmp/pi-web-access/declared-web-links.ts:1-9` (caps + rel allowlist), `:25-58` (`discoverDeclaredWebLinks`), `:60-68` (`appendDeclaredWebLinks`), `:110-173` (Link-header splitter/parameter parser/formatting); wiring `/tmp/pi-web-access/extract.ts:1319-1326`, `:783-786`.

**Adaptation (required):** the reference takes a `Document`. Atlas has no DOM dependency in the fetch path, so re-implement as dependency-free string scanning:
- `link[rel][href]` / `a[rel][href]` extraction with the existing regex technique from `src/web/access/link-extraction.ts:19-38`, plus `<base href>` resolution.
- Link-header parsing (`splitOutsideSyntax`, `parseLinkParameters`) ported as-is (pure string code); skip `anchor`, ≤20 links, 4096-char URL cap, 160-char type cap.
- Rel allowlist unchanged: `api-catalog`, `describedby`, `service-desc`, `service-doc`, `service-meta`. http(s) only.

**Create**
- `src/web/access/declared-web-links.ts` — `discoverDeclaredWebLinks(html: string, linkHeader: string | null, responseUrl: string): DeclaredWebLink[]`, `appendDeclaredWebLinks(content, links): string`, `DeclaredWebLink` type.

**Modify**
- `src/web/web-page-reader.ts` — in `fetchReadablePage`, after content is chosen (bridge, plain, Diffbot, or external) and before return, scan the available HTML (`rawHtml` when present) and the response `Link` header, then append the appendix. Native/bridge results keep `rawHtml`; Diffbot/external results have no HTML → appendix skipped (document this in the module header). Add `declaredLinks?: DeclaredWebLink[]` to `ReadablePage` so the envelope can report a count.
- `src/native-fetch.ts` — surface `declaredLinks` count in `details` (never as content duplication).

**Tests**
- `test/web/access/declared-web-links.test.ts` — Link-header parsing (quoted params, `anchor` skip, comma inside `<>`, malformed → reject), DOM scan, `<base>` resolution, dedup/relation merge, 20-link cap, non-http rejected, appendix formatting, empty content → section only.
- Extend `test/web/web-page-reader.test.ts` — appendix appended once, not duplicated on fallback paths, absent when no declared links.

**Verify:** `node --import tsx --test test/web/access/declared-web-links.test.ts test/web/web-page-reader.test.ts`

---

## M3. Next.js RSC flight-data rescue

**Port source:** `/tmp/pi-web-access/rsc-extract.ts:13-337` (`extractRSCContent`: guard `:14-16`, `self.__next_f.push` script regex `:20`, `id:payload` chunking `:33-50`, `$Lxx` ref resolution + tag→markdown `:81-289`, chunk-23 preference / dedup fallback `:291-337`); rescue ordering `/tmp/pi-web-access/extract.ts:1331-1370` (Readability null) and `:1378-1410` (thin markdown), `MIN_USEFUL_CONTENT = 500` (`extract.ts:69`).

**Create**
- `src/web/access/rsc-extract.ts` — verbatim-logic port, dependency-free (no DOM). Export `extractRSCContent(html: string): { title: string; content: string } | null` and `RSC_MIN_USEFUL_CONTENT = 500` / `RSC_MIN_EXTRACTED_CONTENT = 100` constants. Keep the reference's skip list (script/style/svg/nav/footer) and table builder.

**Modify**
- `src/web/web-page-reader.ts` — Atlas has no Readability, so the rescue slot is: after `stripHtml(html)` produces content, if `content.trim().length < RSC_MIN_USEFUL_CONTENT` and the HTML contains `self.__next_f.push`, run `extractRSCContent`; adopt its result when `> RSC_MIN_EXTRACTED_CONTENT`, else keep the `stripHtml` output. Add `extraction?: 'html-strip' | 'rsc-flight'` to `ReadablePage` (local parse, not a degraded/external marker) and report it in `details`. Apply on the plain-fetch path and on the bridge path (both have `rawHtml`); leave the `fetchPageText` test seam untouched so existing tests stay deterministic.

**Tests**
- `test/web/access/rsc-extract.test.ts` — non-RSC HTML → null, chunk dedup/keep-longest, ref resolution, table builder, title fallback (`<title>` split on `|`), 100-char floor, malformed JSON chunk skipped.
- Extend `test/web/web-page-reader.test.ts` — thin stripHtml + flight payload → `extraction: 'rsc-flight'`; non-flight thin page keeps `html-strip`.

**Verify:** `node --import tsx --test test/web/access/rsc-extract.test.ts test/web/web-page-reader.test.ts`

---

## M4. Remote image handling (asset-acquire wiring)

**Port source:** `/tmp/pi-web-access/extract.ts:1240-1267` (image MIME gate, ≤2000px resize, thumbnail block, decode failure → error), consts `:70`.

**Atlas reality check:** `src/assets/asset-acquire.ts:183-286` already does per-hop SSRF validation, magic-byte sniff, and PNG/GIF/JPEG dimension probe with `IMAGE_MAX_PIXELS` rejection (`src/assets/asset-contract.ts:10`). `src/media-vision/pipeline-image.ts:60` (`sniffImageMime`) and `:104` (`readImageDimensions`) duplicate part of that. **Atlas has no resize/thumbnail capability and no image codec dependency → no resize in v1** (explicitly documented; do not add `sharp`).

**Create**
- `src/web/access/web-access-image.ts` — `fetchRemoteImage(url, options): Promise<{ mime, bytes, width?, height?, pixels? }>` wrapping `acquireAsset(url, 'image', deps)` (never-truncate ceilings preserved), plus `describeFetchedImage(bytes, mime, env)` that returns `undefined` unless an operator-configured vision tier exists: reuse `resolveVisionEligibilityFromEnv` (`src/media-vision/eligibility.ts:76-82`) and the existing describe seams only (`describeImageWithGemini` in `src/media-vision/gemini.ts:267`, `createOpenAICompatibleVisionTransport(...).describe` in `src/media-vision/openai-compatible.ts:116`). Fail-closed: no configured tier → metadata only.

**Modify**
- `src/native-fetch.ts` — new `tryRemoteImageFetch(url, options)` specialist, selected by content-type/extension classification added next to `selectWebAccessReaderKind` usage (the classifier is pure: extend `src/web/access/web-access-specialization.ts:21-48` with an `image` kind for image extensions only, or sniff at the fetch site — pick the fetch-site sniff to avoid touching the github/media/feed precedence). Returns `textResult` with `{ mime, bytes, width, height, pixels, described? }`; `described` text rides `details.generatedText`-style separation (never merged into content) and is labeled with the vision tier. Fail-closed: sniff mismatch or ceiling breach → specialist returns `undefined` so the page reader keeps current behavior.
- `src/native-fetch.ts` — image branch must never run on an authenticated fetch (see M7 rule).

**Tests**
- `test/web/access/web-access-image.test.ts` — sniff-first (announced MIME disagreeing with magic bytes rejects), pixel ceiling reject, redirect ceiling, HTTPS→HTTP downgrade reject, no vision tier → metadata only, configured tier (injected transport) → described text separated, abort.
- Extend `test/native-fetch.test.ts` — image URL returns metadata envelope; unsniffable bytes fall through to the page reader.

**Verify:** `node --import tsx --test test/web/access/web-access-image.test.ts test/assets/asset-acquire.test.ts`

**Open decision D5:** the exact-'1' opt-in env for fetch-time image description (proposed `PI_VISION_FETCH_DESCRIBE=1`); without it, only configured-tier detection gates the call.

---

## M5. GitHub issues/PRs dedicated route

**Port source:** `/tmp/pi-web-access/github-issue-pr.ts:119-152` (`parseGitHubIssuePrUrl`), `:673-700` (entry + gh→REST order), `:182-246` (gh view + review threads), `:305-365` (REST fallback), `:600-671` (renderer), constants `:9-21`.

**Atlas reality check (verified):** `src/github/github-domain.ts` already owns `issues`/`pulls` actions with `number` (`src/github/github-request-contract.ts:21-36`, `:54-68`), normalizes `issue`/`pull` entities (`github-domain.ts:389-417`), fetches over REST with `GITHUB_TOKEN` + SSRF-safe `githubFetch` (`:217-233`), and renders entity text (`:1244-1299`). `parseGithubFetchUrl` (`src/native-fetch.ts:138-162`) deliberately returns `undefined` for issues/pulls, with the fall-through documented at `:134-137`.

**Create**
- `src/github/github-issue-pr-url.ts` — `parseGithubIssuePrFetchUrl(raw: string): { owner, repo, kind: 'issue' | 'pull', number: number } | undefined`. Port the reference parser semantics: `/owner/repo/issues|pull/N`, optional PR subpath (`files|commits|checks|conversation`) and `#issuecomment-N|#discussion_rN` anchors accepted but only used for output notes in v1; validate owner/repo with the reference regexes (`github-issue-pr.ts:103-109`), reject non-positive/non-integer numbers (reject-not-clamp). Keep it in `src/github/` so `native-fetch.ts` stays a dispatcher.

**Modify**
- `src/native-fetch.ts` — in `tryGithubUrlFetch`, after `parseGithubFetchUrl` returns `undefined`, try `parseGithubIssuePrFetchUrl` and map to `{ action: kind === 'pull' ? 'pulls' : 'issues', owner, repo, number }` → existing `callGithubTool`. Update the `:134-137` comment to name the new route and its bounds. Anchor/subpath variants fall back to the page reader (documented).
- `src/web/access/web-access-specialization.ts` — no change needed (`github.com` already classifies as `github`).

**REST-only v1 (parent decision D1):** the reference's `gh`-CLI-first order is **not** ported. Atlas has no `gh` execution in the fetch path, `gh` would be a new child-process surface, and the REST path already carries `GITHUB_TOKEN`. If gh-first is later approved it must use `buildNativeChildEnvironment` + fixed argv + `shell: false`, mirroring `src/github/github-clone.ts:171-176`, `:324-340`.

**Tests**
- Extend `test/native-fetch.test.ts` — `parseGithubIssuePrFetchUrl` maps issues/pull/subpath/anchor and declines commits/gists/other hosts; fetch of `/o/r/issues/1` and `/o/r/pull/2` reaches the github tool (stub `callGithubTool` or assert the mapped request shape); existing `parseGithubFetchUrl` assertions stay green (new function is additive).
- Extend `test/github/github-contract.test.ts` — no contract change expected; add a regression assertion that `issues`/`pulls` with `number` remain valid requests.

**Verify:** `node --import tsx --test test/native-fetch.test.ts test/github/github-domain.test.ts`

**Open decision D2 (partially resolved):** bounded top-level comments (per_page 50, first page, byte-budgeted) ship in v1 riding the entity body; checks/files/commits rendering stays deferred (requires new bounded REST calls in `github-domain`).

---

## M6. Scanned-PDF degraded marking (local-only, fail-closed)

**Port source (semantics only, no cloud):** `/tmp/pi-web-access/extract.ts:1269-1294` (PDF failure wrapping), `:1208-1228` (size caps). Atlas seam: `src/media-vision/pipeline-pdf.ts:24-25` (`PDF_SCANNED_PAGE_MIN_CHARS = 48`), `:68-128` (`runPdfPipeline`, `describePage` absent → `page-N-possibly-scanned-no-vision` warnings), `:50-66` (explicit-vision entry point is NOT the hot path; `isPdfCloudRenderOptIn` is exact-`'1'` and fail-closed).

**Parent decision: cloud PDF is out of scope.** So this milestone only surfaces honest degradation from the local path; it wires **no** `describePage` seam and therefore cannot trigger any cloud render.

**Create**
- `src/web/access/web-access-pdf-diagnostics.ts` — `pdfSparsePageWarnings(bytes, extractor, signal): Promise<{ warnings: string[]; totalPages: number }>` built on `runPdfPipeline` with `{ extractor }` and **no** `describePage`; returns only warnings (never content), so the existing `[p. N]` citation text policy in `extractWebAccessPdfText` is untouched.

**Modify**
- `src/native-fetch.ts` (`tryLocalPdfFetch`) — after successful `extractWebAccessPdfText`, run the diagnostics helper; when warnings indicate sparse pages, add `degraded: true` + a fixed note (`Scanned pages yielded little local text; OCR/vision escalation is not enabled for fetch (local-only PDF policy).`) and carry `warnings` in `details.pdf`. Extraction failure still falls through to the page reader exactly as today.

**Tests**
- `test/web/access/web-access-pdf-diagnostics.test.ts` — sparse page → `page-N-possibly-scanned-no-vision`, dense page → no warning, extraction failure → `pdf-extraction-failed`, byte/page ceiling reasons, **assert no describePage/vision transport is ever constructed** (injected counter).
- Extend `test/web/access/web-access-fetch-pdf.test.ts` — degraded note present for a scanned fixture, absent for a text fixture.

**Verify:** `node --import tsx --test test/web/access/web-access-pdf-diagnostics.test.ts test/web/access/web-access-fetch-pdf.test.ts test/media-vision/pipeline-pdf.test.ts`

---

## M7. Cookie-authenticated fetching (highest risk)

**Port source:** `/tmp/pi-web-access/auth-fetch.ts:22-37` (profile resolve), `:39-53` (`assertAuthFetchUrl`: HTTPS-only + host/subdomain allowlist), `:55-59` (`authFetchRedirectGuard`: refuse cross-origin), `:61-110` (profile parsing), `:112-140` (host/chromeProfile validation); fetch mechanics `/tmp/pi-web-access/extract.ts:173-208` (`fetchAuthenticatedRemoteUrl`: per-hop cookie header, manual redirects ≤5, same-origin guard, per-hop SSRF revalidation), `:160-169` (per-hop cookie resolution), `:537-543` (auth ⇒ direct HTTP only, no provider routing); cache policy `/tmp/pi-web-access/index.ts:638-642` (`authProfile.cache === 'off'` ⇒ no store).

**Atlas reality check (verified):** `src/chrome/cookie-jar.ts` already provides storage-state import from the default browser (`:86-171`), `cookieHeaderForUrl(provider, url, env)` with HTTPS-only + host-only vs `Domain` + path + expiry + ByteString filtering (`:275-306`), `cookieAuthEnvironment` (`:237-266`), and `COOKIE_ENV_KEYS`/`cookieProviderForCommand` (`:215-231`). Provider→`cookieDomains` live in `src/setup/providers.ts:35-47`. `src/chrome/chrome-profile-auth.ts` is the **browser-companion authorization state machine** (TTL/lease), not a cookie reader — it is *not* the seam for this gap; do not wire it. `src/core/http.ts:42-79` already strips credential headers on cross-origin hops and preflights DNS per hop. `src/web/access/web-access-fetch.ts:1-8` currently documents "no proxy, no auth profiles" — that header must be updated.

### Design (resolved by the "no new tool params" constraint)

Operator-only configuration; no model input. `PI_FETCH_AUTH_PROFILES` = JSON object `{ "<name>": { "provider": "<cookie-jar provider>", "hosts": ["example.com"], "cache": "session" | "off", "redirects": "same-origin" } }`. Absent env ⇒ the feature is completely inert (no cookie read, no behavior change). A URL is authenticated only when its hostname exactly matches a profile host or is a subdomain of it (`hostMatches`, trailing-dot normalized). A matching profile takes precedence over specialist routing for that host, and is applied only on the direct-HTTP path.

**Create**
- `src/web/access/web-access-auth-contract.ts` — `WebAccessAuthProfile`, `parseWebAccessAuthProfiles(env)`, `resolveAuthProfileForUrl(url, profiles)`, `assertAuthFetchUrl(profile, rawUrl)`, `authFetchRedirectGuard(profile, from, to)`, caps (`MAX_AUTH_PROFILES`, `MAX_AUTH_HOSTS_PER_PROFILE`, `AUTH_PROFILE_NAME_PATTERN`, `MAX_AUTH_REDIRECTS = 5`). Validation is reject-not-clamp: unknown top-level keys, unknown profile fields, non-`same-origin` redirects, bad `cache`, bad hostname syntax, empty host list, `provider` not present in `PROVIDER_DESCRIPTORS` with a non-empty `cookieDomains`, or a host outside that provider's `cookieDomains` all throw a fixed message naming only the field (never a value, never a cookie).
- `src/web/access/web-access-auth-fetch.ts` — `fetchAuthenticatedReadablePage(url, profile, { env, signal, lookup, maxBytes })`:
  1. `assertAuthFetchUrl` (HTTPS + allowed host) → `validateHttpUrl` → `resolvePublicHostname`.
  2. Manual redirect loop, ≤5 hops: `fetch(hopUrl, { redirect: 'manual', headers: { cookie? } })`; each hop re-runs `validateHttpUrl` + `resolvePublicHostname` **before** any cookie is attached; `authFetchRedirectGuard` refuses a cross-origin hop outright (stricter than header-stripping); missing/invalid `Location` rejects.
  3. Cookie header recomputed per hop via `cookieHeaderForUrl(profile.provider, hopUrl, env)`; no header when no cookie matches (never send an empty/partial credential set to an unrelated host).
  4. Bounded read (`src/core/http.ts:safeResponseText`-style byte ceiling), then content-type routing: HTML → `stripHtml` + M3 RSC rescue + M2 declared links + M1 sanitize; `application/pdf` → `extractWebAccessPdfText`; anything else → fixed `authenticated fetch supports HTML and PDF content types only`.
  5. Fixed safe errors only; cookie values, `Set-Cookie`, and full URLs never appear in error text.

**Modify**
- `src/web/web-page-reader.ts` — add `authFetch?: { profile: WebAccessAuthProfile; cachePolicy: 'session' | 'off' }` to `FetchPageRuntime`. When present: skip the Scrapling bridge, Diffbot, and gated external fetch entirely, run `fetchAuthenticatedReadablePage`, and return with `authenticated: { profile: profile.name, cachePolicy }` on `ReadablePage`. Update the file header comment to record the ordering exception.
- `src/native-fetch.ts` — in `agenticBrowse` (and the singular branch of `dispatchFetch` before `dispatchSpecializedUrl`): resolve the profile from `options.env ?? process.env`; when matched, pass the auth seam and (a) skip `cacheFetchForRetrieve` unless `cachePolicy === 'session'`, (b) skip the `fetchPageText` test seam unless a test injects an auth seam explicitly, (c) add `details.authFetch = { profile, cachePolicy, externalProcessing: false }`.
- `src/web/access/web-access-fetch.ts` — update the header contract text (`:1-8`) to state that auth profiles exist as an operator-only, host-scoped seam.

### Threat-model-lite (auth fetch)

Assets: stored browser cookies (session credentials), fetched authenticated content, operator config.

| # | Threat | Control (must be test-enforced) |
|---|---|---|
| T1 | Cookie exfil via cross-origin redirect | Refuse the hop (`authFetchRedirectGuard`); never fall back to header-stripping for auth'd fetches |
| T2 | Cookie sent to a sibling/attacker host | Exact-host or dot-boundary subdomain match; trailing dot normalized; profile hosts validated against the provider's `cookieDomains` |
| T3 | Plaintext transport / downgrade | `https:` required; any `http:` hop (including https→http) rejects |
| T4 | Cookies attached to a private/reserved target | `validateHttpUrl` + `resolvePublicHostname` per hop *before* cookie attachment; SSRF policy remains the outer boundary |
| T5 | Auth'd content cached / replayed from cache | Default `cache: 'off'` for auth'd fetches; `cacheFetchForRetrieve` skipped; memory-only store untouched (no disk) |
| T6 | Credentials leaked to third-party renderers | Auth path bypasses Scrapling bridge, Diffbot Analyze, Firecrawl/Jina; no external fetch on auth'd URLs |
| T7 | Expired/stale cookies replayed | `cookieHeaderForUrl` expiry filtering (existing); no new caching of cookie values |
| T8 | Secret in error text/logs | Fixed messages; no cookie, `Set-Cookie`, or full-URL echo; `details.authFetch` carries the profile *name* only |
| T9 | Non-latin1 cookie values | Existing ByteString filter in `cookieHeaderForUrl`; header assembly never bypasses it |
| T10 | Model reads auth'd page text as instructions | Existing untrusted-content fencing (`src/core/untrusted-content.ts`, `fetch` in `EXTERNAL_TOOL_NAMES`); no change needed, assert in a test that the marker still applies |
| T11 | Config injection / silent widening | Reject-not-clamp parsing; unknown keys throw; absent env ⇒ inert; no wildcard hosts |
| T12 | Companion-grant confusion | `chrome-profile-auth.ts` (browser companion TTL/lease) is deliberately not involved; document that fetch auth reads the *imported* cookie jar only |

Residual risks to state in the ADR: imported cookie state is a long-lived credential on disk (`~/.pi-northstar/cookies`, 0600); subdomain matching means a compromised subdomain of an allowed host receives cookies; DNS rebinding/TOCTOU remains (container egress authoritative).

**Tests**
- `test/web/access/web-access-auth-contract.test.ts` — profile parsing (array shorthand optional), unknown key reject, bad hostname reject, host outside `cookieDomains` reject, unknown provider reject, name pattern, absent env ⇒ empty, multiple profiles resolve by host, subdomain match, trailing dot.
- `test/web/access/web-access-auth-fetch.test.ts` — HTTPS-only reject, cookie attached only on match, no cookie header when jar empty, per-hop recomputation, PDF branch, unsupported content type rejects, byte ceiling, abort.
- `test/web/access/web-access-auth-redirect.test.ts` — cross-origin redirect refused, https→http refused, private-resolving hop refused before cookie attachment, hop limit, missing Location.
- Extend `test/web/access/web-access-fetch-cache.test.ts` — auth'd result not cached with `cache: 'off'`, cached with `'session'`; extend `test/native-fetch.test.ts` — bridge/Diffbot/external adapters are not invoked on an auth'd URL (counter seams).
- Reuse `test/chrome/cookie-jar.test.ts` as-is for the header builder; add one cross-test asserting the auth path never calls `cookieAuthEnvironment`.

**Verify:** `node --import tsx --test test/web/access/web-access-auth-contract.test.ts test/web/access/web-access-auth-fetch.test.ts test/web/access/web-access-auth-redirect.test.ts test/chrome/cookie-jar.test.ts && npm run typecheck`

**Resolved decisions**
- **D3 (resolved):** config carrier is `PI_FETCH_AUTH_PROFILES` JSON (no schema change, matches Atlas env conventions such as `PI_SEARCH_COOKIE_BROWSER`).
- **D4 (resolved):** authenticated content is limited to HTML and PDF in v1; other content types reject.
- **D6 (resolved):** hosts outside a provider's `cookieDomains` (e.g. a paywalled news host with no descriptor) stay unsupported; extending the descriptor registry or adding a manual storage-state import path is deferred.

---

## M8. Video frames + video analysis (YouTube HTTP(S), anonymous)

**Parent decisions:** yt-dlp/ffmpeg **accepted** for frames, anonymous only (no account credentials, no cookie flags). Frames trigger automatically (no new tool params), gated by exact-`'1'` `PI_VISION_FETCH_VIDEO_FRAMES=1` **and** existing vision eligibility. Synthesis approved **only** with an explicit operator-configured model, fail-closed to evidence-only. Local video **files** are out of scope (D1: `fetch` rejects non-HTTP by contract, and `callReachTool('video')` is YouTube-only — verified: no path/extension handling in `src/media/media.ts`; parity for local files is therefore *not* satisfied via the media tool and is deferred).

**Port source:** `/tmp/pi-web-access/youtube-extract.ts:156-172` (yt-dlp duration + stream URL), `:174-212` (ffmpeg single/batch frame extraction), `:197-212` (`extractYouTubeFrames`), `:228-327` (Gemini Web → Gemini API → Perplexity chain — **not ported as hosted defaults**), dispatch `/tmp/pi-web-access/extract.ts:550-682` (frames/timestamp gating), `:684-697` (local video full).

### M8a. Frame extraction (new child-process seam)

**Create**
- `src/media-vision/frame-extract.ts`:
  - `isYtDlpAvailable(env)`, `readYoutubeDurationSec(url, env, signal)`, `extractYoutubeKeyframes(url, { env, signal, count ≤ VIDEO_MAX_KEYFRAMES }): Promise<VideoKeyframe[]>` using `spawn` with fixed argv arrays and `shell: false`, env = `buildNativeChildEnvironment(parentEnv)` plus **nothing else** (no cookie vars, no proxy), `--no-config` always (blocks user config from injecting credentials/cookies), `--no-cache-dir`, `--no-playlist`, `--no-warnings`, `--no-part`; yt-dlp is invoked for `--print duration` and `--print urls` (stream URL) only.
  - ffmpeg fixed argv: `-nostdin -hide_banner -loglevel error -ss <sec> -i <stream|file> -frames:v 1 -f image2pipe -vcodec mjpeg pipe:1`, one process per keyframe, per-frame timeout, SIGTERM→SIGKILL grace mirroring `src/github/github-clone.ts:264-320`.
  - Hard rejection list enforced in code (test-enforced): argv must never contain `--cookies`, `--cookies-from-browser`, `--username`, `--password`, `--netrc`, `--proxy`, `-c`/`--config-location`; caller-supplied argv is impossible (no argv passthrough API).
  - Bounds: `VIDEO_MAX_KEYFRAMES` (12, from `pipeline-video.ts:10`), per-frame 30s, total 120s, frame byte ceiling (reuse `IMAGE_MAX_BYTES` 20MiB), reject-not-clamp on `count`.
  - Error mapping to fixed strings (private/age-restricted/region/live/unavailable/missing-binary) — never raw stderr echo.

**Modify**
- `src/capabilities.ts:474-479` — rewrite the `yt-dlp` backend note: `mode: 'external'` frames-only, anonymous (no account credentials, no cookie flags), never used for search/details/hot, requires `PI_VISION_FETCH_VIDEO_FRAMES=1`; keep `actions: []` if the registry semantics require it, otherwise add a `frames` action only if the registry supports one without widening the public surface (verify before editing).
- `src/reach-tools.ts:182` — update the adjacent comment (it currently asserts yt-dlp is never routed).
- `src/setup/installer.ts:76-82` — yt-dlp entry already exists; add ffmpeg to the installer's binary list only if it is absent (check `src/setup/installer.ts` before editing; do not add a second entry).

### M8b. Video analysis orchestration

**Create**
- `src/media-vision/video-analysis.ts` — `runFetchVideoAnalysis(url, seams): Promise<{ text: string; warnings: string[]; keyframes: number; synthesized: boolean; degraded: boolean }>` built on `runVideoPipeline` (`src/media-vision/pipeline-video.ts:47-110`):
  - `readMetadata` ← yt-dlp duration/title (bounded).
  - `readTranscript` ← existing transcript path only (`callReachTool('video', { url })`, `src/native-fetch.ts:177-183`); no new transcript backend.
  - `readKeyframes` ← `extractYoutubeKeyframes` (only when `PI_VISION_FETCH_VIDEO_FRAMES === '1'`).
  - `describeKeyframe` ← existing image describe seams: `describeImageWithGemini` (Gemini tier) or `createOpenAICompatibleVisionTransport(...).describe` (OpenAI-compatible tier), selected by `resolveVisionEligibilityFromEnv` order (`native` → `openai-compatible` → `gemini` → `gemini-web`), with `eligibleTiersAfterFailure` on tier failure (never broadening).
  - Fail-closed: env unset, or no eligible non-native tier, or no keyframe source ⇒ evidence-only (metadata + transcript) with warnings; no keyframes are fetched when the env opt-in is absent.

### M8c. Optional synthesis (explicit operator model only)

**Create**
- `src/media-vision/video-synthesis.ts` — `synthesizeVideoEvidence(evidenceText, { env, signal }): Promise<{ text: string; model: string } | undefined>`:
  - Gemini tier: existing `resolveGeminiConfig` (`src/media-vision/gemini.ts:88`) + `createGeminiTransport(...).generateContent({ prompt })` (text-only prompt; verify the request shape supports prompt-without-inlineData, else pass an empty inline guard).
  - OpenAI-compatible tier: reuse `resolveOpenAICompatibleVisionConfig` (`src/media-vision/openai-compatible.ts:67`) and the same model-ID validation; requires one **additive** `describeText` function on that transport (same `config.modelIds` allowlist, same reject-not-clamp prompt bounds) because the current `describe` requires non-empty image bytes.
  - Returns `undefined` when no tier is configured or the model ID is not in the operator allowlist → caller falls back to evidence-only. Never auto-picks a model, never a hosted default.
  - Input is bounded (reuse `WEB_ACCESS_RETRIEVAL_MAX_CHARS`-style cap) and the prompt constrains output to the supplied evidence with untrusted-content framing.

**Modify**
- `src/media-vision/openai-compatible.ts` — additive `describeText` (no change to `describe`'s image validation).
- `src/native-fetch.ts` — `tryMediaUrlFetch`: when the URL is a YouTube watch/shorts URL and (`PI_VISION_FETCH_VIDEO_FRAMES === '1'` or a synthesis tier is configured), run `runFetchVideoAnalysis` and return a combined envelope: transcript text as content, keyframe evidence + optional synthesis in `details` (`generatedText`-style separation, `degraded` note when keyframes were requested but unavailable). When nothing is opted in, current behavior (transcript via media tool) is unchanged.

**Tests**
- `test/media-vision/frame-extract.test.ts` — fixed argv shape, `--no-config` present, forbidden flag list never emitted (assert on the argv builder for every branch), env allowlist contains no cookie/proxy keys (sentinel-secret leak check mirroring `test/process/python-child-env.test.ts` style), keyframe ceiling reject, per-frame timeout → SIGTERM→SIGKILL, fixed error strings, abort.
- `test/media-vision/video-analysis.test.ts` — env unset ⇒ no yt-dlp/ffmpeg invocation (counter), env set + no eligible tier ⇒ evidence-only with warnings, tier failure ⇒ `eligibleTiersAfterFailure` (no broadening), keyframes > 12 truncated with warning, transcript empty warning.
- `test/media-vision/video-synthesis.test.ts` — no model configured ⇒ `undefined`, model not in allowlist ⇒ `undefined`, Gemini tier path with injected transport, OpenAI-compatible `describeText` reject-not-clamp bounds, evidence-only fallback on tier failure.
- Extend `test/native-fetch.test.ts` — YouTube URL with nothing opted in behaves exactly as today; with the env opt-in the envelope carries keyframe evidence and never merges synthesis into `content`.
- Extend `test/capabilities.test.ts` — the yt-dlp registry note no longer claims automatic routing is forbidden, and still advertises no search/details/hot actions.

**Verify:** `node --import tsx --test test/media-vision/frame-extract.test.ts test/media-vision/video-analysis.test.ts test/media-vision/video-synthesis.test.ts test/native-fetch.test.ts test/capabilities.test.ts && npm run typecheck`

---

## M9. Documentation, policy text, ADRs

**Create**
- `docs/adr/0008-cookie-authenticated-fetch.md` — the M7 design, the T1-T12 control table, residual risks, and the "operator-only, host-scoped, no new tool params" decision.
- `docs/adr/0009-anonymous-video-frames.md` — yt-dlp/ffmpeg frames accepted anonymously, the exact-`'1'` opt-in, why hosted summary chains were not ported, and the local-file deferral.

**Modify**
- `docs/plans/2026-09-16-fetch-extraction-parity-port.md` — copy of this plan for repo history (optional but recommended; `docs/plans/` already holds dated plans).
- `AGENTS.md` — invariants section: add the auth-fetch seam (operator-only, HTTPS + same-origin-only, no cache by default, no external renderers) and the video-frames policy text (anonymous yt-dlp/ffmpeg, fixed argv, `PI_VISION_FETCH_VIDEO_FRAMES`).
- `README.md` — fetch section: RSC rescue, declared-links appendix, image metadata, GitHub issues/PRs, auth profiles, video frames; state that PDF stays local-only and the cache stays memory-only.

**Verify:** `npm run typecheck` (docs only otherwise).

---

## M10. Final sweep and regression gate

1. `npm run typecheck` — zero errors (strict + `exactOptionalPropertyTypes`; new optional fields must use the `?: T | undefined` form Atlas uses).
2. `npm test` — full suite green, with particular attention to: `test/native-fetch.test.ts`, `test/web/web-page-reader.test.ts`, `test/web/access/*`, `test/github/*`, `test/media-vision/*`, `test/process/*` (child-env), `test/network-policy.test.ts`, `test/redirect-ssrf-freshness.test.ts`, `test/public-tool-schemas.test.ts` (proves the 5-branch schema is unchanged).
3. Grep gate: `grep -rn "data:" src/web src/native-fetch.ts` shows only the sanitizer; `grep -rn "linkedom\|sharp\|node-html-parser" src/ package.json` is empty (no new deps); `grep -rn "spawn(" src/media-vision src/github` shows only `shell: false` call sites with `buildNativeChildEnvironment`.
4. Confirm no disk writes added: `grep -rn "writeFile\|mkdir" src/web/access src/native-fetch.ts src/media-vision` shows no new cache persistence.
5. Manual smoke (operator env, no hosted keys): one Next.js URL (RSC rescue), one `github.com/o/r/issues/1`, one `.pdf`, one image URL, one YouTube URL with and without `PI_VISION_FETCH_VIDEO_FRAMES=1`.

---

## File touch summary

**New source (10)**
`src/core/data-uri-sanitize.ts` · `src/web/access/declared-web-links.ts` · `src/web/access/rsc-extract.ts` · `src/web/access/web-access-image.ts` · `src/web/access/web-access-pdf-diagnostics.ts` · `src/web/access/web-access-auth-contract.ts` · `src/web/access/web-access-auth-fetch.ts` · `src/media-vision/frame-extract.ts` · `src/media-vision/video-analysis.ts` · `src/media-vision/video-synthesis.ts`

**Modified source (5)**
`src/native-fetch.ts` (M1, M2, M4, M5, M6, M7, M8) · `src/web/web-page-reader.ts` (M2, M3, M7) · `src/web/access/web-access-fetch.ts` (M7 header) · `src/media-vision/openai-compatible.ts` (M8c additive `describeText`) · `src/capabilities.ts` + `src/reach-tools.ts` (M8 policy text)

**New tests (11)**
`test/core/data-uri-sanitize.test.ts` · `test/web/access/declared-web-links.test.ts` · `test/web/access/rsc-extract.test.ts` · `test/web/access/web-access-image.test.ts` · `test/web/access/web-access-pdf-diagnostics.test.ts` · `test/web/access/web-access-auth-contract.test.ts` · `test/web/access/web-access-auth-fetch.test.ts` · `test/web/access/web-access-auth-redirect.test.ts` · `test/media-vision/frame-extract.test.ts` · `test/media-vision/video-analysis.test.ts` · `test/media-vision/video-synthesis.test.ts`

**Modified tests (3)**
`test/native-fetch.test.ts` · `test/web/web-page-reader.test.ts` · `test/web/access/web-access-fetch-cache.test.ts` (+ `test/capabilities.test.ts`)

**Docs (4):** `docs/adr/0008-*`, `docs/adr/0009-*`, `AGENTS.md`, `README.md` (+ optional plan copy).

Total ≈ **32 files** (15 source, 15 test, 4 docs incl. 2 ADRs).

## LOC estimate

| Milestone | Source | Tests | Total |
|---|---|---|---|
| M1 data-URI sanitize | ~400 | ~120 | ~520 |
| M2 declared links | ~200 | ~110 | ~310 |
| M3 RSC rescue | ~350 | ~130 | ~480 |
| M4 remote images | ~140 | ~100 | ~240 |
| M5 GitHub issues/PRs | ~120 | ~110 | ~230 |
| M6 PDF degraded marking | ~70 | ~80 | ~150 |
| M7 cookie auth | ~420 | ~410 | ~830 |
| M8 video frames/analysis/synthesis | ~620 | ~330 | ~950 |
| M9 docs/policy | ~150 | — | ~150 |
| M10 sweep | — | — | ~0 |
| **Total** | **~2.5k** | **~1.4k** | **~3.9k LOC** |

## Open decisions needing parent approval

- **D1 (resolved):** local-video-file analysis is deferred — `fetch` rejects non-HTTP by contract (`src/web/web-fetch-route.ts:165-171`) and `callReachTool('video')` is YouTube-only (verified in `src/media/media.ts`). No route/schema change in this plan.
- **D2 (partially resolved):** bounded top-level comments (per_page 50, first page, byte-budgeted) ship in v1 riding the entity body; checks, changed-files, and commits rendering stays deferred.
- **D3 (resolved):** auth-profile config carrier is `PI_FETCH_AUTH_PROFILES` JSON.
- **D4 (resolved):** authenticated content is limited to HTML and PDF in v1.
- **D5:** env name/necessity for fetch-time image description (proposed `PI_VISION_FETCH_DESCRIBE=1`).
- **D6 (resolved):** hosts outside a provider's `cookieDomains` stay unsupported; extending the descriptor registry or adding a manual storage-state import path is deferred.
- **D7 (resolved):** `src/capabilities.ts` yt-dlp registry entry keeps `actions: []` — frames remain an internal fetch capability.
- **D8:** whether the M8c text-only `describeText` addition to `openai-compatible.ts` is acceptable as an additive transport surface (it is the only source change needed for OpenAI-compatible synthesis).
