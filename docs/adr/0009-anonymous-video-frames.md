# ADR 0009: Anonymous video frames + video analysis (YouTube, opt-in)

## Status

Proposed — implementation in progress (milestone M8 of the fetch-extraction parity port; see `docs/plans/2026-09-16-fetch-extraction-parity-port.md`). No code described here is authoritative until the M8 tests land.

## Context

The `pi-web-access` reference extracts YouTube keyframes via yt-dlp + ffmpeg and then runs a hosted Gemini Web → Gemini API → Perplexity summary chain, plus full local-video-file analysis. Atlas already owns the vision understanding path (`src/media-vision/` pipelines, eligibility, transfer policy, synthetic probe) and YouTube transcript acquisition (`callReachTool('video')`, YouTube-only — verified: no `file://`/`isVideoFile`/extension handling in `src/media/media.ts`). What is missing is the frame-extraction seam and its orchestration into `fetch`. No new tool params are allowed: the 5-branch `fetch` schema is unchanged, so frames trigger automatically under operator gates.

## Decision

- yt-dlp/ffmpeg accepted for frame extraction, **anonymous only**: no account credentials, no cookie flags. argv must never contain `--cookies`, `--cookies-from-browser`, `--username`, `--password`, `--netrc`, `--proxy`, `-c`/`--config-location` (test-enforced); caller-supplied argv is impossible (no argv passthrough API). yt-dlp always runs with `--no-config` (blocks user config from injecting credentials/cookies), `--no-cache-dir`, `--no-playlist`, `--no-warnings`, `--no-part`, and is invoked for `--print duration` and `--print urls` (stream URL) only.
- Frames trigger automatically only when **both** hold: the exact opt-in `PI_VISION_FETCH_VIDEO_FRAMES=1` (absent or any other value is off) **and** existing vision eligibility (`resolveVisionEligibilityFromEnv`; `eligibleTiersAfterFailure` on tier failure, never broadening). Env unset, no eligible non-native tier, or no keyframe source ⇒ evidence-only (metadata + transcript) with warnings; no yt-dlp/ffmpeg process is spawned.
- Synthesis approved **only** with an explicit operator-configured model, fail-closed to evidence-only (never auto-picks a model, never a hosted default). The only source change needed for OpenAI-compatible synthesis is the additive text-only `describeText` transport function (decision D8: approved; `describe`'s image validation unchanged).
- Child-process rules preserved: `spawn` with fixed argv arrays, `shell: false`, env = `buildNativeChildEnvironment(parentEnv)` plus nothing else (no cookie vars, no proxy), per-frame 30s / total 120s timeouts, SIGTERM→SIGKILL grace mirroring `src/github/github-clone.ts:264-320`. Bounds: `VIDEO_MAX_KEYFRAMES` 12, frame bytes reuse `IMAGE_MAX_BYTES` 20MiB, reject-not-clamp on `count`. Errors map to fixed strings (private/age-restricted/region/live/unavailable/missing-binary) — never raw stderr echo.
- Keyframe evidence and optional synthesis ride `details` (`generatedText`-style separation, `degraded` note when keyframes were requested but unavailable); transcript text stays the content. Synthesis input is bounded with untrusted-content framing.
- yt-dlp registry entry keeps `actions: []` — frames stay an internal fetch capability, not an advertised action (decision D7).

## Why the hosted summary chain was not ported

The reference's Gemini Web → Gemini API → Perplexity chain assumes hosted defaults the operator never configured. Atlas policy is explicit-operator-model-only synthesis: unconfigured tiers degrade to native evidence, and one configured destination never authorizes another. Porting the chain would introduce implicit hosted routing behind the operator's back.

## Local-file deferral (decision D1, resolved)

Local video **files** are out of scope: `fetch` rejects non-HTTP by contract (`src/web/web-fetch-route.ts:165-171`), and `callReachTool('video')` is YouTube-only. Parity for local files is therefore not satisfied via the media tool and is deferred — no route/schema change.

## Consequences

YouTube `fetch` URLs gain keyframe evidence + optional operator-model synthesis when the operator opts in twice (frames env + vision destination); with nothing opted in, behavior is exactly today's transcript-via-media-tool path. No credentials can reach yt-dlp by construction.

## Residual risks

- yt-dlp/ffmpeg are new external binaries in the fetch path; availability and version drift are operator concerns (installer lists the binaries; missing binary ⇒ fixed error, evidence-only). The ffmpeg installer entry is darwin-only (brew); linux operators install ffmpeg manually, else frames fail closed with `frame-binary-missing`.
- Keyframe content sent to the operator-configured vision destination is subject to the standard vision privacy warning (content leaves the machine).

## Verification

`node --import tsx --test test/media-vision/frame-extract.test.ts test/media-vision/video-analysis.test.ts test/media-vision/video-synthesis.test.ts test/native-fetch.test.ts test/capabilities.test.ts && npm run typecheck`.
