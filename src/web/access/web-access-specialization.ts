// Pi Web Access final: internal fetch specialization router.
//
// Pure URL classification only: no provider imports, no tool imports, no
// network. The separate `github` / `media` tools are never modified or called
// here; fetch injects their readers and this module only decides order.
// `feed` covers RSS/Atom endpoint hints; `pdf` covers `.pdf` paths (content
// type handled by `isPdfUrl` at the fetch site).

export type WebAccessReaderKind = 'github' | 'media' | 'feed' | 'pdf' | 'page';

function hostnameOf(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.length > 0 ? host : undefined;
  } catch {
    return undefined;
  }
}

/** Classify a URL to its internal reader. Unparseable URLs are plain pages. */
export function selectWebAccessReaderKind(url: string): WebAccessReaderKind {
  const host = hostnameOf(url);
  if (host !== undefined) {
    if (host === 'github.com' || host.endsWith('.github.com') || host === 'githubusercontent.com' || host.endsWith('.githubusercontent.com')) return 'github';
    if (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com')) return 'media';
  }
  let path = '';
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    path = url.trim().toLowerCase().split(/[?#]/)[0] ?? '';
  }
  if (path.endsWith('.pdf')) return 'pdf';
  if (
    path.endsWith('/feed') ||
    path.endsWith('/feed.xml') ||
    path.endsWith('/rss.xml') ||
    path.endsWith('.rss') ||
    path.endsWith('.atom') ||
    (!path.endsWith('sitemap.xml') && path.endsWith('.xml')) ||
    path.includes('/rss') ||
    path.includes('/atom') ||
    path.includes('/feed/')
  ) {
    return 'feed';
  }
  return 'page';
}
