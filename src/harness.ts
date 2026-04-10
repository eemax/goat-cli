import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { normalize, relative, resolve } from "node:path";
import { z } from "zod";

import { type ArtifactStore, createPreview } from "./artifacts.js";
import { GoatError, toolError } from "./errors.js";
import type { ALL_TOOL_IDS } from "./tool-ids.js";
import { runBashTool } from "./tools-bash.js";
import { runReadFileTool, runReplaceInFileTool, runWriteFileTool } from "./tools-files.js";
import { applyStructuredPatch } from "./tools-patch.js";
import { runGlobTool, runGrepTool } from "./tools-search.js";
import type { GlobalConfig, ToolAccessClass, ToolEnvelope } from "./types.js";

type ToolHandler = (context: ToolContext, input: any) => Promise<ToolEnvelope>;

type ToolDefinition = {
  id: (typeof ALL_TOOL_IDS)[number];
  description: string;
  access: ToolAccessClass;
  schema: z.ZodTypeAny;
  handler: ToolHandler;
};

export type ToolContext = {
  cwd: string;
  planMode: boolean;
  config: GlobalConfig["tools"];
  artifacts: ArtifactStore;
  runRoot: string;
  ensureMutationLock: () => Promise<void>;
  abortSignal?: AbortSignal;
};

type ProviderTool = {
  type: "function";
  name: string;
  description: string;
  strict: true;
  parameters: Record<string, unknown>;
};

const fileEncodingSchema = z.enum(["utf8", "utf-8"]).default("utf8");

const toolDefinitions: ToolDefinition[] = [
  {
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
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
    id: "web_search",
    description: "Stubbed web search tool reserved for future Exa integration.",
    access: "read_only",
    schema: z
      .object({
        query: z.string().min(1),
        type: z.string().optional(),
        num_results: z.number().int().positive().optional(),
        published_within_days: z.number().int().positive().optional(),
        include_domains: z.array(z.string()).optional(),
        exclude_domains: z.array(z.string()).optional(),
      })
      .strict(),
    handler: async () => unimplementedTool("web_search"),
  },
  {
    id: "web_fetch",
    description: "Stubbed web fetch tool reserved for future Defuddle integration.",
    access: "read_only",
    schema: z
      .object({
        url: z.string().url(),
      })
      .strict(),
    handler: async () => unimplementedTool("web_fetch"),
  },
  {
    id: "subagents",
    description: "Stubbed subagents tool reserved for future CLI integration.",
    access: "mutating",
    schema: z
      .object({
        action: z.string().min(1),
      })
      .strict(),
    handler: async () => unimplementedTool("subagents"),
  },
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
    throw toolError(`${path} was not found`);
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
    preview: createPreview(content, Math.min(context.config.max_output_chars, 4000)),
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
};

export async function runProcess(
  program: string,
  args: string[],
  options: {
    cwd: string;
    env?: Record<string, string>;
    detached?: boolean;
    abortSignal?: AbortSignal;
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

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolveResult({
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
      });
    });
  });
}
