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

export async function runGlobTool(
  context: ToolContext,
  input: {
    pattern: string;
    path?: string;
  },
): Promise<ToolEnvelope> {
  const root = resolveToolPath(context, input.path ?? ".");
  await ensurePathExists(root, "directory");
  const result = await runProcess("rg", ["--files", "--hidden", "-g", "!.git", "-g", input.pattern], {
    cwd: root,
    abortSignal: context.abortSignal,
  });
  if (result.exitCode !== 0) {
    throw toolError(`rg failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }
  const matches = result.stdout
    .split("\n")
    .filter(Boolean)
    .map((entry) => toRelativeDisplayPath(context, resolveToolPath({ ...context, cwd: root }, entry)));
  const inline = JSON.stringify(matches, null, 2);
  const artifactDecision = await maybeArtifactForText(context, "glob", inline, "application/json");
  return {
    ok: true,
    summary: `Found ${matches.length} matching files.`,
    data: artifactDecision.partial
      ? {
          partial: true,
          truncation_reason: "max_output_chars_exceeded",
          total_lines: matches.length,
          preview: {
            head: artifactDecision.preview,
            tail: artifactDecision.preview,
            head_lines: Math.min(matches.length, 80),
            tail_lines: Math.min(matches.length, 80),
          },
          artifact: artifactDecision.artifact,
        }
      : {
          path: toRelativeDisplayPath(context, root),
          matches,
        },
  };
}

export async function runGrepTool(
  context: ToolContext,
  input: {
    pattern: string;
    path?: string;
    literal?: boolean;
    case_sensitive?: boolean;
  },
): Promise<ToolEnvelope> {
  const root = resolveToolPath(context, input.path ?? ".");
  await ensurePathExists(root, "directory");
  const args = ["--json", "--hidden", "--glob", "!.git"];
  if (input.literal) {
    args.push("--fixed-strings");
  }
  if (input.case_sensitive === false) {
    args.push("-i");
  }
  args.push(input.pattern, ".");
  const result = await runProcess("rg", args, { cwd: root, abortSignal: context.abortSignal });
  if (![0, 1].includes(result.exitCode)) {
    throw toolError(`rg failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }
  const matches: Array<{ path: string; line: number; text: string }> = [];
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed.type !== "match") {
      continue;
    }
    const data = parsed.data as Record<string, unknown>;
    const path = data.path as { text: string };
    const lines = data.lines as { text: string };
    const lineNumber = Number(data.line_number ?? 0);
    matches.push({
      path: toRelativeDisplayPath(context, resolveToolPath({ ...context, cwd: root }, path.text)),
      line: lineNumber,
      text: lines.text.trimEnd(),
    });
  }
  const inline = JSON.stringify(matches, null, 2);
  const artifactDecision = await maybeArtifactForText(context, "grep", inline, "application/json");
  return {
    ok: true,
    summary: `Found ${matches.length} matches.`,
    data: artifactDecision.partial
      ? {
          partial: true,
          truncation_reason: "max_output_chars_exceeded",
          preview: {
            head: artifactDecision.preview,
            tail: artifactDecision.preview,
            head_lines: Math.min(matches.length, 80),
            tail_lines: Math.min(matches.length, 80),
          },
          artifact: artifactDecision.artifact,
        }
      : {
          path: toRelativeDisplayPath(context, root),
          matches,
          files_scanned: null,
        },
  };
}
