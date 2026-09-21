import assert from "node:assert/strict";
import test from "node:test";
import type { BackendCallResult } from "../../src/backend.js";
import { createCommandContext } from "../../src/commands/command-context.js";
import {
  executeSocialRead,
  mapSocialReadCommandResult,
  setSocialReadExecutor,
  SOCIAL_READ_COMMAND,
} from "../../src/commands/social-read-handler.js";
import {
  buildNorthstarResult,
  type NorthstarResultV1,
} from "../../src/result-contract.js";
import { SocialError } from "../../src/social/social-contract.js";

function ctx(env: Record<string, string | undefined> = {}) {
  return createCommandContext({
    surface: "cli",
    env,
    invocationId: "social-read-test",
  });
}

type CommandFailure = {
  commandResult?: {
    outcome: string;
    commandId: string;
    error: { code: string; message: string; retryable: boolean };
  };
};

async function fails(
  args: Record<string, unknown>,
  env: Record<string, string | undefined> = {},
): Promise<NonNullable<CommandFailure["commandResult"]>> {
  try {
    await executeSocialRead(args, ctx(env));
  } catch (error) {
    const command = (error as CommandFailure).commandResult;
    assert.ok(command, "expected a commandResult on failure");
    return command;
  }
  assert.fail("expected executeSocialRead to throw");
}

function entity(id: string) {
  return {
    entityVersion: 1 as const,
    kind: "social_post" as const,
    id,
    source: "reddit",
    title: "T",
    url: "https://www.reddit.com/r/test/comments/abc/",
  };
}

function envelopeFor(
  status: "ok" | "empty" | "partial" | "degraded" | "error",
): NorthstarResultV1 {
  if (status === "partial") {
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
          entities: [entity("reddit:social_post:abc")],
        },
        {
          source: "reddit",
          backend: "fake-2",
          error: {
            code: "backend_http_error",
            message: "boom",
            retryable: true,
          },
        },
      ],
      pagination: { supported: false, limit: 1, hasMore: false },
    });
  }
  if (status === "degraded") {
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
          entities: [entity("reddit:social_post:abc")],
          degraded: true,
        },
      ],
      pagination: { supported: false, limit: 1, hasMore: false },
    });
  }
  if (status === "error") {
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
          error: {
            code: "backend_unavailable",
            message: "down",
            retryable: true,
          },
        },
      ],
      pagination: { supported: false, limit: 0, hasMore: false },
    });
  }
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
        ...(status === "ok"
          ? { entities: [entity("reddit:social_post:abc")] }
          : { entities: [] }),
      },
    ],
    pagination: { supported: false, limit: 1, hasMore: false },
  });
}

function stubResult(envelope: NorthstarResultV1): BackendCallResult {
  return {
    content: [{ type: "text", text: "fake" }],
    details: { northstar: envelope },
  };
}

// ── Outcome mapping ──

test("social.read maps envelope statuses to command outcomes", () => {
  for (const [status, outcome] of [
    ["ok", "success"],
    ["empty", "empty"],
    ["partial", "partial"],
    ["degraded", "degraded"],
    ["error", "failed"],
  ] as const) {
    const result = mapSocialReadCommandResult(envelopeFor(status), ctx());
    assert.equal(result.commandId, SOCIAL_READ_COMMAND);
    assert.equal(result.outcome, outcome);
    assert.equal(result.trust, "external");
    assert.equal(result.resolvedSurface, SOCIAL_READ_COMMAND);
  }
});

// ── Slice coverage: all six read actions ──

test("social.read serves get_post/thread/comments/profile/community/feed with stamp", async () => {
  const seen: Array<Record<string, unknown>> = [];
  setSocialReadExecutor(async (args) => {
    seen.push(args);
    return stubResult(envelopeFor("ok"));
  });
  try {
    const cases: Array<Record<string, unknown>> = [
      { platform: "twitter", action: "get_post", postId: "p1" },
      { platform: "twitter", action: "get_thread", postId: "p1" },
      { platform: "reddit", action: "get_comments", postId: "abc" },
      { platform: "reddit", action: "get_profile", user: "u1" },
      { platform: "reddit", action: "get_community", community: "c1" },
      { platform: "twitter", action: "get_feed" },
    ];
    for (const args of cases) {
      const result = await executeSocialRead(args, ctx());
      const command = (result.details as Record<string, unknown>)
        .northstarCommand as {
        commandId: string;
        outcome: string;
      };
      assert.equal(command.commandId, SOCIAL_READ_COMMAND);
      assert.equal(command.outcome, "success");
    }
    assert.equal(seen.length, cases.length);
    assert.deepEqual(
      seen.map((entry) => entry.action),
      cases.map((entry) => entry.action),
    );
  } finally {
    setSocialReadExecutor(undefined);
  }
});

test("social.read forwards opaque cursors untouched for contract binding", async () => {
  const seen: Array<Record<string, unknown>> = [];
  setSocialReadExecutor(async (args) => {
    seen.push(args);
    return stubResult(envelopeFor("ok"));
  });
  try {
    await executeSocialRead(
      {
        platform: "twitter",
        action: "get_post",
        postId: "p1",
        cursor: "opaque-cursor-1",
      },
      ctx(),
    );
    assert.equal(seen[0]?.cursor, "opaque-cursor-1");
  } finally {
    setSocialReadExecutor(undefined);
  }
});

// ── Strict input gate ──

test("social.read rejects missing/legacy/out-of-slice actions pre-dispatch", async () => {
  let dispatched = 0;
  setSocialReadExecutor(async () => {
    dispatched += 1;
    return stubResult(envelopeFor("ok"));
  });
  try {
    assert.equal(
      (await fails({ platform: "twitter", postId: "p1" })).error.code,
      "invalid_request",
    );
    for (const action of [
      "read",
      "post",
      "subreddit",
      "note",
      "topic",
      "video",
      "search",
    ]) {
      const command = await fails({
        platform: "twitter",
        action,
        postId: "p1",
      });
      assert.equal(
        command.error.code,
        "unsupported_action",
        `action ${action}`,
      );
    }
    assert.equal(dispatched, 0);
  } finally {
    setSocialReadExecutor(undefined);
  }
});

test("social.read rejects unknown fields, bad platform, and bad limits without dispatch", async () => {
  let dispatched = 0;
  setSocialReadExecutor(async () => {
    dispatched += 1;
    return stubResult(envelopeFor("ok"));
  });
  try {
    assert.equal(
      (
        await fails({
          platform: "twitter",
          action: "get_post",
          postId: "p",
          nope: 1,
        })
      ).error.code,
      "invalid_request",
    );
    assert.equal(
      (await fails({ platform: "nope", action: "get_post", postId: "p" })).error
        .code,
      "invalid_request",
    );
    for (const limit of [0, 101, 2.5, Number.NaN, "10"]) {
      const command = await fails({
        platform: "twitter",
        action: "get_post",
        postId: "p",
        limit,
      });
      assert.equal(
        command.error.code,
        "invalid_request",
        `limit ${String(limit)}`,
      );
      assert.match(command.error.message, /limit must be an integer 1\.\.100/);
    }
    assert.equal(dispatched, 0);
  } finally {
    setSocialReadExecutor(undefined);
  }
});

test("social.read rejection messages never echo credential-shaped values", async () => {
  setSocialReadExecutor(async () => {
    assert.fail("no dispatch on rejection");
    throw new Error("unreachable");
  });
  try {
    const secret = "SECRET-test-cookie-value";
    const command = await fails({
      platform: "twitter",
      action: "get_post",
      postId: secret,
      limit: 999,
    });
    assert.equal(command.error.code, "invalid_request");
    assert.ok(
      !command.error.message.includes(secret),
      "limit message must not echo the selector",
    );
  } finally {
    setSocialReadExecutor(undefined);
  }
});

// ── Terminality ──

test("social.read auth failure is terminal and never echoes the token", async () => {
  const token = "TOKEN-test-auth-value";
  setSocialReadExecutor(async () => {
    throw new SocialError("authentication_required", "auth failed", {
      platform: "reddit",
    });
  });
  try {
    const command = await fails({
      platform: "twitter",
      action: "get_post",
      postId: "p",
    });
    assert.equal(command.outcome, "failed");
    assert.equal(command.error.code, "authentication_required");
    assert.equal(command.error.retryable, false);
    assert.equal(command.error.message, "auth failed");
    assert.ok(
      !command.error.message.includes(token),
      "handler must not append credential material",
    );
  } finally {
    setSocialReadExecutor(undefined);
  }
});

test("social.read rate limit and cursor errors stay terminal with codes preserved", async () => {
  for (const code of [
    "rate_limited",
    "cursor_invalid",
    "cursor_mismatch",
  ] as const) {
    setSocialReadExecutor(async () => {
      throw new SocialError(code, `${code} happened`, { platform: "reddit" });
    });
    try {
      const command = await fails({
        platform: "reddit",
        action: "get_comments",
        postId: "abc",
      });
      assert.equal(command.outcome, "failed");
      assert.equal(command.error.code, code);
    } finally {
      setSocialReadExecutor(undefined);
    }
  }
});

test("social.read maps abort to cancelled without dispatch", async () => {
  const controller = new AbortController();
  controller.abort();
  let dispatched = 0;
  setSocialReadExecutor(async () => {
    dispatched += 1;
    return stubResult(envelopeFor("ok"));
  });
  try {
    try {
      await executeSocialRead(
        { platform: "twitter", action: "get_post", postId: "p" },
        { ...ctx(), signal: controller.signal },
      );
    } catch (error) {
      assert.equal(
        (error as CommandFailure).commandResult?.outcome,
        "cancelled",
      );
      assert.equal(dispatched, 0);
      return;
    }
    assert.fail("expected cancellation to throw");
  } finally {
    setSocialReadExecutor(undefined);
  }
});

test("social.read without a canonical envelope fails malformed_upstream", async () => {
  setSocialReadExecutor(async () => ({ content: [], details: {} }));
  try {
    const command = await fails({
      platform: "twitter",
      action: "get_post",
      postId: "p",
    });
    assert.equal(command.error.code, "malformed_upstream");
  } finally {
    setSocialReadExecutor(undefined);
  }
});
