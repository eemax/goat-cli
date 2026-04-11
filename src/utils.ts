import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export function nowIso(): string {
  return new Date().toISOString();
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function atomicWriteFile(path: string, content: string | Uint8Array): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const tempPath = resolve(parent, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    await writeFile(tempPath, content);
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function sha256Hex(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Rough upper-bound token estimate for a single text string.
 *
 * Goat uses a conservative `chars / 3` heuristic everywhere: it slightly
 * overestimates compared to the OpenAI tokenizer, which is what we want when
 * the estimate drives compaction budgets and "approaching context window"
 * warnings. Do NOT swap this for a per-call heuristic in a hot path without
 * updating every other caller together.
 */
export function estimateTextTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return Math.ceil(text.length / 3);
}

export function estimateTokensConservative(parts: Array<string | undefined | null>): number {
  const text = parts.filter((part): part is string => typeof part === "string").join("\n");
  return estimateTextTokens(text);
}

export function parseJsonLine<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

/**
 * Narrows an unknown value to a Node `NodeJS.ErrnoException` so callers can
 * inspect `error.code` (`ENOENT`, `EACCES`, `EEXIST`, …) without reaching for
 * unsafe casts.
 */
export function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
}
