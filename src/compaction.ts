import { readFile } from "node:fs/promises";

import { AgentLoopError, runAgentLoop } from "./agent.js";
import { ArtifactStore } from "./artifacts.js";
import { type DebugSink, debugErrorData } from "./debug.js";
import { GoatError, providerError, sessionConflictError, timeoutError } from "./errors.js";
import type { ToolContext } from "./harness.js";
import { formatError } from "./io.js";
import { OpenAIResponsesProvider } from "./provider.js";
import {
  appendJsonlRecord,
  buildReplayRecords,
  persistProviderFailureRecord,
  persistProviderRecords,
  persistTranscript,
  runStatusFromError,
  terminationReasonFromError,
  unwrapRunError,
  writeSummary,
} from "./run-persist.js";
import type { AppContext, RuntimeDeps } from "./runtime-context.js";
import {
  acquireLock,
  createRunDirectory,
  loadSessionMeta,
  newId,
  readMessages,
  sessionPaths,
  writeSessionMeta,
} from "./session.js";
import type { AgentDef, Effort, MessageRecord, ProviderUsage, RunSummary, SessionMeta } from "./types.js";
import { atomicWriteFile, nowIso, stableJson } from "./utils.js";

const BUILTIN_COMPACTION_PROMPT = new URL("./builtins/compaction-prompt.md", import.meta.url);

type ManualCompactionResult = {
  runId: string | null;
  changed: boolean;
  retainedMessages: number;
  originalMessages: number;
};

function toProviderInput(message: MessageRecord): { type: "message"; role: "user" | "assistant"; content: string } {
  return {
    type: "message",
    role: message.role,
    content: message.content,
  };
}

function parseCompactionResponse(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    throw providerError("compaction response was not valid JSON", {
      code: "invalid_compaction_response",
      retryable: false,
    });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw providerError("compaction response must be a JSON object", {
      code: "invalid_compaction_response",
      retryable: false,
    });
  }

  return stableJson(parsed).trimEnd();
}

async function loadCompactionPrompt(promptFile: string | null): Promise<string> {
  return readFile(promptFile ?? BUILTIN_COMPACTION_PROMPT, "utf8");
}

function buildCompactionSummary(params: {
  sessionMeta: SessionMeta;
  runId: string;
  startedAt: number;
  agent: AgentDef;
  modelId: string;
  effort: Effort | null;
  cwd: string;
  usage: ProviderUsage | null;
  finalText: string | null;
  error: { code: string; message: string } | null;
  status: RunSummary["status"];
  terminationReason: string;
}): RunSummary {
  return {
    v: 1,
    session_id: params.sessionMeta.session_id,
    run_id: params.runId,
    run_kind: "compaction",
    status: params.status,
    started_at: new Date(params.startedAt).toISOString(),
    finished_at: nowIso(),
    duration_s: Number(((Date.now() - params.startedAt) / 1000).toFixed(3)),
    plan_mode: false,
    agent_name: params.agent.name,
    role_name: params.sessionMeta.role_name,
    prompt_name: null,
    model: params.modelId,
    effort: params.effort,
    provider: "openai_responses",
    transport: "http",
    cwd: params.cwd,
    termination_reason: params.terminationReason,
    usage: params.usage,
    artifacts: {
      count: 0,
      total_bytes: 0,
    },
    final_output: {
      text: params.finalText,
      chars: params.finalText?.length ?? 0,
      artifact: null,
    },
    error: params.error,
  };
}

export async function compactSessionHistory(params: {
  context: AppContext;
  sessionMeta: SessionMeta;
  agent: AgentDef;
  modelId: string;
  providerModel: string;
  effort: Effort | null;
  cwd: string;
  apiKey: string;
  deps?: RuntimeDeps;
  debug?: DebugSink;
}): Promise<ManualCompactionResult> {
  const { context, sessionMeta, agent, modelId, providerModel, effort, cwd, apiKey, deps, debug } = params;
  const sessionMessages = await readMessages(context.config.paths.sessions_dir, sessionMeta.session_id);
  if (sessionMessages.length === 0) {
    return {
      runId: null,
      changed: false,
      retainedMessages: 0,
      originalMessages: 0,
    };
  }

  const compactionPrompt = await loadCompactionPrompt(context.config.compaction.prompt_file);
  const runId = newId();
  const runDir = await createRunDirectory(context.config.paths.sessions_dir, sessionMeta.session_id, runId);
  const artifactStore = new ArtifactStore(runDir.artifacts);
  const startedAt = Date.now();
  const timeoutController = new AbortController();
  const timeoutSeconds = agent.run_timeout ?? context.config.runtime.run_timeout;
  const timeoutHandle = setTimeout(
    () => timeoutController.abort(timeoutError("compaction run timed out")),
    Math.ceil(timeoutSeconds * 1000),
  );
  let observedUsage: ProviderUsage | null = null;

  const replayCommand = {
    kind: "run" as const,
    name: "explicit" as const,
    session: sessionMeta.session_id,
    options: {
      fork: false,
      agent: agent.name,
      role: null,
      noRole: false,
      prompt: null,
      skills: [],
      compact: false,
      scenario: null,
      model: modelId,
      effort,
      timeoutSeconds,
      plan: false,
      cwd,
      verbose: false,
      debug: false,
      debugJson: false,
    },
    message: compactionPrompt,
  };

  await appendJsonlRecord(runDir.transcript, {
    v: 1,
    ts: nowIso(),
    kind: "run_started",
    run_id: runId,
    session_id: sessionMeta.session_id,
    run_kind: "compaction",
    agent_name: agent.name,
    role_name: sessionMeta.role_name,
    model: modelId,
    effort,
    plan_mode: false,
    cwd,
  });
  await appendJsonlRecord(runDir.transcript, {
    v: 1,
    ts: nowIso(),
    kind: "message",
    run_id: runId,
    role: "user",
    content: compactionPrompt,
  });

  const toolContext: ToolContext = {
    cwd,
    planMode: false,
    config: context.config.tools,
    catastrophicOutputLimit: context.config.artifacts.catastrophic_output_limit,
    artifacts: artifactStore,
    runRoot: runDir.root,
    abortSignal: timeoutController.signal,
    ensureMutationLock: async () => undefined,
  };

  try {
    await debug?.emit("compaction", "manual", {
      trigger: "manual",
      run_id: runId,
      original_session_messages: sessionMessages.length,
    });

    const provider = deps?.createProvider
      ? deps.createProvider({
          apiKey,
          baseURL: context.config.provider.base_url,
          timeoutSeconds: context.config.provider.timeout,
        })
      : new OpenAIResponsesProvider({
          apiKey,
          baseURL: context.config.provider.base_url,
          timeoutSeconds: context.config.provider.timeout,
        });

    const loopResult = await runAgentLoop({
      runId,
      provider,
      model: providerModel,
      instructions: agent.system_prompt,
      initialInput: [
        ...sessionMessages.map(toProviderInput),
        { type: "message", role: "user", content: compactionPrompt },
      ],
      tools: [],
      enabledTools: [],
      effort,
      maxOutputTokens: agent.max_output_tokens,
      contextWindowTokens: null,
      toolContext,
      debug,
    });
    observedUsage = loopResult.usage;

    const compactedText = parseCompactionResponse(loopResult.final_text);
    await persistProviderRecords(runDir.provider, runId, loopResult.provider_turns, providerModel);
    await persistTranscript(runDir.transcript, loopResult.transcript);

    const replayRecords = buildReplayRecords(runId, replayCommand, null, compactedText, { compacted: true });
    const paths = sessionPaths(context.config.paths.sessions_dir, sessionMeta.session_id);
    const lock = await acquireLock(paths.sessionLock);
    try {
      const fresh = await loadSessionMeta(context.config.paths.sessions_dir, sessionMeta.session_id);
      if (fresh.revision !== sessionMeta.revision) {
        throw sessionConflictError(`session \`${sessionMeta.session_id}\` changed during compaction`);
      }
      await atomicWriteFile(paths.messages, `${replayRecords.map((record) => JSON.stringify(record)).join("\n")}\n`);
      await writeSessionMeta(context.config.paths.sessions_dir, {
        ...fresh,
        bound: true,
        revision: fresh.revision + 1,
        updated_at: nowIso(),
        last_run_usage: loopResult.usage,
        message_count: replayRecords.length,
        agent_name: agent.name,
        model: modelId,
        effort,
        cwd,
      });
    } finally {
      await lock.release();
    }

    await appendJsonlRecord(runDir.transcript, {
      v: 1,
      ts: nowIso(),
      kind: "run_finished",
      run_id: runId,
      status: "completed",
      termination_reason: "compaction_completed",
    });
    await writeSummary(
      runDir.summary,
      buildCompactionSummary({
        sessionMeta,
        runId,
        startedAt,
        agent,
        modelId,
        effort,
        cwd,
        usage: observedUsage,
        finalText: compactedText,
        error: null,
        status: "completed",
        terminationReason: "compaction_completed",
      }),
    );

    return {
      runId,
      changed: true,
      retainedMessages: replayRecords.length,
      originalMessages: sessionMessages.length,
    };
  } catch (error) {
    const rootError = unwrapRunError(error);
    if (error instanceof AgentLoopError) {
      observedUsage = error.state.usage;
      await persistProviderRecords(runDir.provider, runId, error.state.provider_turns, providerModel);
      await persistTranscript(runDir.transcript, error.state.transcript);
    }
    if (rootError instanceof Error) {
      await debug?.emit("error", "compaction_failed", {
        run_id: runId,
        session_id: sessionMeta.session_id,
        ...debugErrorData(rootError),
      });
    }
    if (rootError instanceof GoatError) {
      const requestIndex = error instanceof AgentLoopError ? error.state.provider_turns.length + 1 : 1;
      await persistProviderFailureRecord(runDir.provider, runId, requestIndex, rootError);
    }

    await appendJsonlRecord(runDir.transcript, {
      v: 1,
      ts: nowIso(),
      kind: "run_finished",
      run_id: runId,
      status: runStatusFromError(rootError),
      termination_reason: terminationReasonFromError(rootError),
    });
    await writeSummary(
      runDir.summary,
      buildCompactionSummary({
        sessionMeta,
        runId,
        startedAt,
        agent,
        modelId,
        effort,
        cwd,
        usage: observedUsage,
        finalText: null,
        error: {
          code: rootError instanceof GoatError ? rootError.code : "FAILED",
          message: formatError(rootError),
        },
        status: runStatusFromError(rootError),
        terminationReason: terminationReasonFromError(rootError),
      }),
    );
    throw rootError;
  } finally {
    clearTimeout(timeoutHandle);
  }
}
