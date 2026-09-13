// Zero-dependency CDP: Node built-ins only (WebSocket, fetch, child_process, fs/promises)

import { chmod, mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { findProvider } from '../setup/providers.js';

// ── Types ──

interface StorageStateCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

interface StorageState {
  cookies: StorageStateCookie[];
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number | undefined;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

interface CdpCommandResult {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message: string };
}

interface CookieImportSummary {
  provider: string;
  domains: string[];
  count: number;
  storagePath: string;
  earliestExpiry: number | null;
}

// ── Constants ──

const DEFAULT_STATE_DIR = join(homedir(), '.pi-northstar');
const CDP_TIMEOUT_MS = 30_000;
const LOGIN_POLL_INTERVAL_MS = 2_000;
const DEFAULT_CDP_PORT = 9222;

export const BROWSER_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL',
  'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY',
];

// ── Public API ──

export async function importCookiesFromCdp(
  provider: string,
  endpoint: string,
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<{ ok: boolean; message: string } & Partial<CookieImportSummary>> {
  if (isBrowserAutomationDisabled(env)) return optOutResponse();

  const desc = findProvider(provider);
  if (!desc) return { ok: false, message: `Unknown provider: ${provider}` };
  if (desc.cookieDomains.length === 0) {
    return { ok: false, message: `Provider ${provider} does not use cookies (loginFlow: ${desc.loginFlow})` };
  }

  requireWebSocket();
  const validated = validateCdpEndpoint(endpoint);
  const wsEndpoint = await resolveCdpEndpoint(validated);

  let rawCookies: CdpCookie[] | null;
  try {
    rawCookies = await connectAndGetCookies(wsEndpoint, cookieUrls(desc.cookieDomains), signal);
  } catch (error) {
    return { ok: false, message: sanitizeCookieError(error).message };
  }
  if (!rawCookies) {
    return { ok: false, message: 'CDP connection failed or timed out.' };
  }

  const domainSuffixes = desc.cookieDomains.map((d) => d.toLowerCase());
  const relevant = rawCookies.filter((c) => {
    const cd = c.domain.toLowerCase();
    return domainSuffixes.some((suffix) => cd === suffix || cd.endsWith('.' + suffix));
  });

  if (relevant.length === 0) {
    return {
      ok: false,
      message: `No cookies found for ${provider} domains (${desc.cookieDomains.join(', ')}). Is the user logged in to this browser?`,
    };
  }

  const storage: StorageState = {
    cookies: relevant.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      expires: c.expires ?? 0,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite ?? 'Lax',
    })),
    origins: [],
  };

  const storagePath = join(cookieDir(env), `${provider}.storageState.json`);
  await ensurePrivateDir(cookieDir(env));
  const tmpPath = storagePath + '.tmp';
  await writeFile(tmpPath, JSON.stringify(storage, null, 2), { mode: 0o600 });
  await renameSafe(tmpPath, storagePath);

  const earliestExpiry = relevant.reduce<number | null>((min, c) => {
    const exp = c.expires ?? 0;
    return exp > 0 ? (min === null ? exp : Math.min(min, exp)) : min;
  }, null);
  const domains = [...new Set(relevant.map((c) => c.domain))];

  return {
    ok: true,
    provider,
    domains,
    count: relevant.length,
    storagePath,
    earliestExpiry,
    message: `${relevant.length} cookies imported for ${provider} (${domains.length} domain${domains.length !== 1 ? 's' : ''}). Stored at ${storagePath}.`,
  };
}

export async function loginViaCdp(
  provider: string,
  port: number,
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<{ ok: boolean; message: string } & Partial<CookieImportSummary>> {
  if (isBrowserAutomationDisabled(env)) return optOutResponse();

  const desc = findProvider(provider);
  if (!desc) return { ok: false, message: `Unknown provider: ${provider}` };
  if (desc.cookieDomains.length === 0) {
    return { ok: false, message: `Provider ${provider} does not use cookies (loginFlow: ${desc.loginFlow})` };
  }
  if (!desc.loginUrl) {
    return { ok: false, message: `Provider ${provider} has no configured login URL. Cannot automate login.` };
  }
  if (!Number.isFinite(port) || port < 1024 || port > 65535) {
    return { ok: false, message: `CDP port must be in range 1024-65535, got ${port}` };
  }

  requireWebSocket();
  const actualTimeout = timeoutMs ?? 300_000;
  const browserPath = findBrowserExecutable(env);

  const profileDir = join(cookieDir(env), '..', 'profiles', `login-${provider}-${Date.now()}`);
  await ensurePrivateDir(dirname(profileDir));

  // Minimal env — no API keys or tokens
  const browserEnv: Record<string, string> = { BROWSER_AUTOMATION: '1' };
  for (const key of BROWSER_ENV_ALLOWLIST) {
    const value = env[key] ?? process.env[key];
    if (typeof value === 'string') {
      browserEnv[key] = value;
    }
  }

  const browser = spawn(browserPath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-extensions',
    `--app=${desc.loginUrl}`,
  ], {
    stdio: ['ignore', 'ignore', 'ignore'],
    env: browserEnv,
  });

  // Handle spawn errors (ENOENT etc.)
  const spawnError: { message: string } | null = await new Promise((resolve) => {
    browser.on('error', (err: NodeJS.ErrnoException) => {
      resolve({ message: err.code === 'ENOENT' ? `Browser executable not found: ${browserPath}` : err.message });
    });
    setImmediate(() => resolve(null));
  });
  if (spawnError) {
    cleanup(browser, profileDir);
    return { ok: false, message: spawnError.message };
  }

  try {
    const httpUrl = `http://127.0.0.1:${port}/json/version`;
    const wsEndpoint = await waitForCdpEndpoint(httpUrl, 10_000, signal);
    if (!wsEndpoint) {
      cleanup(browser, profileDir);
      return { ok: false, message: 'Browser started but CDP endpoint not available within 10s.' };
    }

    const pollDeadline = Date.now() + actualTimeout;
    const domainSuffixes = desc.cookieDomains.map((d) => d.toLowerCase());
    let pollCount = 0;

    while (Date.now() < pollDeadline) {
      if (signal?.aborted) {
        cleanup(browser, profileDir);
        return { ok: false, message: 'Login cancelled by user.' };
      }

      const checkResult = await pollCookies(wsEndpoint, domainSuffixes, signal);
      if (checkResult.length > 0) {
        const storage: StorageState = {
          cookies: checkResult.map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path || '/',
            expires: c.expires ?? 0,
            httpOnly: c.httpOnly,
            secure: c.secure,
            sameSite: c.sameSite ?? 'Lax',
          })),
          origins: [],
        };

        const storagePath = join(cookieDir(env), `${provider}.storageState.json`);
        await ensurePrivateDir(cookieDir(env));
        const tmpPath = storagePath + '.tmp';
        await writeFile(tmpPath, JSON.stringify(storage, null, 2), { mode: 0o600 });
        await renameSafe(tmpPath, storagePath);

        const earliestExpiry = checkResult.reduce<number | null>((min, c) => {
          const exp = c.expires ?? 0;
          return exp > 0 ? (min === null ? exp : Math.min(min, exp)) : min;
        }, null);
        const domains = [...new Set(checkResult.map((c) => c.domain))];

        cleanup(browser, profileDir);
        return {
          ok: true,
          provider,
          domains,
          count: checkResult.length,
          storagePath,
          earliestExpiry,
          message: `Login completed for ${provider}. ${checkResult.length} cookies saved from ${domains.length} domain${domains.length !== 1 ? 's' : ''}. Stored at ${storagePath}.`,
        };
      }

      pollCount++;
      await sleep(LOGIN_POLL_INTERVAL_MS);
    }

    cleanup(browser, profileDir);
    return {
      ok: false,
      message: `Login timed out after ${Math.round(actualTimeout / 1000)}s. No cookies found for ${provider} domains (${desc.cookieDomains.join(', ')}). Polled ${pollCount} times.`,
    };
  } catch (err) {
    cleanup(browser, profileDir);
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// ── Endpoint Validation and Resolution ──

export interface CdpEndpointInfo {
  host: string;
  port: number;
  protocol: 'ws' | 'http';
  path: string;
}

export function validateCdpEndpoint(endpoint: string): CdpEndpointInfo {
  const rawPort = /^[a-zA-Z]+:\/\/(?:\[[^\]]+\]|[^/:]+):(\d+)/.exec(endpoint)?.[1];
  if (rawPort) {
    const parsedPort = Number(rawPort);
    if (!Number.isFinite(parsedPort) || parsedPort < 1024 || parsedPort > 65535) {
      throw new Error(`CDP endpoint port must be 1024-65535, got ${rawPort}`);
    }
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`Invalid CDP endpoint URL: ${endpoint}`);
  }

  if (url.protocol !== 'ws:' && url.protocol !== 'http:') {
    throw new Error(`CDP endpoint must use ws:// or http:// scheme, got ${url.protocol}`);
  }

  const host = normalizeLoopbackHost(url.hostname.toLowerCase());
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
    throw new Error(`CDP endpoint must be loopback (localhost, 127.0.0.1, or [::1]), got ${url.hostname}`);
  }

  const port = rawPort ? Number(rawPort) : (url.port ? Number(url.port) : DEFAULT_CDP_PORT);
  if (!Number.isFinite(port) || port < 1024 || port > 65535) {
    throw new Error(`CDP endpoint port must be 1024-65535, got ${url.port || port}`);
  }

  return {
    host,
    port,
    protocol: url.protocol === 'http:' ? 'http' : 'ws',
    path: `${url.pathname}${url.search}`,
  };
}

const DISCOVER_FETCH_TIMEOUT_MS = 5_000;

export async function resolveCdpEndpoint(info: CdpEndpointInfo): Promise<string> {
  if (info.protocol === 'ws' && info.path.includes('/devtools/')) {
    return formatWsEndpoint(info);
  }

  const httpUrl = `http://${formatUrlHost(info.host)}:${info.port}/json/version`;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('fetch timed out')), DISCOVER_FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(httpUrl, { signal: ac.signal });
      if (resp.ok) {
        const data = (await resp.json()) as { webSocketDebuggerUrl?: string };
        if (data.webSocketDebuggerUrl) {
          const discovered = validateCdpEndpoint(data.webSocketDebuggerUrl);
          if (discovered.protocol !== 'ws' || !discovered.path.includes('/devtools/')) {
            throw new Error('Discovered CDP endpoint is not a devtools WebSocket URL.');
          }
          return formatWsEndpoint(discovered);
        }
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Fall through
  }

  throw new Error(`Cannot discover CDP WebSocket endpoint at ${info.host}:${info.port}. Is the browser running with --remote-debugging-port?`);
}

// ── WebSocket Guard ──

export function requireWebSocket(): void {
  if (typeof globalThis.WebSocket !== 'function') {
    throw new Error('WebSocket is not available in this runtime. CDP automation requires a runtime with WebSocket support (Node.js 22+ or a WebSocket shim).');
  }
}

// ── Connect and Get Cookies ──

function cookieUrls(domains: string[]): string[] {
  return domains.map((domain) => `https://${domain}/`);
}

async function connectAndGetCookies(
  wsEndpoint: string,
  urls: string[],
  signal?: AbortSignal,
): Promise<CdpCookie[] | null> {
  return new Promise<CdpCookie[] | null>((resolve, reject) => {
    requireWebSocket();
    const ws = new WebSocket(wsEndpoint);
    let nextId = Math.floor(Math.random() * 1_000_000);
    let settled = false;
    let sessionId: string | undefined;
    const pending = new Map<number, (msg: CdpCommandResult) => void>();

    const send = (method: string, params: Record<string, unknown> = {}, session?: string): Promise<CdpCommandResult> => {
      const id = nextId++;
      const payload = { id, method, params, ...(session ? { sessionId: session } : {}) };
      ws.send(JSON.stringify(payload));
      return new Promise((resolveCommand) => pending.set(id, resolveCommand));
    };

    const finish = (cookies: CdpCookie[] | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abortHandler);
      ws.close();
      if (error) reject(error);
      else resolve(cookies);
    };

    const timer = setTimeout(() => finish(null, new Error('CDP connection timed out')), CDP_TIMEOUT_MS);
    const abortHandler = () => finish(null, new Error('CDP operation cancelled by user.'));
    if (signal) signal.addEventListener('abort', abortHandler, { once: true });

    ws.onopen = () => {
      void (async () => {
        try {
          if (wsEndpoint.includes('/devtools/browser/')) {
            const target = await send('Target.createTarget', { url: 'about:blank' });
            const targetId = typeof target.result?.targetId === 'string' ? target.result.targetId : undefined;
            if (!targetId) throw new Error('CDP did not return a target id.');
            const attached = await send('Target.attachToTarget', { targetId, flatten: true });
            sessionId = typeof attached.result?.sessionId === 'string' ? attached.result.sessionId : undefined;
            if (!sessionId) throw new Error('CDP did not return a session id.');
            await send('Network.enable', {}, sessionId);
            const cookies = await send('Network.getCookies', { urls }, sessionId);
            if (cookies.error) throw new Error(`CDP error: ${cookies.error.message}`);
            finish(Array.isArray(cookies.result?.cookies) ? cookies.result.cookies as CdpCookie[] : []);
            return;
          }

          await send('Network.enable');
          const cookies = await send('Network.getCookies', { urls });
          if (cookies.error) throw new Error(`CDP error: ${cookies.error.message}`);
          finish(Array.isArray(cookies.result?.cookies) ? cookies.result.cookies as CdpCookie[] : []);
        } catch (error) {
          finish(null, error instanceof Error ? error : new Error(String(error)));
        }
      })();
    };

    ws.onmessage = (event: MessageEvent) => {
      if (settled) return;
      try {
        const msg = JSON.parse(event.data as string) as CdpCommandResult;
        if (typeof msg.id === 'number') {
          const resolver = pending.get(msg.id);
          if (resolver) {
            pending.delete(msg.id);
            resolver(msg);
          }
        }
      } catch {
        // Ignore CDP events and malformed messages.
      }
    };

    ws.onerror = () => finish(null, new Error('WebSocket connection failed. Is the browser running with --remote-debugging-port?'));
  });
}

// ── Helpers ──

async function waitForCdpEndpoint(
  httpUrl: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (signal?.aborted) return null;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error('fetch timed out')), DISCOVER_FETCH_TIMEOUT_MS);
      try {
        const resp = await fetch(httpUrl, { signal: ac.signal });
        if (resp.ok) {
          const data = (await resp.json()) as { webSocketDebuggerUrl?: string };
          if (data.webSocketDebuggerUrl) return data.webSocketDebuggerUrl;
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Browser not ready yet
    }
    await sleep(500);
  }
  return null;
}

async function pollCookies(
  wsEndpoint: string,
  domainSuffixes: string[],
  signal?: AbortSignal,
): Promise<CdpCookie[]> {
  try {
    const all = await connectAndGetCookies(wsEndpoint, cookieUrls(domainSuffixes), signal);
    return (all ?? []).filter((c) => {
      const cd = c.domain.toLowerCase();
      return domainSuffixes.some((suffix) => cd === suffix || cd.endsWith('.' + suffix));
    });
  } catch {
    return [];
  }
}

function isBrowserAutomationDisabled(env: Record<string, string | undefined>): boolean {
  const value = env.PI_SEARCH_BROWSER_AUTOMATION;
  if (!value) return false;
  return ['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

function optOutResponse() {
  return { ok: false, message: 'Browser automation disabled by PI_SEARCH_BROWSER_AUTOMATION=0. Set it to 1 to enable.' };
}

function normalizeLoopbackHost(host: string): string {
  return host === '[::1]' ? '::1' : host;
}

function formatUrlHost(host: string): string {
  return host === '::1' ? '[::1]' : host;
}

function formatWsEndpoint(info: CdpEndpointInfo): string {
  return `ws://${formatUrlHost(info.host)}:${info.port}${info.path}`;
}

function findBrowserExecutable(env: Record<string, string | undefined>): string {
  if (env.BROWSER_EXECUTABLE_PATH) return env.BROWSER_EXECUTABLE_PATH;
  if (process.platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  if (process.platform === 'win32') {
    return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  }
  return 'google-chrome';
}

async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700).catch(() => {});
}

async function renameSafe(oldPath: string, newPath: string): Promise<void> {
  try {
    await rename(oldPath, newPath);
  } catch {
    await writeFile(newPath, await readFile(oldPath), { mode: 0o600 });
    await rm(oldPath, { force: true }).catch(() => {});
  }
}

function cookieDir(env: Record<string, string | undefined>): string {
  return join(env.PI_SEARCH_STATE_DIR?.trim() || DEFAULT_STATE_DIR, 'cookies');
}

function cleanup(browser: ChildProcess, profileDir: string): void {
  try { browser.kill('SIGTERM'); } catch { /* Already dead */ }
  rm(profileDir, { recursive: true, force: true }).catch(() => {});
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Cookie helpers ──

// High-level CDP browser automation removed; agent-browser owns public automation.
// Cookie import/login below keeps raw CDP access via connectAndGetCookies.

function sanitizeCookieError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  const sanitized = message
    .replace(/([\"']?(?:cookie|value|token|password|secret|authorization)[\"']?)\s*[:=]\s*[\"']?[^,\s}\"']+[\"']?/gi, '$1=***')
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .slice(0, 2000)
  return new Error(sanitized)
}

// Re-export for reuse
export { isBrowserAutomationDisabled }
