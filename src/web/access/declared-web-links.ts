// Declared-links appendix: Link-header + HTML `rel` allowlist discovery.
//
// Atlas has no DOM dependency in the fetch path, so `link[rel][href]` /
// `a[rel][href]` extraction is dependency-free string scanning (same regex
// technique as link-extraction.ts), plus `<base href>` resolution.
// Link-header parsing (splitOutsideSyntax, parseLinkParameters) is a pure
// string port of the reference implementation.
//
// Native/bridge results keep `rawHtml`; Diffbot/external results have no
// HTML, so the appendix is skipped for those paths (no HTML to scan).

export const MAX_DECLARED_LINKS = 20;
const MAX_DECLARED_URL_LENGTH = 4096;

const DECLARATION_RELATIONS = new Set([
  'api-catalog',
  'describedby',
  'service-desc',
  'service-doc',
  'service-meta',
]);

const RELATION_LABELS: Record<string, string> = {
  'api-catalog': 'API catalog',
  describedby: 'Description',
  'service-desc': 'Service description',
  'service-doc': 'Service documentation',
  'service-meta': 'Service metadata',
};

export interface DeclaredWebLink {
  url: string;
  relations: string[];
  type?: string | undefined;
}

export function discoverDeclaredWebLinks(
  html: string,
  linkHeader: string | null,
  responseUrl: string,
): DeclaredWebLink[] {
  const links = new Map<string, DeclaredWebLink>();
  for (const value of splitLinkHeader(linkHeader ?? '')) {
    const target = /^\s*<([^>]*)>/.exec(value);
    if (!target) continue;
    const parameters = parseLinkParameters(value.slice(target[0].length));
    if (!parameters || parameters.has('anchor')) continue;
    addDeclaredLink(links, {
      url: resolveHttpUrl(target[1], responseUrl),
      relations: declaredRelations(parameters.get('rel')),
      type: parameters.get('type'),
    });
    if (links.size >= MAX_DECLARED_LINKS) break;
  }

  if (links.size < MAX_DECLARED_LINKS) {
    const declaredBase = extractBaseHref(html);
    const documentBase = resolveHttpUrl(declaredBase, responseUrl) ?? responseUrl;
    for (const tag of scanRelHrefTags(html)) {
      addDeclaredLink(links, {
        url: resolveHttpUrl(tag.href, documentBase),
        relations: declaredRelations(tag.rel),
        type: tag.type,
      });
      if (links.size >= MAX_DECLARED_LINKS) break;
    }
  }

  return [...links.values()];
}

export function appendDeclaredWebLinks(content: string, links: DeclaredWebLink[]): string {
  if (links.length === 0) return content;
  const section = [
    '## Declared links',
    '',
    ...links.map(formatDeclaredLink),
  ].join('\n');
  return content.trim() ? `${content.trim()}\n\n${section}` : section;
}

function addDeclaredLink(
  links: Map<string, DeclaredWebLink>,
  candidate: { url: string | null; relations: string[]; type?: string | null | undefined },
): void {
  if (!candidate.url || candidate.relations.length === 0) return;
  const existing = links.get(candidate.url);
  if (existing) {
    for (const relation of candidate.relations) {
      if (!existing.relations.includes(relation)) existing.relations.push(relation);
    }
    if (existing.type === undefined) {
      const merged = normalizeMetadata(candidate.type);
      if (merged !== undefined) existing.type = merged;
    }
    return;
  }
  if (links.size >= MAX_DECLARED_LINKS) return;
  const type = normalizeMetadata(candidate.type);
  links.set(candidate.url, {
    url: candidate.url,
    relations: candidate.relations,
    ...(type !== undefined ? { type } : {}),
  });
}

function declaredRelations(value: string | null | undefined): string[] {
  if (!value) return [];
  return [...new Set(
    value.trim().toLowerCase().split(/\s+/).filter((relation) => DECLARATION_RELATIONS.has(relation)),
  )];
}

function resolveHttpUrl(value: string | null | undefined, baseUrl: string): string | null {
  if (!value || value.length > MAX_DECLARED_URL_LENGTH) return null;
  try {
    const url = new URL(value, baseUrl);
    if (url.href.length > MAX_DECLARED_URL_LENGTH) return null;
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

interface RelHrefTag {
  href: string;
  rel: string | null;
  type: string | null;
}

const BS = String.fromCharCode(92);
const DQ = String.fromCharCode(34);
const SQ = String.fromCharCode(39);
const BT = String.fromCharCode(96);

function buildAttrRegex(name: string): RegExp {
  const escaped = name.replace(/[^A-Za-z0-9_-]/g, (m) => BS + m);
  const boundary = '(?:^|[^A-Za-z0-9_:.' + BS + '-])';
  const value = '(?:' + DQ + '([^' + DQ + ']*)' + DQ + '|' + SQ + '([^' + SQ + ']*)' + SQ + '|([^' + BS + 's>' + DQ + SQ + BT + '=]+))';
  return new RegExp(boundary + escaped + BS + 's*=' + BS + 's*' + value, 'i');
}

const REL_ATTR_REGEX = buildAttrRegex('rel');
const HREF_ATTR_REGEX = buildAttrRegex('href');
const TYPE_ATTR_REGEX = buildAttrRegex('type');

function extractAttr(tag: string, name: string): string | null {
  const regex =
    name === 'rel' ? REL_ATTR_REGEX : name === 'href' ? HREF_ATTR_REGEX : name === 'type' ? TYPE_ATTR_REGEX : buildAttrRegex(name);
  const match = regex.exec(tag);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

function extractBaseHref(html: string): string | null {
  const match = /<base\s+[^>]*>/i.exec(html);
  if (!match) return null;
  return extractAttr(match[0], 'href');
}

function scanRelHrefTags(html: string): RelHrefTag[] {
  const tags: RelHrefTag[] = [];
  const tagRegex = /<(link|a)\s+[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(html)) !== null) {
    const tag = match[0];
    const rel = extractAttr(tag, 'rel');
    const href = extractAttr(tag, 'href');
    if (rel === null || href === null) continue;
    tags.push({ href, rel, type: extractAttr(tag, 'type') });
  }
  return tags;
}

function splitOutsideSyntax(input: string, separator: string, protectTargets: boolean): string[] | null {
  const parts: string[] = [];
  let start = 0;
  let inTarget = false;
  let inQuotes = false;
  let escaped = false;
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (inQuotes) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inQuotes = false;
      continue;
    }
    if (character === '"' && !inTarget) inQuotes = true;
    else if (protectTargets && character === '<') inTarget = true;
    else if (protectTargets && character === '>') inTarget = false;
    else if (character === separator && !inTarget) {
      parts.push(input.slice(start, index));
      start = index + 1;
    }
  }
  if (inQuotes || inTarget) return null;
  parts.push(input.slice(start));
  return parts;
}

function splitLinkHeader(header: string): string[] {
  return (splitOutsideSyntax(header, ',', true) ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseLinkParameters(input: string): Map<string, string> | null {
  const parts = splitOutsideSyntax(input, ';', false);
  if (!parts || parts.shift()?.trim()) return null;

  const parameters = new Map<string, string>();
  for (const part of parts) {
    const match = /^\s*([!#$%&'*+\-.^_`|~A-Za-z0-9]+)(?:\s*=\s*(?:"((?:\\.|[^"])*)"|(\S+)))?\s*$/.exec(part);
    if (!match) return null;
    const name = (match[1] ?? '').toLowerCase();
    const value = match[2] === undefined ? (match[3] ?? '') : match[2].replace(/\\(.)/g, '$1');
    if (!parameters.has(name)) parameters.set(name, value);
  }
  return parameters;
}

function normalizeMetadata(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim().slice(0, 160);
  return normalized || undefined;
}

function formatDeclaredLink(link: DeclaredWebLink): string {
  const relation = link.relations.map(inlineCode).join(', ');
  const type = link.type ? `; ${inlineCode(link.type)}` : '';
  const first = link.relations[0] ?? '';
  const label = RELATION_LABELS[first] ?? 'Declared link';
  return `- ${label} (${relation}${type}): <${link.url}>`;
}

function inlineCode(value: string): string {
  return `\`${value.replace(/`/g, "'")}\``;
}
