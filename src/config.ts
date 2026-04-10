import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import TOML from "@iarna/toml";
import { z } from "zod";

import { configError } from "./errors.js";
import type { ConfigRoots, GlobalConfig } from "./types.js";
import { bytesSchema, timeSchema, tokenSchema } from "./units.js";

type EnvLike = NodeJS.ProcessEnv;

export const effortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]);

const rawConfigSchema = z
  .object({
    paths: z
      .object({
        sessions_dir: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    defaults: z
      .object({
        agent: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    provider: z
      .object({
        kind: z.literal("openai_responses").optional(),
        transport: z.literal("http").optional(),
        base_url: z.string().url().optional(),
        api_key: z.string().min(1).optional(),
        api_key_env: z.string().min(1).optional(),
        timeout: timeSchema.optional(),
      })
      .strict()
      .optional(),
    runtime: z
      .object({
        max_stdin: bytesSchema.optional(),
        run_timeout: timeSchema.optional(),
      })
      .strict()
      .optional(),
    compaction: z
      .object({
        model: z.string().min(1).optional(),
        raw_history_budget_pct: z.number().min(0).max(1).optional(),
        prompt_file: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    artifacts: z
      .object({
        preview_limit: bytesSchema.optional(),
        catastrophic_output_limit: bytesSchema.optional(),
      })
      .strict()
      .optional(),
    tools: z
      .object({
        default_shell: z.string().min(1).optional(),
        default_shell_args: z.array(z.string()).optional(),
        max_output_chars: tokenSchema.optional(),
        max_file_size: bytesSchema.optional(),
        web_search: z
          .object({
            enabled: z.boolean().optional(),
            api_key: z.string().min(1).optional(),
            api_key_env: z.string().min(1).optional(),
          })
          .strict()
          .optional(),
        web_fetch: z
          .object({
            enabled: z.boolean().optional(),
            block_private_hosts: z.boolean().optional(),
            defuddle_base_url: z.string().url().optional(),
          })
          .strict()
          .optional(),
        subagents: z
          .object({
            enabled: z.boolean().optional(),
            default_model: z.string().min(1).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

type RawConfig = z.infer<typeof rawConfigSchema>;

function formatIssue(issue: z.ZodIssue): string {
  const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return `${path}${issue.message}`;
}

export function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }

  throw configError(`invalid ${label}: ${parsed.error.issues.map(formatIssue).join("; ")}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(homeValue: unknown, repoValue: unknown): unknown {
  if (Array.isArray(repoValue)) {
    return [...repoValue];
  }
  if (Array.isArray(homeValue)) {
    return repoValue ?? [...homeValue];
  }
  if (isPlainObject(homeValue) && isPlainObject(repoValue)) {
    const merged: Record<string, unknown> = { ...homeValue };
    for (const [key, value] of Object.entries(repoValue)) {
      merged[key] = key in merged ? deepMerge(merged[key], value) : value;
    }
    return merged;
  }

  return repoValue ?? homeValue;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function resolveConfigPath(baseDir: string, rawPath: string, repoRoot: string | null): string {
  if (rawPath === "~") {
    return normalize(homedir());
  }

  if (rawPath.startsWith("~/")) {
    return normalize(join(homedir(), rawPath.slice(2)));
  }

  if (rawPath.startsWith("/")) {
    return normalize(rawPath);
  }

  if (rawPath === "." || rawPath.startsWith("./")) {
    if (!repoRoot) {
      throw configError(`config path \`${rawPath}\` requires a repo root, but no repo root was discovered`);
    }

    return rawPath === "." ? normalize(repoRoot) : normalize(resolve(repoRoot, rawPath.slice(2)));
  }

  return normalize(resolve(baseDir, rawPath));
}

export async function parseTomlFile(path: string): Promise<Record<string, unknown>> {
  const source = await readFile(path, "utf8");
  try {
    return TOML.parse(source) as Record<string, unknown>;
  } catch (error) {
    throw configError(`failed to parse TOML at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function resolveConfigLayer(layer: RawConfig, sourcePath: string, repoRoot: string | null): RawConfig {
  const baseDir = dirname(sourcePath);
  return {
    ...layer,
    paths: layer.paths
      ? {
          ...layer.paths,
          sessions_dir: layer.paths.sessions_dir
            ? resolveConfigPath(baseDir, layer.paths.sessions_dir, repoRoot)
            : undefined,
        }
      : undefined,
    compaction: layer.compaction
      ? {
          ...layer.compaction,
          prompt_file: layer.compaction.prompt_file
            ? resolveConfigPath(baseDir, layer.compaction.prompt_file, repoRoot)
            : undefined,
        }
      : undefined,
  };
}

function normalizeGlobalConfig(raw: RawConfig, homeRoot: string): GlobalConfig {
  return {
    paths: {
      sessions_dir: raw.paths?.sessions_dir ?? join(homeRoot, "sessions"),
    },
    defaults: {
      agent: raw.defaults?.agent ?? null,
    },
    provider: {
      kind: "openai_responses",
      transport: "http",
      base_url: raw.provider?.base_url ?? "https://api.openai.com/v1",
      api_key: raw.provider?.api_key ?? null,
      api_key_env: raw.provider?.api_key_env ?? "OPENAI_API_KEY",
      timeout: raw.provider?.timeout ?? 45,
    },
    runtime: {
      max_stdin: raw.runtime?.max_stdin ?? 8 * 1024 * 1024,
      run_timeout: raw.runtime?.run_timeout ?? 7200,
    },
    compaction: {
      model: raw.compaction?.model ?? null,
      raw_history_budget_pct: raw.compaction?.raw_history_budget_pct ?? 0.2,
      prompt_file: raw.compaction?.prompt_file ?? null,
    },
    artifacts: {
      preview_limit: raw.artifacts?.preview_limit ?? 50 * 1024,
      catastrophic_output_limit: raw.artifacts?.catastrophic_output_limit ?? 16 * 1024 * 1024,
    },
    tools: {
      default_shell: raw.tools?.default_shell ?? "/bin/bash",
      default_shell_args: raw.tools?.default_shell_args ?? ["-lc"],
      max_output_chars: raw.tools?.max_output_chars ?? 200000,
      max_file_size: raw.tools?.max_file_size ?? 1 * 1024 * 1024,
      web_search: {
        enabled: raw.tools?.web_search?.enabled ?? false,
        api_key: raw.tools?.web_search?.api_key ?? null,
        api_key_env: raw.tools?.web_search?.api_key_env ?? "EXA_API_KEY",
      },
      web_fetch: {
        enabled: raw.tools?.web_fetch?.enabled ?? false,
        block_private_hosts: raw.tools?.web_fetch?.block_private_hosts ?? true,
        defuddle_base_url: raw.tools?.web_fetch?.defuddle_base_url ?? null,
      },
      subagents: {
        enabled: raw.tools?.subagents?.enabled ?? false,
        default_model: raw.tools?.subagents?.default_model ?? "gpt-5.4-mini",
      },
    },
  };
}

export async function discoverRoots(processCwd: string, env: EnvLike = process.env): Promise<ConfigRoots> {
  const overrideRepoRoot = env.GOAT_REPO_ROOT;
  const overrideHomeRoot = env.GOAT_HOME_ROOT;
  const homeRoot = normalize(overrideHomeRoot ? resolve(overrideHomeRoot) : join(homedir(), ".goat"));

  if (overrideRepoRoot) {
    return {
      repoRoot: normalize(resolve(overrideRepoRoot)),
      homeRoot,
    };
  }

  let current = normalize(resolve(processCwd));
  while (true) {
    if ((await exists(join(current, "goat.toml"))) || (await exists(join(current, ".goat")))) {
      return {
        repoRoot: current,
        homeRoot,
      };
    }
    const parent = dirname(current);
    if (parent === current) {
      return {
        repoRoot: null,
        homeRoot,
      };
    }
    current = parent;
  }
}

export async function loadGlobalConfig(roots: ConfigRoots): Promise<GlobalConfig> {
  const layers: RawConfig[] = [];

  for (const root of [roots.homeRoot, roots.repoRoot]) {
    if (!root) {
      continue;
    }
    const path = join(root, "goat.toml");
    if (!(await exists(path))) {
      continue;
    }
    const parsed = parseWithSchema(rawConfigSchema, await parseTomlFile(path), path);
    layers.push(resolveConfigLayer(parsed, path, roots.repoRoot));
  }

  const merged = layers.reduce<RawConfig>((accumulator, layer) => deepMerge(accumulator, layer) as RawConfig, {});
  return normalizeGlobalConfig(merged, roots.homeRoot);
}

export async function resolveOpenAIApiKey(config: GlobalConfig, env: EnvLike = process.env): Promise<string | null> {
  return config.provider.api_key ?? env[config.provider.api_key_env] ?? env.OPENAI_API_KEY ?? null;
}
