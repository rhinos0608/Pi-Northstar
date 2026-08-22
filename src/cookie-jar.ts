import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PROVIDER_DESCRIPTORS } from './providers.js';

export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

export interface CookieImportSummary {
  provider: string;
  domains: string[];
  count: number;
  storagePath: string;
  earliestExpiry: number | null;
  extractedAt: string;
  source: string;
  status: 'imported' | 'fresh' | 'missing' | 'unsupported' | 'error' | 'disabled';
  message: string;
}

interface CookieRow {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Uint8Array | Buffer | null;
  path: string;
  expires_utc: number | bigint;
  is_secure: number;
  is_httponly: number;
  samesite: number;
}

interface StorageState {
  cookies: BrowserCookie[];
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
}

const DEFAULT_STATE_DIR = join(homedir(), '.pi-atlas');
const CHROME_EPOCH_OFFSET_SECONDS = 11_644_473_600;
const DEFAULT_STALE_MS = 12 * 60 * 60 * 1000;
const DEFAULT_COOKIE_IMPORT_PROVIDERS = new Set(['twitter', 'reddit', 'xiaohongshu', 'bilibili']);

const browserProfiles = {
  chrome: {
    label: 'Google Chrome',
    safeStorageName: 'Chrome Safe Storage',
    baseDir: join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome'),
  },
  brave: {
    label: 'Brave Browser',
    safeStorageName: 'Brave Safe Storage',
    baseDir: join(homedir(), 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'),
  },
  edge: {
    label: 'Microsoft Edge',
    safeStorageName: 'Microsoft Edge Safe Storage',
    baseDir: join(homedir(), 'Library', 'Application Support', 'Microsoft Edge'),
  },
} as const;

type BrowserKey = keyof typeof browserProfiles;

export async function importCookiesFromDefaultBrowser(
  env: Record<string, string | undefined>,
  options: { providers?: string[]; force?: boolean } = {},
): Promise<{ ok: boolean; message: string; results: CookieImportSummary[] }> {
  if (browserAutomationDisabled(env) || disabled(env.PI_SEARCH_AUTO_COOKIES)) {
    return { ok: false, message: 'Browser cookie import disabled by environment.', results: [] };
  }

  if (process.platform !== 'darwin') {
    return {
      ok: false,
      message: 'Default-profile cookie import currently supports macOS Chrome-family browsers only. Use /reach-setup login <provider> as fallback.',
      results: [],
    };
  }

  const providerNames = options.providers?.length
    ? options.providers
    : PROVIDER_DESCRIPTORS.filter((provider) => DEFAULT_COOKIE_IMPORT_PROVIDERS.has(provider.provider)).map((provider) => provider.provider);
  const descriptors = providerNames.flatMap((providerName) => {
    const descriptor = PROVIDER_DESCRIPTORS.find((provider) => provider.provider === providerName);
    return descriptor && descriptor.cookieDomains.length > 0 ? [descriptor] : [];
  });

  const browser = browserKey(env.PI_SEARCH_COOKIE_BROWSER);
  const profile = browserProfiles[browser];
  const staleMs = Number(env.PI_SEARCH_COOKIE_STALE_MS ?? DEFAULT_STALE_MS);
  const results: CookieImportSummary[] = [];

  for (const descriptor of descriptors) {
    if (!options.force && await isFresh(descriptor.provider, env, Number.isFinite(staleMs) ? staleMs : DEFAULT_STALE_MS)) {
      results.push({
        provider: descriptor.provider,
        domains: descriptor.cookieDomains,
        count: 0,
        storagePath: storagePath(descriptor.provider, env),
        earliestExpiry: null,
        extractedAt: new Date().toISOString(),
        source: profile.label,
        status: 'fresh',
        message: `${descriptor.provider} cookie state is fresh; skipped extraction.`,
      });
      continue;
    }

    try {
      const cookies = await readBrowserCookies(profile.baseDir, profile.safeStorageName, descriptor.cookieDomains, env);
      if (cookies.length === 0) {
        results.push({
          provider: descriptor.provider,
          domains: descriptor.cookieDomains,
          count: 0,
          storagePath: storagePath(descriptor.provider, env),
          earliestExpiry: null,
          extractedAt: new Date().toISOString(),
          source: profile.label,
          status: 'missing',
          message: `No cookies found for ${descriptor.provider} domains (${descriptor.cookieDomains.join(', ')}).`,
        });
        continue;
      }
      results.push(await writeCookieState(descriptor.provider, cookies, env, profile.label));
    } catch (error) {
      results.push({
        provider: descriptor.provider,
        domains: descriptor.cookieDomains,
        count: 0,
        storagePath: storagePath(descriptor.provider, env),
        earliestExpiry: null,
        extractedAt: new Date().toISOString(),
        source: profile.label,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const imported = results.filter((result) => result.status === 'imported').length;
  return {
    ok: imported > 0 || results.every((result) => result.status === 'fresh'),
    message: `Default browser cookie import complete: ${imported} imported, ${results.filter((r) => r.status === 'fresh').length} fresh, ${results.filter((r) => r.status === 'missing').length} missing, ${results.filter((r) => r.status === 'error').length} failed.`,
    results,
  };
}

export async function writeCookieState(
  provider: string,
  cookies: BrowserCookie[],
  env: Record<string, string | undefined>,
  source: string,
): Promise<CookieImportSummary> {
  const dir = cookieDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});

  const storage: StorageState = { cookies, origins: [] };
  const out = storagePath(provider, env);
  await writeFile(out, JSON.stringify(storage, null, 2), { mode: 0o600 });
  await chmod(out, 0o600).catch(() => {});

  const earliestExpiry = cookies.reduce<number | null>((min, cookie) => {
    const exp = cookie.expires;
    return exp > 0 ? (min === null ? exp : Math.min(min, exp)) : min;
  }, null);
  const domains = [...new Set(cookies.map((cookie) => cookie.domain))];
  const extractedAt = new Date().toISOString();
  await writeFile(metaPath(provider, env), JSON.stringify({ provider, extractedAt, earliestExpiry, count: cookies.length, domains, source }, null, 2), { mode: 0o600 });
  await chmod(metaPath(provider, env), 0o600).catch(() => {});

  return {
    provider,
    domains,
    count: cookies.length,
    storagePath: out,
    earliestExpiry,
    extractedAt,
    source,
    status: 'imported',
    message: `${cookies.length} cookies imported for ${provider} from ${source}. Stored at ${out}.`,
  };
}

export function cookieAuthEnvironment(provider: string, env: Record<string, string | undefined>): Record<string, string> {
  const storage = readCookieState(provider, env);
  if (!storage) return {};
  const header = storage.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  const byName = new Map(storage.cookies.map((cookie) => [cookie.name, cookie.value]));

  switch (provider) {
    case 'twitter':
      return compactEnv({
        TWITTER_AUTH_TOKEN: env.TWITTER_AUTH_TOKEN ?? byName.get('auth_token'),
        TWITTER_CT0: env.TWITTER_CT0 ?? byName.get('ct0'),
        TWITTER_COOKIE: header,
      });
    case 'reddit':
      return compactEnv({ REDDIT_COOKIE: header });
    case 'xiaohongshu':
      return compactEnv({ XHS_COOKIE: header, XIAOHONGSHU_COOKIE: header });
    case 'bilibili':
      return compactEnv({
        BILIBILI_SESSDATA: byName.get('SESSDATA'),
        BILIBILI_CSRF: byName.get('bili_jct'),
        BILIBILI_COOKIE: header,
      });
    case 'xueqiu':
      return compactEnv({ XUEQIU_COOKIE: header });
    default:
      return header ? { [`PI_SEARCH_${provider.toUpperCase()}_COOKIE`]: header } : {};
  }
}

/**
 * Build a `Cookie` header from stored state scoped to an exact HTTPS
 * target host and path. Honors each cookie's expiry, secure flag, domain
 * (host-only vs Domain attribute), and path. Returns undefined when no
 * stored cookie matches. Server-side replay is host/path-based per RFC 6265;
 * SameSite is browser-only and not enforced here.
 */
export function cookieHeaderForUrl(provider: string, urlValue: string, env: Record<string, string | undefined>): string | undefined {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  const storage = readCookieState(provider, env);
  if (!storage) return undefined;
  const host = url.hostname.toLowerCase();
  const path = url.pathname || '/';
  const now = Date.now();
  const parts: string[] = [];
  for (const cookie of storage.cookies) {
    if (cookie.expires > 0 && cookie.expires * 1000 < now) continue;
    if (cookie.secure && url.protocol !== 'https:') continue;
    const domain = cookie.domain.toLowerCase();
    if (domain.startsWith('.')) {
      const base = domain.slice(1);
      if (host !== base && !host.endsWith(domain)) continue;
    } else if (host !== domain) {
      continue;
    }
    const cookiePath = cookie.path || '/';
    const prefix = cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`;
    if (path !== cookiePath && !path.startsWith(prefix)) continue;
    parts.push(`${cookie.name}=${cookie.value}`);
  }
  return parts.length ? parts.join('; ') : undefined;
}

export function filterCookiesForDomains(cookies: BrowserCookie[], domains: string[]): BrowserCookie[] {
  const suffixes = domains.map((domain) => domain.toLowerCase());
  return cookies.filter((cookie) => {
    const domain = cookie.domain.toLowerCase();
    return suffixes.some((suffix) => domain === suffix || domain.endsWith('.' + suffix));
  });
}

async function readBrowserCookies(baseDir: string, safeStorageName: string, domains: string[], env: Record<string, string | undefined>): Promise<BrowserCookie[]> {
  const dbPath = cookieDatabasePath(baseDir, env);
  if (!dbPath) return [];

  const key = readSafeStorageKey(safeStorageName);
  const temp = await mkdtemp(join(tmpdir(), 'pi-search-cookies-'));
  const tempDb = join(temp, 'Cookies');
  try {
    await copyFile(dbPath, tempDb);
    const db = new DatabaseSync(tempDb, { readOnly: true });
    try {
      const statement = db.prepare('select host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite from cookies');
      statement.setReadBigInts(true);
      const rows = statement.all() as unknown as CookieRow[];
      const suffixes = domains.map((domain) => domain.toLowerCase());
      const result: BrowserCookie[] = [];
      for (const row of rows) {
        const domain = String(row.host_key ?? '');
        const normalized = domain.toLowerCase();
        if (!suffixes.some((suffix) => normalized === suffix || normalized.endsWith('.' + suffix))) continue;

        const value = row.value || decryptChromiumCookie(row.encrypted_value, key);
        if (!value) continue;
        result.push({
          name: row.name,
          value,
          domain,
          path: row.path || '/',
          expires: chromeTimeToUnixSeconds(row.expires_utc),
          httpOnly: row.is_httponly === 1,
          secure: row.is_secure === 1,
          sameSite: sameSite(row.samesite),
        });
      }
      return result;
    } finally {
      db.close();
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function cookieDatabasePath(baseDir: string, env: Record<string, string | undefined>): string | null {
  const requested = env.BROWSER_PROFILE_DIR;
  const profileDir = requested?.trim() || join(baseDir, 'Default');
  const networkPath = join(profileDir, 'Network', 'Cookies');
  if (existsSync(networkPath)) return networkPath;
  const legacyPath = join(profileDir, 'Cookies');
  if (existsSync(legacyPath)) return legacyPath;
  return null;
}

function readSafeStorageKey(service: string): Buffer {
  const result = spawnSync('security', ['find-generic-password', '-w', '-s', service], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`Could not read ${service} from macOS Keychain. Approve the Keychain prompt or use /reach-setup login <provider>.`);
  }
  return pbkdf2Sync(result.stdout.trim(), 'saltysalt', 1003, 16, 'sha1');
}

function decryptChromiumCookie(value: Uint8Array | Buffer | null, key: Buffer): string {
  if (!value || value.length === 0) return '';
  const buffer = Buffer.from(value);
  const payload = buffer.subarray(buffer.subarray(0, 3).toString() === 'v10' || buffer.subarray(0, 3).toString() === 'v11' ? 3 : 0);
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.from(' '.repeat(16)));
    const decrypted = Buffer.concat([decipher.update(payload), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    return '';
  }
}

function chromeTimeToUnixSeconds(value: number | bigint): number {
  if (typeof value === 'bigint') {
    if (value <= 0n) return 0;
    const seconds = value / 1_000_000n - BigInt(CHROME_EPOCH_OFFSET_SECONDS);
    return seconds > 0n ? Number(seconds) : 0;
  }
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(0, Math.floor(value / 1_000_000 - CHROME_EPOCH_OFFSET_SECONDS));
}

function sameSite(value: number): 'Strict' | 'Lax' | 'None' {
  if (value === 2) return 'Strict';
  if (value === 0) return 'None';
  return 'Lax';
}

async function isFresh(provider: string, env: Record<string, string | undefined>, staleMs: number): Promise<boolean> {
  try {
    const [metaRaw, storageMeta] = await Promise.all([readFile(metaPath(provider, env), 'utf8'), stat(storagePath(provider, env))]);
    const meta = JSON.parse(metaRaw) as { extractedAt?: string };
    const time = meta.extractedAt ? Date.parse(meta.extractedAt) : storageMeta.mtimeMs;
    return Number.isFinite(time) && Date.now() - time < staleMs;
  } catch {
    return false;
  }
}

function readCookieState(provider: string, env: Record<string, string | undefined>): StorageState | null {
  try {
    const parsed = JSON.parse(readFileSync(storagePath(provider, env), 'utf8')) as StorageState;
    if (!Array.isArray(parsed.cookies)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function compactEnv(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0));
}

function browserKey(value: string | undefined): BrowserKey {
  const key = value?.trim().toLowerCase();
  if (key === 'brave' || key === 'edge') return key;
  return 'chrome';
}

function browserAutomationDisabled(env: Record<string, string | undefined>): boolean {
  return disabled(env.PI_SEARCH_BROWSER_AUTOMATION);
}

function disabled(value: string | undefined): boolean {
  if (!value) return false;
  return ['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

function cookieDir(env: Record<string, string | undefined>): string {
  return join(env.PI_SEARCH_STATE_DIR?.trim() || DEFAULT_STATE_DIR, 'cookies');
}

function storagePath(provider: string, env: Record<string, string | undefined>): string {
  return join(cookieDir(env), `${provider}.storageState.json`);
}

function metaPath(provider: string, env: Record<string, string | undefined>): string {
  return join(dirname(storagePath(provider, env)), `${basename(storagePath(provider, env), '.storageState.json')}.meta.json`);
}
