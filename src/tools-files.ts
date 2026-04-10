import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { toolError } from "./errors.js";
import type { ToolContext } from "./harness.js";
import { ensurePathExists, maybeArtifactForText, resolveToolPath, toRelativeDisplayPath } from "./harness.js";
import type { ToolEnvelope } from "./types.js";
import { atomicWriteFile } from "./utils.js";

function ensureUtf8Encoding(encoding?: string): void {
  if (encoding && encoding !== "utf8" && encoding !== "utf-8") {
    throw toolError("only utf8 and utf-8 are supported");
  }
}

function ensureFileSizeWithinLimit(context: ToolContext, bytes: number): void {
  if (bytes > context.config.max_file_size) {
    throw toolError(`file exceeds max_file_size (${context.config.max_file_size} bytes)`);
  }
}

export async function runReadFileTool(
  context: ToolContext,
  input: {
    path: string;
    offset_line?: number;
    limit_lines?: number;
    encoding?: string;
  },
): Promise<ToolEnvelope> {
  ensureUtf8Encoding(input.encoding);
  const path = resolveToolPath(context, input.path);
  await ensurePathExists(path, "file");
  const info = await stat(path);
  ensureFileSizeWithinLimit(context, info.size);
  const content = await readFile(path, "utf8");
  const lines = content.split("\n");
  const offset = (input.offset_line ?? 1) - 1;
  const limit = input.limit_lines ?? lines.length;
  const selected = lines.slice(offset, offset + limit).join("\n");
  const artifactDecision = await maybeArtifactForText(context, "read-file", selected);

  return {
    ok: true,
    summary: `Read ${toRelativeDisplayPath(context, path)}.`,
    data: {
      path: toRelativeDisplayPath(context, path),
      content: artifactDecision.partial ? artifactDecision.preview : selected,
      start_line: offset + 1,
      end_line: Math.min(lines.length, offset + limit),
      total_lines: lines.length,
      truncated: artifactDecision.partial,
      artifact: artifactDecision.artifact,
    },
  };
}

export async function runWriteFileTool(
  context: ToolContext,
  input: {
    path: string;
    content: string;
    encoding?: string;
  },
): Promise<ToolEnvelope> {
  ensureUtf8Encoding(input.encoding);
  const path = resolveToolPath(context, input.path);
  if (context.planMode) {
    return {
      ok: true,
      summary: `Would write ${toRelativeDisplayPath(context, path)}.`,
      data: {
        planned: true,
        path: toRelativeDisplayPath(context, path),
        size: Buffer.byteLength(input.content),
      },
    };
  }

  ensureFileSizeWithinLimit(context, Buffer.byteLength(input.content));
  const existing = await stat(path).catch(() => null);
  if (existing?.isDirectory()) {
    throw toolError("path points to an existing directory");
  }
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteFile(path, input.content);
  return {
    ok: true,
    summary: `Wrote ${toRelativeDisplayPath(context, path)}.`,
    data: {
      path: toRelativeDisplayPath(context, path),
      size: Buffer.byteLength(input.content),
    },
  };
}

export async function runReplaceInFileTool(
  context: ToolContext,
  input: {
    path: string;
    old_text: string;
    new_text: string;
    replace_all?: boolean;
  },
): Promise<ToolEnvelope> {
  const path = resolveToolPath(context, input.path);
  await ensurePathExists(path, "file");
  const original = await readFile(path, "utf8");
  if (!original.includes(input.old_text)) {
    throw toolError("old_text was not found in the file");
  }
  const allMatches =
    input.old_text === ""
      ? [0]
      : [...original.matchAll(new RegExp(input.old_text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))].map(
          (match) => match.index ?? 0,
        );
  if (!input.replace_all && allMatches.length > 1) {
    throw toolError("multiple matches found; set replace_all=true to replace all occurrences");
  }

  const updated = input.replace_all
    ? original.split(input.old_text).join(input.new_text)
    : original.replace(input.old_text, input.new_text);
  ensureFileSizeWithinLimit(context, Buffer.byteLength(updated));

  if (context.planMode) {
    return {
      ok: true,
      summary: `Would replace text in ${toRelativeDisplayPath(context, path)}.`,
      data: {
        planned: true,
        path: toRelativeDisplayPath(context, path),
        replacements: input.replace_all ? allMatches.length : 1,
      },
    };
  }

  await atomicWriteFile(path, updated);
  return {
    ok: true,
    summary: `Updated ${toRelativeDisplayPath(context, path)}.`,
    data: {
      path: toRelativeDisplayPath(context, path),
      replacements: input.replace_all ? allMatches.length : 1,
    },
  };
}
