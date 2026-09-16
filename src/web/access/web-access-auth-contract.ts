// Cookie-authenticated fetch contract: operator-only auth profiles.
//
// Operator-only configuration; no model input. `PI_FETCH_AUTH_PROFILES` is a
// JSON object mapping profile names to `{ provider, hosts, cache, redirects }`.
// Absent env means the feature is completely inert (no cookie read, no
// behavior change). Hosts outside a provider's `cookieDomains` are unsupported
// in v1: the contract rejects them with a fixed message (see ADR 0008).
//
// Validation is reject-not-clamp: unknown profile fields, non-`same-origin`
// redirects, bad `cache`, bad hostname syntax, empty host lists, unknown
// providers, providers without cookie domains, hosts outside the provider's
// cookie domains, and profile-count/host-count ceiling breaches all throw a
// fixed message naming only the field (never a value, never a cookie).
// `chrome-profile-auth.ts` (browser-companion TTL/lease) is deliberately not
// involved: fetch auth reads the imported cookie jar only.

import { PROVIDER_DESCRIPTORS } from '../../setup/providers.js';

export const PI_FETCH_AUTH_PROFILES_ENV = 'PI_FETCH_AUTH_PROFILES';

export const MAX_AUTH_PROFILES = 16;
export const MAX_AUTH_HOSTS_PER_PROFILE = 32;
export const MAX_AUTH_REDIRECTS = 5;

export const AUTH_PROFILE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export type WebAccessAuthCachePolicy = 'session' | 'off';

export interface WebAccessAuthProfile {
  name: string;
  provider: string;
  hosts: string[];
  redirects: 'same-origin';
  cache: WebAccessAuthCachePolicy;
}

export type WebAccessAuthProfiles = Record<string, WebAccessAuthProfile>;

/**
 * Parse operator auth profiles from the environment. Absent/blank env means
 * inert: returns an empty map and reads no cookies. Every other malformed
 * shape throws a fixed field-naming message (reject-not-clamp).
 */
export function parseWebAccessAuthProfiles(
  env: Record<string, string | undefined>,
): WebAccessAuthProfiles {
  const raw = env[PI_FETCH_AUTH_PROFILES_ENV]?.trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`invalid ${PI_FETCH_AUTH_PROFILES_ENV}: field "profiles" must be a JSON object`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`invalid ${PI_FETCH_AUTH_PROFILES_ENV}: field "profiles" must be a JSON object`);
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > MAX_AUTH_PROFILES) {
    throw new Error(`invalid ${PI_FETCH_AUTH_PROFILES_ENV}: field "profiles" exceeds the profile limit`);
  }
  const out: WebAccessAuthProfiles = {};
  for (const [name, value] of entries) {
    out[name] = parseProfile(name, value);
  }
  return out;
}

/**
 * Resolve the profile governing a URL: exact host or dot-boundary subdomain
 * match, trailing-dot normalized. Returns undefined for non-matching or
 * unparsable URLs (never throws: the dispatch path must stay fail-closed to
 * the unauthenticated reader).
 */
export function resolveAuthProfileForUrl(
  rawUrl: string,
  profiles: WebAccessAuthProfiles,
): WebAccessAuthProfile | undefined {
  let hostname: string;
  try {
    hostname = normalizeHostname(new URL(rawUrl).hostname);
  } catch {
    return undefined;
  }
  let best: WebAccessAuthProfile | undefined;
  let bestSpecificity = -1;
  let ambiguous = false;
  for (const profile of Object.values(profiles)) {
    let specificity = -1;
    for (const host of profile.hosts) {
      if (hostMatches(hostname, host)) specificity = Math.max(specificity, host.length);
    }
    if (specificity < 0) continue;
    if (specificity > bestSpecificity) {
      best = profile;
      bestSpecificity = specificity;
      ambiguous = false;
    } else if (specificity === bestSpecificity) {
      ambiguous = true;
    }
  }
  if (ambiguous) return undefined;
  return best;
}

/**
 * Assert a fetch URL may use a profile: HTTPS only, then exact-host or
 * dot-boundary subdomain match. Fixed messages only (never a value, never a
 * cookie, never the URL).
 */
export function assertAuthFetchUrl(profile: WebAccessAuthProfile, rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('authenticated fetch requires an HTTPS URL');
  }
  if (url.protocol !== 'https:') throw new Error('authenticated fetch requires an HTTPS URL');
  const hostname = normalizeHostname(url.hostname);
  if (!profile.hosts.some((host) => hostMatches(hostname, host))) {
    throw new Error('authenticated fetch URL host is not allowed by the auth profile');
  }
  return url;
}

/**
 * Refuse a cross-origin redirect hop outright. Auth'd fetches never fall back
 * to credential-header stripping: the hop is rejected, not sanitized.
 */
export function authFetchRedirectGuard(
  profile: WebAccessAuthProfile,
  from: URL,
  to: URL,
): void {
  if (profile.redirects === 'same-origin' && to.origin !== from.origin) {
    throw new Error('authenticated fetch refused a cross-origin redirect');
  }
}

function parseProfile(name: string, value: unknown): WebAccessAuthProfile {
  if (!AUTH_PROFILE_NAME_PATTERN.test(name)) {
    throw new Error(`invalid ${PI_FETCH_AUTH_PROFILES_ENV}: field "name" has an invalid profile name`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid ${PI_FETCH_AUTH_PROFILES_ENV}: field "${name}" must be an object`);
  }
  const config = value as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (key !== 'provider' && key !== 'hosts' && key !== 'cache' && key !== 'redirects') {
      throw new Error(`invalid ${PI_FETCH_AUTH_PROFILES_ENV}: field "${name}.${key}" is unknown`);
    }
  }
  const provider = parseProviderField(config.provider, name);
  const hosts = parseHostsField(config.hosts, name);
  const redirects = config.redirects ?? 'same-origin';
  if (redirects !== 'same-origin') {
    throw new Error(`invalid ${PI_FETCH_AUTH_PROFILES_ENV}: field "${name}.redirects" must be "same-origin"`);
  }
  const cache = config.cache ?? 'off';
  if (cache !== 'session' && cache !== 'off') {
    throw new Error(`invalid ${PI_FETCH_AUTH_PROFILES_ENV}: field "${name}.cache" must be "session" or "off"`);
  }
  assertHostsWithinProviderDomains(hosts, provider, name);
  return { name, provider, hosts, redirects: 'same-origin', cache };
}

function parseProviderField(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`invalid ${PI_FETCH_AUTH_PROFILES_ENV}: field "${name}.provider" is required`);
  }
  const provider = value.trim();
  const descriptor = PROVIDER_DESCRIPTORS.find((entry) => entry.provider === provider);
  if (!descriptor) {
    throw new Error(`invalid ${PI_FETCH_AUTH_PROFILES_ENV}: field "${name}.provider" names an unknown provider`);
  }
  if (descriptor.cookieDomains.length === 0) {
    throw new Error(`invalid ${PI_FETCH_AUTH_PROFILES_ENV}: field "${name}.provider" has no cookie domains`);
  }
  return provider;
}

function parseHostsField(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`invalid ${PI_FETCH_AUTH_PROFILES_ENV}: field "${name}.hosts" must be a non-empty array`);
  }
  return parseHosts(value, name);
}

function parseHosts(value: unknown[], name: string): string[] {
  if (value.length === 0) {
    throw new Error(`invalid ${PI_FETCH_AUTH_PROFILES_ENV}: field "${name}.hosts" must be a non-empty array`);
  }
  if (value.length > MAX_AUTH_HOSTS_PER_PROFILE) {
    throw new Error(`invalid ${PI_FETCH_AUTH_PROFILES_ENV}: field "${name}.hosts" exceeds the host limit`);
  }
  const hosts = value.map((entry) => {
    if (typeof entry !== 'string') {
      throw new Error(`invalid ${PI_FETCH_AUTH_PROFILES_ENV}: field "${name}.hosts" must contain only hostnames`);
    }
    return parseHost(entry, name);
  });
  return [...new Set(hosts)];
}

function parseHost(value: string, name: string): string {
  const host = normalizeHostname(value.trim());
  if (
    !host ||
    host.startsWith('.') ||
    host.endsWith('.') ||
    host.length > 253 ||
    /[\s\\/?:#@*]/.test(host) ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host)
  ) {
    throw new Error(`invalid ${PI_FETCH_AUTH_PROFILES_ENV}: field "${name}.hosts" contains an invalid hostname`);
  }
  return host;
}

/**
 * D6 (deferred): hosts outside the provider's `cookieDomains` are unsupported
 * in v1. The contract rejects them with a fixed message instead of silently
 * widening cookie scope.
 */
function assertHostsWithinProviderDomains(hosts: string[], provider: string, name: string): void {
  const descriptor = PROVIDER_DESCRIPTORS.find((entry) => entry.provider === provider);
  const domains = (descriptor?.cookieDomains ?? []).map((domain) => domain.toLowerCase());
  for (const host of hosts) {
    const allowed = domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
    if (!allowed) {
      throw new Error(`invalid ${PI_FETCH_AUTH_PROFILES_ENV}: field "${name}.hosts" is outside the provider cookie domains`);
    }
  }
}

export function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

export function hostMatches(hostname: string, allowedHost: string): boolean {
  return hostname === allowedHost || hostname.endsWith(`.${allowedHost}`);
}
