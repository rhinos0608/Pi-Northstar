export interface TextChunk {
  text: string;
  start: number;
  end: number;
}

export interface ChunkOptions {
  /** Maximum characters per chunk. Default: 2048 */
  maxChars?: number;
  /** Overlap in characters between adjacent chunks. Default: 512 */
  overlap?: number;
  /** Minimum characters per chunk (shorter chunks discarded). Default: 100 */
  minChars?: number;
}

/** Split text into spans at boundaries matched by `regex`. */
function getSpans(
  text: string,
  regex: RegExp,
): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let lastEnd = 0;
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    spans.push({ start: lastEnd, end: match.index });
    lastEnd = match.index + match[0].length;
  }
  if (lastEnd < text.length) {
    spans.push({ start: lastEnd, end: text.length });
  }
  return spans;
}

/**
 * Ensures `pos + maxLen` doesn't split a UTF-16 surrogate pair.
 * Returns an adjusted end index safe for text.slice().
 */
function safeSliceEnd(text: string, pos: number, maxLen: number): number {
  let end = Math.min(pos + maxLen, text.length);
  // If end landed in the middle of a surrogate pair, back up
  if (end < text.length && end > 0) {
    const ch = text.charCodeAt(end - 1);
    if (ch >= 0xd800 && ch <= 0xdbff) {
      const next = text.charCodeAt(end);
      if (next >= 0xdc00 && next <= 0xdfff) {
        end--;
      }
    }
  }
  // If start is on a low surrogate (orphan), signal no chunk here
  if (pos > 0 && pos < text.length) {
    const ch = text.charCodeAt(pos);
    if (ch >= 0xdc00 && ch <= 0xdfff) {
      return pos; // caller advances past orphan
    }
  }
  // If end backed up to pos (high surrogate at chunk boundary), include full pair
  if (end <= pos) {
    const ch = text.charCodeAt(pos);
    if (ch >= 0xd800 && ch <= 0xdbff) return Math.min(pos + 2, text.length);
    return Math.min(pos + 1, text.length);
  }
  return end;
}

/**
 * Greedy accumulate spans into chunks of maxChars, with sentence-boundary
 * overlap. Returns [] when there are not enough spans to split (caller
 * falls back to next level).
 */
function chunkSpans(
  text: string,
  spans: { start: number; end: number }[],
  maxChars: number,
  overlap: number,
  minChars: number,
): TextChunk[] {
  if (spans.length <= 1) return [];

  const chunks: TextChunk[] = [];
  let i = 0;

  while (i < spans.length) {
    // Greedy accumulate spans until we'd exceed maxChars
    let j = i;
    let charLen = 0;
    while (j < spans.length) {
      const sepLen = j > i ? 1 : 0;
      const spanLen = spans[j]!.end - spans[j]!.start;
      if (charLen + sepLen + spanLen > maxChars && j > i) break;
      charLen += sepLen + spanLen;
      j++;
    }

    const start = spans[i]!.start;
    const spanEnd = spans[j - 1]!.end;
    const spanText = text.slice(start, spanEnd);

    if (spanText.length > maxChars) {
      // Split oversized span with fixed-size slices
      let subPos = start;
      while (subPos < spanEnd) {
        const subEnd = Math.min(safeSliceEnd(text, subPos, maxChars), spanEnd);
        const subSlice = text.slice(subPos, subEnd);
        if (subSlice.length >= minChars) {
          chunks.push({ text: subSlice, start: subPos, end: subEnd });
        }
        if (subEnd >= spanEnd) break;
        subPos = Math.max(subEnd - overlap, subPos + 1);
      }
    } else if (spanText.length >= minChars) {
      chunks.push({ text: spanText, start, end: spanEnd });
    }

    // Compute overlap: find the rightmost span boundary within `overlap`
    // chars from the end of this chunk.
    let next = j - 1;
    let overlapLen = 0;
    while (next >= i) {
      const sepLen = next < j - 1 ? 1 : 0;
      const spanLen = spans[next]!.end - spans[next]!.start;
      if (overlapLen + sepLen + spanLen > overlap) break;
      overlapLen += sepLen + spanLen;
      next--;
    }

    // Advance by at least one span to guarantee progress
    i = Math.max(next + 1, i + 1);

    // Guard: if the next chunk would start within spans already consumed
    // by this chunk (j >= total) and there is no new content beyond,
    // stop to avoid a purely-overlap tail chunk.
    if (i < j && j >= spans.length) break;
  }

  return chunks;
}

export function chunkText(text: string, options?: ChunkOptions): TextChunk[] {
  const maxChars = options?.maxChars ?? 2048;
  const overlap = options?.overlap ?? 512;
  const minChars = options?.minChars ?? 100;

  if (maxChars <= 0) throw new RangeError('maxChars must be positive');
  if (minChars < 0) throw new RangeError('minChars must be non-negative');
  if (overlap < 0 || overlap >= maxChars) throw new RangeError('overlap must be >= 0 and < maxChars');

  if (!text) return [];

  // Short-circuit: text fits in a single chunk
  if (text.length <= maxChars) {
    return text.length >= minChars
      ? [{ text, start: 0, end: text.length }]
      : [];
  }

  // Level 1: split on sentence boundaries
  const sentenceRegex = /(?<=[.!?])\s+(?=\p{L})/gu;
  let spans = getSpans(text, sentenceRegex);
  let chunks = chunkSpans(text, spans, maxChars, overlap, minChars);
  if (chunks.length > 0) return chunks;

  // Level 2: split on paragraph breaks (two or more newlines)
  spans = getSpans(text, /\n\n+/g);
  chunks = chunkSpans(text, spans, maxChars, overlap, minChars);
  if (chunks.length > 0) return chunks;

  // Level 3: fixed-size slices with overlap
  const fixed: TextChunk[] = [];
  let pos = 0;
  while (pos < text.length) {
    const end = safeSliceEnd(text, pos, maxChars);
    const slice = text.slice(pos, end);
    if (slice.length >= minChars) {
      fixed.push({ text: slice, start: pos, end });
    }
    pos = Math.max(end - overlap, pos + 1);
  }
  return fixed;
}
