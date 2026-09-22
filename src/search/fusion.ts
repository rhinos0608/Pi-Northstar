export interface RrfMergeResult<T> {
  item: T;
  rrfScore: number;
}

export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw.trim());
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|gclsrc$|dclid$|msclkid$|mc_cid$|mc_eid$|_ga$|_gl$)/i.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.href;
  } catch {
    return raw.trim().toLowerCase();
  }
}

export function rrfMerge<T>(
  rankings: T[][],
  opts: { k?: number; keyFn?: (item: T) => string; getId?: (item: T) => string; mergeFn?: (current: T, candidate: T) => T } = {},
): RrfMergeResult<T>[] {
  const k = opts.k ?? 60;
  const keyFn = opts.keyFn ?? defaultKey;
  const crossRankKey = opts.getId ?? keyFn;
  // Default keeps the first-seen copy (stable for id-keyed chunk rankings).
  // URL-keyed callers should pass a mergeFn so a later richer duplicate
  // contributes its evidence instead of being discarded.
  const mergeFn = opts.mergeFn ?? ((current) => current);
  const scores = new Map<string, { item: T; score: number; ranking: number }>();

  rankings.forEach((ranking, rankingIndex) => {
    const seen = new Map<string, number>();
    const deduped: T[] = [];
    for (const item of ranking) {
      const key = keyFn(item);
      const at = seen.get(key);
      if (at !== undefined) {
        deduped[at] = mergeFn(deduped[at] as T, item);
        continue;
      }
      seen.set(key, deduped.length);
      deduped.push(item);
    }

    deduped.forEach((item, index) => {
      const key = crossRankKey(item);
      const existing = scores.get(key);
      const score = 1 / (k + index + 1);
      if (!existing) {
        scores.set(key, { item, score, ranking: rankingIndex });
        return;
      }
      // Scores still accumulate across rankings; representation merges so a
      // later duplicate contributes evidence instead of being discarded.
      existing.score += score;
      existing.item = mergeFn(existing.item, item);
    });
  });

  return [...scores.values()]
    .map((value) => ({ value, sortKey: keyFn(value.item) }))
    .sort((a, b) => b.value.score - a.value.score || (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0))
    .map(({ value }) => ({ item: value.item, rrfScore: value.score }));
}

function defaultKey<T>(item: T): string {
  const record = item as Record<string, unknown>;
  return typeof record.url === 'string' ? normalizeUrl(record.url) : JSON.stringify(item);
}
