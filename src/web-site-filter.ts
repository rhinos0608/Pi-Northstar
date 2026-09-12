// Shared site: query rewrite + hostname post-filter (serper/serpapi).
// Single spelling for normalizeDomain/parseDomainFilter/passesDomainFilters/buildQuery.

export interface SiteDomainFilters {
  include: string[];
  exclude: string[];
}

export function normalizeDomain(value: string): string | null {
  let input = value.trim().toLowerCase();
  if (!input) return null;
  if (input.startsWith('-')) input = input.slice(1).trim();
  if (!input) return null;
  try {
    const parsed = input.includes('://') ? new URL(input) : new URL(`https://${input}`);
    input = parsed.hostname;
  } catch {
    input = input.split('/')[0]?.split(':')[0] ?? '';
  }
  input = input.replace(/^\.+|\.+$/g, '');
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(input) ? input : null;
}

export function parseDomainFilter(domains: readonly string[] | undefined): SiteDomainFilters {
  const filters: SiteDomainFilters = { include: [], exclude: [] };
  for (const raw of domains ?? []) {
    const domain = normalizeDomain(raw);
    if (!domain) continue;
    const target = raw.trim().startsWith('-') ? filters.exclude : filters.include;
    if (!target.includes(domain)) target.push(domain);
  }
  return filters;
}

export function passesDomainFilters(url: string, filters: SiteDomainFilters): boolean {
  if (filters.include.length === 0 && filters.exclude.length === 0) return true;
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const matches = (domain: string): boolean => hostname === domain || hostname.endsWith(`.${domain}`);
  if (filters.exclude.some(matches)) return false;
  return filters.include.length === 0 || filters.include.some(matches);
}

export function buildQuery(query: string, filters: SiteDomainFilters): string {
  const parts = [query];
  if (filters.include.length === 1) parts.push(`site:${filters.include[0]}`);
  if (filters.include.length > 1) parts.push(`(${filters.include.map((domain) => `site:${domain}`).join(' OR ')})`);
  for (const domain of filters.exclude) parts.push(`-site:${domain}`);
  return parts.join(' ');
}
