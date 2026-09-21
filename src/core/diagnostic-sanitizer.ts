export const DIAGNOSTIC_MESSAGE_MAX_CHARS = 500;

/** Truncate UTF-8 text to a byte bound without splitting a code point. */
export function truncateUtf8Bytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) {
    end--;
  }
  return bytes.subarray(0, end).toString('utf8');
}

const SENSITIVE_PARAM_NAMES: ReadonlySet<string> = new Set([
  'token',
  'access_token',
  'api_key',
  'key',
  'secret',
  'password',
  'sig',
  'signature',
  'credential',
]);

const COMMON_CREDENTIAL_LABEL_REGEX =
  /\b([A-Za-z0-9_-]*(?:TOKEN|API_KEY|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY)[A-Za-z0-9_-]*)\s*[:=]\s*\S+/gi;

/**
 * Scrub secrets (headers, cookies, URL userinfo, sensitive query params, credential labels)
 * across text without truncating/reducing its length.
 */
export function scrubDiagnosticSecrets(text: string): string {
  if (!text) return '';
  let cleaned = text;

  // 1. Authorization / Proxy-Authorization header values (Bearer, Basic, token, or generic)
  cleaned = cleaned.replace(/(?:Proxy-)?Authorization\s*[:=]\s*(?:(?:Bearer|Basic|token)\s+)?\S+/gi, (match) => {
    const sep = match.search(/[=:]\s*/);
    const prefix = match.slice(0, sep + 1);
    const delim = prefix.endsWith(' ') ? '' : ' ';
    return `${prefix}${delim}***`;
  });

  // 2. Cookie / Set-Cookie headers: scrub cookie pair(s) e.g. foo=bar; baz=qux
  cleaned = cleaned.replace(/(?:Set-Cookie|Cookie)\s*[:=]\s*(?:[A-Za-z0-9_.-]+=[^;\r\n\s]+(?:\s*;\s*)?)+/gi, (match) => {
    const sep = match.search(/[=:]\s*/);
    const prefix = match.slice(0, sep + 1);
    const delim = prefix.endsWith(' ') ? '' : ' ';
    return `${prefix}${delim}***`;
  });

  // 3. Narrow userinfo redaction
  cleaned = cleaned.replace(/(https?:\/\/)[^\/\s:@]+(?::[^\/\s@]*)?@/gi, '$1***:***@');
  cleaned = cleaned.replace(/(\/\/[^\/\s:@]+(?::[^\/\s@]*)?@)(?=[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?::\d+)?(?:[\/\s?]|$)|localhost(?::\d+)?(?:[\/\s?]|$)|(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:[\/\s?]|$))/gi, () => {
    return '//***:***@';
  });

  // 4. Sensitive query parameters: parse/normalize query parameter names before matching
  cleaned = cleaned.replace(/([?&])([^=&\s"'>]+)=([^&\s"'>]*)/g, (match, prefix, rawName) => {
    let normalizedName = rawName;
    try {
      normalizedName = decodeURIComponent(rawName).toLowerCase();
    } catch {
      return `${prefix}${rawName}=***`;
    }
    if (SENSITIVE_PARAM_NAMES.has(normalizedName)) {
      return `${prefix}${rawName}=***`;
    }
    return match;
  });

  // 5. Common credential labels (e.g. GITHUB_TOKEN=xyz, MY_SECRET: abc)
  cleaned = cleaned.replace(COMMON_CREDENTIAL_LABEL_REGEX, '$1=***');

  return cleaned;
}

/**
 * Diagnostic message sanitizer for operational/error strings before emission.
 * Removes headers, full cookies, URL userinfo, sensitive query param values,
 * credential labels, and UTF-8 bounds the output to maxBytes (default 500).
 * Does NOT alter general page text or markdown structures.
 */
export function sanitizeDiagnosticMessage(message: string, maxBytes = DIAGNOSTIC_MESSAGE_MAX_CHARS): string {
  if (!message) return '';
  const cleaned = scrubDiagnosticSecrets(message);
  return truncateUtf8Bytes(cleaned, maxBytes);
}
