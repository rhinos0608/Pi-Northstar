import assert from "node:assert/strict";
import { test } from "node:test";
import { callNativeTool } from "../../src/native-tools.js";
import { SocialError } from "../../src/social/social-contract.js";

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Offline DNS stub: example.com does not resolve in sandboxes without
// public DNS, but the fetch helpers always run a DNS preflight before the
// (mocked) fetch. Pin example.com to its documentation address instead.
const offlineLookup = async () => [
  { address: "93.184.216.34", family: 4 as const },
];

async function withFetch<T>(
  mock: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Response | Promise<Response>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = globalThis.fetch;
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => mock(input, init);
  try {
    return await fn();
  } finally {
    globalThis.fetch = saved;
  }
}

// ── Tool routing ──

test("media tool routes rss platform to the native feed backend", async () => {
  await withFetch(
    async (input) => {
      assert.match(String(input), /^https:\/\/example\.com\/feed\.xml/);
      return new Response(
        '<?xml version="1.0"?><rss><channel><item><title>Post One</title><link>https://example.com/p1</link></item></channel></rss>',
        { status: 200, headers: { "content-type": "application/rss+xml" } },
      );
    },
    async () => {
      const result = await callNativeTool(
        "media",
        {
          platform: "rss",
          action: "feed",
          url: "https://example.com/feed.xml",
        },
        { env: {}, lookup: offlineLookup },
      );
      const details = result.details as {
        backend?: string;
        items?: Array<{ kind?: string; title?: string }>;
      };
      assert.equal(details.backend, "native-rss-atom");
      assert.equal(details.items?.[0]?.kind, "feed_entry");
      assert.equal(details.items?.[0]?.title, "Post One");
    },
  );
});

test("feeds tool defaults to the rss channel without a platform", async () => {
  await withFetch(
    async () => {
      return new Response(
        '<?xml version="1.0"?><feed><entry><title>Atom Entry</title><link href="https://example.com/a1"/></entry></feed>',
        { status: 200, headers: { "content-type": "application/atom+xml" } },
      );
    },
    async () => {
      const result = await callNativeTool(
        "feeds",
        { url: "https://example.com/atom.xml" },
        { env: {}, lookup: offlineLookup },
      );
      assert.equal(
        (result.details as { backend?: string }).backend,
        "native-rss-atom",
      );
    },
  );
});

test("media tool infers youtube from a canonical watch URL", async () => {
  await withFetch(
    async (input) => {
      const url = String(input);
      if (url.startsWith("https://www.youtube.com/oembed")) {
        return jsonResponse(
          JSON.stringify({ title: "Inferred", author_name: "a" }),
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    async () => {
      const result = await callNativeTool(
        "media",
        { url: "https://www.youtube.com/watch?v=inf1", action: "details" },
        { env: {} },
      );
      const details = result.details as { channel?: string; backend?: string };
      assert.equal(details.channel, "youtube");
      assert.equal(details.backend, "youtube-oembed");
    },
  );
});

test("media tool without platform or url rejects invalid_request", async () => {
  await assert.rejects(
    () =>
      callNativeTool("media", { action: "search", query: "cats" }, { env: {} }),
    /platform is required/,
  );
});

test("media legacy video spelling rejects unsupported_action before dispatch", async () => {
  await assert.rejects(
    () =>
      callNativeTool(
        "media",
        { platform: "youtube", action: "video", id: "x" },
        { env: { YOUTUBE_API_KEY: "k" } },
      ),
    (err: unknown) =>
      err instanceof SocialError && err.code === "unsupported_action",
  );
});

// ── Cursor pinning (youtube search) ──

test("youtube search cursor round-trips pageToken with backend pinning", async () => {
  const seen: string[] = [];
  const page = (items: unknown[], next?: string) =>
    jsonResponse(
      JSON.stringify({
        items,
        ...(next !== undefined ? { nextPageToken: next } : {}),
      }),
    );
  const item = { id: { videoId: "v1" }, snippet: { title: "Page Video" } };
  let nextCursor = "";
  await withFetch(
    async (input) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("pageToken=TOKEN2")) return page([item]);
      return page([item], "TOKEN2");
    },
    async () => {
      const first = await callNativeTool(
        "media",
        { platform: "youtube", action: "search", query: "cats" },
        { env: { YOUTUBE_API_KEY: "k" } },
      );
      const pagination = (
        first.details as {
          pagination?: { hasMore?: boolean; nextCursor?: string };
        }
      ).pagination;
      assert.equal(pagination?.hasMore, true);
      assert.ok(pagination?.nextCursor);
      nextCursor = pagination.nextCursor as string;
    },
  );
  await withFetch(
    async (input) => {
      const url = String(input);
      seen.push(url);
      return page([item]);
    },
    async () => {
      const second = await callNativeTool(
        "media",
        {
          platform: "youtube",
          action: "search",
          query: "cats",
          cursor: nextCursor,
        },
        { env: { YOUTUBE_API_KEY: "k" } },
      );
      assert.equal(
        (second.details as { backend?: string }).backend,
        "youtube-data-api",
      );
    },
  );
  assert.ok(
    seen.some((url) => url.includes("pageToken=TOKEN2")),
    "second page must send the pinned pageToken",
  );
});

test("youtube search cursor with changed selectors rejects cursor_invalid", async () => {
  let nextCursor = "";
  await withFetch(
    async () => {
      return jsonResponse(
        JSON.stringify({
          items: [{ id: { videoId: "v1" }, snippet: { title: "t" } }],
          nextPageToken: "T",
        }),
      );
    },
    async () => {
      const first = await callNativeTool(
        "media",
        { platform: "youtube", action: "search", query: "cats" },
        { env: { YOUTUBE_API_KEY: "k" } },
      );
      nextCursor = (first.details as { pagination?: { nextCursor?: string } })
        .pagination?.nextCursor as string;
    },
  );
  await assert.rejects(
    () =>
      callNativeTool(
        "media",
        {
          platform: "youtube",
          action: "search",
          query: "dogs",
          cursor: nextCursor,
        },
        { env: { YOUTUBE_API_KEY: "k" } },
      ),
    (err: unknown) =>
      err instanceof SocialError && err.code === "cursor_invalid",
  );
});

test("bilibili and rss report unsupported pagination (cursor rejected)", async () => {
  await assert.rejects(
    () =>
      callNativeTool(
        "media",
        { platform: "bilibili", action: "hot", cursor: "bogus" },
        { env: { PATH: "/nonexistent" } },
      ),
    (err: unknown) =>
      err instanceof SocialError && err.code === "cursor_invalid",
  );
  await withFetch(
    async () => {
      return new Response("<rss><channel></channel></rss>", { status: 200 });
    },
    async () => {
      const result = await callNativeTool(
        "feeds",
        { url: "https://example.com/f.xml" },
        { env: {}, lookup: offlineLookup },
      );
      assert.equal(
        (result.details as { pagination?: { supported?: boolean } }).pagination
          ?.supported,
        false,
      );
    },
  );
});

// ── Normalization specifics ──

test("youtube search empty items are valid-empty and stop without extra attempts", async () => {
  let calls = 0;
  await withFetch(
    async () => {
      calls += 1;
      return jsonResponse(JSON.stringify({ items: [] }));
    },
    async () => {
      const result = await callNativeTool(
        "media",
        { platform: "youtube", action: "search", query: "nothing" },
        { env: { YOUTUBE_API_KEY: "k" } },
      );
      const details = result.details as {
        pagination?: { returned?: number; hasMore?: boolean };
      };
      assert.equal(details.pagination?.returned, 0);
      assert.equal(details.pagination?.hasMore, false);
    },
  );
  assert.equal(calls, 1);
});

test("youtube entity ids are namespaced and northstar envelope validates", async () => {
  await withFetch(
    async () => {
      return jsonResponse(
        JSON.stringify({
          items: [
            {
              id: "v9",
              snippet: { title: "Namespaced" },
              contentDetails: { duration: "PT10S" },
              statistics: { viewCount: "7" },
            },
          ],
        }),
      );
    },
    async () => {
      const result = await callNativeTool(
        "media",
        { platform: "youtube", action: "details", id: "v9" },
        { env: { YOUTUBE_API_KEY: "k" } },
      );
      const details = result.details as {
        items?: Array<{ id?: string; backend?: string }>;
        northstar?: {
          data?: { kind?: string; entities?: Array<{ kind?: string }> };
          errors?: unknown[];
        };
      };
      assert.equal(details.items?.[0]?.id, "youtube:video:v9");
      assert.equal(details.items?.[0]?.backend, "youtube-data-api");
      assert.equal(details.northstar?.data?.kind, "entities");
      assert.equal(details.northstar?.data?.entities?.[0]?.kind, "video");
      assert.deepEqual(details.northstar?.errors, []);
    },
  );
});

test("media feed action with a youtube url still routes to rss (feed check beats url inference)", async () => {
  await withFetch(
    async () => {
      return new Response(
        '<?xml version="1.0"?><rss><channel><item><title>Feed Post</title><link>https://example.com/p1</link></item></channel></rss>',
        { status: 200, headers: { "content-type": "application/rss+xml" } },
      );
    },
    async () => {
      const result = await callNativeTool(
        "media",
        { action: "feed", url: "https://www.youtube.com/watch?v=feedtest" },
        { env: {}, lookup: offlineLookup },
      );
      const details = result.details as { backend?: string; channel?: string };
      assert.equal(details.backend, "native-rss-atom");
      assert.equal(details.channel, "rss");
    },
  );
});

test("youtube transcript malformed non-XML timedtext surfaces a youtube-transcript malformed_upstream error", async () => {
  const watchHtml =
    '<html><body><script>var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.googlevideo.com/api/timedtext?v=abc123&lang=en","languageCode":"en"}]}}};</script></body></html>';
  await withFetch(
    async (input) => {
      const url = String(input);
      if (url.startsWith("https://www.youtube.com/watch")) {
        return new Response(watchHtml, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (url.startsWith("https://www.googlevideo.com/")) {
        return new Response("this is neither xml nor json{{{", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    async () => {
      await assert.rejects(
        () =>
          callNativeTool(
            "media",
            { platform: "youtube", action: "transcript", id: "abc123" },
            { env: {} },
          ),
        (err: unknown) =>
          err instanceof SocialError &&
          /timedtext payload is neither valid XML nor valid JSON/.test(
            err.message,
          ),
      );
    },
  );
});

test("media limit rejects above channel cap without dispatch", async () => {
  await assert.rejects(() =>
    callNativeTool(
      "media",
      { platform: "youtube", action: "search", query: "cats", limit: 500 },
      { env: { YOUTUBE_API_KEY: "k" } },
    ),
  );
});
