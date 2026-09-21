import assert from "node:assert/strict";
import test from "node:test";
import type { BackendCallResult } from "../../src/backend.js";
import { createCommandContext } from "../../src/commands/command-context.js";
import { runCommand } from "../../src/cli/cli.js";
import { callNativeTool } from "../../src/native-tools.js";
import {
  executeMediaDetails,
  MEDIA_DETAILS_COMMAND,
} from "../../src/commands/media-details-handler.js";
import {
  executeMediaFeed,
  MEDIA_FEED_COMMAND,
} from "../../src/commands/media-feed-handler.js";
import { MEDIA_SEARCH_COMMAND } from "../../src/commands/media-search-handler.js";
import { MEDIA_HOT_COMMAND } from "../../src/commands/media-hot-handler.js";
import {
  executeMediaTranscript,
  MEDIA_TRANSCRIPT_COMMAND,
} from "../../src/commands/media-transcript-handler.js";

function ctx() {
  return createCommandContext({
    surface: "cli",
    env: {},
    invocationId: "media-cli-test",
  });
}

function northstarCommandOf(result: BackendCallResult): {
  commandId: string;
  outcome: string;
} {
  return (result.details as Record<string, unknown>).northstarCommand as {
    commandId: string;
    outcome: string;
  };
}

async function withFetch<T>(
  mock: (url: string) => Response | Promise<Response>,
  fn: (seen: string[]) => Promise<T>,
): Promise<T> {
  const saved = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    seen.push(String(input));
    return mock(String(input));
  }) as typeof fetch;
  try {
    return await fn(seen);
  } finally {
    globalThis.fetch = saved;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function oembed() {
  return json({
    title: "Keyless Video",
    author_name: "chan",
    author_url: "https://www.youtube.com/@chan",
  });
}

test("CLI media help exposes migrated search/hot/details/transcript/feed grammar", async () => {
  const domain = await runCommand(["media", "--help"], {});
  assert.equal(domain.ok, true);
  assert.match(
    String((domain.data as { usage: string }).usage),
    /northstar media search --platform/,
  );
  assert.match(
    String((domain.data as { usage: string }).usage),
    /northstar media hot --platform/,
  );
  assert.match(
    String((domain.data as { usage: string }).usage),
    /northstar media details --platform/,
  );
  assert.match(
    String((domain.data as { usage: string }).usage),
    /northstar media transcript --platform/,
  );
  assert.match(
    String((domain.data as { usage: string }).usage),
    /northstar media feed --url/,
  );
  for (const [sub, commandId] of [
    ["search", MEDIA_SEARCH_COMMAND],
    ["hot", MEDIA_HOT_COMMAND],
    ["details", MEDIA_DETAILS_COMMAND],
    ["transcript", MEDIA_TRANSCRIPT_COMMAND],
    ["feed", MEDIA_FEED_COMMAND],
  ] as const) {
    const help = await runCommand(["media", sub, "--help"], {});
    assert.equal(help.ok, true, sub);
    assert.equal((help.data as { commandId: string }).commandId, commandId);
    assert.match(
      String((help.data as { usage: string }).usage),
      /northstar media/,
    );
  }
});

test("CLI media registers domain and capabilities", async () => {
  assert.ok(
    ((await runCommand(["domains"], {})).data as string[]).includes("media"),
  );
  const capabilities = (await runCommand(["capabilities"], {}))
    .data as string[];
  assert.ok(capabilities.includes("media.search"));
  assert.ok(capabilities.includes("media.hot"));
  assert.ok(capabilities.includes("media.details"));
  assert.ok(capabilities.includes("media.transcript"));
  assert.ok(capabilities.includes("media.feed"));
});

test("CLI media rejects malformed use strictly", async () => {
  for (const args of [
    ["media", "blog"],
    ["media", "search"],
    ["media", "hot"],
    ["media", "details"],
    ["media", "transcript"],
    ["media", "feed"],
    ["media", "details", "--id", "abc"],
    ["media", "details", "--platform", "youtube"],
    ["media", "details", "--platform", "youtube", "--id", "abc", "extra"],
    ["media", "details", "--platform", "youtube", "--id", "abc", "--bogus"],
    [
      "media",
      "details",
      "--platform",
      "youtube",
      "--id",
      "abc",
      "--json",
      "--agent",
    ],
    ["media", "details", "--platform", "youtube", "--id", "abc", "--limit"],
    [
      "media",
      "details",
      "--platform",
      "youtube",
      "--id",
      "abc",
      "--limit",
      "abc",
    ],
    [
      "media",
      "details",
      "--platform",
      "youtube",
      "--id",
      "abc",
      "--limit",
      "0",
    ],
    [
      "media",
      "details",
      "--platform",
      "youtube",
      "--id",
      "abc",
      "--limit",
      "3",
      "--limit",
      "4",
    ],
    [
      "media",
      "details",
      "--platform",
      "youtube",
      "--id",
      "abc",
      "--platform",
      "bilibili",
    ],
    [
      "media",
      "transcript",
      "--platform",
      "youtube",
      "--url",
      "https://www.youtube.com/watch?v=abc",
      "--action",
      "transcript",
    ],
    ["media", "feed", "--platform", "rss"],
    [
      "media",
      "feed",
      "--url",
      "https://example.com/feed.xml",
      "--url",
      "https://example.com/other.xml",
    ],
    ["media", "feed", "--url", "https://example.com/feed.xml", "--limit", "0"],
  ]) {
    const result = await runCommand(args, {});
    assert.equal(result.ok, false, args.join(" "));
  }
});

test("CLI media defers limit range to the contract", async () => {
  // 5000 passes CLI parsing (integer >= 1) and fails closed in the handler
  // without dispatch: no fetch on validation failure.
  await withFetch(
    async () => {
      assert.fail("no fetch on out-of-range limit");
    },
    async (seen) => {
      const result = await runCommand(
        [
          "media",
          "details",
          "--platform",
          "youtube",
          "--id",
          "abc",
          "--limit",
          "5000",
        ],
        {},
      );
      assert.equal(result.ok, false);
      assert.equal(seen.length, 0);
    },
  );
});

test("CLI media cursor passes through to the contract rejection", async () => {
  await withFetch(
    async () => {
      assert.fail("no fetch on cursor rejection");
    },
    async (seen) => {
      const result = await runCommand(
        [
          "media",
          "feed",
          "--url",
          "https://example.com/feed.xml",
          "--cursor",
          "opaque",
        ],
        {},
      );
      assert.equal(result.ok, false);
      assert.equal(seen.length, 0);
    },
  );
});

test("media.details shares one handler across direct, native, and CLI surfaces", async () => {
  await withFetch(oembed, async () => {
    const direct = northstarCommandOf(
      await executeMediaDetails(
        { platform: "youtube", id: "dQw4w9WgXcQ" },
        ctx(),
      ),
    );
    const native = northstarCommandOf(
      await callNativeTool(
        "media",
        { action: "details", platform: "youtube", id: "dQw4w9WgXcQ" },
        { env: {} },
      ),
    );
    const cli = await runCommand(
      [
        "media",
        "details",
        "--platform",
        "youtube",
        "--id",
        "dQw4w9WgXcQ",
        "--json",
      ],
      {},
    );
    assert.equal(cli.ok, true);
    const parsed = JSON.parse(String(cli.data)) as {
      commandId: string;
      outcome: string;
    };
    for (const command of [direct, native]) {
      assert.equal(command.commandId, MEDIA_DETAILS_COMMAND);
      assert.equal(command.outcome, "degraded");
    }
    assert.equal(parsed.commandId, MEDIA_DETAILS_COMMAND);
    assert.equal(parsed.outcome, "degraded");
  });
});

test("native media bypass closes through the registry: out-of-range limits never dispatch", async () => {
  // The legacy contract would clamp limit 5000 and dispatch; the registry
  // handler rejects instead, so no fetch happens and the commandResult
  // carries media.details.
  await withFetch(
    async () => {
      assert.fail("registry rejects out-of-range limits before dispatch");
    },
    async (seen) => {
      await assert.rejects(
        callNativeTool(
          "media",
          { action: "details", platform: "youtube", id: "x", limit: 5000 },
          { env: {} },
        ),
        (error: unknown) => {
          const command = (
            error as {
              commandResult?: { commandId: string; error: { code: string } };
            }
          ).commandResult;
          assert.ok(command, "expected a commandResult on registry rejection");
          assert.equal(command.commandId, MEDIA_DETAILS_COMMAND);
          assert.equal(command.error.code, "invalid_request");
          return true;
        },
      );
      assert.equal(seen.length, 0);
    },
  );
});

test("native media legacy spellings stay out of the migrated registry path", async () => {
  // Unmigrated 'video' keeps the legacy reach dispatch: it rejects without a
  // registry commandResult, never through media.details.
  await assert.rejects(
    callNativeTool(
      "media",
      { action: "video", platform: "youtube", id: "x" },
      { env: {} },
    ),
    (error: unknown) => {
      assert.equal(
        (error as { commandResult?: unknown }).commandResult,
        undefined,
      );
      return true;
    },
  );
});

test("media.transcript and media.feed reject invalid input without dispatch", async () => {
  await withFetch(
    async () => {
      assert.fail("no fetch on validation failure");
    },
    async (seen) => {
      try {
        await executeMediaTranscript({}, ctx());
        assert.fail("expected transcript to throw");
      } catch (error) {
        assert.equal(
          (error as { commandResult: { error: { code: string } } })
            .commandResult.error.code,
          "invalid_request",
        );
      }
      try {
        await executeMediaFeed(
          { platform: "youtube", url: "https://example.com/feed.xml" },
          ctx(),
        );
        assert.fail("expected feed to throw");
      } catch (error) {
        const command = (
          error as {
            commandResult: { commandId: string; error: { code: string } };
          }
        ).commandResult;
        assert.equal(command.commandId, MEDIA_FEED_COMMAND);
        assert.equal(command.error.code, "unsupported_action");
      }
      assert.equal(seen.length, 0);
    },
  );
});
