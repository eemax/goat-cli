import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { executeToolCall, runProcess } from "../src/harness.js";
import { createToolContextFixture, useCleanup } from "./helpers.js";

const { track } = useCleanup();

async function planContext() {
  return createToolContextFixture({ planMode: true, tempPrefix: "goat-bash-plan-", track });
}

type PlanResult = Awaited<ReturnType<typeof executeToolCall>>;

async function runPlanCommand(command: string): Promise<PlanResult> {
  const context = await planContext();
  await writeFile(join(context.cwd, "note.txt"), "alpha\nbeta\ngamma\n");
  return executeToolCall(context, ["bash"], "bash", { command });
}

function errorMessage(result: PlanResult): string {
  if (result.ok) {
    return "";
  }
  return result.error.message;
}

describe("plan-mode bash tokenizer", () => {
  test.each([
    ["backtick substitution", "cat `whoami`"],
    ["dollar substitution", "cat $(whoami)"],
    ["variable expansion", "cat $FOO"],
    ["output redirection", "cat note.txt > out.txt"],
    ["input redirection", "cat < note.txt"],
    ["pipe", "cat note.txt | head"],
    ["background", "cat note.txt &"],
    ["sequential", "cat note.txt; rm note.txt"],
    ["subshell", "(cat note.txt)"],
  ])("rejects shell metacharacters — %s", async (_label, command) => {
    const result = await runPlanCommand(command);
    expect(result.ok).toBe(false);
    expect(errorMessage(result)).toContain("shell metacharacters");
  });

  test("rejects NUL and newline payloads before tokenization", async () => {
    const nul = await runPlanCommand("cat\0note.txt");
    expect(nul.ok).toBe(false);
    expect(errorMessage(nul)).toContain("NUL and newline");
    const newline = await runPlanCommand("cat note.txt\nrm note.txt");
    expect(newline.ok).toBe(false);
    expect(errorMessage(newline)).toContain("NUL and newline");
  });

  test("rejects inline environment assignment before the program", async () => {
    const result = await runPlanCommand("FOO=bar cat note.txt");
    expect(result.ok).toBe(false);
    expect(errorMessage(result)).toContain("inline environment assignment");
  });

  test("rejects unterminated quotes", async () => {
    const result = await runPlanCommand('cat "note.txt');
    expect(result.ok).toBe(false);
    expect(errorMessage(result)).toContain("unterminated quote");
  });

  test("rejects an empty command after tokenization", async () => {
    const result = await runPlanCommand("   ");
    expect(result.ok).toBe(false);
    expect(errorMessage(result)).toContain("must not be empty");
  });
});

describe("plan-mode program allowlist", () => {
  test.each([
    ["unsupported program", "ssh example.com", "unsupported program"],
    ["arguments on pwd", "pwd /tmp", "pwd accepts no arguments"],
    ["unknown ls flag", "ls -Z", "unsupported ls flag"],
    ["unknown wc flag", "wc -w note.txt", "unsupported wc flag"],
    ["head without paths", "head -n 5", "requires at least 1"],
    ["tail bad limit", "tail -n abc note.txt", "requires a positive integer"],
    ["rg missing pattern", "rg -n", "search pattern"],
    ["rg dangerous flag", "rg --pre /bin/echo hello .", "unsupported rg flag"],
    ["fd too many positionals", "fd foo bar baz", "at most 2 positional"],
    ["git without subcommand", "git", "requires a subcommand"],
    ["git subcommand denylist", "git push origin main", "unsupported git subcommand"],
    ["git log unsafe flag", "git log --follow src", "unsupported git log flag"],
    ["git branch non-show-current", "git branch -D old", "only `git branch --show-current`"],
    ["value flag without value", "rg -g", "requires a value after -g"],
  ])("rejects — %s", async (_label, command, snippet) => {
    const result = await runPlanCommand(command);
    expect(result.ok).toBe(false);
    expect(errorMessage(result)).toContain(snippet);
  });
});

describe("plan-mode positive allowlist", () => {
  test("pwd runs with no arguments", async () => {
    const context = await planContext();
    const result = await executeToolCall(context, ["bash"], "bash", { command: "pwd" });
    expect(result.ok).toBe(true);
    expect(result.ok && typeof result.data?.stdout === "string").toBe(true);
  });

  test.each([
    ["ls -la"],
    ["wc -l note.txt"],
    ["head -n 2 note.txt"],
    ["tail -n 1 note.txt"],
    ["cat note.txt"],
    ["stat note.txt"],
    ["rg --files"],
    ["rg -n alpha note.txt"],
  ])("allows %s", async (command) => {
    const context = await planContext();
    await writeFile(join(context.cwd, "note.txt"), "alpha\nbeta\ngamma\n");
    await mkdir(join(context.cwd, "nested"), { recursive: true });
    await writeFile(join(context.cwd, "nested", "inside.txt"), "inside\n");
    const result = await executeToolCall(context, ["bash"], "bash", { command });
    expect(result.ok).toBe(true);
  });

  test("git status --porcelain is accepted on an empty repo", async () => {
    const context = await planContext();
    await runProcess("git", ["init", "-q", "-b", "main"], { cwd: context.cwd });
    const result = await executeToolCall(context, ["bash"], "bash", {
      command: "git status --porcelain",
    });
    expect(result.ok).toBe(true);
  });

  test("git rev-parse --is-inside-work-tree is accepted", async () => {
    const context = await planContext();
    await runProcess("git", ["init", "-q", "-b", "main"], { cwd: context.cwd });
    const result = await executeToolCall(context, ["bash"], "bash", {
      command: "git rev-parse --is-inside-work-tree",
    });
    expect(result.ok).toBe(true);
  });

  test("git log --oneline -n passes the plan-mode validator", async () => {
    // We don't need real commits to prove the validator accepts `-n 5` — if the
    // validator rejected it the result error would be a TOOL_FAILURE from
    // validatePlanCommand, not a PLAN_MODE_SHELL_FAILED from the actual git
    // invocation.
    const context = await planContext();
    await runProcess("git", ["init", "-q", "-b", "main"], { cwd: context.cwd });
    const result = await executeToolCall(context, ["bash"], "bash", {
      command: "git log --oneline -n 5",
    });
    if (!result.ok) {
      expect(result.error.code).not.toBe("TOOL_FAILURE");
      expect(result.error.code).toBe("PLAN_MODE_SHELL_FAILED");
    }
  });
});

describe("plan-mode env and shell overrides", () => {
  test("empty env object is accepted (only non-empty env is rejected)", async () => {
    const context = await planContext();
    const result = await executeToolCall(context, ["bash"], "bash", {
      command: "pwd",
      env: {},
    });
    expect(result.ok).toBe(true);
  });

  test("non-empty env override is rejected", async () => {
    const context = await planContext();
    const result = await executeToolCall(context, ["bash"], "bash", {
      command: "pwd",
      env: { FOO: "bar" },
    });
    expect(result.ok).toBe(false);
    expect(errorMessage(result)).toContain("env overrides");
  });

  test("shell override is rejected", async () => {
    const context = await planContext();
    const result = await executeToolCall(context, ["bash"], "bash", {
      command: "pwd",
      shell: "/bin/sh",
    });
    expect(result.ok).toBe(false);
    expect(errorMessage(result)).toContain("shell overrides");
  });
});
