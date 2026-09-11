import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { BackendCallResult } from './backend.js';
import { importCookiesFromCdp, loginViaCdp } from './cdp.js';
import { importCookiesFromDefaultBrowser } from './cookie-jar.js';
import { channelCapability, cookieImportProviders, setupChannelNames } from './capabilities.js';
import { runSetupInstall } from './installer.js';
import { loadedConfigSummary } from './local-config.js';
import { codexConfigured } from './codex-search.js';
import { liveAuthSnapshot, providerSummary, PROVIDER_DESCRIPTORS, findProvider } from './providers.js';
import { jsonTextResult } from './tool-output.js';

export type SetupAction = 'auto' | 'status' | 'plan' | 'install_core' | 'install_all' | 'install_channels' | 'import_cookies' | 'login';

interface SetupOptions {
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
}

interface BootstrapState {
  version: number;
  ranAt: string;
  mode: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
  install?: unknown;
}

interface CookieStatus {
  provider: string;
  path: string;
  cookieCount: number;
  domains: string[];
  updatedAt: string;
}

const BOOTSTRAP_STATE_VERSION = 3;
const DEFAULT_STATE_DIR = join(homedir(), '.pi-northstar');
const DEFAULT_BOOTSTRAP_MESSAGE = 'First-start automation complete. Use /reach-setup status to view backend, auth, and cookie state.';

const STATE_PATH = join(DEFAULT_STATE_DIR, 'bootstrap.json');
export const AUTH_STATE_PATH = join(DEFAULT_STATE_DIR, 'auth-state.json');

const KNOWN_CHANNELS = setupChannelNames();

const platformPlan = [
  { platform: 'web', availability: 'available', ready: 'Read any webpage', unlock: '—', setup: 'No configuration required' },
  { platform: 'youtube', availability: 'available', ready: 'Keyless unofficial transcript; official search/details/hot via Data API', unlock: '—', setup: 'Set YOUTUBE_API_KEY for the official Data API; optional cookie import for consent-gated transcripts' },
  { platform: 'rss', availability: 'available', ready: 'Read RSS/Atom', unlock: '—', setup: 'No configuration required' },
  { platform: 'search', availability: 'available', ready: 'Basic native search', unlock: 'Full semantic search', setup: 'Optional Exa API key' },
  { platform: 'github', availability: 'available', ready: 'Public repos + search', unlock: 'Private repos, Issues/PRs, forks', setup: 'Set GITHUB_TOKEN' },
  { platform: 'twitter', availability: 'available', ready: 'Read single tweet where backend supports it', unlock: 'Search, timelines, articles', setup: 'Install twitter-cli and login via its own authenticated session' },
  { platform: 'bilibili', availability: 'available', ready: 'Search + video details via bili-cli', unlock: 'Subtitles via OpenCLI', setup: 'Install bili-cli' },
  { platform: 'reddit', availability: 'available', ready: '—', unlock: 'Search, posts, subreddits, feeds, and hot via the Reddit Data API (comments are not supported)', setup: 'Set REDDIT_CLIENT_ID + SECRET + USER_AGENT, or import a Reddit cookie (OpenCLI/rdt-cli fallback)' },
  { platform: 'facebook', availability: 'available', ready: '—', unlock: 'Search, profiles, feed, groups', setup: 'Install OpenCLI and login in Chrome' },
  { platform: 'instagram', availability: 'available', ready: '—', unlock: 'User search, profiles, posts, explore', setup: 'Install OpenCLI and login in Chrome' },
  { platform: 'xiaohongshu', availability: 'available', ready: '—', unlock: 'Search, notes, comments', setup: 'Install OpenCLI and login in Chrome' },
  { platform: 'linkedin', availability: 'available', ready: '—', unlock: 'Search, profiles, posts, feed', setup: 'Install OpenCLI and login in Chrome' },
  { platform: 'v2ex', availability: 'available', ready: 'Hot/node topics, details, replies, users', unlock: '—', setup: 'No configuration required' },
];

export async function ensureFirstStartBootstrap(env: Record<string, string | undefined> = process.env): Promise<void> {
  // Default is check-only: first start never installs software unattended.
  // Explicit PI_SEARCH_BOOTSTRAP=auto (or the /reach-setup auto action)
  // remains the opt-in install path.
  const mode = (env.PI_SEARCH_BOOTSTRAP ?? 'check').trim().toLowerCase();
  if (isDisabled(mode)) return;

  const existing = await readState(env);
  // A prior check-only run must not swallow a later explicit install request:
  // only a prior install-mode run (or a matching check request) short-circuits.
  if (existing && existing.version >= BOOTSTRAP_STATE_VERSION && !isLegacyBootstrapState(existing)
    && (existing.mode !== 'check' || mode === 'check')) return;

  if (mode === 'check') {
    await safeWriteState({
      version: BOOTSTRAP_STATE_VERSION,
      ranAt: new Date().toISOString(),
      mode,
      status: 'ok',
      message: 'First-start check complete. Use /reach-setup to view available backends.',
    }, env);
    return;
  }

  if (mode !== 'auto') {
    await safeWriteState({
      version: BOOTSTRAP_STATE_VERSION,
      ranAt: new Date().toISOString(),
      mode: 'check',
      status: 'ok',
      message: 'First-start check complete. Use /reach-setup to view available backends.',
    }, env);
    return;
  }

  await safeRunFirstStartAutomation(mode, env);
}

export async function callSetupTool(args: Record<string, unknown>, options: SetupOptions = {}): Promise<BackendCallResult> {
  const action = typeof args.action === 'string' ? args.action as SetupAction : 'auto';
  switch (action) {
    case 'auto':
      return runInteractiveSetup(options);
    case 'status':
      return setupStatus(options.env);
    case 'plan':
      return setupPlan(options.env);
    case 'install_core':
    case 'install_all':
      return handleInstall(action, undefined, options);
    case 'install_channels': {
      const raw = typeof args.channels === 'string' ? args.channels : '';
      if (!raw.trim()) {
        return jsonTextResult({ status: 'error', message: 'channels parameter is required. Provide comma-separated channel names.' });
      }
      const requested = raw.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
      const invalid = requested.filter((c) => !KNOWN_CHANNELS.includes(c));
      if (invalid.length > 0) {
        return jsonTextResult({ status: 'error', message: `Unknown channels: ${invalid.join(', ')}. Valid: ${KNOWN_CHANNELS.join(', ')}` });
      }
      // Planned channels stay accepted for compatibility but install nothing.
      const planned = requested.filter((c) => channelCapability(c)?.availability === 'planned');
      const operational = requested.filter((c) => !planned.includes(c));
      if (operational.length === 0) {
        return jsonTextResult({
          descriptor: true,
          action: 'install_channels',
          status: 'skipped',
          message: `No operational channels requested; planned channels are accepted but install nothing: ${planned.join(', ')}.`,
          plannedChannels: planned,
          backends: [],
        });
      }
      const result = await handleInstall('install_channels', operational, options);
      if (planned.length > 0) {
        const data = JSON.parse(textFromBackendResult(result)) as Record<string, unknown>;
        data.plannedChannels = planned;
        data.message = `${String(data.message ?? '')} Planned channels accepted but skipped: ${planned.join(', ')}.`;
        return jsonTextResult(data);
      }
      return result;
    }
    case 'import_cookies': {
      const provider = typeof args.provider === 'string' ? args.provider : undefined;
      if (provider) return handleImportCookies(provider, args, options);
      return handleImportAllCookies(options);
    }
    case 'login': {
      const provider = typeof args.provider === 'string' ? args.provider : undefined;
      if (!provider) {
        return jsonTextResult({ status: 'error', message: 'provider parameter is required. Use /reach-setup login <provider> [port] or {action:"login",provider:"...",port?:N}.' });
      }
      return handleLogin(provider, args, options);
    }
    default:
      throw new Error(`Unsupported reach_setup action: ${action}`);
  }
}

async function setupStatus(env?: Record<string, string | undefined>): Promise<BackendCallResult> {
  const effectiveEnv = env ?? process.env;
  const state = await readState(effectiveEnv);
  const auth = await readAuthState(effectiveEnv);
  const live = liveAuthSnapshot(effectiveEnv);
  return jsonTextResult({
    firstStart: state ? normalizeBootstrapState(state) : null,
    authState: auth ?? { version: 1, writtenAt: null, providers: {} },
    liveProviders: live,
    localConfig: loadedConfigSummary(effectiveEnv),
    authDir: displayStateDir(effectiveEnv),
    cookieState: await savedCookieStatus(effectiveEnv),
    safety: [
      'First start defaults to check-only (no installs). Set PI_SEARCH_BOOTSTRAP=auto to enable startup installs, off to disable startup automation.',
      'Install actions execute allowed in-house installer commands unless PI_SEARCH_ALLOW_INSTALL=0.',
      'Startup auto-install can be disabled with PI_SEARCH_AUTO_INSTALL=0.',
      'Startup and bare /reach-setup auto never import browser cookies. Kill switch PI_SEARCH_BROWSER_AUTOMATION=0 disables explicit import/login.',
      'Explicit /reach-setup import_cookies <provider> [endpoint] is the per-provider consent path; planned providers never import cookies.',
      'macOS may show a Keychain prompt when default-browser cookies are imported.',
      'Use /reach-setup import_cookies <provider> [endpoint] with an endpoint to import via loopback CDP instead.',
      'Use /reach-setup login <provider> [port] for isolated setup login; setup login remains CDP-based and is separate from public browser automation.',
      'Saved storageState files are session secrets and are forwarded as compatible env vars for known CLIs; browser-session backends may still need their own login state.',
    ],
  });
}

async function runInteractiveSetup(options: SetupOptions): Promise<BackendCallResult> {
  const env = options.env ?? process.env;
  const install = installAllowed(env) && !isDisabled(env.PI_SEARCH_AUTO_INSTALL)
    ? await runSetupInstall('install_core', env, undefined, options.signal)
    : { status: 'skipped', message: installAllowed(env) ? 'Startup auto-install disabled by PI_SEARCH_AUTO_INSTALL.' : 'Install execution disabled by PI_SEARCH_ALLOW_INSTALL.', installers: [] };
  const cookies = { ok: false, message: 'Browser cookie import never runs at startup or bare auto. Use /reach-setup import_cookies <provider> for explicit per-provider import.', results: [] };

  return jsonTextResult({
    action: 'auto',
    install,
    cookies,
    nextSteps: [
      'Use /reach-status to inspect active backends.',
      'Use /reach-setup login <provider> [port] for headed setup login (legacy CDP boundary during migration).',
      'Use /reach-setup status for config/auth/cookie state.',
    ],
  });
}

function setupPlan(env?: Record<string, string | undefined>): BackendCallResult {
  const providers = env ? providerSummary(env) : PROVIDER_DESCRIPTORS.map(d => ({
    provider: d.provider,
    channel: d.channel,
    family: d.family,
    availability: d.availability,
    configured: false,
    keyNames: d.envKeys,
    loginFlow: d.loginFlow,
    cookieDomains: d.cookieDomains,
    risk: d.risk,
    setup: d.setup,
  }));
  return jsonTextResult({
    platforms: platformPlan,
    providers,
    note: 'Install actions execute local installer commands when allowed. Browser automation defaults to agent-browser; import_cookies without endpoint imports from default browser, with endpoint uses loopback CDP. Startup never imports cookies; /reach-setup import_cookies is the explicit consent path. Setup login remains separate legacy CDP during migration.'
  });
}

async function safeRunFirstStartAutomation(mode: string, env: Record<string, string | undefined>): Promise<void> {
  let install: unknown;
  let status: BootstrapState['status'] = 'ok';
  let message = DEFAULT_BOOTSTRAP_MESSAGE;

  try {
    if (installAllowed(env) && !isDisabled(env.PI_SEARCH_AUTO_INSTALL)) {
      install = await runSetupInstall('install_core', env, undefined);
    }
  } catch (error) {
    status = 'warn';
    message = error instanceof Error ? error.message : String(error);
  }

  await safeWriteState({
    version: BOOTSTRAP_STATE_VERSION,
    ranAt: new Date().toISOString(),
    mode,
    status,
    message,
    ...(install ? { install } : {}),
  }, env);
}

async function handleInstall(action: 'install_core' | 'install_all' | 'install_channels', channels: string[] | undefined, options: SetupOptions): Promise<BackendCallResult> {
  const env = options.env ?? process.env;
  if (!installAllowed(env)) return structuredInstallDescriptor(action, env, channels, 'Installation disabled by PI_SEARCH_ALLOW_INSTALL=0.');
  const result = await runSetupInstall(action, env, channels, options.signal);
  return jsonTextResult(result);
}

function textFromBackendResult(result: BackendCallResult): string {
  const content = result.content;
  if (Array.isArray(content) && content.length > 0) {
    const first = content[0] as { text?: unknown };
    if (typeof first.text === 'string') return first.text;
  }
  return '';
}

function structuredInstallDescriptor(action: string, env?: Record<string, string | undefined>, channels?: string[], message = 'Installation disabled; returning structured install plan only.'): BackendCallResult {
  const allProviders = env ? providerSummary(env) : PROVIDER_DESCRIPTORS.map(d => ({
    provider: d.provider,
    channel: d.channel,
    family: d.family,
    availability: d.availability,
    configured: false,
    keyNames: d.envKeys,
    loginFlow: d.loginFlow,
    cookieDomains: d.cookieDomains,
    risk: d.risk,
    setup: d.setup,
  }));
  const backends = channels
    ? allProviders.filter((p) => channels.includes(p.channel))
    : allProviders;
  return jsonTextResult({
    descriptor: true,
    action,
    message,
    backends,
  });
}

async function handleImportAllCookies(options: SetupOptions): Promise<BackendCallResult> {
  const env = options.env ?? process.env;
  if (isDisabled(env.PI_SEARCH_BROWSER_AUTOMATION)) {
    return jsonTextResult({ status: 'error', ok: false, message: 'Browser cookie import disabled by PI_SEARCH_BROWSER_AUTOMATION.' });
  }
  return jsonTextResult(await importCookiesFromDefaultBrowser(env, { providers: cookieImportProviders(), force: true }));
}

async function handleImportCookies(provider: string, args: Record<string, unknown>, options: SetupOptions): Promise<BackendCallResult> {
  const env = options.env ?? process.env;
  const desc = findProvider(provider);
  if (!desc) {
    return jsonTextResult({ status: 'error', message: `Unknown provider: ${provider}. Use /reach-setup import_cookies without arguments to list providers.` });
  }
  // The automation kill switch applies before any provider consent path.
  if (isDisabled(env.PI_SEARCH_BROWSER_AUTOMATION)) {
    return jsonTextResult({ status: 'error', ok: false, message: `Browser cookie import disabled by PI_SEARCH_BROWSER_AUTOMATION. ${desc.setup}` });
  }
  // Explicit per-provider import stays a consent path, but only operational
  // registry providers whose backend consumes the Pi cookie jar may import.
  // OpenCLI Chrome-session providers (facebook, instagram, linkedin) must not
  // collect unused cookies: their sessions live in OpenCLI, so stored Pi
  // cookies would never be consumed.
  if (!cookieImportProviders().includes(desc.provider)) {
    const registryDomains = channelCapability(desc.channel)?.provider?.cookieDomains.length ?? 0;
    if (desc.cookieDomains.length === 0 && registryDomains === 0) {
      return jsonTextResult({ status: 'error', message: `Provider ${provider} (${desc.loginFlow}) does not use cookies. Cannot import cookies.` });
    }
    const reason = desc.availability === 'planned'
      ? `Provider ${provider} is planned and has no working cookie-consuming backend.`
      : `Provider ${provider} has no working cookie-consuming backend; stored cookies would never be consumed.`;
    return jsonTextResult({ status: 'error', ok: false, message: `${reason} Cookie import is not available. ${desc.setup}` });
  }

  const endpoint = typeof args.endpoint === 'string' && args.endpoint.trim()
    ? args.endpoint.trim()
    : env.BROWSER_CDP_ENDPOINT?.trim();

  try {
    const result = endpoint
      ? await importCookiesFromCdp(provider, endpoint, env, options.signal)
      : await importCookiesFromDefaultBrowser(env, { providers: [provider], force: true });
    return jsonTextResult(result);
  } catch (err) {
    return jsonTextResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
  }
}

async function handleLogin(provider: string, args: Record<string, unknown>, options: SetupOptions): Promise<BackendCallResult> {
  const env = options.env ?? process.env;
  const desc = findProvider(provider);
  if (!desc) {
    return jsonTextResult({ status: 'error', message: `Unknown provider: ${provider}. Use /reach-setup plan to list providers.` });
  }
  // The automation kill switch applies before any provider consent path.
  if (isDisabled(env.PI_SEARCH_BROWSER_AUTOMATION)) {
    return jsonTextResult({ status: 'error', ok: false, message: 'Browser automation disabled by PI_SEARCH_BROWSER_AUTOMATION=0. Set it to 1 to enable.' });
  }
  if (desc.cookieDomains.length === 0) {
    return jsonTextResult({ status: 'error', message: `Provider ${provider} (${desc.loginFlow}) does not use cookies. Cannot automate login.` });
  }
  if (!desc.loginUrl) {
    return jsonTextResult({ status: 'error', message: `Provider ${provider} has no configured login URL. Cannot automate login.` });
  }

  const port = typeof args.port === 'number' ? args.port : 9222;
  const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 300_000;

  try {
    const result = await loginViaCdp(provider, port, env, options.signal, timeoutMs);
    return jsonTextResult(result);
  } catch (err) {
    return jsonTextResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
  }
}

export async function writeAuthState(env: Record<string, string | undefined>): Promise<void> {
  const providers: Record<string, { configured: boolean; keys: string[] }> = {};
  for (const desc of PROVIDER_DESCRIPTORS) {
    if (desc.envKeys.length === 0) continue;
    const present = desc.envKeys.filter((k) => typeof env[k] === 'string' && env[k]!.length > 0);
    let configured = present.length > 0;
    if (desc.provider === 'codex' && !configured) configured = codexConfigured(env);
    providers[desc.provider] = { configured, keys: present };
  }
  const state = {
    version: 1,
    writtenAt: new Date().toISOString(),
    providers,
  };
  try {
    const path = authStatePath(env);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  } catch {
    // Non-critical
  }
}

export function installAllowed(env: Record<string, string | undefined>): boolean {
  return !isDisabled(env.PI_SEARCH_ALLOW_INSTALL);
}

function isDisabled(value: string | undefined): boolean {
  if (!value) return false;
  return ['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

/**
 * Startup and bare auto never import browser cookies: extraction reads session
 * secrets from the default browser profile (and may prompt Keychain), so it
 * runs only via explicit /reach-setup import_cookies|login consent paths.
 */

async function readState(env: Record<string, string | undefined>): Promise<BootstrapState | null> {
  try {
    return JSON.parse(await readFile(bootstrapStatePath(env), 'utf8')) as BootstrapState;
  } catch {
    return null;
  }
}

async function readAuthState(env: Record<string, string | undefined>): Promise<unknown> {
  try {
    return JSON.parse(await readFile(authStatePath(env), 'utf8'));
  } catch {
    return null;
  }
}

async function safeWriteState(state: BootstrapState, env: Record<string, string | undefined>): Promise<void> {
  try {
    await writeState(state, env);
  } catch {
    // Startup bootstrap must never prevent extension registration.
  }
}

async function writeState(state: BootstrapState, env: Record<string, string | undefined>): Promise<void> {
  const path = bootstrapStatePath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

async function savedCookieStatus(env: Record<string, string | undefined>): Promise<CookieStatus[]> {
  const dir = cookieStateDir(env);
  try {
    const files = (await readdir(dir)).filter((file) => file.endsWith('.storageState.json'));
    const summaries = await Promise.all(files.map(async (file) => {
      const path = join(dir, file);
      const [raw, meta] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
      const parsed = JSON.parse(raw) as { cookies?: Array<{ domain?: unknown }> };
      const cookies = Array.isArray(parsed.cookies) ? parsed.cookies : [];
      const domains = [...new Set(cookies.flatMap((cookie) => (typeof cookie.domain === 'string' ? [cookie.domain] : [])))];
      return {
        provider: basename(file, '.storageState.json'),
        path,
        cookieCount: cookies.length,
        domains,
        updatedAt: meta.mtime.toISOString(),
      };
    }));
    return summaries.sort((a, b) => a.provider.localeCompare(b.provider));
  } catch {
    return [];
  }
}

function normalizeBootstrapState(state: BootstrapState): BootstrapState {
  if (!isLegacyBootstrapState(state) && state.version >= BOOTSTRAP_STATE_VERSION) return state;
  return {
    version: BOOTSTRAP_STATE_VERSION,
    ranAt: state.ranAt,
    mode: state.mode,
    status: 'ok',
    message: DEFAULT_BOOTSTRAP_MESSAGE,
  };
}

function isLegacyBootstrapState(state: BootstrapState): boolean {
  return state.version < BOOTSTRAP_STATE_VERSION || /agent-reach|Panniantong/i.test(state.message);
}

function baseStateDir(env: Record<string, string | undefined>): string {
  return env.PI_SEARCH_STATE_DIR?.trim() || DEFAULT_STATE_DIR;
}

function displayStateDir(env: Record<string, string | undefined>): string {
  return env.PI_SEARCH_STATE_DIR?.trim() || DEFAULT_STATE_DIR;
}

function bootstrapStatePath(env: Record<string, string | undefined>): string {
  if (!env.PI_SEARCH_STATE_DIR?.trim()) return STATE_PATH;
  return join(baseStateDir(env), 'bootstrap.json');
}

function authStatePath(env: Record<string, string | undefined>): string {
  if (!env.PI_SEARCH_STATE_DIR?.trim()) return AUTH_STATE_PATH;
  return join(baseStateDir(env), 'auth-state.json');
}

function cookieStateDir(env: Record<string, string | undefined>): string {
  return join(baseStateDir(env), 'cookies');
}
