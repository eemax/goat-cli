import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";

import { compactSessionHistory, maybeCompactReplay } from "./compaction.js";
import { exists, resolveOpenAIApiKey } from "./config.js";
import type { DebugSink } from "./debug.js";
import { summarizePromptMessages } from "./debug.js";
import { resolveModel } from "./defs.js";
import { configError, isGoatError, notFoundError, usageError } from "./errors.js";
import { assemblePrompt, type PromptAssembly } from "./prompt.js";
import type { AppContext, RuntimeDeps } from "./runtime-context.js";
import { loadAppContext, loadBaseContext } from "./runtime-context.js";
import {
  createSession,
  ensureSessionCanRun,
  forkSession,
  lastActiveSession,
  loadCompactionState,
  loadSessionMeta,
  readMessages,
} from "./session.js";
import type {
  AgentDef,
  Command,
  CompactionState,
  Effort,
  MessageRecord,
  PromptDef,
  RoleDef,
  SessionMeta,
  SkillDef,
} from "./types.js";
import { isErrnoException } from "./utils.js";

type RunCommand = Extract<Command, { kind: "run" }>;

export type PreparedRun = {
  context: AppContext;
  sessionMeta: SessionMeta;
  agent: AgentDef;
  role: RoleDef | null;
  prompt: PromptDef | null;
  skills: SkillDef[];
  modelId: string;
  providerModel: string;
  modelContextWindow: number | null;
  effort: Effort | null;
  effectiveCwd: string;
  timeoutSeconds: number;
  stdinText: string | null;
  retainedMessages: MessageRecord[];
  pendingCompactionState: CompactionState | null;
  promptAssembly: PromptAssembly;
  apiKey: string;
};

type RunSessionResolution = {
  sessionMeta: SessionMeta;
  mode: "new" | "existing" | "fork";
  sourceSessionId: string | null;
};

async function readOptionalStdin(stdin: Readable, maxBytes: number): Promise<string | null> {
  const maybeTty = stdin as Readable & { isTTY?: boolean };
  if (maybeTty.isTTY) {
    return null;
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw usageError("stdin exceeded runtime.max_stdin");
    }
    chunks.push(buffer);
  }

  if (total === 0) {
    return null;
  }

  return Buffer.concat(chunks).toString("utf8");
}

function resolveRoleName(sessionMeta: SessionMeta, command: RunCommand): string | null {
  if (command.options.noRole) {
    return null;
  }
  return command.options.role ?? sessionMeta.role_name;
}

function resolveEffectiveEffort(sessionMeta: SessionMeta, agent: AgentDef, command: RunCommand): Effort | null {
  return command.options.effort ?? sessionMeta.effort ?? agent.default_effort;
}

function determineEffectiveCwd(command: RunCommand, sessionMeta: SessionMeta, processCwd: string): string {
  return resolve(command.options.cwd ?? sessionMeta.cwd ?? processCwd);
}

function compactBudgetTokens(compactAtTokens: number): number {
  return Math.floor(compactAtTokens * 0.9);
}

async function ensureExistingDirectory(path: string): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) {
      throw usageError(`working directory \`${path}\` is not a directory`);
    }
  } catch (error) {
    if (isGoatError(error)) {
      throw error;
    }
    if (isErrnoException(error)) {
      if (error.code === "ENOENT") {
        throw usageError(`working directory \`${path}\` was not found`);
      }
      if (error.code === "EACCES" || error.code === "EPERM") {
        throw usageError(`working directory \`${path}\` is not accessible (permission denied)`);
      }
    }
    throw usageError(
      `working directory \`${path}\` could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isApproachingLimit(estimate: number, limit: number | null): boolean {
  return limit !== null && estimate >= Math.floor(limit * 0.8);
}

async function resolveRunSession(context: AppContext, command: RunCommand): Promise<RunSessionResolution> {
  if (command.session === "new") {
    return {
      sessionMeta: await createSession(context.config.paths.sessions_dir),
      mode: "new",
      sourceSessionId: null,
    };
  }
  if (command.session === "last" && command.options.fork) {
    const source = await lastActiveSession(context.config.paths.sessions_dir);
    return {
      sessionMeta: await forkSession(context.config.paths.sessions_dir, "last"),
      mode: "fork",
      sourceSessionId: source.session_id,
    };
  }
  if (command.session !== "last" && command.options.fork) {
    const source = await loadSessionMeta(context.config.paths.sessions_dir, command.session);
    return {
      sessionMeta: await forkSession(context.config.paths.sessions_dir, command.session),
      mode: "fork",
      sourceSessionId: source.session_id,
    };
  }
  if (command.session === "last") {
    const sessionMeta = await lastActiveSession(context.config.paths.sessions_dir);
    return {
      sessionMeta,
      mode: "existing",
      sourceSessionId: sessionMeta.session_id,
    };
  }
  const sessionMeta = await loadSessionMeta(context.config.paths.sessions_dir, command.session);
  return {
    sessionMeta,
    mode: "existing",
    sourceSessionId: sessionMeta.session_id,
  };
}

export async function prepareRunExecution(
  command: RunCommand,
  stdin: Readable,
  deps?: RuntimeDeps,
  debug?: DebugSink,
): Promise<PreparedRun> {
  const processCwd = deps?.processCwd ?? process.cwd();
  const env = deps?.env ?? process.env;
  const context = await loadAppContext(await loadBaseContext(processCwd, env));
  debug?.setMaxChars?.(context.config.runtime.stderr_message_max_chars);

  await debug?.emit("config", "loaded", {
    config_roots: context.roots.configRoots,
    home_root: context.roots.homeRoot,
    loaded_config_paths: (
      await Promise.all(
        context.roots.configRoots.map(async (root) => {
          const path = join(root, "goat.toml");
          return (await exists(path)) ? path : null;
        }),
      )
    ).filter((path): path is string => path !== null),
    sessions_dir: context.config.paths.sessions_dir,
    shadowed_model_aliases: context.models.shadowedAliases,
  });

  const sessionResolution = await resolveRunSession(context, command);
  let sessionMeta = sessionResolution.sessionMeta;
  await ensureSessionCanRun(sessionMeta);

  const agentName = command.options.agent ?? sessionMeta.agent_name ?? context.config.defaults.agent;
  if (!agentName) {
    throw configError("no agent was selected and no default agent is configured");
  }
  if (sessionMeta.bound && sessionMeta.agent_name && sessionMeta.agent_name !== agentName) {
    throw configError(`session \`${sessionMeta.session_id}\` is bound to agent \`${sessionMeta.agent_name}\``);
  }

  const agent = context.definitions.agents.get(agentName);
  if (!agent) {
    throw notFoundError(`agent \`${agentName}\` was not found`);
  }

  const skills: SkillDef[] = [];
  if (command.options.skills.length > 0 && !agent.skills_enabled) {
    throw usageError(`agent \`${agent.name}\` has skills disabled`);
  }
  for (const skillId of command.options.skills) {
    const skill = agent.skills.find((candidate) => candidate.id === skillId);
    if (!skill) {
      throw notFoundError(`skill \`${skillId}\` was not found for agent \`${agent.name}\``);
    }
    skills.push(skill);
  }

  const roleName = resolveRoleName(sessionMeta, command);
  const role = roleName ? (context.definitions.roles.get(roleName) ?? null) : null;
  if (roleName && !role) {
    throw notFoundError(`role \`${roleName}\` was not found`);
  }

  const prompt = command.options.prompt ? (context.definitions.prompts.get(command.options.prompt) ?? null) : null;
  if (command.options.prompt && !prompt) {
    throw notFoundError(`prompt \`${command.options.prompt}\` was not found`);
  }

  const model = resolveModel(context.models, command.options.model ?? sessionMeta.model ?? agent.default_model);
  const modelId = model.id;
  const providerModel = model.provider_model;
  const modelContextWindow = model.context_window;
  const effort = resolveEffectiveEffort(sessionMeta, agent, command);
  const effectiveCwd = determineEffectiveCwd(command, sessionMeta, processCwd);
  await ensureExistingDirectory(effectiveCwd);

  if (command.options.compact) {
    const result = await compactSessionHistory({
      context,
      sessionMeta,
      agent,
      modelId,
      cwd: effectiveCwd,
      reason: "Manual compaction before prompt run.",
    });
    await debug?.emit("compaction", "manual", {
      trigger: "flag",
      run_id: result.runId,
      changed: result.changed,
      original_session_messages: result.originalMessages,
      retained_session_messages: result.retainedMessages,
      compaction_count: result.compactionCount,
    });
    if (result.changed) {
      sessionMeta = await loadSessionMeta(context.config.paths.sessions_dir, sessionMeta.session_id);
    }
  }

  const timeoutSeconds = command.options.timeoutSeconds ?? agent.run_timeout ?? context.config.runtime.run_timeout;
  const stdinText = await readOptionalStdin(stdin, context.config.runtime.max_stdin);
  const sessionMessages = await readMessages(context.config.paths.sessions_dir, sessionMeta.session_id);
  const currentCompaction = await loadCompactionState(context.config.paths.sessions_dir, sessionMeta.session_id);

  let retainedMessages = sessionMessages;
  let pendingCompactionState: CompactionState | null = null;
  let promptAssembly = assemblePrompt({
    agent,
    role,
    prompt,
    skills,
    compaction: currentCompaction,
    sessionMessages: retainedMessages,
    userMessage: command.message,
    stdinText,
  });

  const effectiveCompactBudget = compactBudgetTokens(agent.compact_at_tokens);
  await debug?.emit("session", "resolved", {
    selector: command.session,
    resolution: sessionResolution.mode,
    fork: command.options.fork,
    session_id: sessionMeta.session_id,
    source_session_id: sessionResolution.sourceSessionId,
    revision: sessionMeta.revision,
    bound: sessionMeta.bound,
    agent: agent.name,
    role: role?.name ?? null,
    prompt: prompt?.name ?? null,
    skills: skills.map((skill) => skill.id),
    model: modelId,
    provider_model: providerModel,
    model_source_path: model.source_path,
    effort,
    cwd: effectiveCwd,
    plan_mode: command.options.plan,
    enabled_tools: agent.enabled_tools,
    agent_source_path: agent.source_path,
    role_source_path: role?.source_path ?? null,
    prompt_source_path: prompt?.source_path ?? null,
  });
  await debug?.emit("context", "assembled", {
    compacted: false,
    session_messages: sessionMessages.length,
    input_items: promptAssembly.input.length,
    estimated_tokens: promptAssembly.estimated_tokens,
    compact_at_tokens: agent.compact_at_tokens,
    compact_budget: effectiveCompactBudget,
    context_window: modelContextWindow,
    approaching_limit: isApproachingLimit(promptAssembly.estimated_tokens, modelContextWindow),
    instructions_chars: promptAssembly.instructions.length,
    current_compaction_count: currentCompaction?.compaction_count ?? 0,
    input_preview: summarizePromptMessages(promptAssembly.input),
    stdin_attached: stdinText !== null,
  });
  if (promptAssembly.estimated_tokens > effectiveCompactBudget) {
    const beforeEstimate = promptAssembly.estimated_tokens;
    const beforeMessageCount = promptAssembly.input.length;
    const compacted = maybeCompactReplay({
      compactionConfig: context.config.compaction,
      sessionMeta,
      sessionMessages,
      currentMessage: command.message,
      stdinText,
      compactAtTokens: agent.compact_at_tokens,
      currentCompaction,
    });
    retainedMessages = compacted.retainedMessages;
    pendingCompactionState = compacted.compactionState;
    promptAssembly = assemblePrompt({
      agent,
      role,
      prompt,
      skills,
      compaction: pendingCompactionState ?? currentCompaction,
      sessionMessages: retainedMessages,
      userMessage: command.message,
      stdinText,
    });
    await debug?.emit("compaction", "performed", {
      trigger: "pre_send_budget",
      before_estimated_tokens: beforeEstimate,
      after_estimated_tokens: promptAssembly.estimated_tokens,
      before_input_items: beforeMessageCount,
      after_input_items: promptAssembly.input.length,
      original_session_messages: sessionMessages.length,
      retained_session_messages: retainedMessages.length,
      dropped_session_messages: sessionMessages.length - retainedMessages.length,
      compaction_count: pendingCompactionState?.compaction_count ?? currentCompaction?.compaction_count ?? 0,
      raw_history_budget_pct: context.config.compaction.raw_history_budget_pct,
    });
    await debug?.emit("context", "assembled", {
      compacted: true,
      session_messages: retainedMessages.length,
      input_items: promptAssembly.input.length,
      estimated_tokens: promptAssembly.estimated_tokens,
      compact_at_tokens: agent.compact_at_tokens,
      compact_budget: effectiveCompactBudget,
      context_window: modelContextWindow,
      approaching_limit: isApproachingLimit(promptAssembly.estimated_tokens, modelContextWindow),
      instructions_chars: promptAssembly.instructions.length,
      current_compaction_count: (pendingCompactionState ?? currentCompaction)?.compaction_count ?? 0,
      input_preview: summarizePromptMessages(promptAssembly.input),
      stdin_attached: stdinText !== null,
    });
    if (promptAssembly.estimated_tokens > effectiveCompactBudget) {
      throw usageError(`assembled prompt exceeded compact_at_tokens (${agent.compact_at_tokens}) after compaction`);
    }
  }

  const apiKey = await resolveOpenAIApiKey(context.config, env);
  if (!apiKey) {
    throw configError("OpenAI API key is not configured");
  }

  return {
    context,
    sessionMeta,
    agent,
    role,
    prompt,
    skills,
    modelId,
    providerModel,
    modelContextWindow,
    effort,
    effectiveCwd,
    timeoutSeconds,
    stdinText,
    retainedMessages,
    pendingCompactionState,
    promptAssembly,
    apiKey,
  };
}
