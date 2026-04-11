import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { toolError } from "./errors.js";
import type { ToolContext } from "./harness.js";
import { resolveToolPath, toRelativeDisplayPath } from "./harness.js";
import type { ToolEnvelope } from "./types.js";
import { atomicWriteFile, isErrnoException } from "./utils.js";

type PatchOp =
  | { type: "add"; path: string; lines: string[] }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; moveTo: string | null; hunks: PatchHunk[] };

type PatchHunk = {
  oldLines: string[];
  newLines: string[];
  anchorEof: boolean;
};

function splitLinesPreserve(value: string): string[] {
  const normalized = value.replace(/\r\n/g, "\n");
  if (normalized === "") {
    return [];
  }
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function parsePatch(input: string): PatchOp[] {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  if (lines[0] !== "*** Begin Patch") {
    throw toolError("patch must start with `*** Begin Patch`");
  }
  if (lines.at(-1) !== "*** End Patch") {
    throw toolError("patch must end with `*** End Patch`");
  }

  const operations: PatchOp[] = [];
  let index = 1;
  while (index < lines.length - 1) {
    const line = lines[index];
    if (line.startsWith("*** Add File: ")) {
      const path = line.slice("*** Add File: ".length);
      index += 1;
      const content: string[] = [];
      while (index < lines.length - 1 && !lines[index]!.startsWith("*** ")) {
        const body = lines[index]!;
        if (!body.startsWith("+")) {
          throw toolError("add file hunks must use `+` lines");
        }
        content.push(body.slice(1));
        index += 1;
      }
      if (content.length === 0) {
        throw toolError("add file hunk must contain at least one line");
      }
      operations.push({ type: "add", path, lines: content });
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      operations.push({ type: "delete", path: line.slice("*** Delete File: ".length) });
      index += 1;
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      const path = line.slice("*** Update File: ".length);
      index += 1;
      let moveTo: string | null = null;
      if (lines[index]?.startsWith("*** Move to: ")) {
        moveTo = lines[index]!.slice("*** Move to: ".length);
        index += 1;
      }
      const changeLines: string[] = [];
      let anchorEof = false;
      while (index < lines.length - 1) {
        const current = lines[index]!;
        if (current === "*** End of File") {
          anchorEof = true;
          index += 1;
          break;
        }
        if (current.startsWith("*** ")) {
          break;
        }
        changeLines.push(current);
        index += 1;
      }
      if (changeLines.length === 0 && moveTo === null) {
        throw toolError("update patch must contain changes or a move target");
      }
      operations.push({
        type: "update",
        path,
        moveTo,
        hunks: buildHunks(changeLines, anchorEof),
      });
      continue;
    }
    if (!line) {
      index += 1;
      continue;
    }
    throw toolError(`unrecognized patch line \`${line}\``);
  }
  if (operations.length === 0) {
    throw toolError("patch must contain at least one hunk");
  }
  return operations;
}

function buildHunks(lines: string[], anchorEof: boolean): PatchHunk[] {
  if (lines.length === 0) {
    return [];
  }

  const groups: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (current.length > 0) {
        groups.push(current);
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) {
    groups.push(current);
  }
  if (groups.length === 0) {
    throw toolError("update patch did not contain any hunks");
  }
  return groups.map((group, index) => {
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (const line of group) {
      const prefix = line[0];
      const text = line.slice(1);
      if (prefix === " ") {
        oldLines.push(text);
        newLines.push(text);
      } else if (prefix === "-") {
        oldLines.push(text);
      } else if (prefix === "+") {
        newLines.push(text);
      } else {
        throw toolError(`invalid patch change line \`${line}\``);
      }
    }
    return {
      oldLines,
      newLines,
      anchorEof: anchorEof && index === groups.length - 1,
    };
  });
}

function findUniqueMatch(lines: string[], needle: string[], anchorEof: boolean): number {
  if (anchorEof) {
    const start = lines.length - needle.length;
    if (start < 0) {
      return -1;
    }
    return needle.every((line, index) => lines[start + index] === line) ? start : -1;
  }

  const matches: number[] = [];
  for (let start = 0; start <= lines.length - needle.length; start += 1) {
    let matched = true;
    for (let index = 0; index < needle.length; index += 1) {
      if (lines[start + index] !== needle[index]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      matches.push(start);
    }
  }
  if (matches.length > 1) {
    throw toolError("patch hunk matched multiple locations");
  }
  return matches[0] ?? -1;
}

function applyHunks(original: string, hunks: PatchHunk[]): string {
  const lines = splitLinesPreserve(original);
  let working = [...lines];
  for (const hunk of hunks) {
    const start = findUniqueMatch(working, hunk.oldLines, hunk.anchorEof);
    if (start === -1) {
      throw toolError("patch hunk context did not match");
    }
    working = [...working.slice(0, start), ...hunk.newLines, ...working.slice(start + hunk.oldLines.length)];
  }
  return working.length === 0 ? "" : `${working.join("\n")}\n`;
}

export async function applyStructuredPatch(
  context: ToolContext,
  input: {
    patch: string;
    cwd?: string;
  },
): Promise<ToolEnvelope> {
  const localContext = input.cwd ? { ...context, cwd: resolveToolPath(context, input.cwd) } : context;
  const operations = parsePatch(input.patch);
  const changed: string[] = [];

  if (localContext.planMode) {
    for (const operation of operations) {
      changed.push(operation.path);
      if (operation.type === "update" && operation.moveTo) {
        changed.push(operation.moveTo);
      }
    }
    return {
      ok: true,
      summary: `Would apply patch touching ${changed.length} file(s).`,
      data: {
        planned: true,
        changed,
      },
    };
  }

  const writes = new Map<string, string | null>();
  for (const operation of operations) {
    if (operation.type === "add") {
      const target = resolveToolPath(localContext, operation.path);
      let alreadyExists = false;
      try {
        await stat(target);
        alreadyExists = true;
      } catch (error) {
        if (!isErrnoException(error) || error.code !== "ENOENT") {
          throw toolError(`cannot add ${operation.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (alreadyExists) {
        throw toolError(`cannot add ${operation.path}; file already exists`);
      }
      writes.set(target, operation.lines.length === 0 ? "" : `${operation.lines.join("\n")}\n`);
      changed.push(toRelativeDisplayPath(localContext, target));
      continue;
    }
    if (operation.type === "delete") {
      const target = resolveToolPath(localContext, operation.path);
      try {
        await stat(target);
      } catch (error) {
        if (isErrnoException(error) && error.code === "ENOENT") {
          throw toolError(`cannot delete ${operation.path}; file does not exist`);
        }
        throw toolError(`cannot delete ${operation.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
      writes.set(target, null);
      changed.push(toRelativeDisplayPath(localContext, target));
      continue;
    }
    const source = resolveToolPath(localContext, operation.path);
    let original: string;
    try {
      original = await readFile(source, "utf8");
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        throw toolError(`cannot update ${operation.path}; file does not exist`);
      }
      throw toolError(`cannot update ${operation.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const updated = applyHunks(original, operation.hunks);
    writes.set(source, updated);
    changed.push(toRelativeDisplayPath(localContext, source));
    if (operation.moveTo) {
      const target = resolveToolPath(localContext, operation.moveTo);
      writes.delete(source);
      writes.set(target, updated);
      writes.set(source, null);
      changed.push(toRelativeDisplayPath(localContext, target));
    }
  }

  for (const [path, content] of writes) {
    if (content === null) {
      await rm(path, { force: true });
      continue;
    }
    await mkdir(dirname(path), { recursive: true });
    await atomicWriteFile(path, content);
  }

  return {
    ok: true,
    summary: `Applied patch touching ${changed.length} file(s).`,
    data: {
      changed,
    },
  };
}
