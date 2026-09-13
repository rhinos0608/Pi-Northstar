// Pure collapsed/expanded error/cancel plan for compat tool results.
//
// Reimplemented semantics from pinned upstream commit
// 192ac1875e3b8f88c78953dbc314949ec9fcaa27 (render-search-error.ts
// buildSearchErrorPlan): plain strings, no TUI/theme imports, so the plan is
// unit-testable and the (later) integration renderer only applies styling.
// No verbatim upstream copy.

export interface WebAccessCancelledQueryDetail {
  query: string;
  provider: string | null;
  /** Null = completed ok; string = per-query error. */
  error: string | null;
  resultCount: number;
}

export interface WebAccessErrorPlanDetails {
  /** Headline error/cancel message. */
  error?: string | undefined;
  cancelled?: boolean | undefined;
  cancelReason?: string | undefined;
  /** Whether the curator browser page ever connected. */
  browserConnected?: boolean | undefined;
  /** Age (ms) of the last curator heartbeat at cancel time, if known. */
  lastHeartbeatAgeMs?: number | null | undefined;
  /** Total queries requested (defaults to detail list length). */
  queryCount?: number | undefined;
  /** Partial per-query results gathered before the cancel/error. */
  cancelledQueries?: WebAccessCancelledQueryDetail[] | undefined;
  /** Extra diagnostic lines (URLs, response id) for non-cancel errors. */
  extraLines?: string[] | undefined;
}

export interface WebAccessErrorPlan {
  /** Full diagnostic block, shown when expanded. */
  expanded: string[];
  /** Short preview lines, shown under the headline when collapsed. */
  collapsed: string[];
  /** Hidden-line hint, or null when nothing is hidden. */
  expandHint: string | null;
}

function truncatePlanText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

/**
 * Build the error/cancel render plan. Returns null when details carry no
 * error/cancel signal so callers fall through to the success renderer.
 * Bare argument errors (no partials, no extras) stay a clean single line.
 */
export function buildWebAccessErrorPlan(
  details: WebAccessErrorPlanDetails | undefined | null,
): WebAccessErrorPlan | null {
  if (!details || (!details.error && !details.cancelled)) return null;

  const headline = details.error ?? 'Search cancelled.';
  const queries = details.cancelledQueries ?? [];
  const queryCount =
    typeof details.queryCount === 'number' && details.queryCount > 0 ? details.queryCount : queries.length;
  const done = queries.length;
  const errored = queries.filter((q) => q.error).length;

  const extras = details.extraLines ?? [];
  const rich = details.cancelled === true || queries.length > 0 || extras.length > 0;
  if (!rich) return { expanded: [headline], collapsed: [], expandHint: null };

  const expanded: string[] = [headline, ''];

  if (details.cancelled === true || queries.length > 0) {
    const diag: string[] = [];
    if (details.cancelled) diag.push(`cancel reason   : ${details.cancelReason ?? 'unknown'}`);
    const browserLabel =
      details.browserConnected === undefined ? 'unknown' : details.browserConnected ? 'connected' : 'never connected';
    diag.push(`browser         : ${browserLabel}`);
    if (typeof details.lastHeartbeatAgeMs === 'number' && Number.isFinite(details.lastHeartbeatAgeMs)) {
      diag.push(`last heartbeat  : ${Math.round(details.lastHeartbeatAgeMs / 1000)}s ago`);
    }
    if (queryCount > 0) {
      diag.push(`queries started : ${queryCount}`);
      diag.push(`queries done    : ${done}`);
      if (errored > 0) diag.push(`queries errored : ${errored}`);
    }
    expanded.push('Diagnostics:');
    for (const line of diag) expanded.push(`  ${line}`);
  }

  if (queries.length > 0) {
    expanded.push('');
    expanded.push('Per-query results (gathered before cancel):');
    for (const q of queries) {
      const dq = truncatePlanText(q.query, 52);
      const tag = q.error ? '[err] ' : '[ok]  ';
      const provider = q.provider ? ` (${q.provider})` : '';
      const tail = q.error
        ? `— ${truncatePlanText(q.error, 60)}`
        : `— ${q.resultCount} source${q.resultCount === 1 ? '' : 's'}`;
      expanded.push(`  ${tag}"${dq}"${provider} ${tail}`);
    }
  }

  if (extras.length > 0) {
    expanded.push('');
    expanded.push('Details:');
    for (const line of extras) expanded.push(`  ${line}`);
  }

  const collapsed: string[] = [];
  const parts: string[] = [];
  if (queryCount > 0) parts.push(`${done}/${queryCount} queries completed`);
  if (errored > 0) parts.push(`${errored} errored`);
  if (details.browserConnected === false) parts.push('browser never connected');
  else if (details.cancelReason) parts.push(`reason: ${details.cancelReason}`);
  if (parts.length > 0) collapsed.push(`${parts.join('; ')}.`);
  if (collapsed.length === 0 && extras.length > 0) {
    for (const line of extras.slice(0, 2)) collapsed.push(truncatePlanText(line, 100));
  }

  const hiddenLines = Math.max(0, expanded.length - 1 - collapsed.length);
  const expandHint =
    hiddenLines > 0 ? `... (${hiddenLines} more lines, ${expanded.length} total, ctrl+o to expand)` : null;

  return { expanded, collapsed, expandHint };
}
