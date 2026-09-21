import assert from "node:assert/strict";
import test from "node:test";
import { callNativeTool } from "../src/native-tools.js";
import { setSocialReadExecutor } from "../src/commands/social-read-handler.js";
import { setSocialSearchExecutor } from "../src/commands/social-search-handler.js";

const REDDIT_URL = "https://www.reddit.com/r/test/comments/abc/foo/";

type CommandResult = {
  outcome: string;
  commandId: string;
  error: { code: string; message: string; retryable: boolean };
};

async function captureCommandResult(
  fn: () => Promise<unknown>,
): Promise<CommandResult> {
  try {
    await fn();
  } catch (error) {
    const command = (error as { commandResult?: CommandResult }).commandResult;
    assert.ok(command, "expected a commandResult on failure");
    return command;
  }
  assert.fail("expected the call to reject");
}

test("platform-less social search with reddit URL rejects over-cap limit identically to platform-ful", async () => {
  let dispatched = 0;
  setSocialSearchExecutor(async () => {
    dispatched += 1;
    throw new Error("unreachable: over-cap limit must reject pre-dispatch");
  });
  try {
    const withPlatform = await captureCommandResult(() =>
      callNativeTool(
        "social",
        {
          platform: "reddit",
          action: "search",
          query: "x",
          url: REDDIT_URL,
          limit: 5000,
        },
        { env: {} },
      ),
    );
    const withoutPlatform = await captureCommandResult(() =>
      callNativeTool(
        "social",
        { action: "search", query: "x", url: REDDIT_URL, limit: 5000 },
        { env: {} },
      ),
    );
    assert.equal(withPlatform.error.code, "invalid_request");
    assert.equal(withoutPlatform.error.code, withPlatform.error.code);
    assert.equal(withoutPlatform.error.message, withPlatform.error.message);
    assert.match(withoutPlatform.error.message, /limit must be an integer/);
    assert.equal(dispatched, 0);
  } finally {
    setSocialSearchExecutor(undefined);
  }
});

test("platform-less social read with reddit URL rejects over-cap limit identically to platform-ful", async () => {
  let dispatched = 0;
  setSocialReadExecutor(async () => {
    dispatched += 1;
    throw new Error("unreachable: over-cap limit must reject pre-dispatch");
  });
  try {
    const withPlatform = await captureCommandResult(() =>
      callNativeTool(
        "social",
        {
          platform: "reddit",
          action: "get_post",
          url: REDDIT_URL,
          limit: 5000,
        },
        { env: {} },
      ),
    );
    const withoutPlatform = await captureCommandResult(() =>
      callNativeTool(
        "social",
        { action: "get_post", url: REDDIT_URL, limit: 5000 },
        { env: {} },
      ),
    );
    assert.equal(withPlatform.error.code, "invalid_request");
    assert.equal(withoutPlatform.error.code, withPlatform.error.code);
    assert.equal(withoutPlatform.error.message, withPlatform.error.message);
    assert.match(withoutPlatform.error.message, /limit must be an integer/);
    assert.equal(dispatched, 0);
  } finally {
    setSocialReadExecutor(undefined);
  }
});

test("platform-less remaining social action resolves through registry inference", async () => {
  let searchDispatched = 0;
  let readDispatched = 0;
  setSocialSearchExecutor(async () => {
    searchDispatched += 1;
    throw new Error(
      "unreachable: unmigrated actions must not reach social.search",
    );
  });
  setSocialReadExecutor(async () => {
    readDispatched += 1;
    throw new Error(
      "unreachable: unmigrated actions must not reach social.read",
    );
  });
  try {
    let failure: unknown;
    try {
      await callNativeTool(
        "social",
        { action: "get_followers", url: "https://x.com/someuser", limit: 5 },
        { env: {} },
      );
    } catch (error) {
      failure = error;
    }
    assert.ok(
      failure instanceof Error,
      "expected the legacy path to fail without usable backends",
    );
    assert.equal(
      (failure as { commandResult?: { schema?: string } }).commandResult
        ?.schema,
      "northstar.command-result.v1",
      "migrated failures carry canonical commandResult",
    );
    assert.equal(searchDispatched, 0);
    assert.equal(readDispatched, 1);
  } finally {
    setSocialSearchExecutor(undefined);
    setSocialReadExecutor(undefined);
  }
});
