import type { Writable } from "node:stream";
import { GoatError } from "./errors.js";
import { writeText } from "./io.js";
import type { PromptMessage } from "./prompt.js";
import type { ProviderInputItem, ProviderRequest, ProviderTurnResult } from "./provider.js";
import type { RunOptions } from "./types.js";
import { estimateTokensConservative, nowIso } from "./utils.js";

type DebugMode = "off" | "human" | "json";

export type DebugCategory = "config" | "session" | "context" | "compaction" | "provider" | "tool" | "run" | "error";

export type DebugEvent = {
  ts: string;
  category: DebugCategory;
  event: string;
  data: Record<string, unknown>;
};

export interface DebugSink {
  readonly enabled: boolean;
  readonly mode: DebugMode;
  emit(category: DebugCategory, event: string, data?: Record<string, unknown>): Promise<void>;
}

const HUMAN_OBJECT_LIMIT = 420;
const HUMAN_STRING_LIMIT = 180;
const JSON_PREVIEW_LIMIT = 4000;
const PREVIEW_INPUT_LIMIT = 8;

const CATEGORY_COLORS: Record<DebugCategory, number> = {
  config: 90,
  session: 90,
  context: 36,
  compaction: 36,
  provider: 34,
  tool: 33,
  run: 35,
  error: 31,
};

function colorize(value: string, color: number, enabled: boolean): string {
  return enabled ? `\u001B[${color}m${value}\u001B[0m` : value;
}

function isSimpleToken(value: string): boolean {
  return /^[A-Za-z0-9._/:@-]+$/.test(value);
}

function truncateText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 3))}...`;
}

function previewText(value: string, limit: number): string {
  return truncateText(value.replace(/\s+/g, " ").trim(), limit);
}

function stringifyInputContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function formatHumanValue(value: unknown): string {
  if (typeof value === "string") {
    const normalized = truncateText(value, HUMAN_STRING_LIMIT);
    return isSimpleToken(normalized) ? normalized : JSON.stringify(normalized);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  return truncateText(JSON.stringify(value), HUMAN_OBJECT_LIMIT);
}

function renderHuman(event: DebugEvent, useColor: boolean): string {
  const category = colorize(event.category, CATEGORY_COLORS[event.category], useColor);
  const prefix = `[debug][${category}][${event.ts.slice(11, 23)}]`;
  const fields = Object.entries(event.data)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatHumanValue(value)}`)
    .join(" ");

  return fields ? `${prefix} ${event.event} ${fields}\n` : `${prefix} ${event.event}\n`;
}

export function createDebugSink(stderr: Writable, options: Pick<RunOptions, "debug" | "debugJson">): DebugSink {
  const mode: DebugMode = options.debugJson ? "json" : options.debug ? "human" : "off";
  if (mode === "off") {
    return {
      enabled: false,
      mode,
      async emit() {},
    };
  }

  const useColor = mode === "human" && (stderr as Writable & { isTTY?: boolean }).isTTY === true;
  return {
    enabled: true,
    mode,
    async emit(category, event, data = {}) {
      const record: DebugEvent = {
        ts: nowIso(),
        category,
        event,
        data,
      };
      const line = mode === "json" ? `${JSON.stringify(record)}\n` : renderHuman(record, useColor);
      await writeText(stderr, line);
    },
  };
}

function sanitizeUnknownValue(value: unknown): unknown {
  if (typeof value === "string") {
    return truncateText(value, JSON_PREVIEW_LIMIT);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeUnknownValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, sanitizeUnknownValue(entry)]),
    );
  }
  return value;
}

function contentSummary(value: unknown): { chars: number; preview: string } {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return {
    chars: text.length,
    preview: previewText(text, 240),
  };
}

export function sanitizeToolArguments(name: string, rawArguments: Record<string, unknown>): Record<string, unknown> {
  const argumentsCopy = { ...rawArguments };

  switch (name) {
    case "bash":
      return {
        ...argumentsCopy,
        command:
          typeof argumentsCopy.command === "string"
            ? truncateText(argumentsCopy.command, JSON_PREVIEW_LIMIT)
            : argumentsCopy.command,
        env_keys:
          argumentsCopy.env && typeof argumentsCopy.env === "object"
            ? Object.keys(argumentsCopy.env as Record<string, string>)
            : [],
        env: undefined,
      };
    case "write_file":
      return {
        path: argumentsCopy.path ?? null,
        encoding: argumentsCopy.encoding ?? "utf8",
        content: contentSummary(argumentsCopy.content ?? ""),
      };
    case "apply_patch":
      return {
        cwd: argumentsCopy.cwd ?? null,
        patch: contentSummary(argumentsCopy.patch ?? ""),
      };
    case "replace_in_file":
      return {
        path: argumentsCopy.path ?? null,
        replace_all: argumentsCopy.replace_all ?? false,
        old_text: contentSummary(argumentsCopy.old_text ?? ""),
        new_text: contentSummary(argumentsCopy.new_text ?? ""),
      };
    default:
      return sanitizeUnknownValue(argumentsCopy) as Record<string, unknown>;
  }
}

export function sanitizeDebugData(value: unknown): unknown {
  return sanitizeUnknownValue(value);
}

export function debugErrorData(error: unknown): Record<string, unknown> {
  if (error instanceof GoatError) {
    return {
      error_type: error.name,
      error_code: error.code,
      message: error.message,
      exit_code: error.exitCode,
      details: error.details ?? null,
    };
  }
  if (error instanceof Error) {
    return {
      error_type: error.name,
      message: error.message,
      stack: error.stack ? truncateText(error.stack, JSON_PREVIEW_LIMIT) : null,
    };
  }

  return {
    error_type: typeof error,
    message: String(error),
  };
}

export function summarizePromptMessages(input: PromptMessage[]): Array<Record<string, unknown>> {
  return input.slice(-PREVIEW_INPUT_LIMIT).map((message) => ({
    type: "message",
    role: message.role,
    preview: previewText(message.content, 140),
    chars: message.content.length,
  }));
}

export function summarizeProviderInput(input: ProviderInputItem[]): Array<Record<string, unknown>> {
  return input.slice(-PREVIEW_INPUT_LIMIT).map((item) => {
    if (item.type === "message") {
      const content = stringifyInputContent(item.content);
      return {
        type: item.type,
        role: item.role,
        preview: previewText(content, 140),
        chars: content.length,
      };
    }

    if (item.type === "function_call_output") {
      const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output);
      return {
        type: item.type,
        call_id: item.call_id,
        preview: previewText(output, 140),
        chars: output.length,
      };
    }

    return {
      type: item.type,
    };
  });
}

export function estimateProviderRequestTokens(request: ProviderRequest): number {
  return estimateTokensConservative([
    request.instructions,
    ...request.input.map((item) => {
      if (item.type === "message") {
        return stringifyInputContent(item.content);
      }
      if (item.type === "function_call_output") {
        return typeof item.output === "string" ? item.output : JSON.stringify(item.output);
      }
      return JSON.stringify(item);
    }),
    JSON.stringify(request.tools),
    request.previous_response_id,
    request.effort,
    request.max_output_tokens === null ? null : String(request.max_output_tokens),
  ]);
}

export function serializeProviderRequestForDebug(request: ProviderRequest): Record<string, unknown> {
  return {
    model: request.model,
    instructions: request.instructions,
    input: request.input.map((item) => sanitizeDebugData(item)),
    previous_response_id: request.previous_response_id,
    effort: request.effort,
    max_output_tokens: request.max_output_tokens,
    tools: request.tools.map((tool) => sanitizeDebugData(tool)),
  };
}

export function extractFinishReason(turn: ProviderTurnResult): string {
  const rawResponse = turn.raw_response as unknown as {
    incomplete_details?: {
      reason?: unknown;
    };
  } | null;
  const incompleteReason = rawResponse?.incomplete_details;
  if (incompleteReason && typeof incompleteReason.reason === "string") {
    return incompleteReason.reason;
  }
  if (turn.tool_calls.length > 0) {
    return "tool_calls";
  }
  if (turn.output_text) {
    return "final_output";
  }
  return turn.status;
}
