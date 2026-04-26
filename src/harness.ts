import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { normalize, relative, resolve } from "node:path";
import { type Tool as AgentsTool, tool as agentsTool } from "@openai/agents";
import { z } from "zod";

import { type ArtifactStore, createPreview, PREVIEW_CHAR_LIMIT } from "./artifacts.js";
import { GoatError, toolError } from "./errors.js";
import type { ALL_TOOL_IDS } from "./tool-ids.js";
import { runBashTool } from "./tools-bash.js";
import { runReadFileTool, runReplaceInFileTool, runWriteFileTool } from "./tools-files.js";
import { applyStructuredPatch } from "./tools-patch.js";
import { runGlobTool, runGrepTool } from "./tools-search.js";
import { runWebFetchTool, runWebSearchTool } from "./tools-web.js";
import type { GlobalConfig, ProviderTool, ToolAccessClass, ToolEnvelope } from "./types.js";
import { isErrnoException } from "./utils.js";

type ToolDefinition = {
  id: (typeof ALL_TOOL_IDS)[number];
  description: string;
  access: ToolAccessClass;
  schema: z.ZodTypeAny;
  handler: (context: ToolContext, input: unknown) => Promise<ToolEnvelope>;
};

export type ToolExecutionEvent = {
  tool_call_id: string | null;
  tool_name: string;
  arguments: unknown;
  duration_ms?: number;
  envelope?: ToolEnvelope;
};

export type ToolExecutionObserver = {
  onStart?: (event: ToolExecutionEvent) => void | Promise<void>;
  onFinish?: (event: ToolExecutionEvent) => void | Promise<void>;
};

/**
 * Build a tool definition whose handler input is inferred from its schema.
 *
 * The handler body sees `z.infer<TSchema>` — no `any`, no manual casting — and
 * the registry still stores a homogeneous `ToolDefinition[]` because we erase
 * the generic at the boundary.
 */
function defineTool<TSchema extends z.ZodTypeAny>(definition: {
  id: (typeof ALL_TOOL_IDS)[number];
  description: string;
  access: ToolAccessClass;
  schema: TSchema;
  handler: (context: ToolContext, input: z.infer<TSchema>) => Promise<ToolEnvelope>;
}): ToolDefinition {
  return definition as unknown as ToolDefinition;
}

export type ToolContext = {
  cwd: string;
  planMode: boolean;
  config: GlobalConfig["tools"];
  catastrophicOutputLimit: number;
  artifacts: ArtifactStore;
  runRoot: string;
  ensureMutationLock: () => Promise<void>;
  abortSignal?: AbortSignal;
};

const fileEncodingSchema = z.enum(["utf8", "utf-8"]).default("utf8");

const toolDefinitions: ToolDefinition[] = [
  defineTool({
    id: "bash",
    description: "Run a shell command in the local environment.",
    access: "mutating",
    schema: z
      .object({
        command: z.string().min(1),
        cwd: z.string().min(1).optional(),
        env: z.record(z.string(), z.string()).optional(),
        shell: z.string().min(1).optional(),
      })
      .strict(),
    handler: (context, input) => runBashTool(context, input),
  }),
  defineTool({
    id: "read_file",
    description: "Read UTF-8 text files with optional line slicing.",
    access: "read_only",
    schema: z
      .object({
        path: z.string().min(1),
        offset_line: z.number().int().positive().optional(),
        limit_lines: z.number().int().positive().optional(),
        encoding: fileEncodingSchema.optional(),
      })
      .strict(),
    handler: (context, input) => runReadFileTool(context, input),
  }),
  defineTool({
    id: "write_file",
    description: "Create or overwrite a file with exact content.",
    access: "mutating",
    schema: z
      .object({
        path: z.string().min(1),
        content: z.string(),
        encoding: fileEncodingSchema.optional(),
      })
      .strict(),
    handler: (context, input) => runWriteFileTool(context, input),
  }),
  defineTool({
    id: "replace_in_file",
    description: "Replace exact text in a file.",
    access: "mutating",
    schema: z
      .object({
        path: z.string().min(1),
        old_text: z.string(),
        new_text: z.string(),
        replace_all: z.boolean().optional(),
      })
      .strict(),
    handler: (context, input) => runReplaceInFileTool(context, input),
  }),
  defineTool({
    id: "apply_patch",
    description: "Apply Goat structured patch text.",
    access: "mutating",
    schema: z
      .object({
        patch: z.string().min(1),
        cwd: z.string().min(1).optional(),
      })
      .strict(),
    handler: (context, input) => applyStructuredPatch(context, input),
  }),
  defineTool({
    id: "glob",
    description: "Find files using rg --files.",
    access: "read_only",
    schema: z
      .object({
        pattern: z.string().min(1),
        path: z.string().min(1).optional(),
      })
      .strict(),
    handler: (context, input) => runGlobTool(context, input),
  }),
  defineTool({
    id: "grep",
    description: "Search text files using rg --json.",
    access: "read_only",
    schema: z
      .object({
        pattern: z.string().min(1),
        path: z.string().min(1).optional(),
        literal: z.boolean().optional(),
        case_sensitive: z.boolean().optional(),
      })
      .strict(),
    handler: (context, input) => runGrepTool(context, input),
  }),
  defineTool({
    id: "web_search",
    description:
      "Search the web for relevant sources with Exa. Use this first when you need current or external information, then use web_fetch for deeper reading. Cite exact URLs you use in the final answer.",
    access: "read_only",
    schema: z
      .object({
        query: z.string().min(1),
        num_results: z.number().int().min(1).max(20).optional(),
        published_within_days: z.number().int().min(1).max(365).optional(),
        include_domains: z.array(z.string()).optional(),
        exclude_domains: z.array(z.string()).optional(),
      })
      .strict(),
    handler: (context, input) => runWebSearchTool(context, input),
  }),
  defineTool({
    id: "web_fetch",
    description:
      "Fetch a single URL with Defuddle markdown extraction. Use this after web_search when you need live verification or deeper reading from a specific page. Cite the exact URL you fetched in the final answer.",
    access: "read_only",
    schema: z
      .object({
        url: z.string().url(),
      })
      .strict(),
    handler: (context, input) => runWebFetchTool(context, input),
  }),
  defineTool({
    id: "subagents",
    description: "Stubbed subagents tool reserved for future CLI integration.",
    access: "mutating",
    schema: z
      .object({
        action: z.string().min(1),
      })
      .strict(),
    handler: async () => unimplementedTool("subagents"),
  }),
];

function unimplementedTool(name: string): ToolEnvelope {
  return {
    ok: false,
    summary: `${name} is not implemented in V1.`,
    error: {
      code: "UNIMPLEMENTED_IN_V1",
      message: `${name} is not implemented in V1.`,
      retryable: false,
    },
  };
}

function zodToJsonSchema(shape: z.ZodTypeAny): Record<string, unknown> {
  if (shape instanceof z.ZodObject) {
    const entries = Object.entries(shape.shape).map(([key, child]) => [key, zodToJsonSchema(child as z.ZodTypeAny)]);
    return {
      type: "object",
      properties: Object.fromEntries(entries),
      required: Object.keys(shape.shape).filter((key) => !(shape.shape[key] as z.ZodTypeAny).isOptional()),
      additionalProperties: false,
    };
  }
  if (shape instanceof z.ZodString) {
    return { type: "string" };
  }
  if (shape instanceof z.ZodNumber) {
    return { type: "number" };
  }
  if (shape instanceof z.ZodBoolean) {
    return { type: "boolean" };
  }
  if (shape instanceof z.ZodArray) {
    return {
      type: "array",
      items: zodToJsonSchema(shape.element as z.ZodTypeAny),
    };
  }
  if (shape instanceof z.ZodEnum) {
    return {
      type: "string",
      enum: [...shape.options],
    };
  }
  if (shape instanceof z.ZodOptional || shape instanceof z.ZodDefault) {
    return zodToJsonSchema(shape.unwrap() as z.ZodTypeAny);
  }
  if (shape instanceof z.ZodRecord) {
    return {
      type: "object",
      additionalProperties: { type: "string" },
    };
  }
  if (shape instanceof z.ZodUnion) {
    const options = shape.options.map((option) => zodToJsonSchema(option as z.ZodTypeAny));
    const enumValues = options.flatMap((option) => ("enum" in option && Array.isArray(option.enum) ? option.enum : []));
    if (enumValues.length > 0) {
      return { type: "string", enum: enumValues };
    }
  }
  return { type: "string" };
}

export function resolveToolPath(context: ToolContext, targetPath: string): string {
  if (!targetPath.trim()) {
    throw toolError("path must not be empty");
  }
  return normalize(targetPath.startsWith("/") ? targetPath : resolve(context.cwd, targetPath));
}

export async function ensurePathExists(path: string, kind: "file" | "directory"): Promise<void> {
  try {
    const info = await stat(path);
    if (kind === "file" && !info.isFile()) {
      throw toolError(`${path} is not a file`);
    }
    if (kind === "directory" && !info.isDirectory()) {
      throw toolError(`${path} is not a directory`);
    }
  } catch (error) {
    if (error instanceof GoatError) {
      throw error;
    }
    if (isErrnoException(error)) {
      if (error.code === "ENOENT") {
        throw toolError(`${path} was not found`);
      }
      if (error.code === "EACCES" || error.code === "EPERM") {
        throw toolError(`${path} is not accessible (permission denied)`);
      }
    }
    throw toolError(`${path} could not be inspected: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const toolRegistry: Map<string, ToolDefinition> = new Map(toolDefinitions.map((tool) => [tool.id, tool]));

export function exportProviderTools(enabledTools: string[]): ProviderTool[] {
  return enabledTools.map((name) => {
    const tool = toolRegistry.get(name);
    if (!tool) {
      throw toolError(`unknown tool \`${name}\``);
    }
    return {
      type: "function",
      name: tool.id,
      description: tool.description,
      strict: true,
      parameters: zodToJsonSchema(tool.schema),
    };
  });
}

export function exportAgentsSdkTools(
  enabledTools: string[],
  context: ToolContext,
  observer?: ToolExecutionObserver,
): AgentsTool<ToolContext>[] {
  return enabledTools.map((name) => {
    const definition = toolRegistry.get(name);
    if (!definition) {
      throw toolError(`unknown tool \`${name}\``);
    }

    return agentsTool({
      name: definition.id,
      description: definition.description,
      parameters: zodToJsonSchema(definition.schema) as never,
      strict: true,
      execute: async (input, _runContext, details) => {
        const callId = details?.toolCall?.callId ?? null;
        await observer?.onStart?.({
          tool_call_id: callId,
          tool_name: definition.id,
          arguments: input,
        });
        const startedAt = performance.now();
        const envelope = await executeToolCall(context, enabledTools, definition.id, input);
        const durationMs = Number((performance.now() - startedAt).toFixed(1));
        await observer?.onFinish?.({
          tool_call_id: callId,
          tool_name: definition.id,
          arguments: input,
          duration_ms: durationMs,
          envelope,
        });
        return JSON.stringify(envelope);
      },
    });
  });
}

export async function executeToolCall(
  context: ToolContext,
  enabledTools: string[],
  name: string,
  rawArguments: unknown,
): Promise<ToolEnvelope> {
  if (!enabledTools.includes(name)) {
    throw toolError(`tool \`${name}\` is not enabled for this agent`);
  }

  const tool = toolRegistry.get(name);
  if (!tool) {
    throw toolError(`unknown tool \`${name}\``);
  }

  if (tool.access === "mutating" && !context.planMode) {
    await context.ensureMutationLock();
  }

  const parsed = tool.schema.safeParse(rawArguments);
  if (!parsed.success) {
    return {
      ok: false,
      summary: `Invalid arguments for ${name}.`,
      error: {
        code: "INVALID_TOOL_ARGUMENTS",
        message: parsed.error.issues.map((issue) => issue.message).join("; "),
        retryable: false,
      },
    };
  }

  try {
    return await tool.handler(context, parsed.data);
  } catch (error) {
    if (error instanceof GoatError) {
      return {
        ok: false,
        summary: error.message,
        error: {
          code: error.code,
          message: error.message,
          retryable: false,
        },
      };
    }
    throw error;
  }
}

export async function maybeArtifactForText(
  context: ToolContext,
  prefix: string,
  content: string,
  contentType = "text/plain",
): Promise<{ preview: string; artifact: import("./types.js").ArtifactRef | null; partial: boolean }> {
  if (content.length <= context.config.max_output_chars) {
    return {
      preview: content,
      artifact: null,
      partial: false,
    };
  }

  const artifact = await context.artifacts.write(prefix, content, contentType);
  return {
    preview: createPreview(content, Math.min(context.config.max_output_chars, PREVIEW_CHAR_LIMIT)),
    artifact,
    partial: true,
  };
}

export function toRelativeDisplayPath(context: ToolContext, absolutePath: string): string {
  const relativePath = relative(context.cwd, absolutePath);
  return relativePath && !relativePath.startsWith("..") ? relativePath : absolutePath;
}

export type ProcessResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  outputLimitExceeded: boolean;
  timedOut: boolean;
};

function terminateChildProcess(child: ReturnType<typeof spawn>, detached = false): void {
  // Both the synchronous signal and the delayed follow-up can race the child
  // exiting on its own. Swallow errors in both branches — if the process is
  // already gone we've already captured the output we care about.
  const safeKill = (fn: () => void): void => {
    try {
      fn();
    } catch {
      // Ignore ESRCH / ESRCH-adjacent errors from signalling a dead process.
    }
  };

  if (detached && process.platform !== "win32" && child.pid) {
    const pid = child.pid;
    safeKill(() => process.kill(-pid, "SIGTERM"));
    setTimeout(() => {
      if (!child.killed) {
        safeKill(() => process.kill(-pid, "SIGKILL"));
      }
    }, 100).unref();
    return;
  }

  safeKill(() => child.kill("SIGTERM"));
  setTimeout(() => {
    if (!child.killed) {
      safeKill(() => child.kill("SIGKILL"));
    }
  }, 100).unref();
}

export async function runProcess(
  program: string,
  args: string[],
  options: {
    cwd: string;
    env?: Record<string, string>;
    detached?: boolean;
    abortSignal?: AbortSignal;
    maxOutputBytes?: number;
    timeoutMs?: number;
  },
): Promise<ProcessResult> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      detached: options.detached,
      stdio: ["ignore", "pipe", "pipe"],
      signal: options.abortSignal,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputBytes = 0;
    let outputLimitExceeded = false;
    let terminationRequested = false;
    let timedOut = false;

    const requestTermination = () => {
      if (terminationRequested) {
        return;
      }
      terminationRequested = true;
      terminateChildProcess(child, options.detached);
    };
    const timeout =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            timedOut = true;
            requestTermination();
          }, options.timeoutMs);
    timeout?.unref();

    const appendChunk = (target: Buffer[], chunk: Buffer) => {
      if (outputLimitExceeded) {
        return;
      }

      if (options.maxOutputBytes === undefined) {
        target.push(chunk);
        return;
      }

      const remaining = options.maxOutputBytes - outputBytes;
      if (remaining <= 0) {
        outputLimitExceeded = true;
        requestTermination();
        return;
      }

      if (chunk.length <= remaining) {
        target.push(chunk);
        outputBytes += chunk.length;
        return;
      }

      target.push(chunk.subarray(0, remaining));
      outputBytes += remaining;
      outputLimitExceeded = true;
      requestTermination();
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      appendChunk(stdoutChunks, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      appendChunk(stderrChunks, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on("error", (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      resolveResult({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        outputLimitExceeded,
        timedOut,
      });
    });
  });
}
