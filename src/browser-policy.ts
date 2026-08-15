

// ── Action union ──

import { validateJobRequest } from './browser-job.js';

export type BrowserAction =
  | 'status'
  | 'tabs'
  | 'navigate'
  | 'evaluate'
  | 'text'
  | 'html'
  | 'screenshot'
  | 'click'
  | 'type'
  | 'scroll'
  | 'close'
  | 'cookies'
  | 'set_cookies'
  | 'snapshot'
  | 'fill'
  | 'wait'
  | 'get_url'
  | 'get_title'
  | 'semanticAction'
  | 'job'
  | 'batch';

export const BROWSER_ACTIONS: readonly BrowserAction[] = [
  'status', 'tabs', 'navigate', 'evaluate', 'text', 'html', 'screenshot',
  'click', 'type', 'scroll', 'close', 'cookies', 'set_cookies',
  'snapshot', 'fill', 'wait', 'get_url', 'get_title',
  'semanticAction', 'job', 'batch',
] as const;

export const LEGACY_ACTIONS: readonly BrowserAction[] = [
  'status', 'tabs', 'navigate', 'evaluate', 'text', 'html', 'screenshot',
  'click', 'type', 'scroll', 'close', 'cookies', 'set_cookies',
] as const;

// ── Sensitive classification ──

export type SensitiveAction = 'evaluate' | 'set_cookies' | 'batch';

export const SENSITIVE_ACTIONS: readonly SensitiveAction[] = ['evaluate', 'set_cookies', 'batch'] as const;

export function isSensitiveAction(action: string): action is SensitiveAction {
  return (SENSITIVE_ACTIONS as readonly string[]).includes(action);
}

// ── Cookie metadata policy ──

export type CookieMetadata = Pick<CookieLike, 'name' | 'domain' | 'path' | 'expires' | 'httpOnly' | 'secure' | 'sameSite'>;

export interface CookieLike {
  name: string;
  value?: string;
  domain: string;
  path: string;
  expires: number | undefined;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: string;
}

export function normalizeCookieMetadata(cookie: CookieLike): CookieMetadata {
  return {
    name: cookie.name,
    domain: cookie.domain,
    path: cookie.path || '/',
    expires: cookie.expires ?? 0,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite ?? 'Lax',
  };
}

export function extractCookieMetadata(cookies: CookieLike[]): CookieMetadata[] {
  return cookies.map(normalizeCookieMetadata);
}

// ── URL / navigation policy ──

export interface NavigationPolicy {
  url: string;
  /**
   * NOTE: Currently non-functional. Domain allowlisting was intentionally
   * removed in commits a0fad0e and 04f373d. SSRF containment is delegated
   * to external containerization. Retained for future re-enablement.
   */
  allowedDomains?: string[];
}

/**
 * Validate a navigation URL for browser use.
 * Rejects file:, chrome:, about:, data:, blob:, javascript:, ws:, wss:.
 * Rejects credentials in URL.
 * Does NOT block private/reserved IP ranges. SSRF protection is provided by
 * external network containerization; do not rely on this alone outside a container.
 */
export function validateNavigationUrl(raw: string): string {
  const url = new URL(raw.trim());
  const protocol = url.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(`Disallowed URL scheme: ${url.protocol}`);
  }
  return url.href;
}

/**
 * DNS preflight is a no-op — containerization handles network containment.
 *
 * Hostname / domain allowlisting was intentionally removed in commits a0fad0e and 04f373d.
 * This function is retained as a seam for future re-enablement but currently performs
 * no DNS or hostname validation.
 */
export async function dnsPreflight(_hostname: string, _signal?: AbortSignal): Promise<void> {
  // no-op
}

// ── Allowed domain validation — no-op: containerization handles containment ──
// Domain allowlisting was intentionally removed in commits a0fad0e and 04f373d.
// These functions are retained as API surfaces for future re-enablement but
// currently perform no domain or hostname validation.

export function validateAllowedDomain(pattern: string): string {
  return pattern.trim().toLowerCase();
}

export function freezeAllowedDomains(domains: string[]): string[] {
  const validated = domains.map(validateAllowedDomain);
  validated.sort();
  return validated;
}

/**
 * DNS validation for allowed domains — currently a no-op.
 * Domain allowlisting was intentionally removed in commits a0fad0e and 04f373d.
 * Retained as API surface for future re-enablement.
 */
export async function validateAllowedDomainsDns(_domains: string[], _signal?: AbortSignal): Promise<void> {
  // no-op
}

/**
 * Check if a hostname is in the allowed domains list.
 *
 * NOTE: Currently returns true unconditionally. Domain allowlisting was
 * intentionally removed in commits a0fad0e and 04f373d. SSRF/domain containment
 * is delegated to external containerization. Retained as API surface for
 * future re-enablement.
 */
export function checkDomainAllowed(_hostname: string, _allowedDomains: string[]): boolean {
  return true;
}

// ── Input bounds ──

export const MAX_SELECTOR_LENGTH = 500;
export const MAX_TEXT_LENGTH = 10_000;
export const MAX_EXPRESSION_LENGTH = 50_000;
export const MAX_URL_LENGTH = 8_000;
export const MAX_COOKIES = 500;
export const MAX_SCROLL_COORD = 100_000;
export const MAX_WAIT_MS = 120_000;

export function validateSelector(selector: string): string {
  const trimmed = selector.trim();
  if (!trimmed) throw new Error('selector is required');
  if (trimmed.length > MAX_SELECTOR_LENGTH) {
    throw new Error(`selector too long (max ${MAX_SELECTOR_LENGTH} chars)`);
  }
  return trimmed;
}

export function validateText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('text is required');
  if (trimmed.length > MAX_TEXT_LENGTH) {
    throw new Error(`text too long (max ${MAX_TEXT_LENGTH} chars)`);
  }
  return trimmed;
}

export function validateExpression(expression: string): string {
  if (!expression || !expression.trim()) throw new Error('expression is required');
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    throw new Error(`expression too long (max ${MAX_EXPRESSION_LENGTH} chars)`);
  }
  return expression;
}

export function validateCookiesArray(cookies: unknown[]): void {
  if (cookies.length > MAX_COOKIES) {
    throw new Error(`too many cookies (max ${MAX_COOKIES})`);
  }
  for (const c of cookies) {
    if (typeof c !== 'object' || c === null) {
      throw new Error('each cookie must be an object');
    }
    const entry = c as Record<string, unknown>;
    if (typeof entry.name !== 'string' || !entry.name) {
      throw new Error('each cookie must have a non-empty string name');
    }
  }
}

export function validateScrollCoord(value: unknown, _name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(-MAX_SCROLL_COORD, Math.min(MAX_SCROLL_COORD, value));
}

export function validateWaitMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_WAIT_MS, value));
}

// ── Legacy endpoint validator (kept for rollback path) ──

export interface LoopbackEndpointInfo {
  host: string;
  port: number;
  protocol: 'ws' | 'http';
  path: string;
}

export function validateLegacyLoopbackEndpoint(endpoint: string): LoopbackEndpointInfo {
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

  const host = url.hostname.toLowerCase();
  const normalized = host === '[::1]' ? '::1' : host;
  if (normalized !== 'localhost' && normalized !== '127.0.0.1' && normalized !== '::1') {
    throw new Error(`CDP endpoint must be loopback (localhost, 127.0.0.1, or [::1]), got ${url.hostname}`);
  }

  const port = rawPort ? Number(rawPort) : (url.port ? Number(url.port) : 9222);
  if (!Number.isFinite(port) || port < 1024 || port > 65535) {
    throw new Error(`CDP endpoint port must be 1024-65535, got ${url.port || port}`);
  }

  return {
    host: normalized,
    port,
    protocol: url.protocol === 'http:' ? 'http' : 'ws',
    path: `${url.pathname}${url.search}`,
  };
}

// ── Semantic action types (Component 9) ──

export type SemanticLocator = 'role' | 'text' | 'label' | 'placeholder' | 'alt' | 'title' | 'testid' | 'first' | 'last' | 'nth';
export type SemanticVerb = 'click' | 'fill' | 'check' | 'uncheck' | 'select' | 'type' | 'hover';

export interface SemanticActionRequest {
  locator: SemanticLocator;
  query: string;
  verb: SemanticVerb;
  name?: string;
  index?: number;
  value?: string;
  exact?: boolean;
}

const VALID_LOCATORS: readonly SemanticLocator[] = ['role', 'text', 'label', 'placeholder', 'alt', 'title', 'testid', 'first', 'last', 'nth'];
const VALID_VERBS: readonly SemanticVerb[] = ['click', 'fill', 'check', 'uncheck', 'select', 'type', 'hover'];
const VALUE_VERBS = new Set<SemanticVerb>(['fill', 'type', 'select']);

/** Validate a raw semantic action request, throwing on invalid shape. */
export function validateSemanticActionRequest(raw: Record<string, unknown>): SemanticActionRequest {
  const locator = typeof raw.locator === 'string' ? raw.locator.trim() : '';
  if (!locator || !(VALID_LOCATORS as readonly string[]).includes(locator)) {
    throw new Error(`locator is required and must be one of: ${VALID_LOCATORS.join(', ')}`);
  }
  const query = typeof raw.query === 'string' ? raw.query.trim() : '';
  if (!query) throw new Error('query is required');
  const verb = typeof raw.verb === 'string' ? raw.verb.trim() : '';
  if (!verb || !(VALID_VERBS as readonly string[]).includes(verb)) {
    throw new Error(`verb is required and must be one of: ${VALID_VERBS.join(', ')}`);
  }
  if (locator === 'nth') {
    if (typeof raw.index !== 'number' || !Number.isFinite(raw.index)) {
      throw new Error('index is required when locator is nth');
    }
  }
  if (VALUE_VERBS.has(verb as SemanticVerb) && (raw.value === undefined || typeof raw.value !== 'string')) {
    throw new Error(`value is required when verb is ${verb}`);
  }

  const req: SemanticActionRequest = { locator: locator as SemanticLocator, query, verb: verb as SemanticVerb };
  if (typeof raw.name === 'string' && raw.name) req.name = raw.name;
  if (typeof raw.index === 'number') req.index = raw.index;
  if (typeof raw.value === 'string') req.value = raw.value;
  if (raw.exact === true) req.exact = true;
  return req;
}

// ── Batch types (Component 11) ──

export interface BatchCommand {
  args: string[];
  sensitive?: boolean;
}

export interface BatchRequest {
  commands: BatchCommand[];
  maxCommands?: number;
}

const MAX_BATCH_COMMANDS = 20;

/** Validate a raw batch request, throwing on invalid shape. */
export function validateBatchRequest(raw: Record<string, unknown>): BatchRequest {
  if (!Array.isArray(raw.commands) || raw.commands.length === 0) {
    throw new Error('commands is required and must be a non-empty array');
  }
  const maxCommands = typeof raw.maxCommands === 'number' ? raw.maxCommands : MAX_BATCH_COMMANDS;
  if (raw.commands.length > maxCommands) {
    throw new Error(`too many commands (max ${maxCommands})`);
  }
  const commands: BatchCommand[] = [];
  for (let i = 0; i < raw.commands.length; i++) {
    const c = raw.commands[i] as Record<string, unknown>;
    if (typeof c !== 'object' || c === null) throw new Error(`command ${i}: must be an object`);
    if (!Array.isArray(c.args) || c.args.length === 0) throw new Error(`command ${i}: args is required and must be a non-empty array`);
    const args = c.args.filter((a): a is string => typeof a === 'string');
    commands.push({ args, sensitive: c.sensitive !== false });
  }
  return { commands, maxCommands };
}

// ── Browser request envelope ──

export interface BrowserRequest {
  action: BrowserAction;
  url?: string;
  expression?: string;
  selector?: string;
  text?: string;
  x?: number;
  y?: number;
  urls?: string[];
  cookies?: unknown[];
  waitMs?: number;
  compact?: boolean;
  semanticAction?: SemanticActionRequest;
  job?: import('./browser-job.js').JobRequest;
  batch?: BatchRequest;
}

export function validateBrowserRequest(raw: Record<string, unknown>): BrowserRequest {
  const actionRaw = typeof raw.action === 'string' ? raw.action : 'status';
  if (!(BROWSER_ACTIONS as readonly string[]).includes(actionRaw)) {
    throw new Error(`Unsupported browser action: ${actionRaw}`);
  }
  const action = actionRaw as BrowserAction;

  const request: BrowserRequest = { action };

  if (typeof raw.url === 'string') request.url = raw.url.trim();
  if (typeof raw.expression === 'string') request.expression = raw.expression;
  if (typeof raw.selector === 'string') request.selector = raw.selector;
  if (typeof raw.text === 'string') request.text = raw.text;
  if (typeof raw.x === 'number') request.x = raw.x;
  if (typeof raw.y === 'number') request.y = raw.y;
  if (Array.isArray(raw.urls)) {
    const urls = raw.urls.filter((u): u is string => typeof u === 'string');
    request.urls = urls;
  }
  if (Array.isArray(raw.cookies)) request.cookies = raw.cookies;

  if (typeof raw.waitMs === 'number') request.waitMs = raw.waitMs;
  if (raw.compact === true) request.compact = true;
  if (typeof raw.semanticAction === 'object' && raw.semanticAction !== null) {
    request.semanticAction = validateSemanticActionRequest(raw.semanticAction as Record<string, unknown>);
  }
  if (typeof raw.job === 'object' && raw.job !== null) {
    request.job = validateJobRequest(raw.job as Record<string, unknown>);
  }
  if (typeof raw.batch === 'object' && raw.batch !== null) {
    request.batch = validateBatchRequest(raw.batch as Record<string, unknown>);
  }

  return request;
}
