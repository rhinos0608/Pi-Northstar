export interface PageRef {
  ref: string;
  role?: string;
  name?: string;
  isContentEditable?: boolean;
}

export interface TabTarget {
  tabId: string;
  url: string;
  title?: string;
  label?: string;
  pinned: boolean;
}

export interface PageSnapshotRecord {
  token: number;
  url: string;
  refs: ReadonlyMap<string, PageRef>;
  capturedAt: number;
}

export class StaleRefError extends Error {
  constructor(public readonly ref: string, public readonly detail: string) {
    super(`Stale or unknown ref ${ref}: ${detail}`);
  }
}

const REF_PATTERN = /^@e\d+$/;

export class SessionPageStateStore {
  private readonly snapshots = new Map<string, PageSnapshotRecord>();
  private readonly tokens = new Map<string, number>();
  private readonly activeTabs = new Map<string, TabTarget>();

  snapshot(namespace: string): PageSnapshotRecord | undefined {
    return this.snapshots.get(namespace);
  }

  recordSnapshot(namespace: string, url: string, refs: PageRef[], expectedPriorToken?: number): PageSnapshotRecord {
    const currentToken = this.tokens.get(namespace) ?? 0;
    if (expectedPriorToken !== undefined && expectedPriorToken !== currentToken) {
      return this.snapshots.get(namespace) ?? this.buildAndStore(namespace, url, refs, currentToken);
    }
    const nextToken = currentToken + 1;
    this.tokens.set(namespace, nextToken);
    return this.buildAndStore(namespace, url, refs, nextToken);
  }

  private buildAndStore(namespace: string, url: string, refs: PageRef[], token: number): PageSnapshotRecord {
    const refMap = new Map<string, PageRef>();
    for (const ref of refs) refMap.set(ref.ref, ref);
    const record: PageSnapshotRecord = { token, url, refs: refMap, capturedAt: Date.now() };
    this.snapshots.set(namespace, record);
    return record;
  }

  invalidate(namespace: string, _reason: string): void {
    this.snapshots.delete(namespace);
  }

  resolveRef(namespace: string, ref: string): PageRef {
    const record = this.snapshots.get(namespace);
    if (!record) throw new StaleRefError(ref, 'no snapshot recorded or snapshot invalidated');
    const pageRef = record.refs.get(ref);
    if (!pageRef) throw new StaleRefError(ref, 'ref not present in current snapshot');
    return pageRef;
  }

  currentToken(namespace: string): number {
    return this.tokens.get(namespace) ?? 0;
  }

  setActiveTab(namespace: string, tab: TabTarget): void {
    this.activeTabs.set(namespace, tab);
  }

  getActiveTab(namespace: string): TabTarget | undefined {
    return this.activeTabs.get(namespace);
  }

  pinTab(namespace: string, tabId: string): void {
    const tab = this.activeTabs.get(namespace);
    if (tab && tab.tabId === tabId) {
      this.activeTabs.set(namespace, { ...tab, pinned: true });
    }
  }

  clear(namespace: string): void {
    this.snapshots.delete(namespace);
    this.tokens.delete(namespace);
    this.activeTabs.delete(namespace);
  }
}

/** Returns the tracked PageRef for a selector that looks like a ref, or `undefined` if the
 *  selector isn't ref-shaped (plain CSS/role/xpath selectors pass through untouched). Throws
 *  StaleRefError if it *is* ref-shaped but not present in the current snapshot. */
export function preflightRef(store: SessionPageStateStore, namespace: string, selector: string): PageRef | undefined {
  if (!REF_PATTERN.test(selector)) return undefined;
  return store.resolveRef(namespace, selector);
}
