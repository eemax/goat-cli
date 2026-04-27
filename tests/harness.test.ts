import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { toolError } from "../src/errors.js";
import {
  ensurePathExists,
  executeToolCall,
  exportProviderTools,
  resolveToolPath,
  toRelativeDisplayPath,
} from "../src/harness.js";
import { createToolContextFixture, testToolsConfig, useCleanup } from "./helpers.js";

const { track } = useCleanup();

describe("exportProviderTools", () => {
  test("emits JSON schemas matching enabled tool ids, in order", () => {
    const tools = exportProviderTools(["bash", "read_file", "grep"]);
    expect(tools.map((tool) => tool.name)).toEqual(["bash", "read_file", "grep"]);
    for (const tool of tools) {
      expect(tool).toMatchObject({
        type: "function",
        strict: true,
      });
      expect(tool.parameters).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
    }
  });

  test("throws on unknown tool ids", () => {
    expect(() => exportProviderTools(["bash", "not_a_tool"])).toThrow("unknown tool");
  });
});

describe("executeToolCall", () => {
  test("returns an invalid-arguments envelope for schema failures instead of throwing", async () => {
    const context = await createToolContextFixture({ tempPrefix: "goat-harness-", track });
    const result = await executeToolCall(context, ["read_file"], "read_file", {
      path: "", // violates min(1)
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.code).toBe("INVALID_TOOL_ARGUMENTS");
  });

  test("rejects unknown tool names as a tool error when enabled", async () => {
    const context = await createToolContextFixture({ tempPrefix: "goat-harness-", track });
    // "mystery_tool" is enabled but not in the registry — hits the unknown-tool branch.
    await expect(executeToolCall(context, ["mystery_tool"], "mystery_tool", {})).rejects.toMatchObject({
      code: "TOOL_FAILURE",
      message: expect.stringContaining("unknown tool"),
    });
  });

  test("rejects tools that exist but are not enabled for the agent", async () => {
    const context = await createToolContextFixture({ tempPrefix: "goat-harness-", track });
    await expect(executeToolCall(context, ["read_file"], "bash", { command: "pwd" })).rejects.toMatchObject({
      code: "TOOL_FAILURE",
      message: expect.stringContaining("not enabled"),
    });
  });

  test("acquires the mutation lock exactly once for mutating tools in normal mode", async () => {
    const tracker = { count: 0 };
    const context = await createToolContextFixture({
      tempPrefix: "goat-harness-",
      track,
      mutationLockTracker: tracker,
    });

    await executeToolCall(context, ["write_file", "read_file"], "write_file", {
      path: "note.txt",
      content: "hello",
    });
    expect(tracker.count).toBe(1);

    // Read-only calls must NOT take the lock.
    await executeToolCall(context, ["write_file", "read_file"], "read_file", {
      path: "note.txt",
    });
    expect(tracker.count).toBe(1);

    // A second mutating call re-enters the lock callback (dedup is the caller's job).
    await executeToolCall(context, ["write_file", "read_file"], "write_file", {
      path: "note.txt",
      content: "updated",
    });
    expect(tracker.count).toBe(2);
  });

  test("skips mutation lock acquisition entirely in plan mode", async () => {
    const tracker = { count: 0 };
    const context = await createToolContextFixture({
      tempPrefix: "goat-harness-",
      track,
      planMode: true,
      mutationLockTracker: tracker,
    });

    const result = await executeToolCall(context, ["write_file"], "write_file", {
      path: "note.txt",
      content: "planned",
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.data?.planned).toBe(true);
    expect(tracker.count).toBe(0);
  });

  test("converts thrown GoatError into failure envelopes instead of propagating", async () => {
    const context = await createToolContextFixture({ tempPrefix: "goat-harness-", track });
    // `read_file` throws `toolError("... was not found")` via ensurePathExists.
    const result = await executeToolCall(context, ["read_file"], "read_file", {
      path: "does-not-exist.txt",
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.code).toBe("TOOL_FAILURE");
  });

  test("keeps read-only web_search from touching the mutation lock", async () => {
    const tracker = { count: 0 };
    const context = await createToolContextFixture({
      tempPrefix: "goat-harness-",
      track,
      mutationLockTracker: tracker,
      config: {
        ...testToolsConfig,
        web_search: {
          ...testToolsConfig.web_search,
          api_key_env: "GOAT_TEST_MISSING_EXA_API_KEY",
        },
      },
    });
    const result = await executeToolCall(context, ["web_search"], "web_search", { query: "hi" });
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.message).toContain("missing Exa API key");
    // web_search is read-only, so no lock.
    expect(tracker.count).toBe(0);
  });
});

describe("resolveToolPath", () => {
  test("resolves relative paths against the tool cwd", async () => {
    const context = await createToolContextFixture({ tempPrefix: "goat-harness-", track });
    const absolute = resolveToolPath(context, "subdir/file.txt");
    expect(absolute).toBe(join(context.cwd, "subdir/file.txt"));
  });

  test("preserves absolute paths as-is", async () => {
    const context = await createToolContextFixture({ tempPrefix: "goat-harness-", track });
    expect(resolveToolPath(context, "/etc/hosts")).toBe("/etc/hosts");
  });

  test("rejects empty paths", async () => {
    const context = await createToolContextFixture({ tempPrefix: "goat-harness-", track });
    expect(() => resolveToolPath(context, "   ")).toThrow(toolError("path must not be empty").message);
  });
});

describe("ensurePathExists", () => {
  test("classifies missing paths as not-found", async () => {
    const context = await createToolContextFixture({ tempPrefix: "goat-harness-", track });
    const missing = join(context.cwd, "does-not-exist.txt");
    await expect(ensurePathExists(missing, "file")).rejects.toMatchObject({
      code: "TOOL_FAILURE",
      message: expect.stringContaining("was not found"),
    });
  });

  test("classifies wrong-kind targets explicitly", async () => {
    const context = await createToolContextFixture({ tempPrefix: "goat-harness-", track });
    const target = join(context.cwd, "note.txt");
    await writeFile(target, "hello");
    await expect(ensurePathExists(target, "directory")).rejects.toMatchObject({
      message: expect.stringContaining("is not a directory"),
    });
  });
});

describe("toRelativeDisplayPath", () => {
  test("returns paths relative to cwd when inside", async () => {
    const context = await createToolContextFixture({ tempPrefix: "goat-harness-", track });
    const absolute = join(context.cwd, "nested", "file.txt");
    expect(toRelativeDisplayPath(context, absolute)).toBe("nested/file.txt");
  });

  test("returns absolute paths for targets outside cwd", async () => {
    const context = await createToolContextFixture({ tempPrefix: "goat-harness-", track });
    expect(toRelativeDisplayPath(context, "/etc/hosts")).toBe("/etc/hosts");
  });
});
