import { describe, expect, test } from "bun:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ArtifactStore } from "../src/artifacts.js";
import { executeToolCall, exportProviderTools, runProcess } from "../src/harness.js";
import { createTempDir, testToolsConfig, useCleanup } from "./helpers.js";

const { track } = useCleanup();

async function createContext(planMode = false) {
  const runRoot = await createTempDir("goat-run-");
  track(runRoot);
  const cwd = join(runRoot, "workspace");
  const artifactsDir = join(runRoot, "artifacts");
  await mkdir(cwd, { recursive: true });
  return {
    cwd,
    planMode,
    config: testToolsConfig,
    artifacts: new ArtifactStore(runRoot, artifactsDir),
    runRoot,
    ensureMutationLock: async () => undefined,
  };
}

describe("tool registry", () => {
  test("exports provider tool schemas", () => {
    const tools = exportProviderTools(["read_file", "write_file", "bash"]);
    expect(tools.map((tool) => tool.name)).toEqual(["read_file", "write_file", "bash"]);
    expect(tools[0]?.parameters).toHaveProperty("type", "object");
  });
});

describe("file tools", () => {
  test("reads, writes, and replaces file content", async () => {
    const context = await createContext();
    const target = join(context.cwd, "note.txt");

    const writeResult = await executeToolCall(context, ["write_file", "read_file", "replace_in_file"], "write_file", {
      path: "note.txt",
      content: "hello world",
    });
    expect(writeResult.ok).toBe(true);

    const readResult = await executeToolCall(context, ["write_file", "read_file", "replace_in_file"], "read_file", {
      path: "note.txt",
    });
    expect(readResult.ok).toBe(true);
    expect(readResult.ok && readResult.data?.content).toBe("hello world");

    const replaceResult = await executeToolCall(
      context,
      ["write_file", "read_file", "replace_in_file"],
      "replace_in_file",
      {
        path: "note.txt",
        old_text: "world",
        new_text: "goat",
      },
    );
    expect(replaceResult.ok).toBe(true);
    expect(await readFile(target, "utf8")).toBe("hello goat");
  });

  test("returns planned results for mutating file tools", async () => {
    const context = await createContext(true);
    const result = await executeToolCall(context, ["write_file"], "write_file", {
      path: "note.txt",
      content: "hello",
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.data?.planned).toBe(true);
  });
});

describe("search tools", () => {
  test("glob and grep use rg and return structured results", async () => {
    const context = await createContext();
    await writeFile(join(context.cwd, "one.ts"), "export const one = 1;\n");
    await writeFile(join(context.cwd, "two.ts"), "export const two = 2;\n");

    const globResult = await executeToolCall(context, ["glob", "grep"], "glob", {
      pattern: "*.ts",
    });
    expect(globResult.ok).toBe(true);
    expect(globResult.ok && globResult.data?.matches).toEqual(["one.ts", "two.ts"]);

    const grepResult = await executeToolCall(context, ["glob", "grep"], "grep", {
      pattern: "two",
    });
    expect(grepResult.ok).toBe(true);
    expect(grepResult.ok && Array.isArray(grepResult.data?.matches)).toBe(true);
  });
});

describe("bash tool", () => {
  test("runs shell commands in normal mode", async () => {
    const context = await createContext();
    const result = await executeToolCall(context, ["bash"], "bash", {
      command: "printf 'hi'",
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.data?.stdout).toBe("hi");
  });

  test("restricts plan-mode commands and executes read-only subset", async () => {
    const context = await createContext(true);
    await writeFile(join(context.cwd, "note.txt"), "hello\n");
    const result = await executeToolCall(context, ["bash"], "bash", {
      command: "cat note.txt",
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.data?.stdout).toBe("hello\n");

    const invalid = await executeToolCall(context, ["bash"], "bash", {
      command: "echo hello > note.txt",
    });
    expect(invalid.ok).toBe(false);

    const dangerousRg = await executeToolCall(context, ["bash"], "bash", {
      command: "rg --pre /bin/echo hello .",
    });
    expect(dangerousRg.ok).toBe(false);
  });

  test("allows safe git and rg commands in plan mode", async () => {
    const context = await createContext(true);
    await writeFile(join(context.cwd, "note.txt"), "goat\n");
    await runProcess("git", ["init", "-q"], { cwd: context.cwd });

    const gitStatus = await executeToolCall(context, ["bash"], "bash", {
      command: "git status --short",
    });
    expect(gitStatus.ok).toBe(true);

    const rgResult = await executeToolCall(context, ["bash"], "bash", {
      command: "rg -n goat note.txt",
    });
    expect(rgResult.ok).toBe(true);
    expect(rgResult.ok && rgResult.data?.stdout).toContain("1:goat");
  });

  test("rejects unsafe plan-mode command patterns and override inputs", async () => {
    const context = await createContext(true);
    await writeFile(join(context.cwd, "note.txt"), "hello\n");

    const disallowedCommands = [
      {
        command: "git push",
        message: "unsupported git subcommand",
      },
      {
        command: "FOO=bar cat note.txt",
        message: "inline environment assignment",
      },
      {
        command: 'cat "note.txt',
        message: "unterminated quote",
      },
    ];

    for (const testCase of disallowedCommands) {
      const result = await executeToolCall(context, ["bash"], "bash", {
        command: testCase.command,
      });
      expect(result.ok).toBe(false);
      expect(result.ok ? null : result.error.message).toContain(testCase.message);
    }

    const envOverride = await executeToolCall(context, ["bash"], "bash", {
      command: "cat note.txt",
      env: {
        FOO: "bar",
      },
    });
    expect(envOverride.ok).toBe(false);
    expect(envOverride.ok ? null : envOverride.error.message).toContain("env overrides");

    const shellOverride = await executeToolCall(context, ["bash"], "bash", {
      command: "cat note.txt",
      shell: "/bin/sh",
    });
    expect(shellOverride.ok).toBe(false);
    expect(shellOverride.ok ? null : shellOverride.error.message).toContain("shell overrides");
  });

  test("returns error envelopes for non-zero shell exits in normal mode", async () => {
    const context = await createContext();
    const result = await executeToolCall(context, ["bash"], "bash", {
      command: "exit 7",
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.code).toBe("SHELL_COMMAND_FAILED");
    expect(result.ok ? null : result.error.message).toContain("command exited with 7");
  });
});

describe("patch and stub tools", () => {
  test("applies structured patches", async () => {
    const context = await createContext();
    await writeFile(join(context.cwd, "note.txt"), "hello\nworld\n");
    const patch = `*** Begin Patch
*** Update File: note.txt
@@
 hello
-world
+goat
*** End Patch`;
    const result = await executeToolCall(context, ["apply_patch"], "apply_patch", {
      patch,
    });
    expect(result.ok).toBe(true);
    expect(await readFile(join(context.cwd, "note.txt"), "utf8")).toBe("hello\ngoat\n");
  });

  test("accepts trailing newline after end marker and rename-only updates", async () => {
    const context = await createContext();
    await writeFile(join(context.cwd, "note.txt"), "hello\n");

    const renamePatch = `*** Begin Patch
*** Update File: note.txt
*** Move to: renamed.txt
*** End Patch
`;
    const renameResult = await executeToolCall(context, ["apply_patch"], "apply_patch", {
      patch: renamePatch,
    });

    expect(renameResult.ok).toBe(true);
    expect(await readFile(join(context.cwd, "renamed.txt"), "utf8")).toBe("hello\n");
  });

  test("applies multi-hunk patches", async () => {
    const context = await createContext();
    await writeFile(join(context.cwd, "multi.txt"), "aaa\nbbb\nccc\nddd\neee\n");
    const patch = `*** Begin Patch
*** Update File: multi.txt
@@
 aaa
-bbb
+BBB
@@
 ddd
-eee
+EEE
*** End Patch`;
    const result = await executeToolCall(context, ["apply_patch"], "apply_patch", { patch });
    expect(result.ok).toBe(true);
    expect(await readFile(join(context.cwd, "multi.txt"), "utf8")).toBe("aaa\nBBB\nccc\nddd\nEEE\n");
  });

  test("deletes files via patch", async () => {
    const context = await createContext();
    await writeFile(join(context.cwd, "doomed.txt"), "goodbye\n");
    const patch = `*** Begin Patch
*** Delete File: doomed.txt
*** End Patch`;
    const result = await executeToolCall(context, ["apply_patch"], "apply_patch", { patch });
    expect(result.ok).toBe(true);
    await expect(stat(join(context.cwd, "doomed.txt"))).rejects.toThrow();
  });

  test("adds new files via patch", async () => {
    const context = await createContext();
    const patch = `*** Begin Patch
*** Add File: brand-new.txt
+line one
+line two
*** End Patch`;
    const result = await executeToolCall(context, ["apply_patch"], "apply_patch", { patch });
    expect(result.ok).toBe(true);
    expect(await readFile(join(context.cwd, "brand-new.txt"), "utf8")).toBe("line one\nline two\n");
  });

  test("rejects patch when context does not match file content", async () => {
    const context = await createContext();
    await writeFile(join(context.cwd, "note.txt"), "actual content\n");
    const patch = `*** Begin Patch
*** Update File: note.txt
@@
 wrong context
-actual content
+replaced
*** End Patch`;
    const result = await executeToolCall(context, ["apply_patch"], "apply_patch", { patch });
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.message).toContain("did not match");
  });

  test("rejects patch when hunk matches multiple locations", async () => {
    const context = await createContext();
    await writeFile(join(context.cwd, "dup.txt"), "aaa\nbbb\naaa\nbbb\n");
    const patch = `*** Begin Patch
*** Update File: dup.txt
@@
 aaa
-bbb
+ccc
*** End Patch`;
    const result = await executeToolCall(context, ["apply_patch"], "apply_patch", { patch });
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.message).toContain("multiple locations");
  });

  test("anchors patch to end of file with End of File marker", async () => {
    const context = await createContext();
    await writeFile(join(context.cwd, "eof.txt"), "first\nsecond\nthird\n");
    const patch = `*** Begin Patch
*** Update File: eof.txt
@@
 second
-third
+THIRD
*** End of File
*** End Patch`;
    const result = await executeToolCall(context, ["apply_patch"], "apply_patch", { patch });
    expect(result.ok).toBe(true);
    expect(await readFile(join(context.cwd, "eof.txt"), "utf8")).toBe("first\nsecond\nTHIRD\n");
  });

  test("rejects empty patches", async () => {
    const context = await createContext();
    const result = await executeToolCall(context, ["apply_patch"], "apply_patch", {
      patch: `*** Begin Patch
*** End Patch`,
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.message).toContain("at least one hunk");
  });

  test("returns explicit unimplemented failures for stub tools", async () => {
    const context = await createContext();
    const result = await executeToolCall(context, ["web_search"], "web_search", {
      query: "hello",
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.code).toBe("UNIMPLEMENTED_IN_V1");
  });
});
