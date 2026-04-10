import { basename } from "node:path";
import { toolError } from "./errors.js";
import type { ToolContext } from "./harness.js";
import {
  ensurePathExists,
  maybeArtifactForText,
  resolveToolPath,
  runProcess,
  toRelativeDisplayPath,
} from "./harness.js";
import type { ToolEnvelope } from "./types.js";

const FORBIDDEN_PLAN_CHARACTERS = /[$`><|&;()]/;
const SAFE_LS_FLAGS = new Set(["-1", "-a", "-A", "-l", "-h", "-la", "-al", "-lah", "-ahl", "-lha", "-hal"]);
const SAFE_WC_FLAGS = new Set(["-l", "-c", "-m"]);
const SAFE_RG_FLAGS = new Set([
  "--files",
  "--hidden",
  "-n",
  "--line-number",
  "-i",
  "--ignore-case",
  "-F",
  "--fixed-strings",
  "-S",
  "--smart-case",
  "-l",
  "--files-with-matches",
  "-uu",
]);
const SAFE_RG_VALUE_FLAGS = new Set(["-g", "--glob", "-m", "--max-count"]);
const SAFE_FD_FLAGS = new Set(["-H", "--hidden", "-I", "--no-ignore", "-a", "--absolute-path", "-g", "--glob"]);
const SAFE_FD_VALUE_FLAGS = new Set(["-t", "--type", "-d", "--max-depth"]);
const SAFE_GIT_STATUS_FLAGS = new Set(["--short", "-s", "--branch", "-b", "--porcelain"]);
const SAFE_GIT_DIFF_FLAGS = new Set([
  "--stat",
  "--name-only",
  "--name-status",
  "--cached",
  "--staged",
  "--summary",
  "--no-ext-diff",
]);
const SAFE_GIT_SHOW_FLAGS = new Set([
  "--stat",
  "--name-only",
  "--name-status",
  "--summary",
  "--no-patch",
  "--no-ext-diff",
]);
const SAFE_GIT_LOG_FLAGS = new Set([
  "--oneline",
  "--stat",
  "--name-only",
  "--name-status",
  "--decorate",
  "--graph",
  "--no-ext-diff",
]);
const SAFE_GIT_LOG_VALUE_FLAGS = new Set(["-n", "--max-count"]);
const SAFE_GIT_REV_PARSE_FLAGS = new Set([
  "--show-toplevel",
  "--git-dir",
  "--show-prefix",
  "--show-cdup",
  "--is-inside-work-tree",
  "--abbrev-ref",
]);
const SAFE_GIT_LS_FILES_FLAGS = new Set([
  "--others",
  "--cached",
  "--modified",
  "--deleted",
  "--ignored",
  "--exclude-standard",
]);

function tokenizePlanCommand(command: string): string[] {
  if (command.includes("\0") || command.includes("\n")) {
    throw toolError("plan-mode bash rejects NUL and newline characters");
  }

  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote) {
    throw toolError("unterminated quote in plan-mode bash command");
  }
  if (current) {
    tokens.push(current);
  }
  if (tokens.length === 0) {
    throw toolError("bash command must not be empty");
  }
  for (const token of tokens) {
    if (FORBIDDEN_PLAN_CHARACTERS.test(token)) {
      throw toolError("plan-mode bash rejected shell metacharacters");
    }
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
    throw toolError("plan-mode bash rejected inline environment assignment");
  }
  return tokens;
}

function ensurePositiveInteger(program: string, flag: string, value: string | undefined): void {
  if (!value || !/^\d+$/.test(value)) {
    throw toolError(`${program} requires a positive integer after ${flag}`);
  }
}

function validatePlainArguments(program: string, args: string[], minimum = 0): void {
  if (args.length < minimum) {
    throw toolError(`${program} requires at least ${minimum} path argument(s) in plan mode`);
  }
  for (const arg of args) {
    if (arg.startsWith("-")) {
      throw toolError(`unsupported ${program} flag in plan mode: ${arg}`);
    }
  }
}

function validateHeadOrTail(program: "head" | "tail", args: string[]): void {
  let index = 0;
  if (args[index] === "-n") {
    ensurePositiveInteger(program, "-n", args[index + 1]);
    index += 2;
  }
  validatePlainArguments(program, args.slice(index), 1);
}

function validateWc(args: string[]): void {
  const paths: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-")) {
      if (!SAFE_WC_FLAGS.has(arg)) {
        throw toolError(`unsupported wc flag in plan mode: ${arg}`);
      }
      continue;
    }
    paths.push(arg);
  }
  validatePlainArguments("wc", paths, 1);
}

function validateTree(args: string[]): void {
  let index = 0;
  while (index < args.length) {
    const arg = args[index]!;
    if (arg === "-a") {
      index += 1;
      continue;
    }
    if (arg === "-L") {
      ensurePositiveInteger("tree", "-L", args[index + 1]);
      index += 2;
      continue;
    }
    break;
  }
  validatePlainArguments("tree", args.slice(index));
}

function validateFlagSubset(
  program: string,
  args: string[],
  safeFlags: Set<string>,
  safeValueFlags: Set<string>,
  constraints?: {
    maxPositionals?: number;
    requirePositionals?: boolean;
  },
): number {
  let positionals = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (safeFlags.has(arg)) {
      continue;
    }
    if (safeValueFlags.has(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw toolError(`${program} requires a value after ${arg}`);
      }
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      throw toolError(`unsupported ${program} flag in plan mode: ${arg}`);
    }
    positionals += 1;
  }

  if (constraints?.requirePositionals && positionals === 0) {
    throw toolError(`${program} requires at least one positional argument in plan mode`);
  }
  if (constraints?.maxPositionals !== undefined && positionals > constraints.maxPositionals) {
    throw toolError(`${program} accepts at most ${constraints.maxPositionals} positional argument(s) in plan mode`);
  }

  return positionals;
}

function validateRg(args: string[]): void {
  const hasFilesMode = args.includes("--files");
  const positionals = validateFlagSubset("rg", args, SAFE_RG_FLAGS, SAFE_RG_VALUE_FLAGS);
  if (!hasFilesMode && positionals === 0) {
    throw toolError("rg requires a search pattern in plan mode");
  }
}

function validateFd(args: string[]): void {
  validateFlagSubset("fd", args, SAFE_FD_FLAGS, SAFE_FD_VALUE_FLAGS, {
    maxPositionals: 2,
  });
}

function validateGit(args: string[]): void {
  const [subcommand, ...rest] = args;
  if (!subcommand) {
    throw toolError("git requires a subcommand in plan mode");
  }

  switch (subcommand) {
    case "status":
      validateFlagSubset("git status", rest, SAFE_GIT_STATUS_FLAGS, new Set());
      return;
    case "diff":
      validateFlagSubset("git diff", rest, SAFE_GIT_DIFF_FLAGS, new Set());
      return;
    case "show":
      validateFlagSubset("git show", rest, SAFE_GIT_SHOW_FLAGS, new Set(), {
        maxPositionals: 2,
      });
      return;
    case "log":
      validateFlagSubset("git log", rest, SAFE_GIT_LOG_FLAGS, SAFE_GIT_LOG_VALUE_FLAGS, {
        maxPositionals: 2,
      });
      return;
    case "rev-parse":
      validateFlagSubset("git rev-parse", rest, SAFE_GIT_REV_PARSE_FLAGS, new Set(), {
        maxPositionals: 1,
      });
      return;
    case "ls-files":
      validateFlagSubset("git ls-files", rest, SAFE_GIT_LS_FILES_FLAGS, new Set());
      return;
    case "branch":
      if (rest.length !== 1 || rest[0] !== "--show-current") {
        throw toolError("only `git branch --show-current` is allowed in plan mode");
      }
      return;
    default:
      throw toolError(`unsupported git subcommand in plan mode: ${subcommand}`);
  }
}

function validatePlanCommand(tokens: string[]): void {
  const [program, ...args] = tokens;
  switch (program) {
    case "pwd":
      if (args.length !== 0) {
        throw toolError("pwd accepts no arguments in plan mode");
      }
      return;
    case "ls":
      for (const arg of args) {
        if (arg.startsWith("-") && !SAFE_LS_FLAGS.has(arg)) {
          throw toolError(`unsupported ls flag in plan mode: ${arg}`);
        }
      }
      return;
    case "cat":
    case "stat":
      validatePlainArguments(program, args, 1);
      return;
    case "head":
      validateHeadOrTail("head", args);
      return;
    case "tail":
      validateHeadOrTail("tail", args);
      return;
    case "wc":
      validateWc(args);
      return;
    case "tree":
      validateTree(args);
      return;
    case "rg":
      validateRg(args);
      return;
    case "fd":
      validateFd(args);
      return;
    case "git":
      validateGit(args);
      return;
    default:
      throw toolError(`unsupported program in plan mode: ${program}`);
  }
}

export async function runBashTool(
  context: ToolContext,
  input: {
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    shell?: string;
  },
): Promise<ToolEnvelope> {
  const effectiveCwd = input.cwd ? resolveToolPath(context, input.cwd) : context.cwd;
  await ensurePathExists(effectiveCwd, "directory");
  const localContext = { ...context, cwd: effectiveCwd };

  if (context.planMode) {
    if (input.env && Object.keys(input.env).length > 0) {
      throw toolError("plan-mode bash rejects env overrides");
    }
    if (input.shell) {
      throw toolError("plan-mode bash rejects shell overrides");
    }
    const tokens = tokenizePlanCommand(input.command);
    validatePlanCommand(tokens);
    const [program, ...args] = tokens;
    const result = await runProcess(program, args, { cwd: localContext.cwd, abortSignal: localContext.abortSignal });
    const combined = [result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? "\n" : "");
    const artifactDecision = await maybeArtifactForText(localContext, "bash-plan", combined);
    return {
      ok: result.exitCode === 0,
      summary: result.exitCode === 0 ? `Ran read-only plan command ${program}.` : `Plan command ${program} failed.`,
      ...(result.exitCode === 0
        ? {
            data: {
              command: input.command,
              cwd: toRelativeDisplayPath(localContext, localContext.cwd),
              planned: false,
              stdout: artifactDecision.partial ? artifactDecision.preview : result.stdout,
              stderr: result.stderr,
              combined: artifactDecision.partial ? artifactDecision.preview : combined,
              exit_code: result.exitCode,
              artifact: artifactDecision.artifact,
            },
          }
        : {
            data: {
              command: input.command,
              cwd: toRelativeDisplayPath(localContext, localContext.cwd),
              stdout: artifactDecision.partial ? artifactDecision.preview : result.stdout,
              stderr: result.stderr,
              combined: artifactDecision.partial ? artifactDecision.preview : combined,
              exit_code: result.exitCode,
              artifact: artifactDecision.artifact,
            },
            error: {
              code: "PLAN_MODE_SHELL_FAILED",
              message: result.stderr || `command exited with ${result.exitCode}`,
              retryable: false,
            },
          }),
    } as ToolEnvelope;
  }

  const shell = input.shell ?? context.config.default_shell;
  const shellArgs = [...context.config.default_shell_args, input.command];
  const detached = process.platform !== "win32";
  const result = await runProcess(shell, shellArgs, {
    cwd: localContext.cwd,
    env: input.env,
    detached,
    abortSignal: localContext.abortSignal,
  });
  const combined = [result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? "\n" : "");
  const artifactDecision = await maybeArtifactForText(localContext, "bash", combined);
  if (result.exitCode !== 0) {
    return {
      ok: false,
      summary: `Shell command failed: ${basename(shell)} exited with ${result.exitCode}.`,
      data: {
        command: input.command,
        cwd: toRelativeDisplayPath(localContext, localContext.cwd),
        stdout: artifactDecision.partial ? artifactDecision.preview : result.stdout,
        stderr: result.stderr,
        combined: artifactDecision.partial ? artifactDecision.preview : combined,
        exit_code: result.exitCode,
        artifact: artifactDecision.artifact,
      },
      error: {
        code: "SHELL_COMMAND_FAILED",
        message: result.stderr || `command exited with ${result.exitCode}`,
        retryable: false,
      },
    };
  }
  return {
    ok: true,
    summary: "Ran shell command successfully.",
    data: {
      command: input.command,
      cwd: toRelativeDisplayPath(localContext, localContext.cwd),
      stdout: artifactDecision.partial ? artifactDecision.preview : result.stdout,
      stderr: result.stderr,
      combined: artifactDecision.partial ? artifactDecision.preview : combined,
      exit_code: result.exitCode,
      artifact: artifactDecision.artifact,
    },
  };
}
