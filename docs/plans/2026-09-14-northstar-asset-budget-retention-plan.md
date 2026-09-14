# Plan B — Asset / Budget / Retention Core

> **For agentic workers:** Implement task-by-task. Own only listed files. Gate 1 seam; Plans C/D/E build on this. No commits.

**Goal:** Shared asset pipeline primitives: ceilings, bounded acquisition, per-entry owner-bound store, budget ledger with honest preflight tiers, retention with finally-deletion.

## Task B1: Asset contract + per-entry owner binding
**Outcome:** Ceilings and evidence shape exist; store enforces session/owner binding per entry (not per store).

**Files:**
- Create: `src/assets/asset-contract.ts` (ceilings: `IMAGE_MAX_BYTES=20MiB`, `IMAGE_MAX_PIXELS=40MP`, `PDF_MAX_BYTES=25MiB`, `PDF_MAX_PAGES=100`, `VIDEO_MAX_BYTES=250MiB`, `VIDEO_MAX_MINUTES=120`, `VIDEO_MAX_KEYFRAMES=12`, `AGGREGATE_MAX_BYTES=512MiB`; `sourceKind: 'extracted'|'derived'`; locator `page|timestamp|location`; `warnings`; UTF-8 byte-admission helper)
- Modify: `src/web/access/web-access-content-store.ts` (**per-entry owner**: `put(entry, owner)`, `get(id, owner)` rejects foreign owner; singleton `Map` `:76` stays but entries carry owner; preserve existing 1h TTL (`WEB_ACCESS_STORE_TTL_MS` in `src/web/access/web-access-contract.ts:48`) with per-entry `createdAt` expiry; no per-store process-unique id)
- Modify: `src/web/access/web-access-contract.ts` (stored-entry owner field)
- Create: `test/assets/asset-contract.test.ts`, `test/web/access/web-access-store-owner.test.ts` (foreign-owner get rejects; cross-session isolation; expired entries (>1h) rejected even with matching owner)

**Session-id source (decided here before consumers merge):** default owner = extension session id threaded from `src/index.ts` call context; fallback = per-request random id (isolated, non-shared). Pivot: if Plan C jobs must outlive one store instance → job id becomes owner for job-derived entries.

**Checks:**
- `node --import tsx --test test/assets/asset-contract.test.ts test/web/access/web-access-store-owner.test.ts`
- Type: `npm run typecheck`

## Task B2: Bounded acquisition
**Outcome:** HTTP(S)/GitHub acquisition reuses `network-policy.ts` per-hop checks; MIME + magic-byte sniff; image dimension probe; never-truncate.

**Files:**
- Create: `src/assets/asset-acquire.ts`
- Create: `test/assets/asset-acquire.test.ts` (bomb fixtures rejected pre-decode: byte+page+pixel ceilings)

**Checks:**
- `node --import tsx --test test/assets/asset-acquire.test.ts`

## Task B3: Budget ledger with honest preflight tiers
**Outcome:** Per-fetch 512MiB aggregate accounting; token preflight split by capability.

**Files:**
- Create: `src/assets/budget-ledger.ts` (`enforcePreflightTokens(): 'authoritative' | 'bounded-bytes'`; authoritative path enforces **250k input tokens/asset + 1M aggregate preflight** via count APIs; `bounded-bytes` path uses hard media/byte bounds + post-response usage checks and **asserts must-not-claim preflight**; non-goal: no monetary cost control — backend owns cost, ledger tracks bytes/tokens safety bounds only)
- Create: `test/assets/budget-ledger.test.ts` (concurrent acquires in one fetch exceed 512MiB → reject; OpenAI-compatible path test asserts no preflight claim)

**Checks:**
- `node --import tsx --test test/assets/budget-ledger.test.ts`

## Task B4: Retention + orphan telemetry
**Outcome:** Default delete-in-finally for raw assets/renders/keyframes/temp credentials; cloud-upload deletion attempted with bounded orphan telemetry; in-memory derived evidence + response/job entries enforce 1h TTL with owner binding (preserve `WEB_ACCESS_STORE_TTL_MS`); optional derived-only persistence (≤24h, 0700 root/0600 files, TTL janitor, env-gated default-off, prominent warning).

**Files:**
- Create: `src/assets/asset-retention.ts`
- Create: `test/assets/asset-retention.test.ts` (finally-deletion; 1h TTL expiry on derived/response entries; orphan telemetry LRU-bounded, default 64 entries; telemetry redaction: no provider/model/secrets)

**Checks:**
- `node --import tsx --test test/assets/asset-retention.test.ts`

## Task B5: Dedicated non-Python child env seam
**Outcome:** Git/ffmpeg/media children never reuse CLI bridge-token env.

**Files:**
- Create: `src/process/native-child-env.ts` (`buildNativeChildEnvironment()`: minimal allowlist, no tokens/keys/cookies, fixed argv + `shell:false` call-site requirement documented)
- Create: `test/process/native-child-env.test.ts` (sentinel secret leak test)

**Checks:**
- `node --import tsx --test test/process/native-child-env.test.ts`

## Negative security tests (this plan)
- Bombs (zip/PDF/image) rejected pre-decode; symlink escape/races; upload cleanup/orphans bounded; cache cross-session access rejected; telemetry redaction; aggregate 512MiB ledger rejects across concurrent acquires.

## Known unknowns / defaults / pivots
- Orphan-telemetry bound default 64 entries LRU (operator-lowerable). Pivot: operator sets lower via env.
- Owner fallback (per-request random id) isolates but breaks cross-call retrieve; acceptable until session threading lands.
