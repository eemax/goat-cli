import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { executeToolCall } from "../src/harness.js";
import { createToolContextFixture, useCleanup } from "./helpers.js";

const { track } = useCleanup();

async function ctx() {
  return createToolContextFixture({ tempPrefix: "goat-patch-errors-", track });
}

function errorMessage(result: Awaited<ReturnType<typeof executeToolCall>>): string {
  return result.ok ? "" : result.error.message;
}

describe("patch parser error paths", () => {
  test.each([
    [
      "missing begin marker",
      `*** Update File: a.txt
@@
 hello
-hello
+world
*** End Patch`,
      "must start with",
    ],
    [
      "missing end marker",
      `*** Begin Patch
*** Update File: a.txt
@@
 hello
-hello
+world`,
      "must end with",
    ],
    [
      "unrecognized line between markers",
      `*** Begin Patch
nonsense
*** End Patch`,
      "unrecognized patch line",
    ],
    [
      "add file with no body",
      `*** Begin Patch
*** Add File: new.txt
*** End Patch`,
      "at least one line",
    ],
    [
      "add file with unprefixed body",
      `*** Begin Patch
*** Add File: new.txt
hello
*** End Patch`,
      "must use `+` lines",
    ],
    [
      "update with no hunks and no move",
      `*** Begin Patch
*** Update File: note.txt
*** End Patch`,
      "must contain changes or a move target",
    ],
    [
      "invalid prefix in update hunk",
      `*** Begin Patch
*** Update File: note.txt
@@
?unknown prefix
*** End Patch`,
      "invalid patch change line",
    ],
  ])("rejects — %s", async (_label, patch, snippet) => {
    const context = await ctx();
    const result = await executeToolCall(context, ["apply_patch"], "apply_patch", { patch });
    expect(result.ok).toBe(false);
    expect(errorMessage(result)).toContain(snippet);
  });
});

describe("patch application error paths", () => {
  test("add fails when the target already exists", async () => {
    const context = await ctx();
    await writeFile(join(context.cwd, "note.txt"), "already here\n");
    const patch = `*** Begin Patch
*** Add File: note.txt
+replacement
*** End Patch`;
    const result = await executeToolCall(context, ["apply_patch"], "apply_patch", { patch });
    expect(result.ok).toBe(false);
    expect(errorMessage(result)).toContain("already exists");
  });

  test("delete fails when the target does not exist", async () => {
    const context = await ctx();
    const patch = `*** Begin Patch
*** Delete File: ghost.txt
*** End Patch`;
    const result = await executeToolCall(context, ["apply_patch"], "apply_patch", { patch });
    expect(result.ok).toBe(false);
    expect(errorMessage(result)).toContain("does not exist");
  });

  test("update fails when the target does not exist", async () => {
    const context = await ctx();
    const patch = `*** Begin Patch
*** Update File: ghost.txt
@@
 anything
-anything
+altered
*** End Patch`;
    const result = await executeToolCall(context, ["apply_patch"], "apply_patch", { patch });
    expect(result.ok).toBe(false);
    expect(errorMessage(result)).toContain("does not exist");
  });

  test("reports filesystem errors distinctly from does-not-exist", async () => {
    // Make a subdirectory unreadable so add-file stat() hits EACCES, not ENOENT.
    // This is best-effort: if the test runner is root and perms are ignored,
    // we accept either the permission message or a successful add.
    const context = await ctx();
    const lockedDir = join(context.cwd, "locked");
    await mkdir(lockedDir, { recursive: true });
    const target = join(lockedDir, "inner.txt");
    await writeFile(target, "hidden\n");
    await chmod(lockedDir, 0o000);
    try {
      const patch = `*** Begin Patch
*** Add File: locked/inner.txt
+clobber
*** End Patch`;
      const result = await executeToolCall(context, ["apply_patch"], "apply_patch", { patch });
      if (!result.ok) {
        // Either the EACCES branch in our code, or the pre-existing-file branch
        // if the OS still let us stat inside the locked dir.
        expect(result.error.message).toMatch(/permission|already exists|denied/i);
      }
    } finally {
      await chmod(lockedDir, 0o755);
    }
  });
});

describe("multi-hunk patch ordering", () => {
  test("rejects patches where the second hunk no longer matches after the first", async () => {
    const context = await ctx();
    await writeFile(join(context.cwd, "multi.txt"), "aaa\nbbb\nccc\n");
    // Second hunk still references the pre-first-hunk state.
    const patch = `*** Begin Patch
*** Update File: multi.txt
@@
 aaa
-bbb
+BBB
@@
 bbb
-ccc
+CCC
*** End Patch`;
    const result = await executeToolCall(context, ["apply_patch"], "apply_patch", { patch });
    expect(result.ok).toBe(false);
    expect(errorMessage(result)).toContain("did not match");
  });
});

describe("patch EOF-anchored hunks on short files", () => {
  test("rejects EOF-anchored hunks whose context exceeds file length", async () => {
    const context = await ctx();
    await writeFile(join(context.cwd, "tiny.txt"), "only line\n");
    const patch = `*** Begin Patch
*** Update File: tiny.txt
@@
 nonexistent
 still not there
-only line
+replaced
*** End of File
*** End Patch`;
    const result = await executeToolCall(context, ["apply_patch"], "apply_patch", { patch });
    expect(result.ok).toBe(false);
    expect(errorMessage(result)).toContain("did not match");
  });
});

describe("patch move-only updates", () => {
  test("a plain rename preserves content", async () => {
    const context = await ctx();
    await writeFile(join(context.cwd, "src.txt"), "persisted\nbody\n");
    const patch = `*** Begin Patch
*** Update File: src.txt
*** Move to: dst.txt
*** End Patch`;
    const result = await executeToolCall(context, ["apply_patch"], "apply_patch", { patch });
    expect(result.ok).toBe(true);
    await expect(readFile(join(context.cwd, "src.txt"), "utf8")).rejects.toThrow();
    expect(await readFile(join(context.cwd, "dst.txt"), "utf8")).toBe("persisted\nbody\n");
  });
});
