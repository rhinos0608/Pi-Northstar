// Richest-donor representation selection for duplicate normalized URLs.
// Ranking (RRF score/order anchors) stays in fuseWebSearchRankings; this
// module only decides which donor's title/URL/snippet surfaces.

import type { WebSearchContentKind, WebSearchHit } from './web-search-types.js';

/** Explicit richness order: full > summary > snippet (omission = snippet). */
export function contentRichness(kind: WebSearchContentKind | undefined): number {
  if (kind === 'full') return 2;
  if (kind === 'summary') return 1;
  return 0;
}

/** Clean-text length used for within-kind comparison. */
export function cleanContentLength(snippet: string): number {
  return snippet.trim().length;
}

/**
 * Deterministically choose the richer donor. Independent from score/rank:
 * kind first, then clean length, then the earlier selected provider
 * (current). Publication metadata backfills only when the winner lacks it;
 * conflicting values keep the winner's.
 */
export function chooseRepresentation(current: WebSearchHit, candidate: WebSearchHit): WebSearchHit {
  const currentRank = contentRichness(current.contentKind);
  const candidateRank = contentRichness(candidate.contentKind);
  let winner: WebSearchHit;
  let loser: WebSearchHit;
  if (candidateRank !== currentRank) {
    winner = candidateRank > currentRank ? candidate : current;
    loser = winner === candidate ? current : candidate;
  } else {
    const currentLen = cleanContentLength(current.snippet);
    const candidateLen = cleanContentLength(candidate.snippet);
    if (candidateLen !== currentLen) {
      winner = candidateLen > currentLen ? candidate : current;
      loser = winner === candidate ? current : candidate;
    } else {
      winner = current;
      loser = candidate;
    }
  }
  const backfilled: WebSearchHit = { ...winner };
  if (backfilled.publishedDate === undefined && loser.publishedDate !== undefined) {
    backfilled.publishedDate = loser.publishedDate;
  }
  if (backfilled.author === undefined && loser.author !== undefined) {
    backfilled.author = loser.author;
  }
  return backfilled;
}
