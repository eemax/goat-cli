import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { z } from "zod";
import { effortSchema, exists, parseTomlFile, parseWithSchema } from "./config.js";
import { configError } from "./errors.js";
import { isKnownToolId } from "./tool-ids.js";
import type { AgentDef, ConfigRoots, ModelDef, PromptDef, RoleDef } from "./types.js";
import { timeSchema, tokenSchema } from "./units.js";

type LayeredFile = {
  name: string;
  path: string;
};

async function listTomlFiles(directory: string): Promise<LayeredFile[]> {
  if (!(await exists(directory))) {
    return [];
  }
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".toml"))
    .map((entry) => ({
      name: basename(entry.name, ".toml"),
      path: join(directory, entry.name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function listDefinitionFiles(
  roots: ConfigRoots,
  kind: "agents" | "roles" | "prompts",
): Promise<LayeredFile[]> {
  const byName = new Map<string, LayeredFile>();
  const homeFiles = await listTomlFiles(join(roots.homeRoot, kind));
  const repoFiles = roots.repoRoot ? await listTomlFiles(join(roots.repoRoot, kind)) : [];

  for (const file of homeFiles) {
    byName.set(file.name, file);
  }
  for (const file of repoFiles) {
    byName.set(file.name, file);
  }

  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

const rawModelsSchema = z
  .object({
    models: z
      .array(
        z
          .object({
            id: z.string().min(1),
            provider: z.literal("openai_responses").optional(),
            provider_model: z.string().min(1).optional(),
            aliases: z.array(z.string().min(1)).optional(),
            context_window: tokenSchema.nullable().optional(),
            max_output_tokens: tokenSchema.nullable().optional(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

function validateLayerAliases(entries: Array<z.infer<typeof rawModelsSchema>["models"][number]>, label: string): void {
  const ids = new Set<string>();
  const aliases = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) {
      throw configError(`duplicate model id \`${entry.id}\` in ${label}`);
    }
    ids.add(entry.id);
    for (const alias of entry.aliases ?? []) {
      if (aliases.has(alias)) {
        throw configError(`duplicate model alias \`${alias}\` in ${label}`);
      }
      aliases.add(alias);
    }
  }
}

export type ModelCatalog = {
  byId: Map<string, ModelDef>;
  aliasToId: Map<string, string>;
  shadowedAliases: string[];
};

export async function loadModelCatalog(roots: ConfigRoots): Promise<ModelCatalog> {
  const layers = [];
  for (const root of [roots.homeRoot, roots.repoRoot]) {
    if (!root) {
      continue;
    }
    const path = join(root, "models.toml");
    if (!(await exists(path))) {
      continue;
    }
    const parsed = parseWithSchema(rawModelsSchema, await parseTomlFile(path), path);
    validateLayerAliases(parsed.models, path);
    layers.push({ path, models: parsed.models });
  }

  const byId = new Map<string, ModelDef>();

  for (const layer of layers) {
    for (const model of layer.models) {
      byId.set(model.id, {
        id: model.id,
        provider_model: model.provider_model ?? model.id,
        aliases: model.aliases ?? [],
        context_window: model.context_window ?? null,
        max_output_tokens: model.max_output_tokens ?? null,
        source_path: layer.path,
      });
    }
  }

  const aliasToId = new Map<string, string>();
  const shadowedAliases: string[] = [];

  for (const layer of layers) {
    for (const model of layer.models) {
      for (const alias of model.aliases ?? []) {
        const existing = aliasToId.get(alias);
        if (existing && existing !== model.id) {
          shadowedAliases.push(alias);
        }
        aliasToId.set(alias, model.id);
      }
    }
  }

  return {
    byId,
    aliasToId,
    shadowedAliases,
  };
}

export function resolveModelId(catalog: ModelCatalog, idOrAlias: string): string {
  if (catalog.byId.has(idOrAlias)) {
    return idOrAlias;
  }
  const resolved = catalog.aliasToId.get(idOrAlias);
  if (!resolved) {
    throw configError(`unknown model \`${idOrAlias}\``);
  }
  return resolved;
}

export function resolveModel(catalog: ModelCatalog, idOrAlias: string): ModelDef {
  const modelId = resolveModelId(catalog, idOrAlias);
  const model = catalog.byId.get(modelId);
  if (!model) {
    throw configError(`unknown model \`${idOrAlias}\``);
  }

  return model;
}

function resolveDefinitionFilePath(sourcePath: string, rawPath: string): string {
  return normalize(resolve(dirname(sourcePath), rawPath));
}

async function readTextAsset(path: string): Promise<string> {
  return readFile(path, "utf8");
}

const rawAgentSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1).optional(),
    default_model: z.string().min(1),
    default_effort: effortSchema.optional(),
    max_output_tokens: tokenSchema.optional(),
    compact_at_tokens: tokenSchema.optional(),
    run_timeout: timeSchema.optional(),
    enabled_tools: z.array(z.string().min(1)).min(1),
    system_prompt: z.string().min(1).optional(),
    system_prompt_file: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const count = Number(Boolean(value.system_prompt)) + Number(Boolean(value.system_prompt_file));
    if (count !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "exactly one of `system_prompt` or `system_prompt_file` is required",
      });
    }
  });

const rawRoleSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1).optional(),
    system_prompt: z.string().min(1).optional(),
    system_prompt_file: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const count = Number(Boolean(value.system_prompt)) + Number(Boolean(value.system_prompt_file));
    if (count !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "exactly one of `system_prompt` or `system_prompt_file` is required",
      });
    }
  });

const rawPromptSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    text_file: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const count = Number(Boolean(value.text)) + Number(Boolean(value.text_file));
    if (count !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "exactly one of `text` or `text_file` is required",
      });
    }
  });

export type Definitions = {
  agents: Map<string, AgentDef>;
  roles: Map<string, RoleDef>;
  prompts: Map<string, PromptDef>;
};

export async function loadDefinitions(roots: ConfigRoots, catalog: ModelCatalog): Promise<Definitions> {
  const agents = new Map<string, AgentDef>();
  for (const file of await listDefinitionFiles(roots, "agents")) {
    const parsed = parseWithSchema(rawAgentSchema, await parseTomlFile(file.path), file.path);
    for (const toolId of parsed.enabled_tools) {
      if (!isKnownToolId(toolId)) {
        throw configError(`agent \`${parsed.name}\` enables unknown tool \`${toolId}\``);
      }
    }
    agents.set(parsed.name, {
      name: parsed.name,
      description: parsed.description ?? null,
      default_model: resolveModelId(catalog, parsed.default_model),
      default_effort: parsed.default_effort ?? null,
      max_output_tokens: parsed.max_output_tokens ?? 12000,
      compact_at_tokens: parsed.compact_at_tokens ?? 180000,
      run_timeout: parsed.run_timeout ?? null,
      enabled_tools: parsed.enabled_tools,
      system_prompt:
        parsed.system_prompt ?? (await readTextAsset(resolveDefinitionFilePath(file.path, parsed.system_prompt_file!))),
      source_path: file.path,
    });
  }

  const roles = new Map<string, RoleDef>();
  for (const file of await listDefinitionFiles(roots, "roles")) {
    const parsed = parseWithSchema(rawRoleSchema, await parseTomlFile(file.path), file.path);
    roles.set(parsed.name, {
      name: parsed.name,
      description: parsed.description ?? null,
      system_prompt:
        parsed.system_prompt ?? (await readTextAsset(resolveDefinitionFilePath(file.path, parsed.system_prompt_file!))),
      source_path: file.path,
    });
  }

  const prompts = new Map<string, PromptDef>();
  for (const file of await listDefinitionFiles(roots, "prompts")) {
    const parsed = parseWithSchema(rawPromptSchema, await parseTomlFile(file.path), file.path);
    prompts.set(parsed.name, {
      name: parsed.name,
      description: parsed.description ?? null,
      text: parsed.text ?? (await readTextAsset(resolveDefinitionFilePath(file.path, parsed.text_file!))),
      source_path: file.path,
    });
  }

  return {
    agents,
    roles,
    prompts,
  };
}

export function formatDefinitionList(names: Iterable<string>): string {
  return [...names]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => `${name}\n`)
    .join("");
}
