/**
 * Shared SSRF network policy classifier.
 *
 * Blocks private/reserved IP ranges and known metadata/local hostnames
 * for user-controlled public fetch/browser URLs. Does NOT block configured
 * local services (SearXNG, Ollama, embedding, sidecar, CDP/setup paths)
 * — those use `unsafeFetchJson` which bypasses this validator.
 *
 * Defense-in-depth: does not claim complete SSRF containment.
 * DNS rebinding, Chromium DNS TOCTOU, and redirects remain residual risks.
 * Container egress is the authoritative outer boundary.
 */

import { BlockList, isIP } from 'node:net';
import { promises as dnsPromises, type LookupAddress } from 'node:dns';

// ── Static hostname blocklist ──

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'metadata.azure.com',
  'instance-data',
  'host.docker.internal',
  'gateway.docker.internal',
]);

// ── IP range blocklist via node:net BlockList ──

const ipBlocklist = new BlockList();

// IPv4 private/reserved ranges
const ipv4Ranges = [
  '0.0.0.0/8',       // "This" network
  '10.0.0.0/8',      // Private Class A
  '100.64.0.0/10',   // Shared Address Space (CGN)
  '127.0.0.0/8',     // Loopback
  '169.254.0.0/16',  // Link-local
  '172.16.0.0/12',   // Private Class B
  '192.168.0.0/16',  // Private Class C
  '192.0.0.0/24',    // IETF Protocol Assignments
  '192.0.2.0/24',    // Documentation (TEST-NET-1)
  '198.18.0.0/15',   // Benchmarking
  '198.51.100.0/24', // Documentation (TEST-NET-2)
  '203.0.113.0/24',  // Documentation (TEST-NET-3)
  '224.0.0.0/4',     // Multicast
  '240.0.0.0/4',     // Reserved (starting from 240.0.0.0)
] as const;

// IPv6 private/reserved ranges
const ipv6Ranges = [
  '::/128',         // Unspecified
  '::1/128',        // Loopback
  'fc00::/7',       // Unique Local Addresses
  'fe80::/10',      // Link-local
  'fec0::/10',      // Site-local (deprecated)
  'ff00::/8',       // Multicast
  '100::/64',       // Discard-only
  '2001:2::/48',    // Benchmarking
  '2001:db8::/32',  // Documentation
  '2001:10::/28',   // ORCHID
  '2001:20::/28',   // ORCHIDv2
  '2002::/16',      // 6to4
] as const;

function parseCidr(cidr: string): { address: string; prefix: number } {
  const idx = cidr.lastIndexOf('/');
  return { address: cidr.slice(0, idx), prefix: Number(cidr.slice(idx + 1)) };
}

for (const range of ipv4Ranges) {
  const { address, prefix } = parseCidr(range);
  ipBlocklist.addSubnet(address, prefix, 'ipv4');
}
for (const range of ipv6Ranges) {
  const { address, prefix } = parseCidr(range);
  ipBlocklist.addSubnet(address, prefix, 'ipv6');
}

// IPv4-mapped equivalents are handled by BlockList.addSubnet with IPv6 range.
// IPv4-mapped forms like ::ffff:10.0.0.0/104 match 10.0.0.0/8 via BlockList.

// ── Hostname normalization ──

function normalizeHostname(raw: string): string {
  // Strip brackets (IPv6 literal in URL)
  let h = raw.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  // Strip trailing dot
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

// ── Public API ──

export type DnsLookup = (hostname: string, options?: { all?: boolean; family?: number }) => Promise<LookupAddress[]>;

/**
 * Check if an IP address string is private/reserved.
 * Uses node:net BlockList for exact CIDR matching.
 * Returns true for private, reserved, documentation, and link-local addresses.
 */
export function isPrivateOrReservedAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  // Direct loopback / wildcard checks (BlockList.check handles these too but be explicit)
  if (normalized === '0.0.0.0' || normalized === '::' || normalized === '::0') return true;
  if (isIP(normalized) === 6) {
    const mapped = /^::ffff:(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|([0-9.]+))$/i.exec(normalized);
    if (mapped) {
      const ipv4 = mapped[3] ?? [mapped[1]!, mapped[2]!].flatMap((part) => [Number.parseInt(part.slice(0, 2), 16), Number.parseInt(part.slice(2), 16)]).join('.');
      if (isPrivateOrReservedAddress(ipv4)) return true;
    }
  }
  return ipBlocklist.check(normalized, 'ipv4') || ipBlocklist.check(normalized, 'ipv6');
}

/**
 * Assert a hostname is public (not private/reserved/blocked).
 * Checks hostname literals only — does NOT resolve DNS.
 * Throws on blocked hostnames or IP addresses in private/reserved ranges.
 */
export function assertPublicHostname(hostname: string): void {
  const h = normalizeHostname(hostname);

  // Check blocked hostnames
  if (BLOCKED_HOSTNAMES.has(h)) {
    throw new Error(`Blocked hostname: ${h}`);
  }

  // Check wildcard localhost subdomains
  if (h.endsWith('.localhost')) {
    throw new Error(`Blocked hostname: ${h}`);
  }

  // Try to parse as IP address and check range
  // WHATWG URL already normalizes decimal/hex/octal IPv4 in hostname
  if (isPrivateOrReservedAddress(h)) {
    throw new Error(`Private/reserved address: ${h}`);
  }
}

/**
 * Resolve a public hostname via system DNS and verify ALL returned addresses
 * are public. Rejects when any answer is private/reserved, on zero answers,
 * lookup error, timeout, or caller abort.
 *
 * @param lookup - Injectable DNS lookup for testing (defaults to dns.promises.lookup)
 */
export async function resolvePublicHostname(
  hostname: string,
  _signal?: AbortSignal,
  lookup?: DnsLookup,
): Promise<string[]> {
  const lookupFn = lookup ?? ((h: string, _opts?: { all?: boolean }) => dnsPromises.lookup(h, { all: true }));
  const h = normalizeHostname(hostname);

  // Check hostname literal first
  assertPublicHostname(h);

  if (_signal?.aborted) throw new Error(`DNS lookup aborted for ${hostname}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`DNS lookup timed out for ${hostname}`)), 5_000);
  });
  const aborted = _signal ? new Promise<never>((_, reject) => _signal.addEventListener('abort', () => reject(new Error(`DNS lookup aborted for ${hostname}`)), { once: true })) : undefined;
  try {
    const result = await Promise.race([lookupFn(h, { all: true }), timeout, ...(aborted ? [aborted] : [])]);
    const addresses = result.map((entry: LookupAddress) => entry.address);
    if (addresses.length === 0) throw new Error(`DNS lookup returned no addresses for ${hostname}`);
    for (const addr of addresses) {
      if (isPrivateOrReservedAddress(addr)) throw new Error(`DNS resolved ${hostname} to private/reserved address: ${addr}`);
    }
    return addresses;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
