import type { PageRef } from './session-page-state.js';

// ── Component 7: Snapshot Ref Extraction ──

export interface RawSnapshotNode {
  ref?: string;
  role?: string;
  name?: string;
  editable?: boolean;
  children?: RawSnapshotNode[];
}

/** Normalize a ref string to always have the @eN prefix. */
function normalizeRef(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (/^@e\d+$/.test(trimmed)) return trimmed;
  if (/^e\d+$/.test(trimmed)) return `@${trimmed}`;
  return undefined;
}

/** Recursively walk a snapshot tree/flat array and collect all PageRef entries. */
function walkNodes(nodes: unknown[], acc: PageRef[]): void {
  for (const node of nodes) {
    if (typeof node !== 'object' || node === null) continue;
    const n = node as Record<string, unknown>;
    const refRaw = typeof n.ref === 'string' ? n.ref : undefined;
    if (refRaw) {
      const ref = normalizeRef(refRaw);
      if (ref) {
        acc.push({
          ref,
          ...(typeof n.role === 'string' && n.role ? { role: n.role } : {}),
          ...(typeof n.name === 'string' && n.name ? { name: n.name } : {}),
          ...(n.editable === true ? { isContentEditable: true } : {}),
        });
      }
    }
    if (Array.isArray(n.children)) {
      walkNodes(n.children, acc);
    }
  }
}

/** Parse agent-browser snapshot --json output into a flat PageRef[]. Handles both flat arrays and nested trees. */
export function parseSnapshotRefs(raw: unknown): PageRef[] {
  if (!raw || typeof raw !== 'object') return [];

  let nodes: unknown[];
  if (Array.isArray(raw)) {
    nodes = raw;
  } else if (Array.isArray((raw as Record<string, unknown>).nodes)) {
    nodes = (raw as { nodes: unknown[] }).nodes;
  } else if (Array.isArray((raw as Record<string, unknown>).refs)) {
    nodes = (raw as { refs: unknown[] }).refs;
  } else {
    return [];
  }

  const acc: PageRef[] = [];
  walkNodes(nodes, acc);
  return acc;
}

/** Extract URL from snapshot JSON data if present. */
export function extractSnapshotUrl(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const d = data as Record<string, unknown>;
  if (typeof d.url === 'string') return d.url;
  return '';
}

// ── Component 8: Compact Snapshot ──

const HIGH_VALUE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio',
  'combobox', 'select', 'menuitem', 'tab', 'switch',
]);

export interface CompactSnapshotOptions {
  maxRefs?: number;  // default 200
}

export interface CompactSnapshotResult {
  refs: PageRef[];
  omittedCount: number;
  truncated: boolean;
}

/** Keep high-value interactive roles + named structural nodes. Drop nameless structural nodes. Cap at maxRefs. */
export function compactSnapshotRefs(refs: PageRef[], options?: CompactSnapshotOptions): CompactSnapshotResult {
  const maxRefs = options?.maxRefs ?? 200;

  // Keep high-value roles first, then named nodes; drop unnamed non-interactive nodes
  const highValue: PageRef[] = [];
  const named: PageRef[] = [];

  for (const ref of refs) {
    if (ref.role && HIGH_VALUE_ROLES.has(ref.role)) {
      highValue.push(ref);
    } else if (ref.name) {
      named.push(ref);
    }
    // else: unnamed non-interactive node → dropped
  }

  const combined = [...highValue, ...named];
  const truncated = combined.length > maxRefs;
  const kept = truncated ? combined.slice(0, maxRefs) : combined;
  const omittedCount = refs.length - kept.length;

  return { refs: kept, omittedCount, truncated };
}
