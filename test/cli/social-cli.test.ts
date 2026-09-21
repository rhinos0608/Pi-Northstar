import assert from "node:assert/strict";
import test from "node:test";
import type { BackendCallResult } from "../../src/backend.js";
import { createCommandContext } from "../../src/commands/command-context.js";
import { runCommand } from "../../src/cli/cli.js";
import { callNativeTool } from "../../src/native-tools.js";
import {
  executeSocialSearch,
  setSocialSearchExecutor,
  SOCIAL_SEARCH_COMMAND,
} from "../../src/commands/social-search-handler.js";
import {
  executeSocialRead,
  setSocialReadExecutor,
  SOCIAL_READ_COMMAND,
} from "../../src/commands/social-read-handler.js";
import { buildNorthstarResult } from "../../src/result-contract.js";

function entity(id: string, source: string) {
  return {
    entityVersion: 1 as const,
    kind: "social_post" as const,
    id,
    source,
    title: "T",
    url: "https://example.com/p/1",
  };
}

function searchEnvelope() {
  return buildNorthstarResult({
    request: {
      tool: "social",
      channel: "twitter",
      action: "search",
      source: "fake",
    },
    outcomes: [
      {
        source: "twitter",
        backend: "fake",
        entities: [entity("twitter:social_post:1", "twitter")],
      },
    ],
    pagination: { supported: false, limit: 5, hasMore: false },
  });
}

function readEnvelope() {
  return buildNorthstarResult({
    request: {
      tool: "social",
      channel: "reddit",
      action: "get_post",
      source: "fake",
    },
    outcomes: [
      {
        source: "reddit",
        backend: "fake",
        entities: [entity("reddit:social_post:9", "reddit")],
      },
    ],
    pagination: { supported: false, limit: 5, hasMore: false },
  });
}

function stubResult(
  envelope: ReturnType<typeof searchEnvelope>,
): BackendCallResult {
  return {
    content: [{ type: "text", text: "fake" }],
    details: { northstar: envelope },
  };
}

function northstarCommandOf(result: BackendCallResult): {
  commandId: string;
  outcome: string;
  data: unknown;
} {
  return (result.details as Record<string, unknown>).northstarCommand as {
    commandId: string;
    outcome: string;
    data: unknown;
  };
}

test("CLI social help exposes the migrated search/read grammar", async () => {
  const domain = await runCommand(["social", "--help"], {});
  assert.equal(domain.ok, true);
  assert.match(
    String((domain.data as { usage: string }).usage),
    /northstar social search --platform/,
  );
  assert.match(
    String((domain.data as { usage: string }).usage),
    /northstar social read --platform/,
  );
  for (const [sub, commandId] of [
    ["search", SOCIAL_SEARCH_COMMAND],
    ["read", SOCIAL_READ_COMMAND],
  ] as const) {
    const help = await runCommand(["social", sub, "--help"], {});
    assert.equal(help.ok, true, sub);
    assert.equal((help.data as { commandId: string }).commandId, commandId);
    assert.match(
      String((help.data as { usage: string }).usage),
      /northstar social/,
    );
  }
});

test("CLI social registers domain and capabilities", async () => {
  assert.ok(
    ((await runCommand(["domains"], {})).data as string[]).includes("social"),
  );
  const capabilities = (await runCommand(["capabilities"], {}))
    .data as string[];
  assert.ok(capabilities.includes("social.search"));
  assert.ok(capabilities.includes("social.read"));
});

test("CLI social rejects malformed use strictly", async () => {
  for (const args of [
    ["social", "blog"],
    ["social", "search"],
    ["social", "read"],
    ["social", "search", "--query", "cats"],
    ["social", "search", "--platform", "twitter"],
    ["social", "search", "--platform", "twitter", "--query", "cats", "extra"],
    ["social", "search", "--platform", "twitter", "--query", "cats", "--bogus"],
    [
      "social",
      "search",
      "--platform",
      "twitter",
      "--query",
      "cats",
      "--action",
      "search",
    ],
    [
      "social",
      "search",
      "--platform",
      "twitter",
      "--query",
      "cats",
      "--json",
      "--agent",
    ],
    ["social", "search", "--platform", "twitter", "--query", "cats", "--limit"],
    [
      "social",
      "search",
      "--platform",
      "twitter",
      "--query",
      "cats",
      "--limit",
      "abc",
    ],
    [
      "social",
      "search",
      "--platform",
      "twitter",
      "--query",
      "cats",
      "--limit",
      "0",
    ],
    [
      "social",
      "search",
      "--platform",
      "twitter",
      "--query",
      "cats",
      "--limit",
      "3",
      "--limit",
      "4",
    ],
    [
      "social",
      "search",
      "--platform",
      "twitter",
      "--query",
      "cats",
      "--platform",
      "reddit",
    ],
    ["social", "read", "--platform", "reddit", "--post-id", "abc"],
    ["social", "read", "--action", "get_post", "--post-id", "abc"],
    [
      "social",
      "read",
      "--platform",
      "reddit",
      "--action",
      "get_post",
      "--limit",
      "0",
    ],
    ["social", "read", "--platform", "reddit", "--action", "post"],
  ]) {
    const result = await runCommand(args, {});
    assert.equal(result.ok, false, args.join(" "));
  }
});

test("CLI social defers limit range to the contract", async () => {
  // 5000 passes CLI parsing (integer >= 1) and fails closed in the handler.
  const result = await runCommand(
    [
      "social",
      "search",
      "--platform",
      "twitter",
      "--query",
      "cats",
      "--limit",
      "5000",
    ],
    {},
  );
  assert.equal(result.ok, false);
});

test("social.search shares one handler across direct, native, and CLI surfaces", async () => {
  const seen: Array<Record<string, unknown>> = [];
  setSocialSearchExecutor(async (args) => {
    seen.push(args);
    return stubResult(searchEnvelope());
  });
  try {
    const ctx = createCommandContext({
      surface: "direct-test",
      env: {},
      invocationId: "parity-search",
    });
    const direct = northstarCommandOf(
      await executeSocialSearch(
        { platform: "twitter", action: "search", query: "cats", limit: 5 },
        ctx,
      ),
    );
    const native = northstarCommandOf(
      await callNativeTool(
        "social",
        { platform: "twitter", action: "search", query: "cats", limit: 5 },
        { env: {} },
      ),
    );
    const cli = await runCommand(
      [
        "social",
        "search",
        "--platform",
        "twitter",
        "--query",
        "cats",
        "--limit",
        "5",
        "--json",
      ],
      {},
    );
    assert.equal(cli.ok, true);
    const parsed = JSON.parse(String(cli.data)) as {
      commandId: string;
      outcome: string;
      data: unknown;
    };
    for (const command of [direct, native]) {
      assert.equal(command.commandId, SOCIAL_SEARCH_COMMAND);
      assert.equal(command.outcome, "success");
    }
    assert.equal(parsed.commandId, SOCIAL_SEARCH_COMMAND);
    assert.equal(parsed.outcome, "success");
    assert.deepEqual(parsed.data, direct.data);
    assert.deepEqual(native.data, direct.data);
    assert.equal(seen.length, 3);
    for (const forwarded of seen) {
      assert.deepEqual(forwarded, {
        platform: "twitter",
        action: "search",
        query: "cats",
        limit: 5,
      });
    }
  } finally {
    setSocialSearchExecutor(undefined);
  }
});

test("social.read shares one handler across direct, native, and CLI surfaces", async () => {
  const seen: Array<Record<string, unknown>> = [];
  setSocialReadExecutor(async (args) => {
    seen.push(args);
    return stubResult(readEnvelope());
  });
  try {
    const ctx = createCommandContext({
      surface: "direct-test",
      env: {},
      invocationId: "parity-read",
    });
    const direct = northstarCommandOf(
      await executeSocialRead(
        { platform: "reddit", action: "get_post", postId: "abc" },
        ctx,
      ),
    );
    const native = northstarCommandOf(
      await callNativeTool(
        "social",
        { platform: "reddit", action: "get_post", postId: "abc" },
        { env: {} },
      ),
    );
    const cli = await runCommand(
      [
        "social",
        "read",
        "--platform",
        "reddit",
        "--action",
        "get_post",
        "--post-id",
        "abc",
        "--json",
      ],
      {},
    );
    assert.equal(cli.ok, true);
    const parsed = JSON.parse(String(cli.data)) as {
      commandId: string;
      outcome: string;
      data: unknown;
    };
    for (const command of [direct, native]) {
      assert.equal(command.commandId, SOCIAL_READ_COMMAND);
      assert.equal(command.outcome, "success");
    }
    assert.equal(parsed.commandId, SOCIAL_READ_COMMAND);
    assert.equal(parsed.outcome, "success");
    assert.deepEqual(parsed.data, direct.data);
    assert.deepEqual(native.data, direct.data);
    assert.equal(seen.length, 3);
    for (const forwarded of seen) {
      assert.deepEqual(forwarded, {
        platform: "reddit",
        action: "get_post",
        postId: "abc",
      });
    }
  } finally {
    setSocialReadExecutor(undefined);
  }
});

test("native social routes remaining reads through registry handler", async () => {
  // Remaining read actions share social.read handler and contract validation.
  // Missing selectors fail in contract validation before any backend dispatch.
  const searchSeen: Array<Record<string, unknown>> = [];
  const readSeen: Array<Record<string, unknown>> = [];
  setSocialSearchExecutor(async (args) => {
    searchSeen.push(args);
    return stubResult(searchEnvelope());
  });
  setSocialReadExecutor(async (args) => {
    readSeen.push(args);
    return stubResult(readEnvelope());
  });
  try {
    const result = await callNativeTool(
      "social",
      { platform: "twitter", action: "get_user_posts", user: "alice" },
      { env: {} },
    ).then(
      (value) => ({ thrown: false as const, value }),
      (error: unknown) => ({ thrown: true as const, error }),
    );
    assert.deepEqual(searchSeen, []);
    assert.equal(result.thrown, false);
    assert.equal(readSeen[0]?.action, "get_user_posts");
  } finally {
    setSocialSearchExecutor(undefined);
    setSocialReadExecutor(undefined);
  }
});
