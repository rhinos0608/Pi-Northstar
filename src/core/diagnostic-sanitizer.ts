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
  /\b([A-Za-z0-9_-]{0,128}(?:TOKEN|API_KEY|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY)[A-Za-z0-9_-]{0,128})[ \t]*[:=][ \t]*[^\s]+/gi;

function looksLikeUrlAuthorityHost(authority: string): boolean {
  let host = authority;
  const colon = authority.lastIndexOf(':');
  if (colon > 0 && /^\d{1,5}$/.test(authority.slice(colon + 1))) host = authority.slice(0, colon);
  if (host === 'localhost') return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (host.length > 253 || !/^[A-Za-z0-9.-]+$/.test(host)) return false;
  const lastDot = host.lastIndexOf('.');
  return lastDot > 0 && /^[A-Za-z]{2,63}$/.test(host.slice(lastDot + 1));
}

function scrubCookieHeaders(text: string): string {
  const header = /\b(?:Set-Cookie|Cookie)\b/gi;
  let output = '';
  let cursor = 0;

  for (let match = header.exec(text); match !== null; match = header.exec(text)) {
    let index = match.index + match[0].length;
    while (index < text.length && (text[index] === ' ' || text[index] === '\t')) index++;
    if (text[index] !== ':' && text[index] !== '=') continue;
    index++;
    while (index < text.length && (text[index] === ' ' || text[index] === '\t')) index++;

    const valueStart = index;
    while (index < text.length && !/[\s;]/.test(text[index]!)) index++;
    if (index === valueStart) continue;

    let end = index;
    while (end < text.length) {
      let next = end;
      while (next < text.length && (text[next] === ' ' || text[next] === '\t')) next++;
      if (text[next] !== ';') break;
      next++;
      while (next < text.length && (text[next] === ' ' || text[next] === '\t')) next++;
      const tokenStart = next;
      while (next < text.length && !/[\s;]/.test(text[next]!)) next++;
      if (next === tokenStart) break;
      end = next;
    }

    output += text.slice(cursor, match.index) + `${match[0]}: ***`;
    cursor = end;
    header.lastIndex = end;
  }

  return output + text.slice(cursor);
}

function scrubSensitiveQueryParameters(text: string): string {
  const isBoundary = (char: string): boolean =>
    char === '&' || char === ' ' || char === '\t' || char === '\r' || char === '\n'
    || char === '"' || char === "'" || char === '>' || char === '<';

  let output = '';
  let cursor = 0;
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '?' && text[index] !== '&') {
      index++;
      continue;
    }

    const nameStart = index + 1;
    let equals = nameStart;
    while (equals < text.length && text[equals] !== '=' && !isBoundary(text[equals]!)) equals++;
    if (text[equals] !== '=') {
      index++;
      continue;
    }

    let valueEnd = equals + 1;
    while (valueEnd < text.length && !isBoundary(text[valueEnd]!)) valueEnd++;
    const rawName = text.slice(nameStart, equals);
    let sensitive = false;
    try {
      sensitive = SENSITIVE_PARAM_NAMES.has(decodeURIComponent(rawName).toLowerCase());
    } catch {
      sensitive = true;
    }

    if (sensitive) {
      output += text.slice(cursor, equals + 1) + '***';
      cursor = valueEnd;
    }
    index = valueEnd;
  }

  return output + text.slice(cursor);
}

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

  // 2. Cookie / Set-Cookie headers: linear scan avoids regex backtracking on hostile diagnostics.
  cleaned = scrubCookieHeaders(cleaned);

  // 3. Narrow userinfo redaction
  cleaned = cleaned.replace(/(https?:\/\/)[^\/\s:@]+(?::[^\/\s@]*)?@/gi, '$1***:***@');
  cleaned = cleaned.replace(/\/\/([^\/\s@]{1,512})@([^\/\s?#]{1,255})/g, (match, _userinfo, authority) => {
    return looksLikeUrlAuthorityHost(authority) ? `//***:***@${authority}` : match;
  });

  // 4. Sensitive query parameters: linear scan normalizes names without regex backtracking.
  cleaned = scrubSensitiveQueryParameters(cleaned);

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
