

// ── Action union ──

import { validateJobRequest } from './browser-job.js';
import { parseLoopbackDebugTarget } from './loopback-debug-policy.js';
import { assertPublicHostname, resolvePublicHostname, type DnsLookup } from '../network-policy.js';

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
  | 'select'
  | 'wait'
  | 'get_url'
  | 'get_title'
  | 'semanticAction'
  | 'job'
  | 'batch';

export const BROWSER_ACTIONS: readonly BrowserAction[] = [
  'status', 'tabs', 'navigate', 'evaluate', 'text', 'html', 'screenshot',
  'click', 'type', 'scroll', 'close', 'cookies', 'set_cookies',
  'snapshot', 'fill', 'select', 'wait', 'get_url', 'get_title',
  'semanticAction', 'job', 'batch',
] as const;

type ObserveWhat = 'status' | 'tabs' | 'get_url' | 'get_title' | 'text' | 'html' | 'snapshot' | 'screenshot';
const OBSERVE_FIELDS: Record<ObserveWhat, readonly ('selector' | 'compact')[]> = {
  status: [], tabs: [], get_url: [], get_title: [], text: ['selector'], html: ['selector'], snapshot: ['compact'], screenshot: ['compact'],
};

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
  allowedDomains?: string[];
}

/**
 * Validate a navigation URL for browser use.
 * Rejects file:, chrome:, about:, data:, blob:, javascript:, ws:, wss:.
 * Rejects credentials in URL.
 * Rejects private/reserved IP ranges and known metadata/local hostnames.
 * Defense-in-depth: does not cover DNS rebinding, redirects, or Chromium DNS TOCTOU.
 * Container egress is the authoritative outer boundary.
 */
export function validateNavigationUrl(raw: string): string {
  const url = new URL(raw.trim());
  const protocol = url.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(`Disallowed URL scheme: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error(`URL credentials are not allowed: ${url.href}`);
  }
  assertPublicHostname(url.hostname);
  return url.href;
}

/**
 * DNS preflight: resolve hostname via system DNS and reject if any address is private/reserved.
 * Defense-in-depth — does not prevent DNS rebinding between check and connection.
 */
export async function dnsPreflight(hostname: string, signal?: AbortSignal, lookup?: DnsLookup): Promise<void> {
  await resolvePublicHostname(hostname, signal, lookup);
}

// ── Allowed domain validation ──

export function validateAllowedDomain(pattern: string): string {
  const trimmed = pattern.trim().toLowerCase();
  if (!trimmed) throw new Error('Domain pattern is required');
  if (trimmed === '*') throw new Error('Wildcard-only domain pattern (*) is not allowed');
  // Validate wildcard syntax: must be `*.` prefix or exact
  if (trimmed.startsWith('*.')) {
    const domain = trimmed.slice(2); // e.g. "example.com" from "*.example.com"
    // Require at least two labels after the `*.` prefix (e.g. "*.example.com",
    // reject "*." and "*.com") before parsing as a hostname.
    if (!domain || !domain.includes('.')) {
      throw new Error(`Invalid wildcard domain: ${pattern} — must be *.<domain.tld> (at least two labels)`);
    }
    assertPublicHostname(domain);
  } else if (!trimmed.includes('*')) {
    assertPublicHostname(trimmed);
  } else {
    throw new Error(`Invalid domain pattern: ${pattern} — only exact or *.<suffix> allowed`);
  }
  return trimmed;
}

export function freezeAllowedDomains(domains: string[]): string[] {
  const validated = domains.map(validateAllowedDomain);
  validated.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return validated;
}

/**
 * DNS validation for allowed domains: resolve each exact domain or wildcard suffix
 * and reject if any resolution includes a private/reserved address.
 */
export async function validateAllowedDomainsDns(domains: string[], signal?: AbortSignal, lookup?: DnsLookup): Promise<void> {
  for (const domain of domains) {
    if (domain.startsWith('*.')) {
      // Resolve the suffix (strip `*.` prefix)
      const suffix = domain.slice(2);
      await resolvePublicHostname(suffix, signal, lookup);
    } else {
      await resolvePublicHostname(domain, signal, lookup);
    }
  }
}

/**
 * Check if a hostname is in the allowed domains list.
 * Uses label-boundary matching for wildcards: *.example.com matches
 * sub.example.com but NOT example.com or evilexample.com.
 */
export function checkDomainAllowed(hostname: string, allowedDomains: string[]): boolean {
  const h = hostname.toLowerCase();
  for (const pattern of allowedDomains) {
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // .example.com
      // Wildcard requires at least one label before suffix; suffix starts with '.'.
      if (h.length > suffix.length && h.endsWith(suffix)) return true;
    } else {
      if (h === pattern) return true;
    }
  }
  return false;
}

// ── Input bounds ──

export const MAX_SELECTOR_LENGTH = 500;
export const MAX_TEXT_LENGTH = 10_000;
export const MAX_EXPRESSION_LENGTH = 50_000;
export const MAX_URL_LENGTH = 8_000;
export const MAX_COOKIES = 500;
export const MAX_SCROLL_COORD = 100_000;
export const MAX_WAIT_MS = 120_000;
export const MAX_SELECT_VALUES = 32;

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

export function validateScrollCoord(value: unknown, name: string): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`invalid_request: ${name} must be a finite number`);
  }
  if (value < -MAX_SCROLL_COORD || value > MAX_SCROLL_COORD) {
    throw new Error(`invalid_request: ${name} out of range (max absolute ${MAX_SCROLL_COORD})`);
  }
  return value;
}

export function validateWaitMs(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('invalid_request: waitMs must be a finite number');
  }
  if (value < 0 || value > MAX_WAIT_MS) {
    throw new Error(`invalid_request: waitMs out of range (max ${MAX_WAIT_MS})`);
  }
  return value;
}

// ── Semantic action types (Component 9) ──

export type SemanticLocator = 'role' | 'text' | 'label' | 'placeholder' | 'alt' | 'title' | 'testid' | 'first' | 'last' | 'nth';
// find action set verified against agent-browser 0.37.1 (`find --help`):
// click, fill, check, hover, text. Anything else fails at the CLI with
// "Unknown action", so reject it here with a nameable validation error.
export type SemanticVerb = 'click' | 'fill' | 'check' | 'hover' | 'text';

export interface SemanticActionRequest {
  locator: SemanticLocator;
  query: string;
  verb: SemanticVerb;
  name?: string;
  index?: number;
  value?: string;
  exact?: boolean;
}

export const VALID_LOCATORS: readonly SemanticLocator[] = ['role', 'text', 'label', 'placeholder', 'alt', 'title', 'testid', 'first', 'last', 'nth'];
export const VALID_VERBS: readonly SemanticVerb[] = ['click', 'fill', 'check', 'hover', 'text'];
/** Canonical semantic vocabulary for later strict schema generation. Aliases of VALID_*; keep in sync. */
export const SEMANTIC_LOCATORS: readonly SemanticLocator[] = VALID_LOCATORS;
export const SEMANTIC_VERBS: readonly SemanticVerb[] = VALID_VERBS;
/** Closed field set for a semanticAction object. Unknown fields reject. */
export const SEMANTIC_ACTION_ALLOWED_FIELDS: readonly string[] = [
  'locator', 'query', 'verb', 'name', 'index', 'value', 'exact',
] as const;
const VALUE_VERBS = new Set<SemanticVerb>(['fill']);

/** Validate a raw semantic action request, throwing on invalid shape. */
export function validateSemanticActionRequest(raw: Record<string, unknown>): SemanticActionRequest {
  const locator = typeof raw.locator === 'string' ? raw.locator.trim() : '';
  if (!locator || !(VALID_LOCATORS as readonly string[]).includes(locator)) {
    throw new Error(`locator is required and must be one of: ${VALID_LOCATORS.join(', ')}`);
  }
  const query = typeof raw.query === 'string' ? raw.query.trim() : '';
  if (!query) throw new Error('query is required');
  if (query.length > MAX_TEXT_LENGTH) throw new Error(`query too long (max ${MAX_TEXT_LENGTH} chars)`);
  const verb = typeof raw.verb === 'string' ? raw.verb.trim() : '';
  if (!verb || !(VALID_VERBS as readonly string[]).includes(verb)) {
    throw new Error(`verb is required and must be one of: ${VALID_VERBS.join(', ')}`);
  }
  for (const key of Object.keys(raw)) {
    if (!(SEMANTIC_ACTION_ALLOWED_FIELDS as readonly string[]).includes(key)) {
      throw new Error(`unknown field: ${key}`);
    }
  }
  if (locator === 'nth') {
    if (typeof raw.index !== 'number' || !Number.isFinite(raw.index)) {
      throw new Error('index is required when locator is nth');
    }
    if (!Number.isInteger(raw.index) || (raw.index as number) < 0) {
      throw new Error('index must be a nonnegative integer when locator is nth');
    }
  } else if (raw.index !== undefined) {
    throw new Error('index is only allowed when locator is nth');
  }
  if (VALUE_VERBS.has(verb as SemanticVerb)) {
    if (raw.value === undefined || typeof raw.value !== 'string') {
      throw new Error(`value is required when verb is ${verb}`);
    }
  } else if (raw.value !== undefined) {
    throw new Error('value is only allowed when verb is fill');
  }
  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string') throw new Error('name must be a non-empty string');
    if (raw.name.trim().length === 0) throw new Error('name must be a non-empty string');
    if (locator !== 'role') throw new Error('name is only allowed when locator is role');
    if (raw.name.trim().length > MAX_TEXT_LENGTH) throw new Error(`name too long (max ${MAX_TEXT_LENGTH} chars)`);
  }
  if (raw.exact !== undefined && typeof raw.exact !== 'boolean') {
    throw new Error('exact must be a boolean');
  }

  const req: SemanticActionRequest = { locator: locator as SemanticLocator, query, verb: verb as SemanticVerb };
  if (typeof raw.name === 'string' && raw.name.trim()) req.name = raw.name.trim();
  if (typeof raw.index === 'number') req.index = raw.index;
  if (typeof raw.value === 'string') {
    if (raw.value.length > MAX_TEXT_LENGTH) throw new Error(`value too long (max ${MAX_TEXT_LENGTH} chars)`);
    req.value = raw.value;
  }
  if (raw.exact === true) req.exact = true;
  return req;
}

// ── Batch types (Component 11) ──

/**
 * Batch subcommands the adapter is authorized to pipe to `agent-browser batch`
 * stdin. Anything else (session lifecycle, screenshots, network/storage/mouse
 * primitives, unknown verbs) is rejected at validation time — before any
 * session is created or child process spawned — so raw argv can never tunnel
 * underneath the policy layer. Keep in sync with the CLI verbs dispatched by
 * `src/agent-browser.ts` (open, eval, read, get, click, type, fill, scroll,
 * tab, cookies, snapshot, select, wait, find).
 */
export const SUPPORTED_BATCH_SUBCOMMANDS = [
  'open', 'navigate', 'eval', 'read', 'get', 'click', 'type', 'fill',
  'scroll', 'tab', 'cookies', 'snapshot', 'select', 'wait', 'find',
] as const;
export type BatchSubcommand = typeof SUPPORTED_BATCH_SUBCOMMANDS[number];
export const BATCH_SUBCOMMANDS: readonly BatchSubcommand[] = SUPPORTED_BATCH_SUBCOMMANDS;


export interface BatchCommand {
  args: string[];
  sensitive?: boolean;
  /** Normalized subcommand (args[0], lowercased), populated by validateBatchRequest. */
  subcommand: BatchSubcommand;
}

export interface BatchRequest {
  commands: BatchCommand[];
  maxCommands?: number;
}

export const MAX_BATCH_COMMANDS = 20;

/** Stable allowlist-miss prefix asserted by policy tests; keep greppable. */
export const BATCH_SUBCOMMAND_ERROR_PREFIX = 'unsupported batch subcommand';

/** Normalize args[0] against the allowlist, throwing with the command index. */
export function parseBatchSubcommand(index: number, raw: string): BatchSubcommand {
  const sub = raw.toLowerCase();
  if ((SUPPORTED_BATCH_SUBCOMMANDS as readonly string[]).includes(sub)) return sub as BatchSubcommand;
  throw new Error(`command ${index}: ${BATCH_SUBCOMMAND_ERROR_PREFIX}: '${raw}' (supported: ${SUPPORTED_BATCH_SUBCOMMANDS.join(', ')})`);
}

/** Arity guard shared by per-subcommand validators below. */
function checkBatchArity(index: number, sub: string, args: string[], min: number, max: number): void {
  if (args.length < min || args.length > max) {
    throw new Error(`command ${index}: ${sub} requires ${min === max ? `exactly ${min}` : `${min} to ${max}`} args (got ${args.length})`);
  }
}

/**
 * Strict argv typing per batch subcommand. Reuses the canonical validators
 * (validateSelector/validateText/validateExpression/validateWaitMs/bounds)
 * so batch cannot smuggle values that single actions would reject. Navigation
 * URLs get a shape check here only — full SSRF validation + DNS preflight +
 * domain freeze stay authoritative in preflightNavigationTarget, which prefixes
 * failures with the command index.
 */
export function validateBatchCommandArgs(index: number, sub: BatchSubcommand, args: string[]): void {
  switch (sub) {
    case 'open':
    case 'navigate':
      checkBatchArity(index, sub, args, 2, 2);
      if (args[1]!.length === 0 || args[1]!.length > MAX_URL_LENGTH) {
        throw new Error(`command ${index}: ${sub} URL must be 1 to ${MAX_URL_LENGTH} characters`);
      }
      return;
    case 'eval':
      checkBatchArity(index, sub, args, 2, 2);
      validateExpression(args[1]!);
      return;
    case 'read':
      checkBatchArity(index, sub, args, 1, 2);
      return;
    case 'get':
      checkBatchArity(index, sub, args, 2, 3);
      if (args[1]!.length === 0) throw new Error(`command ${index}: get requires a target (text, title, url, ...)`);
      return;
    case 'click':
      checkBatchArity(index, sub, args, 2, 2);
      validateSelector(args[1]!);
      return;
    case 'type':
    case 'fill':
      checkBatchArity(index, sub, args, 3, 3);
      validateSelector(args[1]!);
      validateText(args[2]!);
      return;
    case 'scroll': {
      checkBatchArity(index, sub, args, 2, 3);
      const dir = args[1]!.toLowerCase();
      if (dir !== 'up' && dir !== 'down' && dir !== 'left' && dir !== 'right') {
        throw new Error(`command ${index}: scroll direction must be one of up, down, left, right`);
      }
      if (args[2] !== undefined) {
        const px = Number(args[2]);
        if (!Number.isFinite(px)) throw new Error(`command ${index}: scroll px must be a finite number`);
        validateScrollCoord(px, 'px');
      }
      return;
    }
    case 'tab':
      checkBatchArity(index, sub, args, 2, 3);
      if (args[1]!.length === 0) throw new Error(`command ${index}: tab requires an action (list)`);
      // `tab new <url>` carries a navigation target: shape-check the URL here
      // (full SSRF validation + DNS preflight run in preflightNavigationTarget).
      if (args[1]!.toLowerCase() === 'new' && args[2] !== undefined) {
        if (args[2].length === 0 || args[2].length > MAX_URL_LENGTH) {
          throw new Error(`command ${index}: tab new URL must be 1 to ${MAX_URL_LENGTH} characters`);
        }
      }
      return;
    case 'cookies': {
      checkBatchArity(index, sub, args, 2, 16);
      const op = args[1]!.toLowerCase();
      if (op !== 'get' && op !== 'set' && op !== 'clear') {
        throw new Error(`command ${index}: cookies operation must be one of get, set, clear`);
      }
      if (op === 'set' && args.length < 4) {
        throw new Error(`command ${index}: cookies set requires a name and value`);
      }
      if (op === 'set' && args[2]!.length === 0) {
        throw new Error(`command ${index}: cookies set requires a non-empty name`);
      }
      return;
    }
    case 'snapshot':
      checkBatchArity(index, sub, args, 1, 4);
      for (const flag of args.slice(1)) {
        if (!flag.startsWith('-')) throw new Error(`command ${index}: snapshot only accepts flags (got '${flag}')`);
      }
      return;
    case 'select': {
      checkBatchArity(index, sub, args, 3, 2 + MAX_SELECT_VALUES);
      validateSelector(args[1]!);
      for (const v of args.slice(2)) validateText(v);
      return;
    }
    case 'wait':
      checkBatchArity(index, sub, args, 2, 3);
      if (args[1] === '--text') {
        if (args[2] === undefined) throw new Error(`command ${index}: wait --text requires a text argument`);
        validateText(args[2]);
        return;
      }
      if (args[1] !== undefined && args[1] !== '' && Number.isFinite(Number(args[1])) && args[1].trim() !== '') {
        validateWaitMs(Number(args[1]));
        return;
      }
      validateSelector(args[1]!);
      return;
    case 'find': {
      checkBatchArity(index, sub, args, 4, 9);
      if (!(VALID_LOCATORS as readonly string[]).includes(args[1]!)) {
        throw new Error(`command ${index}: find locator must be one of ${VALID_LOCATORS.join(', ')}`);
      }
      const isNth = args[1] === 'nth';
      if (isNth && !Number.isInteger(Number(args[2]))) {
        throw new Error(`command ${index}: find nth requires a numeric index`);
      }
      const query = args[isNth ? 3 : 2]!;
      if (query.length === 0 || query.length > MAX_TEXT_LENGTH) {
        throw new Error(`command ${index}: find query must be 1 to ${MAX_TEXT_LENGTH} characters`);
      }
      const verb = args[isNth ? 4 : 3]!;
      if (!(VALID_VERBS as readonly string[]).includes(verb)) {
        throw new Error(`command ${index}: find verb must be one of ${VALID_VERBS.join(', ')}`);
      }
      return;
    }
  }
}

/** Validate a raw batch request, throwing on invalid shape. */
export function validateBatchRequest(raw: Record<string, unknown>): BatchRequest {
  if (!Array.isArray(raw.commands) || raw.commands.length === 0) {
    throw new Error('commands is required and must be a non-empty array');
  }
  if (
    raw.maxCommands !== undefined &&
    (typeof raw.maxCommands !== 'number' || !Number.isInteger(raw.maxCommands) || raw.maxCommands < 1)
  ) {
    throw new Error('maxCommands must be a positive integer');
  }
  const callerMax = typeof raw.maxCommands === 'number' ? raw.maxCommands : MAX_BATCH_COMMANDS;
  // Hard cap: caller may not exceed the built-in constant
  const maxCommands = Math.min(callerMax, MAX_BATCH_COMMANDS);
  if (raw.commands.length > maxCommands) {
    throw new Error(`too many commands (max ${maxCommands})`);
  }
  const commands: BatchCommand[] = [];
  for (let i = 0; i < raw.commands.length; i++) {
    const c = raw.commands[i] as Record<string, unknown>;
    if (typeof c !== 'object' || c === null) throw new Error(`command ${i}: must be an object`);
    if (!Array.isArray(c.args) || c.args.length === 0) throw new Error(`command ${i}: args is required and must be a non-empty array`);
    for (const a of c.args) {
      if (typeof a !== 'string') throw new Error(`command ${i}: args must be an array of strings`);
    }
    const rawArgs = c.args as string[];
    const subcommand = parseBatchSubcommand(i, rawArgs[0]!);
    validateBatchCommandArgs(i, subcommand, rawArgs);
    const args = [...rawArgs];
    args[0] = subcommand;
    commands.push({ args, sensitive: c.sensitive !== false, subcommand });
  }
  validateNoLoopbackInBatch(commands);
  return { commands, maxCommands };
}

/** Extract the navigation URL carried by a batch command, if any: the URL
 * arg of `open`/`navigate`, or the URL arg of `tab new <url>`. Centralizes
 * the navigation-target shape so preflight and loopback rejection cannot
 * drift apart when new navigation-carrying subcommands are added. */
export function batchNavigationUrl(cmd: BatchCommand): string | undefined {
  const action = cmd.args[0]?.toLowerCase();
  if (action === 'open' || action === 'navigate') {
    return typeof cmd.args[1] === 'string' ? cmd.args[1] : undefined;
  }
  if (action === 'tab' && cmd.args[1]?.toLowerCase() === 'new' && typeof cmd.args[2] === 'string') {
    return cmd.args[2];
  }
  return undefined;
}

/** True when a navigation URL carries embedded credentials (userinfo),
 * as opposed to a bare `@` in a path, query, or fragment. Unparseable
 * (relative) URLs cannot carry userinfo, so they pass. */
function batchUrlHasCredentials(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.username.length > 0 || parsed.password.length > 0;
  } catch {
    return false;
  }
}

/** Reject batch commands containing loopback URLs in navigation args
 * (`open`/`navigate` URL arg, `tab new <url>`). */
export function validateNoLoopbackInBatch(commands: BatchCommand[]): void {
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i]!;
    const url = batchNavigationUrl(cmd);
    if (url !== undefined) {
      if (batchUrlHasCredentials(url)) {
        throw new Error(
          `command ${i}: URL with credentials is not allowed in batch commands.`,
        );
      }
      if (parseLoopbackDebugTarget(url)) {
        throw new Error(
          `command ${i}: loopback URL '${url}' is not allowed in batch commands. Use a single navigate action instead.`,
        );
      }
    }
  }
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
  values?: string[];
  compact?: boolean;
  semanticAction?: SemanticActionRequest;
  job?: import('./browser-job.js').JobRequest;
  batch?: BatchRequest;
}

export function validateBrowserRequest(raw: Record<string, unknown>): BrowserRequest {
  const actionRaw = typeof raw.action === 'string' ? raw.action : typeof raw.what === 'string' ? raw.what : 'status';
  if (!(BROWSER_ACTIONS as readonly string[]).includes(actionRaw)) {
    throw new Error(`Unsupported browser action: ${actionRaw}`);
  }
  if (typeof raw.what === 'string') {
    const allowed = OBSERVE_FIELDS[actionRaw as ObserveWhat] ?? [];
    if (raw.selector !== undefined && !allowed.includes('selector')) throw new Error(`selector is not allowed for observe what '${actionRaw}'`);
    if (raw.compact !== undefined && !allowed.includes('compact')) throw new Error(`compact is not allowed for observe what '${actionRaw}'`);
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
  if (Array.isArray(raw.values)) {
    if (!raw.values.every((v): v is string => typeof v === 'string')) throw new Error('values must be an array of strings');
    request.values = [...raw.values];
  }
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
