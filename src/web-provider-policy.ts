// Environment-only web search provider selection policy.
// Absent/blank PI_SEARCH_WEB_BACKENDS selects first three configured
// preference entries (Codex explicit-only). Explicit lists run all runnable
// entries concurrently; duplicates/unknown/>8 reject before any calls.
import {
  DEFAULT_WEB_SEARCH_PROVIDER_COUNT,
  DEFAULT_WEB_SEARCH_PROVIDER_ORDER,
  DEFAULT_WEB_SEARCH_PROVIDER_TIMEOUT_MS,
  MAX_WEB_SEARCH_PROVIDER_COUNT,
  MAX_WEB_SEARCH_PROVIDER_TIMEOUT_MS,
  MIN_WEB_SEARCH_PROVIDER_TIMEOUT_MS,
  WEB_SEARCH_PROVIDER_IDS,
  type WebSearchAdapter,
  type WebSearchProviderId,
} from './web-search-types.js';

export interface ResolvedWebProviderPolicy {
  explicit: boolean;
  selected: WebSearchProviderId[];
  runnable: WebSearchAdapter[];
  unavailable: WebSearchProviderId[];
  timeoutMs: number;
}

const KNOWN_IDS: ReadonlySet<string> = new Set(WEB_SEARCH_PROVIDER_IDS);

export function resolveWebProviderPolicy(
  env: Record<string, string | undefined>,
  adapters: readonly WebSearchAdapter[],
): ResolvedWebProviderPolicy {
  const timeoutMs = resolveProviderTimeoutMs(env);
  const raw = env['PI_SEARCH_WEB_BACKENDS'];
  if (raw === undefined || raw.trim() === '') {
    const byId = new Map(adapters.map((adapter) => [adapter.id, adapter] as const));
    const runnable: WebSearchAdapter[] = [];
    for (const id of DEFAULT_WEB_SEARCH_PROVIDER_ORDER) {
      if (runnable.length >= DEFAULT_WEB_SEARCH_PROVIDER_COUNT) break;
      const adapter = byId.get(id);
      if (adapter !== undefined && adapter.configured(env)) {
        runnable.push(adapter);
      }
    }
    return {
      explicit: false,
      selected: runnable.map((adapter) => adapter.id),
      runnable,
      unavailable: [],
      timeoutMs,
    };
  }
  const selected = parseExplicitBackends(raw);
  const byId = new Map(adapters.map((adapter) => [adapter.id, adapter] as const));
  const runnable: WebSearchAdapter[] = [];
  const unavailable: WebSearchProviderId[] = [];
  for (const id of selected) {
    const adapter = byId.get(id);
    if (adapter !== undefined && adapter.configured(env)) {
      runnable.push(adapter);
    } else {
      unavailable.push(id);
    }
  }
  return { explicit: true, selected, runnable, unavailable, timeoutMs };
}

function parseExplicitBackends(raw: string): WebSearchProviderId[] {
  const ids = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (ids.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(`PI_SEARCH_WEB_BACKENDS: duplicate backend "${id}"`);
    }
    seen.add(id);
    if (!KNOWN_IDS.has(id)) {
      throw new Error(`PI_SEARCH_WEB_BACKENDS: unknown backend "${id}"`);
    }
  }
  if (ids.length > MAX_WEB_SEARCH_PROVIDER_COUNT) {
    throw new Error(
      `PI_SEARCH_WEB_BACKENDS: at most ${MAX_WEB_SEARCH_PROVIDER_COUNT} backends, got ${ids.length}`,
    );
  }
  return ids as WebSearchProviderId[];
}

function resolveProviderTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = env['PI_SEARCH_WEB_PROVIDER_TIMEOUT_MS'];
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_WEB_SEARCH_PROVIDER_TIMEOUT_MS;
  }
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < MIN_WEB_SEARCH_PROVIDER_TIMEOUT_MS || parsed > MAX_WEB_SEARCH_PROVIDER_TIMEOUT_MS) {
    throw new Error(
      `PI_SEARCH_WEB_PROVIDER_TIMEOUT_MS: expected integer ${MIN_WEB_SEARCH_PROVIDER_TIMEOUT_MS}..${MAX_WEB_SEARCH_PROVIDER_TIMEOUT_MS}, got "${raw}"`,
    );
  }
  return parsed;
}

/** Compose caller abort with provider timeout. Aborts on whichever fires first. */
export function providerSignal(caller: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  if (caller?.aborted === true) {
    controller.abort(caller.reason);
    return controller.signal;
  }
  const timer = setTimeout(() => {
    controller.abort(new Error('web search provider timeout'));
  }, timeoutMs);
  const clear = (): void => {
    clearTimeout(timer);
  };
  controller.signal.addEventListener('abort', clear, { once: true });
  if (typeof (timer as unknown as { unref?: unknown }).unref === 'function') {
    (timer as unknown as { unref: () => void }).unref();
  }
  if (caller !== undefined) {
    const onCallerAbort = (): void => {
      controller.abort(caller.reason);
    };
    if (caller.aborted) {
      onCallerAbort();
    } else {
      caller.addEventListener('abort', onCallerAbort, { once: true });
      controller.signal.addEventListener(
        'abort',
        () => {
          caller.removeEventListener('abort', onCallerAbort);
        },
        { once: true },
      );
    }
  }
  return controller.signal;
}
