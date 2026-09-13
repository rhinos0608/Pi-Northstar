// Shared Stage 2 social CLI safety primitive.
//
// Owns two focused guards for platform workers that shell out to external
// read-only CLIs (twitter-cli, opencli, xhs-cli, ...):
//   - requireCliPositional: reject blank or option-shaped positionals before
//     they reach argv (option injection: a value like `--limit` in a
//     positional slot would be parsed as a flag by the child CLI).
//   - redactCliDiagnostics: strip secret-bearing material from CLI
//     stdout/stderr before it flows into caller-visible SocialError messages.
//
// Dependency-light by design: only the SocialError/platform vocabulary from
// the shared contract. Never imports reach-tools or any worker.

import { SocialError, type SocialPlatform } from './social-contract.js';

/** Caller-visible CLI diagnostics are truncated to this many characters. */
export const MAX_CLI_DIAGNOSTIC_CHARS = 2_000;

/**
 * Require a non-blank CLI positional. Rejects values whose trimmed form
 * starts with `-` (option-shaped) with invalid_request carrying
 * platform/field context. Ordinary text — including multilingual content
 * and interior hyphens — passes through trimmed.
 */
export function requireCliPositional(
  value: unknown,
  field: string,
  platform: SocialPlatform,
): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0) {
    throw new SocialError('invalid_request', `${platform} ${field} must be a non-empty value`, {
      platform,
    });
  }
  if (text.startsWith('-')) {
    throw new SocialError(
      'invalid_request',
      `${platform} ${field} must not be option-shaped`,
      { platform },
    );
  }
  return text;
}

// Labeled secrets: generic TOKEN/SECRET/PASSWORD/COOKIE carriers (covers
// OPENCLI_TOKEN, XHS_COOKIE, xsec_token, auth_token), bare CT0, API keys,
// and standalone AUTH/BEARER/KEY. Boundary guards keep words like `author`
// or `keyboard` from matching: every alternative is fenced by a leading
// non-word lookbehind and a trailing word-boundary lookahead.
const SECRET_LABEL_PATTERN =
  /(?<![\w.-])(?:[A-Za-z0-9_]*?(?:TOKEN|SECRET|PASSWORD|COOKIE)|CT0|API[_-]?KEY|APIKEY|AUTH|BEARER|KEY)(?![\w-])\s*[:=]\s*[^\s;,]+/gi;

// Labeled cookie values run to end of line: cookie carriers hold
// semicolon-delimited `k=v` components (`XHS_COOKIE=a1=x; web_session=y`)
// and masking only the first token would leak every trailing component.
const SECRET_COOKIE_LABELED_PATTERN =
  /(?<![\w.-])(?:[A-Za-z0-9_]*?COOKIE)(?![\w-])\s*[:=]\s*[^\r\n]+/gi;

// Trailing cookie pairs: `; web_session=y` echoes after a labeled cookie.
// The pair name is unlabeled, so the generic label pattern never fires;
// mask the value of every semicolon-delimited `key=value` component.
const SECRET_COOKIE_TAIL_PATTERN = /(;\s*[\w.-]+\s*=\s*)[^\s;,]+/g;

// Percent-encoded secret labels (e.g. `xsec%5Ftoken%3D<value>`): URL-encoded
// diagnostics must not leak the value past the plain-text label pattern.
// Underscores and the `:`/`=` separator may appear as %XX (either hex case);
// keywords stay plain-text so `author`/`keyboard` guards keep working.
const SECRET_ENCODED_LABEL_PATTERN =
  /(?<![\w.-])(?:[A-Za-z0-9_]|%[0-9A-Fa-f]{2})*?(?:TOKEN|SECRET|PASSWORD|COOKIE|CT0|API[_-]?KEY|APIKEY|AUTH|BEARER|KEY)(?![\w-])(?:\s|%[0-9A-Fa-f]{2})*(?:[:=]|%3A|%3D)(?:\s|%[0-9A-Fa-f]{2})*[^\s;,]+/gi;

// Header echoes: `Authorization: ...`, `Cookie: ...`, `Set-Cookie: ...`.
// Masked to end of line: the whole header value is secret-bearing (covers
// `Bearer <token>` where the token sits past the first whitespace run).
const SECRET_HEADER_PATTERN = /(?<![\w.-])(?:Authorization|Set-Cookie|Cookie)\s*:\s*[^\r\n]+/gi;

const SECRET_PATTERNS: readonly RegExp[] = [
  SECRET_HEADER_PATTERN,
  SECRET_COOKIE_LABELED_PATTERN,
  SECRET_ENCODED_LABEL_PATTERN,
  SECRET_LABEL_PATTERN,
];

// Semicolon-delimited trailing pairs keep their `; key=` prefix so cookie
// shape stays visible while every value is masked.
function maskCookieTail(_match: string, prefix: string): string {
  return `${prefix}***`;
}

function maskMatch(match: string): string {
  const separator = match.search(/[:=]|%3A|%3D/i);
  if (separator < 0) return '***';
  const raw = match.slice(separator, separator + 3);
  const encoded = /^%3[AD]/i.test(raw) ? 3 : 1;
  return `${match.slice(0, separator + encoded)}***`;
}

/** Percent-encoded spellings of an explicitly supplied sensitive value. */
function sensitiveValueVariants(literal: string): string[] {
  const variants = new Set<string>([literal]);
  try {
    const encoded = encodeURIComponent(literal);
    variants.add(encoded);
    variants.add(encoded.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase()));
  } catch {
    // Non-encodable literal: raw form alone is the variant set.
  }
  return [...variants];
}

/**
 * Redact bounded CLI diagnostics so secret-bearing labels, header echoes,
 * and explicitly supplied sensitive values cannot reach caller-visible
 * errors. Benign text without a secret shape passes through unchanged.
 */
export function redactCliDiagnostics(text: string, sensitiveValues?: readonly string[]): string {
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, maskMatch);
  }
  SECRET_COOKIE_TAIL_PATTERN.lastIndex = 0;
  redacted = redacted.replace(SECRET_COOKIE_TAIL_PATTERN, maskCookieTail);
  if (sensitiveValues !== undefined) {
    const literals = [...sensitiveValues]
      .filter((value) => typeof value === 'string' && value.trim().length > 0)
      .sort((a, b) => b.length - a.length);
    for (const literal of literals) {
      for (const variant of sensitiveValueVariants(literal)) {
        if (variant.length > 0) redacted = redacted.split(variant).join('***');
      }
    }
  }
  return redacted.length > MAX_CLI_DIAGNOSTIC_CHARS
    ? redacted.slice(0, MAX_CLI_DIAGNOSTIC_CHARS)
    : redacted;
}
