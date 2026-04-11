import type { Readable, Writable } from "node:stream";
import { AgentLoopError, runAgentLoop } from "./agent.js";
import { ArtifactStore } from "./artifacts.js";
import { createDebugSink, debugErrorData } from "./debug.js";
import { ExitCode, GoatError, sessionConflictError, timeoutError } from "./errors.js";
import { exportProviderTools, type ToolContext } from "./harness.js";
import { formatError, writeText } from "./io.js";
import type { ProviderClient } from "./provider.js";
import { OpenAIResponsesProvider } from "./provider.js";
import {
  appendJsonlRecord,
  buildReplayRecords,
  commitRun,
  persistProviderFailureRecord,
  persistProviderRecords,
  persistTranscript,
  runStatusFromError,
  terminationReasonFromError,
  unwrapRunError,
  writeSummary,
} from "./run-persist.js";
import { type PreparedRun, prepareRunExecution } from "./run-prepare.js";
import type { CommandOutput, RuntimeDeps } from "./runtime-context.js";
import { acquireLock, createRunDirectory, type LockHandle, loadSessionMeta, newId, sessionPaths } from "./session.js";
import type { Command, RunSummary, TranscriptRecord } from "./types.js";
import { nowIso } from "./utils.js";

function createProviderFactory(
  deps?: RuntimeDeps,
): (config: { apiKey: string; baseURL: string; timeoutSeconds: number }) => ProviderClient {
  return deps?.createProvider ?? ((config) => new OpenAIResponsesProvider(config));
}

export async function executeRunCommand(
  command: Extract<Command, { kind: "run" }>,
  stdin: Readable,
  stderr: Writable,
  deps?: RuntimeDeps,
): Promise<CommandOutput> {
  const providerFactory = createProviderFactory(deps);
  const debug = createDebugSink(stderr, command.options);
  let prepared: PreparedRun;
  try {
    prepared = await prepareRunExecution(command, stdin, deps, debug);
  } catch (error) {
    await debug.emit("error", "prepare_failed", debugErrorData(error));
    throw error;
  }
  const {
    context,
    sessionMeta,
    agent,
    role,
    prompt,
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
  } = prepared;

  const runId = newId();
  const runDir = await createRunDirectory(context.config.paths.sessions_dir, sessionMeta.session_id, runId);
  const artifactStore = new ArtifactStore(runDir.root, runDir.artifacts);
  const startedAt = Date.now();
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(
    () => {
      timeoutController.abort(timeoutError("run timed out"));
    },
    Math.ceil(timeoutSeconds * 1000),
  );
  let observedUsage: RunSummary["usage"] = null;

  const lockState: { executionLock: LockHandle | null } = {
    executionLock: null,
  };
  const toolContext: ToolContext = {
    cwd: effectiveCwd,
    planMode: command.options.plan,
    config: context.config.tools,
    catastrophicOutputLimit: context.config.artifacts.catastrophic_output_limit,
    artifacts: artifactStore,
    runRoot: runDir.root,
    abortSignal: timeoutController.signal,
    ensureMutationLock: async () => {
      if (command.options.plan || lockState.executionLock) {
        return;
      }
      lockState.executionLock = await acquireLock(
        sessionPaths(context.config.paths.sessions_dir, sessionMeta.session_id).executionLock,
      );
      const fresh = await loadSessionMeta(context.config.paths.sessions_dir, sessionMeta.session_id);
      if (fresh.revision !== sessionMeta.revision) {
        await lockState.executionLock.release();
        lockState.executionLock = null;
        throw sessionConflictError(`session \`${sessionMeta.session_id}\` changed before the first mutating tool`);
      }
    },
  };

  const runStartedRecord: TranscriptRecord = {
    v: 1,
    ts: nowIso(),
    kind: "run_started",
    run_id: runId,
    session_id: sessionMeta.session_id,
    run_kind: "prompt",
    agent_name: agent.name,
    role_name: role?.name ?? null,
    model: modelId,
    effort,
    plan_mode: command.options.plan,
    cwd: effectiveCwd,
  };
  await appendJsonlRecord(runDir.transcript, runStartedRecord);
  await appendJsonlRecord(runDir.transcript, {
    v: 1,
    ts: nowIso(),
    kind: "message",
    run_id: runId,
    role: "user",
    content: prompt ? `${prompt.text}\n\n${command.message}` : command.message,
  });
  if (stdinText !== null) {
    await appendJsonlRecord(runDir.transcript, {
      v: 1,
      ts: nowIso(),
      kind: "message",
      run_id: runId,
      role: "user",
      content: stdinText,
    });
  }

  try {
    await debug.emit("run", "started", {
      run_id: runId,
      session_id: sessionMeta.session_id,
      plan_mode: command.options.plan,
      model: modelId,
      provider_model: providerModel,
      cwd: effectiveCwd,
    });
    const provider = providerFactory({
      apiKey,
      baseURL: context.config.provider.base_url,
      timeoutSeconds: context.config.provider.timeout,
    });
    const loopResult = await runAgentLoop({
      runId,
      provider,
      model: providerModel,
      instructions: promptAssembly.instructions,
      initialInput: promptAssembly.input.map((message) => ({
        type: "message",
        role: message.role,
        content: message.content,
      })),
      tools: exportProviderTools(agent.enabled_tools),
      enabledTools: agent.enabled_tools,
      effort,
      maxOutputTokens: agent.max_output_tokens,
      contextWindowTokens: modelContextWindow,
      toolContext,
      debug,
      onTextDelta: command.options.verbose
        ? async (delta) => {
            await writeText(stderr, delta);
          }
        : undefined,
    });

    if (command.options.verbose && loopResult.final_text) {
      await writeText(stderr, "\n");
    }
    observedUsage = loopResult.usage;

    await persistProviderRecords(runDir.provider, runId, loopResult.provider_turns, providerModel);
    await persistTranscript(runDir.transcript, loopResult.transcript);

    const replayRecords = buildReplayRecords(runId, command, stdinText, loopResult.final_text);
    const boundSessionMeta = {
      ...sessionMeta,
      agent_name: agent.name,
    };
    await commitRun({
      context,
      sessionMeta: boundSessionMeta,
      updatedRoleName: role?.name ?? null,
      modelId,
      effort,
      effectiveCwd,
      replayRecords,
      runUsage: loopResult.usage,
      compactionState: pendingCompactionState,
      retainedMessages,
    });
    await appendJsonlRecord(runDir.transcript, {
      v: 1,
      ts: nowIso(),
      kind: "run_finished",
      run_id: runId,
      status: "completed",
      termination_reason: "assistant_final",
    });

    const summary: RunSummary = {
      v: 1,
      session_id: sessionMeta.session_id,
      run_id: runId,
      run_kind: "prompt",
      status: "completed",
      started_at: new Date(startedAt).toISOString(),
      finished_at: nowIso(),
      duration_s: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
      plan_mode: command.options.plan,
      agent_name: agent.name,
      role_name: role?.name ?? null,
      prompt_name: prompt?.name ?? null,
      model: modelId,
      effort,
      provider: "openai_responses",
      transport: "http",
      cwd: effectiveCwd,
      termination_reason: "assistant_final",
      usage: observedUsage,
      artifacts: artifactStore.stats(),
      final_output: {
        text: loopResult.final_text,
        chars: loopResult.final_text.length,
        artifact: null,
      },
      error: null,
    };
    await writeSummary(runDir.summary, summary);
    await debug.emit("run", "finished", {
      run_id: runId,
      session_id: sessionMeta.session_id,
      status: "completed",
      termination_reason: "assistant_final",
      duration_s: summary.duration_s,
      usage: observedUsage,
    });
    return {
      stdout: `${loopResult.final_text}\n`,
      stderr: [],
      exitCode: ExitCode.success,
    };
  } catch (error) {
    const rootError = unwrapRunError(error);
    if (error instanceof AgentLoopError) {
      observedUsage = error.state.usage;
      await persistProviderRecords(runDir.provider, runId, error.state.provider_turns, providerModel);
      await persistTranscript(runDir.transcript, error.state.transcript);
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
    const summary: RunSummary = {
      v: 1,
      session_id: sessionMeta.session_id,
      run_id: runId,
      run_kind: "prompt",
      status: runStatusFromError(rootError),
      started_at: new Date(startedAt).toISOString(),
      finished_at: nowIso(),
      duration_s: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
      plan_mode: command.options.plan,
      agent_name: agent.name,
      role_name: role?.name ?? null,
      prompt_name: prompt?.name ?? null,
      model: modelId,
      effort,
      provider: "openai_responses",
      transport: "http",
      cwd: effectiveCwd,
      termination_reason: terminationReasonFromError(rootError),
      usage: observedUsage,
      artifacts: artifactStore.stats(),
      final_output: {
        text: null,
        chars: 0,
        artifact: null,
      },
      error: {
        code: rootError instanceof GoatError ? rootError.code : "FAILED",
        message: formatError(rootError),
      },
    };
    await writeSummary(runDir.summary, summary);
    await debug.emit("error", "run_failed", {
      run_id: runId,
      session_id: sessionMeta.session_id,
      ...debugErrorData(rootError),
    });
    await debug.emit("run", "finished", {
      run_id: runId,
      session_id: sessionMeta.session_id,
      status: summary.status,
      termination_reason: summary.termination_reason,
      duration_s: summary.duration_s,
      usage: observedUsage,
    });
    throw rootError;
  } finally {
    clearTimeout(timeoutHandle);
    if (lockState.executionLock) {
      await lockState.executionLock.release().catch(() => undefined);
    }
  }
}
