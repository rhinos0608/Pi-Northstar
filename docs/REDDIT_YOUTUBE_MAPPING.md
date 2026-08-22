# Reddit & YouTube Service Paths and Resilience Mapping

**Generated:** 2026-08-22  
**Scope:** Local service/tool paths, backend dispatch chains, CLI providers, retry/resilience behavior, test coverage, and integration entry points.

---

## Executive Summary

Reddit and YouTube access flows entirely through **external CLI backends** with no native API implementations. Both platforms use a dispatch chain: user tool → native-tools → reach-tools → ordered CLI candidates → subprocess execution with timeout/sanitization. **No retry mechanism exists at the CLI level**—only single-attempt per candidate with 120s timeout. Resilience depends on ordered fallback between candidates and proper environment/auth setup.

---

## Service Architecture

### Call Path (Reddit)
```
index.ts (social tool)
  ↓ callSearchMcpTool(client, 'social', ...)
  ↓ cli-backend.ts:CliSearchBackend.callTool
  ↓ spawn cli.ts
  ↓ cli.ts:callNativeTool('social', ...)
  ↓ native-tools.ts:callNativeTool (tries callReachTool first)
  ↓ reach-tools.ts:dispatchReachTool('social')
  ↓ reach-tools.ts:social()
  ↓ platformOrInfer(args, ['twitter', 'reddit', ...]) → 'reddit'
  ↓ socialCandidates('reddit')
    ├─ openCliCandidate('reddit')      [primary]
    └─ rdtCandidate()                  [fallback]
  ↓ runFirstUsable('reddit', candidates, action, args, options)
  ↓ forEach candidate:
      ├─ args(action, input) → ['reddit', 'search', ...]
      ├─ runCommand(candidate.command, commandArgs, 120_000)
      │   └─ spawn(command, args, { env, stdio })
      │   └─ Kill after SIGTERM + 5s SIGKILL
      │   └─ Truncate stdout/stderr to 1M chars
      └─ Exit 0 → return + sanitize output
      └─ Exit 127 → not installed error
      └─ Exit other → accumulate failure, try next
  ↓ Return result or throw combined error
```

### Call Path (YouTube)
```
index.ts (media tool with buildMediaRoute)
  ↓ buildMediaRoute({ platform: 'youtube', action, ... })
    → { tool: 'video', args: {...}, timeout: 300_000 }
  ↓ callSearchMcpTool(client, 'video', ...)
  ↓ [same cli-backend/native-tools/reach-tools stack]
  ↓ reach-tools.ts:dispatchReachTool('video')
  ↓ reach-tools.ts:video()
  ↓ platformOrInfer(args, ['youtube', 'bilibili']) → 'youtube'
  ↓ videoCandidates('youtube')
    └─ youtubeCandidate() [only option: yt-dlp]
  ↓ runFirstUsable('youtube', [ytdlpCandidate], action, args, options)
  ↓ runCommand('yt-dlp', [...], 120_000)
  ↓ Return result or throw error (no fallback)
```

---

## CLI Backends

### Reddit

#### OpenCLI Backend
- **Name:** `OpenCLI`
- **Command:** `opencli`
- **Probe:** `opencli --help`
- **Setup:** "Install OpenCLI and login in Chrome"
- **Environment:** `OPENCLI_HOST`, `OPENCLI_PORT`, `OPENCLI_TOKEN` (optional for remote)
- **File:** `src/reach-tools.ts:291-344` (lines 309-316 for reddit)
- **Actions:** `search`, `read`, `feed`, `subreddit`, `hot`, `popular`, `subreddit_info`

**Command Path (line 309-316):**
```typescript
case 'reddit':
  if (action === 'search') return [...base, 'search', requireString(input.query, 'query'), '-f', 'yaml'];
  if (action === 'read') return [...base, 'read', publicUrlOrId(input, 'id or url'), '-f', 'yaml'];
  if (action === 'feed') return [...base, 'home', '--limit', limit, '-f', 'yaml'];
  if (action === 'subreddit') return [...base, 'subreddit', requireString(input.subreddit, 'subreddit'), '-f', 'yaml'];
  if (action === 'hot' || action === 'popular') return [...base, action, '--limit', limit, '-f', 'yaml'];
  if (action === 'subreddit_info') return [...base, 'subreddit-info', requireString(input.subreddit, 'subreddit'), '-f', 'yaml'];
```

#### rdt-cli Backend
- **Name:** `rdt-cli`
- **Command:** `rdt`
- **Probe:** `rdt status --json`
- **Setup:** `pipx install 'git+https://github.com/public-clis/rdt-cli.git' && rdt login`
- **Environment:** `REDDIT_COOKIE` (optional; auth via file)
- **File:** `src/reach-tools.ts:346-365`
- **Actions:** `search`, `read`, `feed`, `subreddit`, `popular`, `all`

**Command Path:**
```typescript
const limit = String(numberOrDefault(input.limit, 10));
switch (action) {
  case 'search': return ['search', requireString(input.query, 'query'), '--limit', limit];
  case 'read': return ['read', publicUrlOrId(input, 'id or url')];
  case 'feed': return ['feed', '--limit', limit];
  case 'subreddit': return ['sub', requireString(input.subreddit, 'subreddit'), '--limit', limit];
  case 'popular': return ['popular', '--limit', limit];
  case 'all': return ['all', '--limit', limit];
}
```

### YouTube

#### yt-dlp Backend (Only Option)
- **Name:** `yt-dlp`
- **Command:** `yt-dlp`
- **Probe:** `yt-dlp --version`
- **Setup:** `pip install yt-dlp; install node or deno for YouTube JS challenge handling`
- **Environment:** `YOUTUBE_API_KEY` (optional for quota bypass)
- **File:** `src/reach-tools.ts:387-402`
- **Actions:** `search`, `details`, `transcript`

**Command Path:**
```typescript
switch (action) {
  case 'search': 
    return [`ytsearch${numberOrDefault(input.limit, 10)}:${requireString(input.query, 'query')}`, 
            '--dump-json', '--flat-playlist'];
  case 'details': 
    return ['--dump-json', '--skip-download', 
            validatePublicHttpUrl(requireString(input.url, 'url'))];
  case 'transcript': 
    return ['--skip-download', '--write-sub', '--write-auto-sub', 
            '--sub-langs', String(input.language ?? 'en.*'), 
            '--sub-format', 'vtt', '-o', `${requireString(input.outputDir, 'outputDir')}/%(id)s.%(ext)s`, 
            validatePublicHttpUrl(requireString(input.url, 'url'))];
}
```

---

## Resilience & Error Handling

### Timeout
- **COMMAND_TIMEOUT_MS:** 120,000 ms (2 minutes)  
- **File:** `src/reach-tools.ts:42`
- **Mechanism:** `setTimeout(terminate, timeoutMs)` → SIGTERM → wait 5s → SIGKILL
- **Env var:** None (hardcoded)

### Retry
- **No retry at CLI level.** Each candidate gets one attempt.
- **Platform-level retry:** `retryWithBackoff` exists in `src/retry.ts:8-27` but is **only used in native-tools.ts for web_search backends**, not for reach-tools CLI dispatch.
- **Retryability check:** `isRetryable(error)` matches timeout/ECONNRESET/ENOTFOUND/5xx, but this is **not called** for CLI commands.

### Output Sanitization
- **File:** `src/reach-tools.ts:423-442` (`sanitizeExternalOutput`)
- **Patterns (SECRET_PATTERNS):**
  - Authorization headers: `Authorization: Bearer|token|Basic <value>`
  - Set-Cookie, Cookie headers
  - Platform cookies: `TWITTER_COOKIE`, `REDDIT_COOKIE`, `XHS_COOKIE`, `BILIBILI_COOKIE`, etc.
  - API keys: `TWITTER_AUTH_TOKEN`, `TWITTER_CT0`, `REDDIT_CLIENT_SECRET`, `YOUTUBE_API_KEY`, etc.
  - Generic: `apiKey`, `api_key`, `api-key` (case-insensitive)
- **Applied:** After command execution, before returning to caller (line 467-468)
- **Limitation:** Regex-based only; does not handle obfuscated secrets or unexpected formats

### Error Handling
- **Exit 0:** Success, return stdout with sanitization
- **Exit 127:** "not installed" (ENOENT), accumulate setup message, try next candidate
- **Exit other:** Failure, accumulate with tail(stderr/stdout), try next candidate
- **No candidates succeed:** Throw combined error: `No usable ${platform} backend. <failures>`
- **File:** `src/reach-tools.ts:444-472` (`runFirstUsable`)

### Environment Isolation
- **File:** `src/reach-tools.ts:648-674` (`externalEnvironment`)
- **Allowed vars (global):** `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `PYTHONIOENCODING`, proxy vars
- **Platform-specific additions:**
  - `twitter`: `TWITTER_AUTH_TOKEN`, `TWITTER_CT0`, `TWITTER_COOKIE`
  - `rdt`: `REDDIT_COOKIE`
  - `xhs`: `XHS_COOKIE`, `XIAOHONGSHU_COOKIE`
  - `bili`: `BILIBILI_SESSDATA`, `BILIBILI_CSRF`, `BILIBILI_COOKIE`
  - `opencli`: `OPENCLI_HOST`, `OPENCLI_PORT`, `OPENCLI_TOKEN`
- **Secrets blocked:** Keys are on allowlist only; all other env vars (except above) are excluded

---

## Provider Descriptors

### Reddit (src/providers.ts:41)
```typescript
{
  provider: 'reddit',
  channel: 'reddit',
  family: 'social',
  envKeys: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USER_AGENT'],
  cookieDomains: ['reddit.com'],
  loginFlow: 'env_var',
  risk: 'medium',
  setup: 'Set Reddit API credentials or install OpenCLI/rdt-cli',
  loginUrl: 'https://www.reddit.com/login'
}
```
**Note:** `envKeys` are for native API (not yet implemented); actual tools use CLI backends.

### YouTube (src/providers.ts:30)
```typescript
{
  provider: 'youtube',
  channel: 'youtube',
  family: 'media',
  envKeys: ['YOUTUBE_API_KEY'],
  cookieDomains: [],
  loginFlow: 'api_key',
  risk: 'low',
  setup: 'Set YOUTUBE_API_KEY env var or install yt-dlp',
  description: 'YouTube search, metadata, and subtitles'
}
```
**Note:** Setup mentions both API key AND yt-dlp; yt-dlp is the actual implementation.

---

## Test Coverage

### Existing Tests
- **File:** `test/native-tools.test.ts`
- **Reddit:**
  - Line 333-349: `reddit feed filter maps to hot and popular feeds with limits`
    - Spawns mock `opencli` binary
    - Tests that `feed` action with `filter: 'hot'` → `opencli reddit hot --limit 6 -f yaml`
    - Tests that `filter: 'popular'` → `opencli reddit popular --limit 8 -f yaml`
  - Line 94-105: Platform validation and URL scheme validation
- **YouTube:**
  - Line 115-117: URL scheme validation (rejects `file://`)
  - No mock CLI tests for yt-dlp
- **General:**
  - Line 72-92: `reach_status` reports media family backends
  - Line 254-295: Backend redaction and secret filtering
  - Line 263-295: Env isolation and output redaction

### Missing Tests
- **No tests for:**
  - Exit code 127 (command not installed) handling
  - Actual yt-dlp invocation failure scenarios
  - rdt-cli as fallback after opencli failure
  - Timeout behavior (120s)
  - Output truncation (>1M chars)
  - Combined error message formatting when all candidates fail

---

## Scheduler / Timeout Details

### runCommand Implementation (src/reach-tools.ts:474-509)
```typescript
async function runCommand(command: string, args: string[], options: ReachToolOptions, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, args, {
      env: externalEnvironment(command, options.env ?? process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let killTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), SIGKILL_AFTER_MS);  // 5s grace
    };
    const timer = setTimeout(terminate, timeoutMs);  // 120s default
    options.signal?.addEventListener('abort', terminate, { once: true });  // AbortSignal support
    
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + String(chunk)).slice(-MAX_OUTPUT_CHARS);  // 1M limit, keep tail
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-MAX_OUTPUT_CHARS);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', terminate);
      resolve({ code: error.code === 'ENOENT' ? 127 : 1, stdout, stderr: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', terminate);
      resolve({ code, stdout, stderr });
    });
  });
}
```

**Timeout Behavior:**
- SIGTERM sent at 120s
- Process has 5s to shut down cleanly
- SIGKILL sent if process still alive
- Either way, result is returned to caller (no throw)

---

## Current User Diff

**File:** `src/reach-tools.ts` (staging changes)

### Changes (all in openCliCandidate)

1. **Twitter feed action added (line 307):**
   ```typescript
   if (action === 'feed') return [...base, 'timeline', '-f', 'yaml'];
   ```
   - Maps 'feed' → 'timeline' subcommand for Twitter

2. **Twitter command path corrections (lines 303-306):**
   - 'tweet' → 'thread'
   - 'user-posts' → 'tweets'
   - 'user' → 'profile'

3. **XiaoHongShu hot action added (line 321):**
   ```typescript
   if (action === 'feed' || action === 'hot') return [...base, 'feed', '--limit', limit, '-f', 'yaml'];
   ```
   - Maps both 'feed' and 'hot' to 'feed' subcommand with limit

4. **Instagram feed/user_posts/read actions added (lines 333-335):**
   ```typescript
   if (action === 'explore' || action === 'saved' || action === 'feed') 
     return [...base, action === 'feed' ? 'explore' : action, '--limit', limit, '-f', 'yaml'];
   if (action === 'user_posts') 
     return [...base, 'user', requireString(input.user ?? input.username, 'user'), '--limit', limit, '-f', 'yaml'];
   if (action === 'read' || action === 'post') 
     return [...base, 'download', requireString(input.url ?? input.id, 'url or id'), '-f', 'yaml'];
   ```

**Impact on Reddit/YouTube:** None. The diff only affects Twitter, XiaoHongShu, and Instagram.

---

## Backward Compatibility

### Integration Options (Smallest Diff)

**Option 1: Local Retry Wrapper (5 lines)**
- Wrap `runFirstUsable` result in a retry loop
- Only retry on timeout/transient errors
- Keep everything else the same
- **Files affected:** `src/reach-tools.ts` only (runFirstUsable call sites)

**Option 2: Per-Candidate Timeout Override (3 lines)**
- Allow env var like `PI_SEARCH_REDDIT_TIMEOUT_MS` / `PI_SEARCH_YOUTUBE_TIMEOUT_MS`
- Fallback to 120_000 if not set
- **Files affected:** `src/reach-tools.ts` (line 462)

**Option 3: Native API Fallback (100+ lines)**
- Add native Reddit/YouTube API implementations to `native-tools.ts`
- Requires API key validation and auth flow setup
- Reorder candidates to try native first, then CLI
- **Files affected:** `native-tools.ts`, `reach-tools.ts`, `providers.ts`, test files

**Option 4: Health Check Pre-Cache (50 lines)**
- Cache backend availability after first probe
- Reuse in subsequent calls within TTL
- Avoid repeated "not installed" errors
- **Files affected:** `reach-tools.ts` (inspectChannel logic), possibly new cache module

---

## Gaps & Constraints

### Confirmed Gaps
1. **No retry at CLI level** — single attempt per candidate
2. **No configurable timeout per platform** — all CLI commands fixed at 120s
3. **No native Reddit API** — only CLI backends (OpenCLI, rdt-cli)
4. **No native YouTube API** — only yt-dlp (undocumented)
5. **No fallback for yt-dlp** — if yt-dlp not installed, YouTube is entirely unavailable
6. **Exit code detection is coarse** — only 0/127/other; no distinction between auth failure vs. network error
7. **Output redaction regex-based** — may miss obfuscated secrets or new key formats

### Operational Constraints
- **YouTube requires either:**
  - YOUTUBE_API_KEY set (but not used by yt-dlp; only informational)
  - yt-dlp installed
- **Reddit requires either:**
  - OpenCLI installed + Chrome login OR
  - rdt-cli installed + CLI login OR
  - REDDIT_CLIENT_ID/SECRET (unused by CLI; only informational)
- **All CLI tools require:**
  - Command on PATH or full path in env
  - Proper auth setup (cookies, login sessions, API keys)

---

## Validation Commands

```bash
# Check backend availability
npm run cli -- call reach_status '{"family":"social"}'
npm run cli -- call reach_status '{"family":"media"}'

# Test Reddit (OpenCLI)
npm run cli -- call social '{"platform":"reddit","action":"search","query":"rust"}'
npm run cli -- call social '{"platform":"reddit","action":"feed","filter":"hot","limit":5}'

# Test Reddit (rdt-cli fallback)
REDDIT_BACKEND=rdt npm run cli -- call social '{"platform":"reddit","action":"search","query":"rust"}'

# Test YouTube
npm run cli -- call media '{"platform":"youtube","action":"search","query":"web performance"}'
npm run cli -- call media '{"platform":"youtube","action":"details","url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'

# Test YouTube transcript
npm run cli -- call media '{"platform":"youtube","action":"transcript","url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'

# Test timeout (should error after ~120s)
npm run cli -- call media '{"platform":"youtube","action":"search","query":"test"}' &
sleep 121
# Check if process terminated

# Test output redaction
REDDIT_COOKIE="test_secret_abc" npm run cli -- call social '{"platform":"reddit","action":"search","query":"test"}'
# Verify output contains "***" not "test_secret_abc"

# Test missing backend
rm $(which opencli) && npm run cli -- call social '{"platform":"reddit","action":"search","query":"test"}'
# Should suggest install commands
```

---

## Reusable Primitives

### Existing (available for reuse)
- **`retryWithBackoff<T>(fn, opts)`** — `src/retry.ts:8-27`
  - Configurable maxAttempts, backoff factor, delays
  - Skips non-retryable errors (AbortError, TimeoutError, 5xx, connection errors)
  - Can wrap CLI call, but must be careful not to retry destructive operations

- **`sanitizeExternalOutput(text)`** — `src/reach-tools.ts:433-442`
  - Redacts secrets via regex patterns
  - Can be extended with new patterns for emerging key formats

- **`externalEnvironment(command, env)`** — `src/reach-tools.ts:648-674`
  - Env allowlist per command
  - Can be extended for new backends

- **`orderedBackendMetadata(channel, env)`** — `src/reach-tools.ts:511-517`
  - Respects `${PLATFORM}_BACKEND` and `PI_SEARCH_${PLATFORM}_BACKEND` overrides
  - Reorders candidates based on env var

- **`orderByOverride<T>(platform, candidates, env)`** — `src/reach-tools.ts:519-531`
  - Generic reordering for any candidate list
  - Prefix matching (e.g., "op" matches "OpenCLI")

### New candidates for shared service
- **Backend probe & caching** — Check if backend is available, cache result for TTL
  - Avoid repeated "not installed" checks
  - Could live in a new `src/backend-probe.ts`

- **Timeout per platform** — Environment-driven timeouts
  - `PI_SEARCH_${PLATFORM}_TIMEOUT_MS`
  - Fallback to global constant

---

## Architecture Decision Records

### Why no native API for Reddit/YouTube?
- **Reddit:** Official API requires OAuth setup per user; CLI backends (OpenCLI/rdt-cli) handle auth via browser cookies/login
- **YouTube:** Official API has quota limits and requires key setup; yt-dlp works via public web scraping with JS rendering support
- **Trade-off:** CLI backends are lower-friction for end users (no API key registration) but less reliable (no SLA, subject to scraping detection)

### Why no retry at CLI level?
- Some CLI tools may not be idempotent (e.g., commands with side effects)
- Network timeout is only one failure mode; others (command not found, auth failed) shouldn't retry
- Single attempt per candidate forces order dependency (try primary first, fallback if it's broken)

### Why 120s timeout?
- Chosen to allow slow network/rendering (e.g., yt-dlp JS challenge solving)
- Aligns with typical CI/CD timeout expectations
- Configurable per future design decision

---

## Summary Table

| Aspect | Reddit | YouTube |
|--------|--------|---------|
| **Primary Backend** | OpenCLI | yt-dlp |
| **Fallback** | rdt-cli | None |
| **Auth Method** | Browser cookie / CLI login | None / yt-dlp JS rendering |
| **Actions** | search, read, feed, subreddit, hot, popular, subreddit_info | search, details, transcript |
| **Timeout** | 120s | 120s |
| **Retry** | No (ordered fallback only) | No (no fallback) |
| **Native API** | Not implemented | Not implemented |
| **Env Keys** | REDDIT_COOKIE (optional) | YOUTUBE_API_KEY (optional, informational) |
| **Test Coverage** | 1 test (mock opencli) | URL scheme validation only |
| **Risk Level** | Medium (external CLI) | Low (external CLI, no fallback) |

---

## Files & Line References

| File | Lines | Purpose |
|------|-------|---------|
| `src/reach-tools.ts` | 1-689 | Dispatch, CLI candidates, timeout, redaction |
| `src/reach-tools.ts` | 42 | COMMAND_TIMEOUT_MS constant |
| `src/reach-tools.ts` | 54, 246 | Reddit channel definition & socialCandidates |
| `src/reach-tools.ts` | 58, 261 | YouTube channel definition & videoCandidates |
| `src/reach-tools.ts` | 291-344 | openCliCandidate (Twitter, Reddit, XHS, FB, Instagram, Bilibili) |
| `src/reach-tools.ts` | 309-316 | Reddit OpenCLI command paths |
| `src/reach-tools.ts` | 346-365 | rdtCandidate (Reddit fallback) |
| `src/reach-tools.ts` | 387-402 | youtubeCandidate (yt-dlp only) |
| `src/reach-tools.ts` | 423-442 | sanitizeExternalOutput (redaction) |
| `src/reach-tools.ts` | 444-472 | runFirstUsable (ordered fallback, error accumulation) |
| `src/reach-tools.ts` | 474-509 | runCommand (spawn, timeout, signal handling) |
| `src/reach-tools.ts` | 648-674 | externalEnvironment (allowlist) |
| `src/index.ts` | 207-231 | 'social' tool registration |
| `src/index.ts` | 234-255 | 'media' tool registration |
| `src/index.ts` | 324-345 | buildMediaRoute (routes 'youtube' to 'video' tool) |
| `src/providers.ts` | 30, 41 | YouTube & Reddit provider descriptors |
| `src/retry.ts` | 8-27 | retryWithBackoff (not used by CLI backends) |
| `src/cli-backend.ts` | 25-30 | CliSearchBackend.callTool spawns cli.ts |
| `src/cli.ts` | 44 | callNativeTool routing |
| `src/native-tools.ts` | 64-73 | callNativeTool fallback to reach-tools |
| `test/native-tools.test.ts` | 333-349 | Reddit CLI test (mock opencli) |
| `test/native-tools.test.ts` | 72-92 | reach_status test |

