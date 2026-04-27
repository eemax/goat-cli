import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { z } from "zod";
import { effortSchema, exists, parseTomlFile, parseWithSchema } from "./config.js";
import { configError } from "./errors.js";
import { loadSkillsFromDirectory } from "./skills.js";
import { isKnownToolId } from "./tool-ids.js";
import type { AgentDef, ConfigRoots, ModelDef, PromptDef, RoleDef, ScenarioDef } from "./types.js";
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
  kind: "agents" | "roles" | "prompts" | "scenarios",
): Promise<LayeredFile[]> {
  const byName = new Map<string, LayeredFile>();
  for (const root of roots.configRoots) {
    for (const file of await listTomlFiles(join(root, kind))) {
      byName.set(file.name, file);
    }
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

type ModelCatalog = {
  byId: Map<string, ModelDef>;
  aliasToId: Map<string, string>;
  shadowedAliases: string[];
};

export async function loadModelCatalog(roots: ConfigRoots): Promise<ModelCatalog> {
  const layers = [];
  for (const root of roots.configRoots) {
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
    skills: z
      .object({
        enabled: z.boolean().optional(),
        path: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
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
    if (value.skills?.enabled === true && !value.skills.path) {
      ctx.addIssue({
        code: "custom",
        path: ["skills", "path"],
        message: "`skills.path` is required when skills are enabled",
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

const rawScenarioStepSchema = z
  .object({
    id: z.string().min(1),
    agent: z.string().min(1),
    role: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    message: z.string().min(1),
    skills: z.array(z.string().min(1)).optional(),
    model: z.string().min(1).optional(),
    effort: effortSchema.optional(),
    timeout: timeSchema.optional(),
    cwd: z.string().min(1).optional(),
    compact: z.boolean().optional(),
  })
  .strict();

const rawScenarioSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1).optional(),
    steps: z.array(rawScenarioStepSchema).min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const [index, step] of value.steps.entries()) {
      if (seen.has(step.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", index, "id"],
          message: `duplicate scenario step id \`${step.id}\``,
        });
      }
      seen.add(step.id);
    }
  });

type Definitions = {
  agents: Map<string, AgentDef>;
  roles: Map<string, RoleDef>;
  prompts: Map<string, PromptDef>;
  scenarios: Map<string, ScenarioDef>;
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
    const skillsEnabled = parsed.skills?.enabled ?? false;
    const skillsPath =
      skillsEnabled && parsed.skills?.path ? resolveDefinitionFilePath(file.path, parsed.skills.path) : null;
    const skills = skillsEnabled && skillsPath ? await loadSkillsFromDirectory(skillsPath) : [];
    agents.set(parsed.name, {
      name: parsed.name,
      description: parsed.description ?? null,
      default_model: resolveModelId(catalog, parsed.default_model),
      default_effort: parsed.default_effort ?? null,
      max_output_tokens: parsed.max_output_tokens ?? 12000,
      compact_at_tokens: parsed.compact_at_tokens ?? 180000,
      run_timeout: parsed.run_timeout ?? null,
      enabled_tools: parsed.enabled_tools,
      skills_enabled: skillsEnabled,
      skills_path: skillsPath,
      skills,
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

  const scenarios = new Map<string, ScenarioDef>();
  for (const file of await listDefinitionFiles(roots, "scenarios")) {
    const parsed = parseWithSchema(rawScenarioSchema, await parseTomlFile(file.path), file.path);
    for (const step of parsed.steps) {
      const agent = agents.get(step.agent);
      if (!agent) {
        throw configError(`scenario \`${parsed.name}\` references unknown agent \`${step.agent}\``);
      }
      if (step.role && !roles.has(step.role)) {
        throw configError(`scenario \`${parsed.name}\` references unknown role \`${step.role}\``);
      }
      if (step.prompt && !prompts.has(step.prompt)) {
        throw configError(`scenario \`${parsed.name}\` references unknown prompt \`${step.prompt}\``);
      }
      if (step.model) {
        try {
          resolveModelId(catalog, step.model);
        } catch {
          throw configError(`scenario \`${parsed.name}\` references unknown model \`${step.model}\``);
        }
      }
      for (const skillId of step.skills ?? []) {
        if (!agent.skills.find((skill) => skill.id === skillId)) {
          throw configError(
            `scenario \`${parsed.name}\` references unknown skill \`${skillId}\` for agent \`${agent.name}\``,
          );
        }
      }
    }
    scenarios.set(parsed.name, {
      name: parsed.name,
      description: parsed.description ?? null,
      steps: parsed.steps.map((step) => ({
        id: step.id,
        agent: step.agent,
        role: step.role ?? null,
        prompt: step.prompt ?? null,
        message: step.message,
        skills: step.skills ?? [],
        model: step.model ?? null,
        effort: step.effort ?? null,
        timeoutSeconds: step.timeout ?? null,
        cwd: step.cwd ? resolveDefinitionFilePath(file.path, step.cwd) : null,
        compact: step.compact ?? null,
      })),
      source_path: file.path,
    });
  }

  return {
    agents,
    roles,
    prompts,
    scenarios,
  };
}

export function formatDefinitionList(names: Iterable<string>): string {
  return [...names]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => `${name}\n`)
    .join("");
}
