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
  opts: { k?: number; keyFn?: (item: T) => string; getId?: (item: T) => string } = {},
): RrfMergeResult<T>[] {
  const k = opts.k ?? 60;
  const keyFn = opts.keyFn ?? defaultKey;
  const crossRankKey = opts.getId ?? keyFn;
  const scores = new Map<string, { item: T; score: number; ranking: number }>();

  rankings.forEach((ranking, rankingIndex) => {
    const seen = new Set<string>();
    const deduped: T[] = [];
    for (const item of ranking) {
      const key = keyFn(item);
      if (seen.has(key)) continue;
      seen.add(key);
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
      // First-seen item wins. Rankings arrive in priority order (operator
      // backend order in web-access-search.ts `mergeResponses`, per-provider
      // rankings in knowledge-aggregate.ts `rrfRankKgEntities`), and both
      // call sites document first-copy-wins; answer selection in
      // `mergeResponses` is first-wins too. Scores still accumulate.
      existing.score += score;
    });
  });

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map((value) => ({ item: value.item, rrfScore: value.score }));
}

function defaultKey<T>(item: T): string {
  const record = item as Record<string, unknown>;
  return typeof record.url === 'string' ? normalizeUrl(record.url) : JSON.stringify(item);
}
