import { z } from "zod";

const TIME_TOKEN_RE = /(\d+(?:\.\d+)?)\s*(ms|s|m|h)/gi;
const BYTES_RE = /^(\d+(?:\.\d+)?)\s*(kb|mb)$/i;
const TOKEN_RE = /^(\d+(?:\.\d+)?)\s*(k|m)?$/i;

const TIME_MULTIPLIERS: Record<string, number> = {
  ms: 0.001,
  s: 1,
  m: 60,
  h: 3600,
};

const BYTE_MULTIPLIERS: Record<string, number> = {
  kb: 1024,
  mb: 1024 * 1024,
};

const TOKEN_MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  m: 1_000_000,
};

export function parseTime(input: string): number {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('expected a time string like "30s", "5m", "2h", or "1h 30m"');
  }

  let total = 0;
  let matched = 0;

  for (const match of trimmed.matchAll(TIME_TOKEN_RE)) {
    const value = Number(match[1]);
    const unit = match[2]!.toLowerCase();
    total += value * TIME_MULTIPLIERS[unit]!;
    matched += match[0].length;
  }

  const stripped = trimmed.replace(/\s+/g, "").length;
  if (matched === 0 || matched !== stripped) {
    throw new Error(`invalid time "${input}" — expected a time string like "30s", "5m", "2h", or "1h 30m"`);
  }

  if (total <= 0) {
    throw new Error(`time must be positive, got "${input}"`);
  }

  return total;
}

export function parseBytes(input: string): number {
  const trimmed = input.trim();
  const match = BYTES_RE.exec(trimmed);
  if (!match) {
    throw new Error(`invalid byte size "${input}" — expected a size like "8mb", "512kb"`);
  }

  const value = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const result = Math.floor(value * BYTE_MULTIPLIERS[unit]!);

  if (result <= 0) {
    throw new Error(`byte size must be positive, got "${input}"`);
  }

  return result;
}

export function parseTokenCount(input: string): number {
  const trimmed = input.trim();
  const match = TOKEN_RE.exec(trimmed);
  if (!match) {
    throw new Error(`invalid count "${input}" — expected a number like "4000", "4k", "1m"`);
  }

  const value = Number(match[1]);
  const suffix = match[2]?.toLowerCase();
  const multiplier = suffix ? TOKEN_MULTIPLIERS[suffix]! : 1;
  const result = Math.floor(value * multiplier);

  if (!suffix && !Number.isInteger(value)) {
    throw new Error(
      `invalid count "${input}" — bare numbers must be integers; use a suffix like "k" or "m" for decimals`,
    );
  }

  if (result <= 0) {
    throw new Error(`count must be positive, got "${input}"`);
  }

  return result;
}

export const timeSchema = z.string().transform((val, ctx) => {
  try {
    return parseTime(val);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
    return z.NEVER;
  }
});

export const bytesSchema = z.string().transform((val, ctx) => {
  try {
    return parseBytes(val);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
    return z.NEVER;
  }
});

export const tokenSchema = z.string().transform((val, ctx) => {
  try {
    return parseTokenCount(val);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
    return z.NEVER;
  }
});
