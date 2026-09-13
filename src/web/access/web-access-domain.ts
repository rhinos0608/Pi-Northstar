// Pi Web Access v0.29 compat domain handling.
//
// Query rewrite plus hostname post-filter for the opt-in `domainFilter`
// compat field. Pure helpers; no network, no storage.
import type { WebAccessSearchHit } from './web-access-contract.js';

/** Rewrite a query with `site:` restrictions. No filter returns query unchanged. */
export function buildWebAccessDomainQuery(query: string, domainFilter?: string[] | undefined): string {
  if (!domainFilter || domainFilter.length === 0) return query;
  const sites = domainFilter.map((d) => `site:${d.toLowerCase()}`).join(' OR ');
  return `${query} (${sites})`;
}

/** Lowercased hostname of an absolute URL, or undefined when unparseable. */
export function extractWebAccessHostname(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.length > 0 ? host : undefined;
  } catch {
    return undefined;
  }
}

/** True on exact match or subdomain match (sub.a.test matches a.test). */
export function hostnameMatchesWebAccessFilter(hostname: string, filter: string): boolean {
  const host = hostname.toLowerCase();
  const want = filter.trim().toLowerCase().replace(/^\.+/, '');
  return host === want || host.endsWith(`.${want}`);
}

/**
 * Shared include/exclude domain rules. `-` prefixed entries always reject on
 * match; when at least one include entry is present the host must match one.
 * Empty/blank entries are ignored. Hostname comparison is case-insensitive.
 */
export function passesWebAccessDomainFilter(hostname: string, domains: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  let included = false;
  let hasInclude = false;
  for (const raw of domains) {
    const entry = raw.trim().toLowerCase().replace(/^(-?)\.+/, '$1');
    if (entry.startsWith('-')) {
      const blocked = entry.slice(1);
      if (blocked && hostnameMatchesWebAccessFilter(host, blocked)) return false;
    } else if (entry) {
      hasInclude = true;
      if (hostnameMatchesWebAccessFilter(host, entry)) included = true;
    }
  }
  return hasInclude ? included : true;
}

/**
 * Hostname post-filter. No filter returns hits unchanged. With a filter,
 * keeps hits whose hostname matches any entry; unparseable URLs are dropped.
 */
export function filterWebAccessHitsByDomain(
  hits: WebAccessSearchHit[],
  domainFilter?: string[] | undefined,
): WebAccessSearchHit[] {
  if (!domainFilter || domainFilter.length === 0) return hits;
  return hits.filter((hit) => {
    const host = extractWebAccessHostname(hit.url);
    if (host === undefined) return false;
    return domainFilter.some((f) => hostnameMatchesWebAccessFilter(host, f));
  });
}
