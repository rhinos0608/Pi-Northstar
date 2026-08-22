# Reddit + YouTube Fallback Resilience (2026-08-22)

## Rationale

Reddit and YouTube tool actions previously depended on external CLIs
(`opencli`, `rdt-cli`, `yt-dlp`) that require browser logins, can be flaky,
and had no native first-party path. This change adds:

- **Reddit live primary**: the official Reddit Data API via `client_credentials`
  OAuth when a complete credential triple is configured, plus a native
  direct request using a saved Reddit session cookie. Both hit fixed Reddit
  hosts only.
- **Reddit archive fallback**: the fixed Arctic Shift archive
  (`arctic-shift.photon-reddit.com`), used strictly as a last resort and
  clearly labeled as archival (never live).
- **YouTube**: the official YouTube Data API v3 when `YOUTUBE_API_KEY` is set,
  and the fixed `www.youtube.com/oembed` endpoint as a keyless `details`
  fallback. No scraping, no proxy, no transcript service, and **no automatic
  yt-dlp routing** — `yt-dlp` remains only as legacy descriptor/probe
  metadata, never invoked by calls. Transcripts return a clear bounded
  unavailable error.

No new dependencies. No public tool-schema changes. No user-configurable
fallback hosts. No changes to the deliberate SSRF/containerization posture
(`validatePublicHttpUrl` behavior is untouched).

## Source ordering

Reddit (`social` -> `reddit`):

1. Native OAuth Data API (`oauth.reddit.com`) — requires complete
   `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` + `REDDIT_USER_AGENT`.
2. Native direct request (`www.reddit.com`) — when a raw `REDDIT_COOKIE` env
   value is present, or when a **stored** cookie matches the exact request
   URL by host/path/expiry/secure (`cookieHeaderForUrl`). The unfiltered
   stored-cookie blob is never used as a session: expired, path-mismatched,
   or non-Reddit stored cookies do not bypass the legacy CLI fallback. Cookie
   is sent only to fixed Reddit hosts.
3. Legacy CLI compatibility fallback (`opencli`, then `rdt-cli`) — only when
   no live credentials/session exist.
4. Arctic Shift archive — only after a live read has no public content, a
   transient/block/network failure, or no live source exists and the CLI
   cannot serve.
5. **Opt-in only** (`PI_SEARCH_PLATFORM_WEB_FALLBACK=1`, last resort):
   Pi-owned `web_search`/`agentic_browse` through a sanitized Pi child process
   (no cookies, no proxy variables, no platform/API credentials;
   `PI_SEARCH_SCRAPLING_ENABLED=0`; the child's `PI_SEARCH_ENV_PATH` is pinned
   to a never-existing path so `cli.ts` cannot re-load the repo `.env` or a
   JSON config). Separate `web-search-fallback`/`web-fetch-fallback` data
   models, never merged into API models.

YouTube (`video` -> `youtube`):

1. Official Data API when `YOUTUBE_API_KEY` set (`search`, `details`, `hot`).
2. `oEmbed` (keyless) as the `details` fallback.
3. **Opt-in only** last resort (`PI_SEARCH_PLATFORM_WEB_FALLBACK=1`): the same
   sanitized web-search/web-fetch fallbacks for `search`/`hot` (no key or API
   failure) and for `details` once oEmbed fails. `transcript`/`subtitle`
   always return a clear unavailable error.

## Supported action / failure boundaries

Reddit live actions: `search`, `read`, `feed`, `subreddit`, `hot`,
`popular`, `subreddit_info`, `all`. Unsupported actions (e.g. `comments`)
keep legacy CLI error behavior and never reach live or archive backends.

Reddit live failure classification:

| Live outcome | Archive? |
|---|---|
| 200 with empty listing (`content_absent`) | yes (reason `content_absent`) |
| 429 / 5xx / network failure / timeout (`transient`) | yes (reason `transient`) |
| 401 / 403 (`auth_error`/`permission`) | no — thrown |
| 400 / missing required args (`invalid_input`) | no — thrown |
| AbortError | no — rethrown immediately |
| Incomplete credential triple / no cookie, CLI cannot serve | yes (reason `cli_unavailable`) |
| Invalid CLI input (missing args, non-Reddit URL host) | no — thrown |

The live primary error is preserved if the archive itself cannot help.

Archive action mappings: `search` -> `/api/posts/search?query=`,
`read` -> `/api/posts/ids?ids=`, `subreddit` -> `/api/posts/search?subreddit=`,
`feed`/`popular`/`all` -> `/api/posts/search?sort=desc&after=7d`, `hot` ->
`/api/posts/search?sort=desc&after=24h` (with `subreddit=` when provided),
`subreddit_info` -> `/api/subreddits/search?subreddit=`.

Archive output: explicit `backend: 'arctic-shift'`, `archived: true`,
`source`, `retrievedAt` provenance, `historicalApproximation: true` for
feed-like actions (Arctic Shift sorts only by `created_utc`; archive
feed/order is a historical approximation, not live ranking). Items marked
deleted/removed (`_meta.was_deleted_later === true` or truthy
`_meta.removal_type`) are filtered. Archive data is never labeled live.

## Arctic Shift caveats

- No SLA; archive freshness: content is ingested near-live and re-retrieved
  after ~36h, so summaries/scores may be stale. Deleted content can exist in
  the archive with `_meta` markers; we filter those items.
- Private/quarantined subreddits are excluded by Arctic Shift itself.
- Rate limit / transient errors: **no retry** — a single attempt per address;
  429/5xx propagate and are never masked.
- Legal posture: the archive is an unofficial third-party service with no
  license file and no stated Reddit authorization. It is used only as a
  clearly-labeled last resort.

## Credential isolation

`REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USER_AGENT`, and
`YOUTUBE_API_KEY` were removed from the `externalEnvironment` allowlist, so
they are never forwarded to any external command. External CLIs (`opencli`,
`rdt-cli`) receive **no session cookies** and no platform/API credentials —
`rdt` receives none of the stored Reddit cookie state (cookie forwarding to
external CLIs was removed; session cookies are only used by the Pi-owned
native direct request). Cookie-bearing `rdt read` URL input requires an exact
`reddit.com` subdomain/root or exact `redd.it` host; lookalike hosts are
rejected. The YouTube API key never appears in returned URLs, result details,
or error messages (redacted as `key=[redacted]`). The Reddit OAuth token is
cached module-level keyed by a SHA-256 digest of the credential triple
(values never used as the key), with bounded expiry and never surfaced in
output. All cookie-bearing and bearer requests reject HTTP redirects so
credentials never hop to another host.

`reach_status`/provider metadata reports Reddit as configured only when the
complete OAuth triple is present — an incomplete triple is never labeled
configured. Keyless YouTube is reported as partial (`youtube-oembed`, details
only), never as fully available and never via a `yt-dlp` probe.

## Opt-in final web fallback (PI_SEARCH_PLATFORM_WEB_FALLBACK=1)

Last resort after all of the above, enabled only by explicit opt-in:

- Pi-owned `web_search` / `agentic_browse` utilities run in a **sanitized Pi
  child process**: no cookies, no proxy variables, no platform or API
  credentials; `PI_SEARCH_SCRAPLING_ENABLED=0` inside the child so the
  page-fetch path makes exactly one remote attempt with no scrapling
  restart/retry and no plain-fetch second attempt.
- Search-like actions return `backend: "web-search-fallback"`,
  `dataModel: "search-results"`, `degraded: true`.
- URL/id detail/read actions perform at most one platform page fetch and
  return `backend: "web-fetch-fallback"`, `dataModel: "page-text"`,
  `degraded: true`.
- Fallback output is **never merged** into the Reddit/YouTube API models.
- The fallback is never invoked after invalid input, auth/permission errors,
  private/quarantined content, or abort; aborts propagate immediately.
- No user-configurable fallback hosts are introduced.

## Terms, authorization, and account risk

Reddit and YouTube prohibit unauthorized automated access/scraping; a logged-in
session or exported cookie does **not** confer permission, and session cookies
are full-account bearer credentials. Users who enable cookie-based fallbacks or
`PI_SEARCH_PLATFORM_WEB_FALLBACK=1` do so **at their own caution**: account
locks, IP/egress blocks, and ToS enforcement are possible. This feature set is
off by default and must be explicitly enabled.

## Verification

```bash
node --import tsx --test test/native-tools.test.ts
node --import tsx --test test/bootstrap.test.ts
node --import tsx --test test/index.test.ts
npm test
npm run typecheck
git diff --check
```

## Future work (deferred)

**Opt-in OAuth dashboard** — a future opt-in OAuth management UI could
provide Reddit and YouTube token management, scope selection, refresh flows,
and quota monitoring with a first-party UI. This release adds **no**
dashboard, redirect endpoint, token storage, schema field, or tool. Any such
feature requires a separate product decision, security review, and ADR before
implementation.