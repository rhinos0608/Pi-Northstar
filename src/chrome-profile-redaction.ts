// Chrome profile output redaction (Worker 1).
//
// Pure string guards for the user-Chrome path. No network, no disk, no
// Pi-runtime imports. Applies AFTER the action allowlist (evaluate/html/
// cookies/batch/storage/network/console are denied before output), as
// defense-in-depth against bearer-material echo in results, errors, and
// diagnostics.
//
// Forbidden in user-Chrome text/details/logs:
// cookie values, storage, raw HTML, Authorization/Cookie/Set-Cookie headers,
// bodies, form values, typed echo, nonce/grant ids, screenshot base64.

export const CHROME_REDACTED = '[redacted]';

/** Shared minimum secret length: shorter fragments are skipped to avoid over-redaction. */
const CHROME_MIN_SECRET_LEN = 4;

const GRANT_ID_PATTERN = /\bgrant-[a-z0-9-]{4,}\b/gi;
const SESSION_KEY_PATTERN = /\bsession-?key\b\s*[:=]\s*['"]?[a-z0-9-_.]{4,}['"]?/gi;
const NONCE_PATTERN = /\bnonce\b\s*[:=]\s*['"]?[a-z0-9-_.+/=]{4,}['"]?/gi;
const COOKIE_VALUE_PATTERN = /(cookie|set-cookie)(\s*[:=]\s*)([^\s;,\n]+)/gi;
const AUTHORIZATION_PATTERN = /(authorization)(\s*[:=]\s*)([^\n]+)/gi;
const BEARER_PATTERN = /\b(bearer)\s+([a-z0-9\-._~+/=]+)/gi;
const FORM_VALUE_PATTERN = /(form[-_ ]?value|typed[-_ ]?value|input[-_ ]?value)(\s*[:=]\s*)([^\s\n]+)/gi;
const BASE64_RUN_PATTERN = /[A-Za-z0-9+/]{200,}={0,2}/g;

export interface ChromeRedactionSecrets {
  sessionKey?: string | undefined;
  grantId?: string | undefined;
  nonce?: string | undefined;
  instanceId?: string | undefined;
  typedValues?: string[] | undefined;
}

/** Redact secret-bearing text. Never returns secret values verbatim. */
export function redactChromeProfileText(input: string, secrets?: ChromeRedactionSecrets): string {
  let out = input;
  if (secrets?.sessionKey && secrets.sessionKey.length >= CHROME_MIN_SECRET_LEN) {
    out = out.split(secrets.sessionKey).join(CHROME_REDACTED);
  }
  if (secrets?.grantId && secrets.grantId.length >= CHROME_MIN_SECRET_LEN) {
    out = out.split(secrets.grantId).join(CHROME_REDACTED);
  }
  if (secrets?.nonce && secrets.nonce.length >= CHROME_MIN_SECRET_LEN) {
    out = out.split(secrets.nonce).join(CHROME_REDACTED);
  }
  if (secrets?.instanceId && secrets.instanceId.length >= CHROME_MIN_SECRET_LEN) {
    out = out.split(secrets.instanceId).join(CHROME_REDACTED);
  }
  if (secrets?.typedValues) {
    for (const typed of secrets.typedValues) {
      if (typed.length >= CHROME_MIN_SECRET_LEN) out = out.split(typed).join(CHROME_REDACTED);
    }
  }
  out = out
    .replace(GRANT_ID_PATTERN, CHROME_REDACTED)
    .replace(SESSION_KEY_PATTERN, `session-key: ${CHROME_REDACTED}`)
    .replace(NONCE_PATTERN, `nonce: ${CHROME_REDACTED}`)
    .replace(COOKIE_VALUE_PATTERN, `$1$2${CHROME_REDACTED}`)
    .replace(AUTHORIZATION_PATTERN, `$1$2${CHROME_REDACTED}`)
    .replace(BEARER_PATTERN, `$1 ${CHROME_REDACTED}`)
    .replace(FORM_VALUE_PATTERN, `$1$2${CHROME_REDACTED}`)
    .replace(BASE64_RUN_PATTERN, CHROME_REDACTED);
  return out;
}

/** True when text still carries any known secret verbatim. */
export function chromeProfileTextLeaksSecret(text: string, secrets: ChromeRedactionSecrets): boolean {
  const candidates = [
    secrets.sessionKey,
    secrets.grantId,
    secrets.nonce,
    secrets.instanceId,
    ...(secrets.typedValues ?? []),
  ].filter((v): v is string => typeof v === 'string' && v.length >= CHROME_MIN_SECRET_LEN);
  return candidates.some((secret) => text.includes(secret));
}

/** Redact a snapshot node tree string (form values already redacted upstream). */
export function redactChromeProfileSnapshot(snapshot: string, secrets?: ChromeRedactionSecrets): string {
  return redactChromeProfileText(snapshot, secrets);
}

/**
 * Build a safe error message: strips typed echo, grant material, header
 * values, and long base64 runs. Falls back to a generic message when the
 * template itself is secret-shaped.
 */
export function safeChromeProfileErrorMessage(message: string, secrets?: ChromeRedactionSecrets): string {
  const redacted = redactChromeProfileText(message, secrets).slice(0, 500);
  if (redacted.trim().length === 0) return 'user-chrome operation failed';
  return redacted;
}
