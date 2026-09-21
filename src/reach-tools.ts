import { spawnCliCommand } from './process/cli-command.js';
import type { BackendCallResult } from './backend.js';
import { callSetupTool } from './setup/bootstrap.js';
import { cookieAuthEnvironment, cookieEnvKeysForProvider, cookieHeaderForUrl, cookieProviderForCommand, COOKIE_ENV_KEYS } from './chrome/cookie-jar.js';
import { authForChannel, PROVIDER_DESCRIPTORS } from './setup/providers.js';
import {
  backendCapability,
  canonicalActionsFor,
  channelCapability,
  CHANNEL_CAPABILITIES,
} from './capabilities.js';
import type { DnsLookup } from './network-policy.js';
import { guardResult, jsonTextResult } from './core/tool-output.js';
import { executeMedia } from './media/media.js';
import { executeSocial } from './social/social.js';

export type ReachToolName = 'reach_status' | 'reach_setup' | 'social' | 'feeds' | 'media';

interface ReachToolOptions {
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
  lookup?: DnsLookup;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface ChannelDefinition {
  name: string;
  family: 'social' | 'media' | 'web' | 'dev' | 'research' | 'browser';
  description: string;
  tier: 0 | 1 | 2;
  backends: Array<{ name: string; type: 'native' | 'external'; command?: string; probeArgs?: readonly string[]; setup?: string }>;
}

const MAX_OUTPUT_CHARS = 1_000_000;
const SIGKILL_AFTER_MS = 5_000;

// Fixed first-party hosts only. No user-configurable fallback hosts.
const REDDIT_WWW_BASE = 'https://www.reddit.com';

// Channel/platform/action truth derives from the canonical Stage 0 capability
// registry. Reach-tools keeps only the per-backend invocation details that the
// registry intentionally does not own (external CLI argv shapes).
const channels: ChannelDefinition[] = CHANNEL_CAPABILITIES
  .filter((cap) => cap.availability === 'available')
  .map((cap) => ({
    name: cap.id,
    family: cap.family,
    description: cap.description,
    tier: cap.tier,
    backends: cap.backends.map((backend) => ({
      name: backend.id,
      type: (backend.mode === 'external' ? 'external' : 'native') as 'external' | 'native',
      ...(backend.probe ? { command: backend.probe.command, probeArgs: backend.probe.args } : {}),
    })),
  }));

export async function callReachTool(
  name: string,
  args: Record<string, unknown>,
  options: ReachToolOptions = {},
): Promise<BackendCallResult | undefined> {
  const result = await dispatchReachTool(name, args, options);
  return result ? guardResult(result, { env: options.env }) : undefined;
}

async function dispatchReachTool(
  name: string,
  args: Record<string, unknown>,
  options: ReachToolOptions,
): Promise<BackendCallResult | undefined> {
  switch (name as ReachToolName) {
    case 'reach_status':
      return reachStatus(args, options);
    case 'reach_setup':
      return callSetupTool(args, options);
    case 'social':
      return social(args, options);
    case 'feeds':
      return executeMedia('feeds', args, options);
    case 'media':
      return executeMedia('media', args, options);
    default:
      return undefined;
  }
}

async function reachStatus(args: Record<string, unknown>, options: ReachToolOptions): Promise<BackendCallResult> {
  const family = typeof args.family === 'string' ? args.family : undefined;
  // Action-aware status: when an action is requested, eligibility, active
  // backend, and usability are evaluated for that action's registry backend
  // support instead of the channel as a whole.
  const action = typeof args.action === 'string' && args.action.trim() ? args.action.trim() : undefined;
  const selected = family ? channels.filter((channel) => channel.family === family) : channels;
  const env = options.env ?? process.env;
  const results = await Promise.all(selected.map((channel) => inspectChannel(channel, options, action)));
  const usable = results.filter((item) => item.status === 'ok').length;
  const channelsWithAuth = results.map((r) => {
    const name = typeof r.name === 'string' ? r.name : '';
    const auth = authForChannel(name, env);
    return {
      ...r,
      // Canonical action vocabulary from the registry (aliases excluded).
      actions: canonicalActionsFor(name),
      ...(action ? { requestedAction: action } : {}),
      auth: auth ?? { configured: false, keyNames: [], loginFlow: 'unknown', cookieDomains: [], risk: 'low' },
    };
  });
  return jsonTextResult({ usable, total: results.length, channels: channelsWithAuth });
}

/** Canonical-only lookup: exact registry match, no alias mapping. */
function canonicalActionFor(channelName: string, action: string): string {
  for (const entry of channelCapability(channelName)?.actions ?? []) {
    if (entry.action === action) return entry.action;
  }
  return action;
}

/** Registry-declared action support for a backend; unknown ids never match. */
function backendSupportsAction(channelName: string, backendName: string, canonicalAction: string): boolean {
  const declared = backendCapability(channelName, backendName);
  if (!declared) return false;
  return declared.actions.includes(canonicalAction);
}

async function inspectChannel(channel: ChannelDefinition, options: ReachToolOptions, requestedAction?: string): Promise<Record<string, unknown>> {
  const env = options.env ?? process.env;
  try {
    const canonicalAction = requestedAction ? canonicalActionFor(channel.name, requestedAction) : undefined;
    // Browser verbs are owned by BROWSER_ACTIONS (browser-policy.ts); the
    // registry keeps no browser-action truth, so it must never declare a
    // browser action supported or unsupported. Status stays 'off' (unchanged)
    // with per-action validation deferred to the browser tool.
    if (channel.name === 'browser' && canonicalAction) {
      return { ...channel, status: 'off', active_backend: null, message: `Browser action "${requestedAction}" is validated by the browser tool (BROWSER_ACTIONS); the capability registry holds no browser-action truth` };
    }
    if (canonicalAction && !canonicalActionsFor(channel.name).includes(canonicalAction)) {
      return { ...channel, status: 'off', active_backend: null, message: `Action "${requestedAction}" is not a supported ${channel.name} action` };
    }
    // Reddit/YouTube native HTTP backends are credential-gated and handled by
    // their own checks below; exclude them from the generic native shortcut so
    // unconfigured native channels are never falsely marked usable.
    const native = channel.name === 'reddit' || channel.name === 'youtube'
      ? undefined
      : channel.backends.find((backend) => backend.type === 'native');
    if (native) {
      if (canonicalAction && !backendSupportsAction(channel.name, native.name, canonicalAction)) {
        return { ...channel, status: 'off', active_backend: null, message: `No ${channel.name} backend supports action "${requestedAction}"` };
      }
      return { ...channel, status: 'ok', active_backend: native.name };
    }

    // Native HTTP backends need no CLI probe: report usable when credentials exist.
    if (channel.name === 'reddit') {
      const nativeBackend = redditNativeBackend(env);
      if (nativeBackend && (!canonicalAction || backendSupportsAction('reddit', nativeBackend, canonicalAction))) {
        return { ...channel, status: 'ok', active_backend: nativeBackend };
      }
    }
    if (channel.name === 'youtube') {
      // Transcript is served keylessly by the unofficial youtube-transcript
      // adapter (executeMedia plans it regardless of API key), so status must
      // report it as available/degraded instead of unavailable.
      if (canonicalAction === 'transcript' && backendSupportsAction('youtube', 'youtube-transcript', 'transcript')) {
        return { ...channel, status: 'warn', active_backend: 'youtube-transcript', message: 'Transcript via keyless unofficial youtube-transcript adapter (degraded, may break without notice).' };
      }
      const key = typeof env.YOUTUBE_API_KEY === 'string' ? env.YOUTUBE_API_KEY.trim() : '';
      if (key && (!canonicalAction || backendSupportsAction('youtube', 'youtube-data-api', canonicalAction))) {
        return { ...channel, status: 'ok', active_backend: 'youtube-data-api' };
      }
      if (key) {
        return { ...channel, status: 'off', active_backend: null, message: `No youtube backend supports action "${requestedAction}"` };
      }
      // Keyless: the keyless oEmbed endpoint provides limited `details` only.
      // yt-dlp is frames-only for fetch-time YouTube keyframes (anonymous,
      // fixed argv, PI_VISION_FETCH_VIDEO_FRAMES=1 plus a vision tier): never
      // probed or reported here, never used for search/details/hot/transcript.
      if (canonicalAction && canonicalAction !== 'details') {
        return { ...channel, status: 'off', active_backend: null, message: `Keyless youtube cannot serve action "${requestedAction}"; only details via oEmbed. Set YOUTUBE_API_KEY for search, details, and hot via the official Data API.` };
      }
      return { ...channel, status: 'warn', active_backend: 'youtube-oembed', message: 'Keyless partial: video details via oEmbed (limited fields). Set YOUTUBE_API_KEY for search, details, and hot via the official Data API.' };
    }

    // Probe external candidates only (native entries describe HTTP backends
    // that require no CLI binary). Capability-aware eligibility: backends the
    // registry does not list for this action are never probed.
    const candidates = orderedBackendMetadata(channel, env)
      .filter((backend) => backend.type === 'external')
      .filter((backend) => !canonicalAction || backendSupportsAction(channel.name, backend.name, canonicalAction));
    const warnings: Array<{ backend: string; message: string }> = [];
    const availability = await describeChannelBackends(channel, candidates, options, canonicalAction);
    for (const candidate of candidates) {
      const probe = await runCommand(candidate.command ?? '', [...(candidate.probeArgs ?? ['--help'])], options, 8_000);
      if (probe.code === 0) return { ...channel, status: 'ok', active_backend: candidate.name, backends: availability };
      if (probe.code !== 127) warnings.push({ backend: candidate.name, message: tail(sanitizeExternalOutput(probe.stderr || probe.stdout)) });
    }
    if (warnings[0]) return { ...channel, status: 'warn', active_backend: warnings[0].backend, message: warnings[0].message, backends: availability };
    return { ...channel, status: 'off', active_backend: null, message: setupMessage(channel), backends: availability };
  } catch (error) {
    return { ...channel, status: 'error', active_backend: null, message: error instanceof Error ? error.message : String(error) };
  }
}

async function social(args: Record<string, unknown>, options: ReachToolOptions): Promise<BackendCallResult> {
  // Stage 2 social path: the central integrator owns alias resolution,
  // backend selection (cookie → anonymous → API key), cursor pinning,
  // normalization, and the additive details.northstar envelope.
  return executeSocial(args, { signal: options.signal, env: options.env });
}


/** Registry-derived backend availability for reach_status. Distinguishes
 *  installed/responding (external probe), authenticated (env/cookie session),
 *  and action-verified (registry declares the canonical action) where the
 *  current probes support it. Native HTTP backends need no CLI probe. */
async function describeChannelBackends(channel: ChannelDefinition, candidates: ChannelDefinition['backends'], options: ReachToolOptions, canonicalAction?: string): Promise<Array<Record<string, unknown>>> {
  const env = options.env ?? process.env;
  const rows: Array<Record<string, unknown>> = [];
  for (const backend of channel.backends) {
    const declared = backendCapability(channel.name, backend.name);
    const supportsAction = !canonicalAction || backendSupportsAction(channel.name, backend.name, canonicalAction);
    const authenticated = backendAuthSatisfied(channel.name, backend.name, env);
    const completeness = declared?.quality ?? (backend.type === 'native' ? 'full' : 'full');
    if (backend.type === 'native') {
      rows.push({ backend: backend.name, mode: 'native', authenticated, actionVerified: supportsAction, completeness });
      continue;
    }
    if (!candidates.some((candidate) => candidate.name === backend.name)) {
      rows.push({ backend: backend.name, mode: 'external', installed: false, responding: false, authenticated, actionVerified: supportsAction, completeness });
      continue;
    }
    const probe = await runCommand(backend.command ?? '', [...(backend.probeArgs ?? ['--help'])], options, 8_000);
    rows.push({ backend: backend.name, mode: 'external', installed: probe.code !== 127, responding: probe.code === 0, authenticated, actionVerified: supportsAction, completeness });
  }
  return rows;
}

/** Registry auth requirement satisfied by env/cookie session. Cookie-tier
 *  backends prefer scoped jar/session; anonymous/keyless needs no keys. */
function backendAuthSatisfied(channelName: string, backendName: string, env: Record<string, string | undefined>): boolean {
  if (channelName === 'reddit' && backendName === 'reddit-cookie') {
    return Boolean(redditCookieHeader(env) || cookieHeaderForUrl('reddit', `${REDDIT_WWW_BASE}/`, env));
  }
  if (channelName === 'reddit' && backendName === 'reddit-oauth') return hasRedditApiCredentials(env);
  if (channelName === 'youtube' && backendName === 'youtube-data-api') {
    return Boolean(typeof env.YOUTUBE_API_KEY === 'string' && env.YOUTUBE_API_KEY.trim());
  }
  if (channelName === 'youtube' && backendName === 'youtube-oembed') return true;
  const declared = backendCapability(channelName, backendName);
  const auth = declared?.auth;
  if (!auth || auth.required === false) return true;
  const anyOf = auth.anyOf ?? [];
  const allOf = auth.allOf ?? [];
  if (allOf.length > 0) return allOf.every((key) => typeof env[key] === 'string' && (env[key] as string).trim().length > 0);
  if (anyOf.length > 0) return anyOf.some((key) => typeof env[key] === 'string' && (env[key] as string).trim().length > 0);
  return false;
}

// ── Reddit: native cookie session → optional API-key tier ──


function hasRedditApiCredentials(env: Record<string, string | undefined>): boolean {
  return Boolean(env.REDDIT_CLIENT_ID?.trim() && env.REDDIT_CLIENT_SECRET?.trim() && env.REDDIT_USER_AGENT?.trim());
}

function redditNativeBackend(env: Record<string, string | undefined>): 'reddit-oauth' | 'reddit-cookie' | undefined {
  // Binding auth order: a browser-session cookie tier reports before the
  // optional API-key tier. A stored-session backend is only reported when a
  // scoped cookie actually matches the canonical Reddit host; expired/
  // path-mismatched/non-Reddit stored cookies never mark the channel usable.
  if (redditCookieHeader(env)) return 'reddit-cookie';
  if (cookieHeaderForUrl('reddit', `${REDDIT_WWW_BASE}/`, env)) return 'reddit-cookie';
  if (hasRedditApiCredentials(env)) return 'reddit-oauth';
  return undefined;
}

function redditCookieHeader(env: Record<string, string | undefined>): string | undefined {
  if (typeof env.REDDIT_COOKIE === 'string' && env.REDDIT_COOKIE.trim()) return env.REDDIT_COOKIE.trim();
  return undefined;
}






function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Cookie-provider env labels derive from the cookie-jar single source of
// truth, unioned with retired cookie env labels kept for defense-in-depth
// over-masking; provider env-key labels derive from the provider descriptors.
// No other parallel hardcoded lists. Generic patterns (bearer/cookie headers,
// bare cookie pairs, api keys) stay static.
const RETIRED_COOKIE_ENV_LABELS = ['TWITTER_AUTH_TOKEN', 'TWITTER_CT0', 'TWITTER_COOKIE', 'XHS_COOKIE', 'XIAOHONGSHU_COOKIE'];
const cookieEnvLabels = [...new Set([...Object.values(COOKIE_ENV_KEYS).flat(), ...RETIRED_COOKIE_ENV_LABELS])].map(escapeRegExp);
const providerEnvLabels = [...new Set([
  ...PROVIDER_DESCRIPTORS.flatMap((descriptor) => descriptor.envKeys),
  // Infra/search-backend env names that are not tied to a provider descriptor.
  'SEARCH_LLM_API_TOKEN',
  'EMBEDDING_SIDECAR_API_TOKEN',
  'CRAWL4AI_API_TOKEN',
  'LISTENNOTES_API_KEY',
  'PRODUCTHUNT_API_TOKEN',
  'PATENTSVIEW_API_KEY',
])].map(escapeRegExp);

const SECRET_PATTERNS = [
  /Authorization:\s*(Bearer|token|Basic)\s+\S+/gi,
  /Set-Cookie:\s*\S+/gi,
  /Cookie:\s*\S+/gi,
  new RegExp(`(${cookieEnvLabels.join('|')})[=:]\\s*[^\\n\\r]+`, 'gi'),
  new RegExp(`(${providerEnvLabels.join('|')})[=:]\\s*\\S+`, 'gi'),
  // Bare cookie pairs printed by CLI tools (e.g. `auth_token=<secret>; ct0=<secret>`):
  // only known provider session-cookie names, so ordinary text like `session=` or
  // URLs never match. Lookbehind keeps this from firing inside longer env labels
  // (those are handled by the labeled pattern above).
  /(?<![\w.-])(?:auth_token|ct0|SESSDATA|bili_jct)\s*=\s*[^\s;,]+/gi,
  /api[Kk]ey["']?\s*[:=]\s*["']?\S+/gi,
  /api_?key\s*[:=]\s*\S+/gi,
];

export function sanitizeExternalOutput(text: string): string {
  let sanitized = text;
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match) => {
      const sep = match.search(/[=:]\s*/);
      return sep >= 0 ? match.slice(0, sep + 1) + '***' : '***';
    });
  }
  return sanitized;
}

export async function runCommand(command: string, args: string[], options: ReachToolOptions, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(abortError());
      return;
    }
    let stdout = '';
    let stderr = '';
    let aborted = false;
    let timedOut = false;
    // win32: bare commands resolve via PATHEXT; .cmd/.bat shims run through
    // cmd.exe with pre-quoted argv (shell:false cannot execute them — spawn
    // EINVAL; shell:true concatenates args unescaped). See cli-command.ts.
    // Probes run credential-free (probeEnvironment): --help/--version checks
    // never need tokens or cookies. Real executions use externalEnvironment.
    const child = spawnCliCommand(command, args, {
      env: probeEnvironment(options.env ?? process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let killTimer: NodeJS.Timeout | undefined;
    // Termination is shared, but the reason is tracked separately: only a
    // caller AbortSignal produces AbortError; a wall-clock timeout resolves as
    // a non-zero CommandResult (124) so callers can retry or fall back.
    const terminate = () => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), SIGKILL_AFTER_MS);
    };
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk) => {
      stdout = (stdout + String(chunk)).slice(-MAX_OUTPUT_CHARS);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-MAX_OUTPUT_CHARS);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      if (aborted || options.signal?.aborted) {
        reject(abortError());
        return;
      }
      resolve({ code: error.code === 'ENOENT' ? 127 : 1, stdout, stderr: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      if (aborted || options.signal?.aborted) {
        reject(abortError());
        return;
      }
      if (timedOut) {
        // Timeout is a backend failure, not caller cancellation: resolve with
        // the standard timeout exit code so runFirstUsable treats it as a
        // candidate failure eligible for fallback.
        resolve({ code: 124, stdout, stderr: `command timed out after ${timeoutMs}ms` });
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function orderedBackendMetadata(channel: ChannelDefinition, env: Record<string, string | undefined>): ChannelDefinition['backends'] {
  return orderByOverride(channel.name, channel.backends, env);
}

function orderByOverride<T extends { name: string }>(platform: string, candidates: T[], env: Record<string, string | undefined>): T[] {
  const override = env[`${platform.toUpperCase()}_BACKEND`] ?? env[`PI_SEARCH_${platform.toUpperCase()}_BACKEND`];
  if (!override) return candidates;
  const normalized = override.toLowerCase();
  const index = candidates.findIndex((candidate) => {
    const name = candidate.name.toLowerCase();
    return name === normalized || (normalized.length >= 3 && name.startsWith(normalized));
  });
  if (index < 0) return candidates;
  const ordered = [...candidates];
  ordered.unshift(...ordered.splice(index, 1));
  return ordered;
}

function setupMessage(channel: ChannelDefinition): string {
  return channel.backends.map((backend) => `${backend.name}: ${backend.setup ?? 'built in'}`).join('; ');
}

// Shared benign base: locale, path, temp, win32 essentials, and proxy base.
// Never carries credentials on its own; credentials are per-context additions.
const BASE_ENV_KEYS = [
  'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'SHELL', 'LANG', 'LC_ALL', 'PYTHONIOENCODING',
  'SystemRoot', 'windir', 'COMSPEC', 'PATHEXT',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
];

function pickBaseEnv(env: Record<string, string | undefined>, keys: readonly string[]): Record<string, string> {
  const base = Object.fromEntries(keys.flatMap((key) => (typeof env[key] === 'string' ? [[key, env[key] as string]] : []))) as Record<string, string>;
  if (base.PATH === undefined) {
    const alt = env.Path ?? env.path;
    if (typeof alt === 'string') base.PATH = alt;
  }
  return base;
}

/** Strip userinfo (`user:pass@`) from a proxy URL so probe subprocesses
 * never receive proxy credentials. Absolute URLs parse directly;
 * scheme-less values fall back to cutting at the last `@`. */
function stripProxyCredentials(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username.length === 0 && parsed.password.length === 0) return value;
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    const at = value.lastIndexOf('@');
    if (at < 0) return value;
    const schemeEnd = value.indexOf('://');
    const scheme = schemeEnd >= 0 ? value.slice(0, schemeEnd + 3) : '';
    const host = value.slice(at + 1);
    // No host (e.g. `http://user:pass@`): drop the variable rather than
    // return credential-bearing input to the probe child.
    return host.length > 0 ? `${scheme}${host}` : '';
  }
}

const PROXY_URL_KEYS = new Set([
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
]);

/** Credential-free probe environment for reach_status installed/responding
 * checks (`--help`/`--version` argv need no credentials): base keys only —
 * no OPENCLI_* (not even HOST/PORT), no cookie keys, no cookie-auth session.
 * Cookie/token env never reaches a probe subprocess. Proxy URLs are carried
 * without userinfo (stripped above): probes need the proxy host, not its creds. */
export function probeEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  const base = pickBaseEnv(env, BASE_ENV_KEYS);
  for (const key of Object.keys(base)) {
    if (PROXY_URL_KEYS.has(key)) base[key] = stripProxyCredentials(base[key]!);
  }
  return base;
}

export function externalEnvironment(command: string, env: Record<string, string | undefined>): Record<string, string> {
  // Execution environment: base plus the command's own credential needs —
  // OPENCLI_* for opencli, cookie keys for mapped cookie consumers. Unrelated
  // API keys never reach an execution subprocess. Cookie env vars derive from
  // the cookie-jar single source of truth: only commands with a real
  // cookie-consuming provider mapping receive them.
  const cookieProvider = cookieProviderForCommand(command);
  const allowed = [
    ...BASE_ENV_KEYS,
    ...(command === 'opencli' ? ['OPENCLI_HOST', 'OPENCLI_PORT', 'OPENCLI_TOKEN'] : []),
    ...(cookieProvider ? cookieEnvKeysForProvider(cookieProvider) : []),
  ];
  const base = pickBaseEnv(env, allowed);
  return { ...(cookieProvider ? cookieAuthEnvironment(cookieProvider, env) : {}), ...base };
}

function tail(text: string): string {
  const cleaned = text.trim();
  return cleaned.length > 1000 ? cleaned.slice(-1000) : cleaned;
}
