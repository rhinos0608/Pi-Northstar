// Pi Web Access FINAL source_check: cached-corpus-only claim assessment.
//
// Reads exclusively from the bounded in-memory content store. No network,
// no disk, no hidden fetch: unknown or expired responseIds throw.
// Claims are bounded to 1..20; sourceIds optionally narrow the corpus
// using the retrieve source identity (`s-<queryIndex>-<hitIndex>`).
// Assessment reuses the heuristic marker pipeline (hashes, citation
// passage IDs, 0.85 confidence cap, `heuristic: true` label).

import {
  WEB_ACCESS_MAX_CLAIMS,
  WebAccessContractError,
  type WebAccessContentStore,
} from './web-access-contract.js';
import {
  buildWebAccessSourceCheck,
  type WebAccessSourceCheckArtifact,
} from './web-access-source-check.js';

export interface WebAccessCachedSourceCheckRequest {
  responseId: string;
  claims: string[];
  sourceIds?: string[] | undefined;
}

export function runWebAccessCachedSourceCheck(
  store: WebAccessContentStore,
  req: WebAccessCachedSourceCheckRequest,
): WebAccessSourceCheckArtifact {
  if (!Array.isArray(req.claims) || req.claims.length < 1 || req.claims.length > WEB_ACCESS_MAX_CLAIMS) {
    throw new WebAccessContractError(`claims must contain 1-${WEB_ACCESS_MAX_CLAIMS} entries`);
  }
  for (const claim of req.claims) {
    if (typeof claim !== 'string' || claim.trim().length === 0) {
      throw new WebAccessContractError('claims entries must be non-empty strings');
    }
  }
  const entry = store.get(req.responseId);
  if (!entry) {
    throw new WebAccessContractError(
      `No stored results for responseId ${JSON.stringify(req.responseId)}. ResponseIds expire after 1h; re-run search.`,
    );
  }
  // Source identity matches retrieve: `s-<queryIndex>-<hitIndex>` where
  // hitIndex is the position inside its own query response.
  const hits: Array<{ sourceId: string; title: string; url: string; snippet: string; inlineContent?: string }> = [];
  for (const result of entry.results) {
    for (const [hitIndex, hit] of (result.response?.results ?? []).entries()) {
      const inline = hitIndex === 0 ? result.response?.inlineContent : undefined;
      if (inline !== undefined) {
        hits.push({
          sourceId: `s-${result.queryIndex}-${hitIndex}`,
          title: hit.title,
          url: hit.url,
          snippet: hit.snippet,
          inlineContent: inline,
        });
      } else {
        hits.push({
          sourceId: `s-${result.queryIndex}-${hitIndex}`,
          title: hit.title,
          url: hit.url,
          snippet: hit.snippet,
        });
      }
    }
  }
  let selected = hits;
  if (req.sourceIds !== undefined) {
    const wanted = new Set(req.sourceIds);
    const missing = [...wanted].filter((id) => !hits.some((h) => h.sourceId === id));
    if (missing.length > 0) {
      throw new WebAccessContractError(
        `Unknown sourceIds for responseId ${JSON.stringify(req.responseId)}: ${missing.join(', ')}`,
      );
    }
    selected = hits.filter((h) => wanted.has(h.sourceId));
  }
  const query = entry.queries.join(' | ');
  return buildWebAccessSourceCheck(
    {
      query,
      results: selected.map(({ title, url, snippet }) => ({ title, url, snippet })),
      fetched: selected
        .filter((h) => h.inlineContent)
        .map((h) => ({ url: h.url, title: h.title, content: h.inlineContent! })),
      claims: req.claims.map((c) => c.trim()),
    },
    {},
  );
}
