// Compat presentation for GitHub / media specialized fetch routing.
//
// Upstream v0.29 builds GitHub/YouTube specialization into fetch; Northstar
// keeps separate `github` / `media` tools. This module only *presents*
// content already read through the injected GitHub/media reader seam — it
// never calls those tools and never fetches. Pure functions only.

import { WEB_ACCESS_RETRIEVAL_MAX_CHARS } from './web-access-contract.js';
import { truncateWebAccessText } from './web-access-presentation.js';
import { selectWebAccessReaderKind } from './web-access-specialization.js';

export type WebAccessSpecializedKind = 'github' | 'media';

/** Route a URL to its specialized reader without fetching or importing tools. */
export function selectWebAccessSpecializedKind(url: string): WebAccessSpecializedKind | undefined {
  const kind = selectWebAccessReaderKind(url);
  return kind === 'github' || kind === 'media' ? kind : undefined;
}

export interface WebAccessSpecializedSection {
  kind: WebAccessSpecializedKind;
  url: string;
  title: string;
  content: string;
  maxChars?: number | undefined;
}

/** Render an already-read specialized result as a bounded markdown section. */
export function formatWebAccessSpecializedSection(section: WebAccessSpecializedSection): string {
  const label = section.kind === 'github' ? 'GitHub' : 'Media';
  const sliced = truncateWebAccessText(section.content, section.maxChars ?? WEB_ACCESS_RETRIEVAL_MAX_CHARS);
  return `## ${label}: ${section.title}\n${section.url}\n\n${sliced.text}`;
}
