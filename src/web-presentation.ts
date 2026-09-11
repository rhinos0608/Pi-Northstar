// Fetch-only semantic presentation for oversized page text.
//
// boundPageText (src/web.ts) delegates here. Generic guardText stays
// untouched: this parser runs only on fetched page content, never on
// arbitrary tool output. External content remains untrusted; treatment is
// bounding + inert links, not safety proof.
//
// Rules: Markdown/plain block parsing, confirmed-navigation filtering,
// non-HTTP(S) link neutralization, exact-budget truncation. Code and table
// blocks are atomic (whole or skipped); prose reduces to complete
// sentences; plain one-line text without terminators degrades to a
// word-boundary slice. One truncation marker rides inside maxChars.

export interface PresentedPageText {
  text: string;
  shown: string;
  truncated: boolean;
  omittedChars: number;
}

type BlockKind = 'code' | 'table' | 'quote' | 'prose';

interface Block {
  kind: BlockKind;
  text: string;
}

const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const TABLE_ROW_RE = /^\s*\|/;
// Delimiter rows (--- | ---, |:---|---:|) and pipe rows without a leading
// pipe (alpha | 1) are table syntax too; naked rows join only adjacent to
// explicit table syntax so pipe-separated nav chrome stays prose.
const TABLE_DELIM_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const TABLE_NAKED_ROW_RE = /^\s*[^|\n]+\|/;
const QUOTE_RE = /^\s*>/;
const LIST_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;
const HEADING_RE = /^\s*#{1,6}\s/;

const CHROME_LINES = new Set([
  'skip to content',
  'skip to main content',
  'skip to navigation',
  'back to top',
]);

function markerFor(shownLen: number, total: number): string {
  return `\n\n[truncated: showing ${shownLen} of ${total} chars; raise maxChars up to 50000 for more]`;
}

function wordSlice(value: string, budget: number): string {
  if (budget >= value.length) return value;
  if (budget <= 0) return '';
  const cut = value.slice(0, budget);
  const idx = cut.lastIndexOf(' ');
  if (idx > budget * 0.25) return cut.slice(0, idx).trimEnd();
  return cut.trimEnd();
}

/** Neutralize non-HTTP(S) Markdown links/images, preserving visible labels. */
function neutralizeLinks(text: string): string {
  // Resolve reference definitions first: [label][ref] + [ref]: destination.
  const targets = new Map<string, string>();
  for (const match of text.matchAll(/^\s*\[([^\]]+)\]:\s*(\S+).*$/gm)) {
    targets.set(match[1]!.toLowerCase(), match[2]!.replace(/^<+|>+$/g, '').trim());
  }
  // Drop definitions pointing at non-HTTP(S) targets; the labels become text.
  const pruned = text.replace(/^\s*\[([^\]]+)\]:\s*(\S+).*$/gm, (line, _ref: string, target: string) => {
    const clean = String(target).replace(/^<+|>+$/g, '').trim();
    if (/^https?:\/\//i.test(clean)) return line;
    return '';
  });
  const dereferenced = pruned
    .replace(/!\[([^\]]*)\]\[([^\]]*)\]/g, '$1')
    .replace(/\[([^\]]*)\]\[([^\]]*)\]/g, (match, label: string, ref: string) => {
      const key = (ref || label).toLowerCase();
      const target = targets.get(key) ?? '';
      if (/^https?:\/\//i.test(target)) return match;
      return String(label);
    });
  const withoutImages = dereferenced.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  return withoutImages.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (match, label: string, target: string) => {
    const clean = String(target).trim().replace(/^<+|>+$/g, '').trim();
    if (/^https?:\/\//i.test(clean)) return match;
    return String(label);
  });
}

/** Next non-blank line carries explicit table syntax (leading pipe or delimiter). */
function nextIsTableSyntax(lines: string[], index: number): boolean {
  for (let next = index + 1; next < lines.length; next++) {
    const candidate = lines[next]!;
    if (!candidate.trim()) return false;
    return TABLE_ROW_RE.test(candidate) || TABLE_DELIM_RE.test(candidate);
  }
  return false;
}

function parseBlocks(input: string): Block[] {
  const lines = input.split('\n');
  const blocks: Block[] = [];
  let current: string[] = [];
  let currentKind: BlockKind = 'prose';

  const flush = (): void => {
    const text = current.join('\n').trim();
    if (text) blocks.push({ kind: currentKind, text });
    current = [];
    currentKind = 'prose';
  };

  let inFence = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (inFence) {
      current.push(line);
      if (FENCE_RE.test(line)) {
        inFence = false;
        flush();
      }
      continue;
    }
    if (FENCE_RE.test(line)) {
      if (current.length > 0) flush();
      inFence = true;
      currentKind = 'code';
      current.push(line);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (TABLE_ROW_RE.test(line) || TABLE_DELIM_RE.test(line) || (TABLE_NAKED_ROW_RE.test(line) && (currentKind === 'table' || nextIsTableSyntax(lines, index)))) {
      if (current.length > 0 && currentKind !== 'table') flush();
      currentKind = 'table';
      current.push(line);
      continue;
    }
    if (QUOTE_RE.test(line)) {
      if (current.length > 0 && currentKind !== 'quote') flush();
      currentKind = 'quote';
      current.push(line);
      continue;
    }
    if (LIST_RE.test(line) || HEADING_RE.test(line)) {
      if (current.length > 0 && currentKind !== 'prose') flush();
      currentKind = 'prose';
      current.push(line);
      continue;
    }
    if (currentKind !== 'prose') flush();
    currentKind = 'prose';
    current.push(line);
  }
  // Unclosed fence stays atomic through end of input (deterministic).
  flush();
  return blocks;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Strip a leading run of short pipe-separated labels (flattened nav chrome
 * merges into the article block, so whole-block detection cannot see it).
 * Only the leading run goes; later pipes in article text are untouched. */
function stripLeadingPipeNav(block: string): string {
  const run = block.match(/^\s*(?:[^|\n]{1,24}\|){2,}\s*/);
  if (!run) return block;
  const rest = block.slice(run[0].length);
  return rest.trim() ? rest : block;
}

/** Conservative navigation detection; code/table/quote never reach here. */
function isNavigation(block: string): boolean {
  const trimmed = block.trim();
  if (!trimmed) return true;
  if (CHROME_LINES.has(trimmed.toLowerCase())) return true;
  const words = wordCount(trimmed);
  // Pipe-separated chrome: Home | About | Contact.
  const pipes = (trimmed.match(/\|/g) ?? []).length;
  if (pipes >= 2 && words <= 40) {
    const segments = trimmed.split('|').map((part) => part.trim()).filter(Boolean);
    if (segments.length >= 3 && segments.every((part) => wordCount(part) <= 8 || part.includes('['))) {
      return true;
    }
  }
  // Link-list chrome: every line a link or short label, mostly links.
  const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length >= 3 && words <= 48) {
    const linkLines = lines.filter((line) => line.includes('[')).length;
    const shortEvery = lines.every(
      (line) => /\[[^\]]+\]\([^)]*\)/.test(line) || (wordCount(line) <= 5 && line.length <= 48),
    );
    if (shortEvery && linkLines >= Math.ceil(lines.length / 2)) return true;
  }
  return false;
}

/** Cumulative prefixes ending at complete sentences, in order. */
function sentencePrefixes(text: string): string[] {
  const out: string[] = [];
  const re = /[^.!?…]+[.!?…]+(?=\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    out.push(text.slice(0, match.index + match[0].length).trimEnd());
  }
  return out;
}

export function presentPageText(content: string, maxChars: number): PresentedPageText {
  const total = content.length;
  const worstMarker = markerFor(maxChars, total).length;
  if (maxChars <= worstMarker) {
    return { text: markerFor(0, total).slice(0, maxChars), shown: '', truncated: true, omittedChars: total };
  }

  const sanitized = neutralizeLinks(content);
  const blocks = parseBlocks(sanitized).flatMap((block) => {
    if (block.kind !== 'prose') return [block];
    const stripped = stripLeadingPipeNav(block.text);
    if (!stripped.trim() || isNavigation(stripped)) return [];
    return [{ ...block, text: stripped }];
  });
  const cleaned = blocks.map((block) => block.text).join('\n\n');
  if (cleaned.length <= maxChars) {
    return { text: cleaned, shown: cleaned, truncated: false, omittedChars: total - cleaned.length };
  }

  // Greedy pack in order against worst-case marker reservation, so the
  // final marker always fits and output never exceeds maxChars.
  const reserve = (candidateShownLen: number): number => candidateShownLen + worstMarker;
  let shown = '';
  const candidateFor = (addition: string): string => (shown ? `${shown}\n\n${addition}` : addition);

  for (const block of blocks) {
    if (block.kind === 'code' || block.kind === 'table') {
      const candidate = candidateFor(block.text);
      if (reserve(candidate.length) <= maxChars) shown = candidate;
      continue;
    }
    const whole = candidateFor(block.text);
    if (reserve(whole.length) <= maxChars) {
      shown = whole;
      continue;
    }
    const prefixes = sentencePrefixes(block.text);
    let best = '';
    for (const prefix of prefixes) {
      const candidate = candidateFor(prefix);
      if (reserve(candidate.length) <= maxChars) best = prefix;
      else break;
    }
    if (best) {
      shown = candidateFor(best);
      continue;
    }
    // No complete sentence fits: skip sentenced blocks; degrade a lone
    // unterminated block to a word-boundary slice instead of emitting nothing.
    if (prefixes.length === 0 && !shown) {
      const slice = wordSlice(block.text, maxChars - worstMarker);
      if (slice) shown = slice;
    }
  }

  if (!shown) {
    return { text: markerFor(0, total).slice(0, maxChars), shown: '', truncated: true, omittedChars: total };
  }
  const marker = markerFor(shown.length, total);
  return { text: `${shown}${marker}`, shown, truncated: true, omittedChars: total - shown.length };
}
