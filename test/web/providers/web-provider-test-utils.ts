// Shared fetch-mock + input factory for web provider tests.
//
// mockFetch swaps globalThis.fetch with a call-tracking stub: it honors an
// already-aborted caller signal (throwIfAborted before dispatch), records
// every call, and delegates to a configurable handler. jsonResponse builds a
// JSON Response with configurable status/headers. makeTestInput merges a
// per-provider base input with test overrides.
export interface MockFetchCall {
  url: string;
  init: RequestInit;
}

export type MockFetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>;

export function mockFetch(handler: MockFetchHandler): {
  calls: MockFetchCall[];
  restore: () => void;
} {
  const calls: MockFetchCall[] = [];
  const saved = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    const normalized = init ?? {};
    calls.push({ url: String(url), init: normalized });
    return handler(String(url), normalized);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = saved; } };
}

export function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

export function makeTestInput<T extends object>(base: T, overrides?: Partial<T>): T {
  return { ...base, ...overrides };
}
