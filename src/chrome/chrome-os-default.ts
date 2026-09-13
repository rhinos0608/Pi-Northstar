// OS-default browser detection (read-only, fixed queries only).
//
// Pi-side helper for the final Chromium-default contract. Exposes a fixed
// allowlist of read-only OS queries per platform; no caller-supplied commands,
// no shell, sanitized env, bounded time/output. Callers map the detected
// default to a Chromium family (or non-Chromium) for companion selection.
//
// No profile identity is collected: only the default-handler family +
// bounded evidence label.

export type ChromiumFamily = 'chrome' | 'chromium' | 'edge' | 'brave' | 'arc' | 'vivaldi';

export type OsDefaultFamily = ChromiumFamily | 'safari' | 'firefox' | 'unknown';

export const CHROMIUM_FAMILIES: readonly ChromiumFamily[] = [
  'chrome',
  'chromium',
  'edge',
  'brave',
  'arc',
  'vivaldi',
] as const;

export function isChromiumFamily(family: OsDefaultFamily): family is ChromiumFamily {
  return (CHROMIUM_FAMILIES as readonly string[]).includes(family);
}

/** Bounded caps for every OS query. */
export const OS_DEFAULT_TIMEOUT_MS = 5_000;
export const OS_DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
export const OS_DEFAULT_EVIDENCE_MAX_CHARS = 240;

/** One fixed read-only OS query. argv[0] is an absolute binary path. */
export interface OsDefaultQuery {
  label: string;
  argv: readonly string[];
}

function darwinQueries(): OsDefaultQuery[] {
  return [
    {
      label: 'darwin:default-http-handler',
      argv: ['/usr/bin/defaults', 'read', 'com.apple.LaunchServices/com.apple.launchservices.secure', 'LSHandlers'],
    },
  ];
}

function linuxQueries(): OsDefaultQuery[] {
  return [
    { label: 'linux:xdg-default-http', argv: ['/usr/bin/xdg-settings', 'get', 'default-web-browser'] },
    { label: 'linux:xdg-mime-http', argv: ['/usr/bin/xdg-mime', 'query', 'default', 'x-scheme-handler/http'] },
  ];
}

function winQueries(): OsDefaultQuery[] {
  return [
    {
      label: 'win:http-progid',
      argv: ['C:\\Windows\\System32\\reg.exe', 'QUERY', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice', '/v', 'ProgId'],
    },
  ];
}

/** Fixed allowlist of read-only queries for a platform. Unknown platform -> []. */
export function listOsDefaultQueries(platform: NodeJS.Platform = process.platform): OsDefaultQuery[] {
  if (platform === 'darwin') return darwinQueries();
  if (platform === 'linux') return linuxQueries();
  if (platform === 'win32') return winQueries();
  return [];
}

export interface OsQueryResult {
  label: string;
  output: string;
}

export interface OsDefaultDetection {
  family: OsDefaultFamily;
  isChromium: boolean;
  /** Bounded evidence: which query matched + normalized token, never raw dump. */
  evidence: string;
}

export interface OsRunner {
  run(query: OsDefaultQuery, caps: { timeoutMs: number; maxBytes: number }): OsQueryResult | null;
  sanitizedEnv(): Record<string, string>;
}

const OS_RUN_ENV_ALLOWLIST: readonly string[] = ['PATH', 'LANG', 'LC_ALL', 'SystemRoot', 'windir'] as const;

/** Sanitized env for OS child queries: allowlisted benign vars only. */
export function buildOsQueryEnv(parentEnv: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of OS_RUN_ENV_ALLOWLIST) {
    const val = parentEnv[key];
    if (typeof val === 'string' && val.length > 0 && val.length <= 4096) out[key] = val;
  }
  return out;
}

/** Normalize one bounded token of query output for family matching. */
function normalizeToken(output: string): string {
  return output.slice(0, 2048).toLowerCase();
}

function matchFamily(token: string): OsDefaultFamily | null {
  if (token.includes('brave')) return 'brave';
  if (token.includes('edg') || token.includes('edge')) return 'edge';
  if (token.includes('arc-company') || /(^|[^a-z])arc([^a-z]|$)/.test(token)) return 'arc';
  if (token.includes('vivaldi')) return 'vivaldi';
  if (token.includes('chromium') && !token.includes('chrome')) return 'chromium';
  if (token.includes('chrome')) return 'chrome';
  if (token.includes('safari') || token.includes('apple')) return 'safari';
  if (token.includes('firefox') || token.includes('mozilla')) return 'firefox';
  return null;
}

function boundEvidence(label: string, family: OsDefaultFamily): string {
  return `${label}:${family}`.slice(0, OS_DEFAULT_EVIDENCE_MAX_CHARS);
}

export interface DetectOsDefaultDeps {
  platform?: NodeJS.Platform | undefined;
  queries?: OsDefaultQuery[] | undefined;
  run?: ((query: OsDefaultQuery) => string | null) | undefined;
}

/**
 * Detect the OS default browser family from fixed read-only queries.
 * Returns null when no query matches (unknown default). Never throws for
 * parse misses; only throws on programmer error (empty fixed argv).
 */
export function detectOsDefault(deps?: DetectOsDefaultDeps): OsDefaultDetection | null {
  const queries = deps?.queries ?? listOsDefaultQueries(deps?.platform ?? process.platform);
  const run = deps?.run;
  if (run === undefined) return null;
  for (const query of queries) {
    if (query.argv.length === 0 || query.argv[0] === undefined || query.argv[0].length === 0) {
      throw new Error('os-default: fixed query argv must be non-empty');
    }
    let raw: string | null;
    try {
      raw = run(query);
    } catch {
      continue;
    }
    if (raw === null || raw.length === 0) continue;
    const token = normalizeToken(raw);
    const family = matchFamily(token);
    if (family === null) continue;
    return { family, isChromium: isChromiumFamily(family), evidence: boundEvidence(query.label, family) };
  }
  return null;
}
