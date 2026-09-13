/**
 * Shared link extraction helpers used in native-tools and tests.
 */

export const BINARY_EXTENSIONS = new Set([
  '.pdf', '.zip', '.gz', '.tar', '.rar', '.7z', '.exe', '.dmg', '.pkg',
  '.deb', '.rpm', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
  '.bmp', '.tiff', '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm',
  '.ogg', '.wav', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.doc', '.docx',
  '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.json', '.xml', '.yaml', '.yml',
  '.bin', '.dat', '.so', '.dll', '.dylib',
]);

/**
 * Extract http/https links from <a href="..."> elements in HTML.
 * Accepts quoted (double/single) and valid unquoted href values.
 * Strips fragments, excludes binary extensions, resolves relative URLs.
 */
export function extractLinksFromHtml(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  const anchorRegex = /<a\s+[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"'`=]+))[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorRegex.exec(html)) !== null) {
    const href = match[1] ?? match[2] ?? match[3] ?? '';
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) continue;
    try {
      const resolved = new URL(href, baseUrl);
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
      resolved.hash = '';
      const ext = resolved.pathname.toLowerCase().split('.').pop();
      if (ext && BINARY_EXTENSIONS.has(`.${ext}`)) continue;
      links.push(resolved.href);
    } catch {
      // Skip malformed URLs
    }
  }
  return links;
}

/**
 * Check whether url belongs to rootHost (www-prefix-insensitive).
 */
export function sameDomain(url: string, rootHost: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host === rootHost;
  } catch {
    return false;
  }
}
