# Plan D — Multimodal Providers / Routing

> **For agentic workers:** Implement task-by-task. Own only listed files. Builds on Plan B (acquire/ledger/retention). Task D5 lands at Gate 1 (ahead of the rest of Plan D, exempt from the Gate 2 prerequisite); tasks D0–D4 build on Gate 2. Spike S1 first. No commits.

**Goal:** Image/PDF/video pipelines with deterministic eligibility ordering and transfer authorization.

## Task D0: Spike S1 (executable, throwaway, not committed)
**Outcome:** Written findings for `@google/genai` 1.52.0 (lock entry nested, `dev:true`, hoisting unproven): root install + import + image-understanding + token-count + Vertex ADC/project/location shape vs official docs.
- Pivot: lock version ≠ docs stable surface → pin exact lock version, escalate. No pin claim before this spike.

## Task D1: Eligibility (pure function)
**Outcome:** Route order native → configured OpenAI-compatible vision → Gemini (Developer API or Vertex) → Gemini Web (disabled default, last resort). **Policy/auth failure never broadens eligibility.**

**Files:**
- Create: `src/media-vision/eligibility.ts`
- Create: `test/media-vision/eligibility.test.ts` (negative: auth/policy failure must not escalate tiers)

**Checks:**
- `node --import tsx --test test/media-vision/eligibility.test.ts`

## Task D2: Capability probe + OpenAI-compatible transport
**Outcome:** Synthetic-image probe before user content rejects non-vision models. Accepts any configured base URL (loopback or cloud) + exact model IDs + optional API key. Never called "local". Uses Plan B `buildNativeChildEnvironment()` where a child is spawned; byte bounds + post-response usage checks only (must-not-claim preflight).

**Files:**
- Create: `src/media-vision/probe.ts`, `src/media-vision/openai-compatible.ts`
- Create: `test/media-vision/probe.test.ts`

**Checks:**
- `node --import tsx --test test/media-vision/probe.test.ts`

## Task D3: Gemini transports (direct owned dep)
**Outcome:** Direct `@google/genai` dependency at exact S1-verified version; exact configured models; developer key or Vertex ADC/project/location. Gemini Web: disabled default, last resort only, lease from actual lease owners (`browser-tools.ts` / `chrome-profile-bridge.ts` / `chrome-profile-adapter.ts` — **not** `chrome-profile-auth.ts`, which owns TTL parse only), exact Gemini origins, no raw cookie input/config.

**Files:**
- Create: `src/media-vision/gemini.ts`, `src/media-vision/gemini-web.ts`
- Modify: `package.json` (direct dep; lock update via installer, not hand-edit)
- Create: `test/media-vision/gemini.test.ts` (zero-network-call gate when disabled/unconfigured: mocked transport counter)

**Checks:**
- `node --import tsx --test test/media-vision/gemini.test.ts`

## Task D4: Pipelines
**Outcome:** Image (acquire → MIME/magic → dimension → OCR + description as **separate evidence kinds**); PDF (unpdf local first → scanned/layout vision escalation, extends `src/web/access/web-access-pdf.ts` seam); video (internal metadata+transcript first via `src/media/*`, then ≤12 timestamped keyframes per S4; no ffmpeg → metadata+transcript only with warnings, no new binary dep).

**Files:**
- Create: `src/media-vision/pipeline-image.ts`, `pipeline-pdf.ts`, `pipeline-video.ts`
- Create: `test/media-vision/pipeline-image.test.ts`, `pipeline-pdf.test.ts`, `pipeline-video.test.ts` (OCR and description asserted as distinct `sourceKind` entries with page/timestamp/location + warnings; ranking flows through existing chunker/BM25/embedding/RRF)

**Checks:**
- `node --import tsx --test test/media-vision/pipeline-image.test.ts test/media-vision/pipeline-pdf.test.ts test/media-vision/pipeline-video.test.ts`

## Task D5: Transfer policy (Gate 1 shared seam)
**Outcome:** Public transfer authorized by explicit endpoint config or Gemini credentials; **private/authenticated GitHub cloud transfer requires independent explicit operator flag** (default off; Plan E asserts this gate). Warning task owned here (not deferred): worker edits `README.md` (privacy-warning section), `src/setup/providers.ts` (multimodal provider descriptors), `.env.example` (new endpoint/Gemini/flag keys with loud comments). Each warning states which content leaves the machine and requires explicit operator opt-in. Check: `grep -rin "sends.*to\|leaves.*machine\|explicit.*opt" README.md .env.example src/setup/providers.ts` shows new warnings; `node --import tsx --test test/media-vision/transfer-policy.test.ts`.

**Files:**
- Create: `src/media-vision/transfer-policy.ts`
- Create: `test/media-vision/transfer-policy.test.ts` (private GitHub content never reaches cloud provider without flag; cross-provider leakage negative)

**Checks:**
- `node --import tsx --test test/media-vision/transfer-policy.test.ts`

## Negative security tests (this plan)
- Cloud zero-call gates; cross-provider private leakage; provider eligibility (auth failure never unlocks next tier); prompt injection on OCR/description surfaces; upload cleanup/orphans via Plan B retention.

## Known unknowns / defaults / pivots
- OCR engine: default = vision-provider OCR as distinct evidence kind (no separate OCR dependency). Pivot: S1 proves provider verbatim OCR unreliable → escalate, do not silently collapse OCR into description.
- TODO (PDF page rendering): `runPdfPipeline` wires into the native PDF fetch path local-only; sparse-page cloud rendering (`describePage` seam) is designed but has no page-image source — `unpdf` ships no render API and the repo has no canvas backend (adding `node-canvas` or equivalent native dep is rejected for now). Until a render path exists, `PI_VISION_PDF_CLOUD_RENDER=1` must stay fail-closed (no seam supplied, local text + `page-N-possibly-scanned-no-vision` warnings). Options when revisited: dependency-free software rasterizer, optional peer dep behind capability check, or server-side render at the vision endpoint.
