// ── Loopback-only debug mode: pure detection and matching ──

/**
 * Immutable policy describing an allowed loopback debug origin.
 */
export interface LoopbackDebugPolicy {
  /** The full navigation URL (e.g. http://localhost:3000/) */
  navigationUrl: string;
  /** WHATWG-normalized origin (e.g. http://localhost:3000) */
  origin: string;
  hostname: string;
  protocol: 'http:' | 'https:';
  port: number;
}

// ── Loopback detection helpers ──

/** Recognized loopback hostnames/IPs (pre-normalized, lowercase) */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(h)) return true;
  // 127.x.x.x
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

/** Reject known-bad hostnames */
function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === '0.0.0.0' || h === '::') return true;
  if (h === 'host.docker.internal') return true;
  // RFC1918 / link-local (not 127.x.x.x which is loopback)
  if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(h)) return true;
  return false;
}

// ── Public API ──

/**
 * Parse and validate a loopback debug target URL.
 * Returns undefined if the target is not a valid loopback origin.
 */
export function parseLoopbackDebugTarget(raw: string): LoopbackDebugPolicy | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }

  // Only http/https
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;

  // No credentials
  if (url.username !== '' || url.password !== '') return undefined;

  const hostname = url.hostname.toLowerCase();
  if (!isLoopbackHostname(hostname)) return undefined;
  if (isBlockedHostname(hostname)) return undefined;

  const origin = url.origin;
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);

  // Rebuild a clean navigation URL with trailing slash for consistency
  const navigationUrl = origin + '/';

  return {
    navigationUrl,
    origin,
    hostname,
    protocol: url.protocol as 'http:' | 'https:',
    port,
  };
}

/**
 * Check if a raw URL matches the exact origin of a loopback debug policy.
 * Used for subresource / navigation containment checks.
 * Maps ws: → http: and wss: → https: for same-origin HMR comparison.
 */
export function isAllowedLoopbackRequest(policy: LoopbackDebugPolicy, rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    // Map WebSocket schemes to HTTP for origin comparison
    let effectiveProtocol = url.protocol;
    if (effectiveProtocol === 'ws:') effectiveProtocol = 'http:';
    else if (effectiveProtocol === 'wss:') effectiveProtocol = 'https:';
    else if (effectiveProtocol !== 'http:' && effectiveProtocol !== 'https:') return false;

    const effectiveOrigin = `${effectiveProtocol}//${url.host}`;
    return effectiveOrigin === policy.origin;
  } catch {
    return false;
  }
}

/**
 * Check if two URLs share the same network origin (scheme + host).
 * For the loopback context: ws→http, wss→https mapping.
 */
export function sameNetworkOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const normA = normalizeScheme(ua.protocol);
    const normB = normalizeScheme(ub.protocol);
    return normA === normB && ua.host === ub.host;
  } catch {
    return false;
  }
}

function normalizeScheme(protocol: string): string {
  if (protocol === 'ws:') return 'http:';
  if (protocol === 'wss:') return 'https:';
  return protocol;
}
