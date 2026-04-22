import type { Readable, Writable } from "node:stream";
import type { AgentInputItem } from "@openai/agents";
import { AgentLoopError, runAgentLoop } from "./agent.js";
import { runAgentsSdkLoop } from "./agents-sdk.js";
import { ArtifactStore } from "./artifacts.js";
import { createDebugSink, type DebugSink, debugErrorData } from "./debug.js";
import { ExitCode, GoatError, sessionConflictError, timeoutError } from "./errors.js";
import { exportProviderTools, type ToolContext } from "./harness.js";
import { formatError } from "./io.js";
import {
  appendJsonlRecord,
  buildReplayRecords,
  buildRunSummary,
  commitRun,
  persistProviderFailureRecord,
  persistProviderRecords,
  persistTranscript,
  type RunSummaryInputs,
  runStatusFromError,
  terminationReasonFromError,
  unwrapRunError,
  writeSummary,
} from "./run-persist.js";
import { type PreparedRun, prepareRunExecution } from "./run-prepare.js";
import type { CommandOutput, RuntimeDeps } from "./runtime-context.js";
import {
  acquireLock,
  createRunDirectory,
  type LockHandle,
  loadSessionMeta,
  newId,
  type RunPaths,
  sessionPaths,
} from "./session.js";
import type { Command, RunSummary, TranscriptRecord } from "./types.js";
import { nowIso } from "./utils.js";

type RunCommand = Extract<Command, { kind: "run" }>;
type LockState = { executionLock: LockHandle | null };

function toAgentsSdkInputItem(message: { role: "user" | "assistant"; content: string }): AgentInputItem {
  if (message.role === "assistant") {
    return {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: message.content,
        },
      ],
    };
  }

  return {
    type: "message",
    role: "user",
    content: message.content,
  };
}

/**
 * Build the tool context for a run. The mutation lock is acquired lazily —
 * we only take it the first time a mutating tool is actually invoked so that
 * read-only runs never contend for the execution lock.
 */
function createToolContext(params: {
  command: RunCommand;
  prepared: PreparedRun;
  artifactStore: ArtifactStore;
  runRoot: string;
  abortSignal: AbortSignal;
}): { toolContext: ToolContext; lockState: LockState } {
  const { command, prepared, artifactStore, runRoot, abortSignal } = params;
  const { context, sessionMeta, effectiveCwd } = prepared;
  const lockState: LockState = { executionLock: null };

  const toolContext: ToolContext = {
    cwd: effectiveCwd,
    planMode: command.options.plan,
    config: context.config.tools,
    catastrophicOutputLimit: context.config.artifacts.catastrophic_output_limit,
    artifacts: artifactStore,
    runRoot,
    abortSignal,
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

  return { toolContext, lockState };
}

/**
 * Write the `run_started` transcript record plus the initial user message(s).
 *
 * Kept separate from the main orchestration so the record shape lives in one
 * place; once the run commits these are the entries a reader can use to
 * reconstruct what was sent to the provider on turn 1.
 */
async function writeInitialTranscript(params: {
  runDir: RunPaths;
  runId: string;
  prepared: PreparedRun;
  command: RunCommand;
}): Promise<void> {
  const { runDir, runId, prepared, command } = params;
  const { sessionMeta, agent, role, modelId, effort, effectiveCwd, promptAssembly, stdinText } = prepared;

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
    content: promptAssembly.current_user_content,
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
}

/**
 * Emit the debug events + transcript + summary that terminate a run. Used by
 * both the success and failure paths so the terminal audit trail stays
 * consistent.
 */
async function finalizeRun(params: {
  runDir: RunPaths;
  runId: string;
  sessionId: string;
  summary: RunSummary;
  debug: DebugSink;
  failureError?: unknown;
}): Promise<void> {
  const { runDir, runId, sessionId, summary, debug, failureError } = params;
  await appendJsonlRecord(runDir.transcript, {
    v: 1,
    ts: nowIso(),
    kind: "run_finished",
    run_id: runId,
    status: summary.status,
    termination_reason: summary.termination_reason,
  });
  await writeSummary(runDir.summary, summary);
  if (failureError !== undefined) {
    await debug.emit("error", "run_failed", {
      run_id: runId,
      session_id: sessionId,
      ...debugErrorData(failureError),
    });
  }
  await debug.emit("run", "finished", {
    run_id: runId,
    session_id: sessionId,
    status: summary.status,
    termination_reason: summary.termination_reason,
    duration_s: summary.duration_s,
    usage: summary.usage,
  });
}

export async function executeRunCommand(
  command: RunCommand,
  stdin: Readable,
  stderr: Writable,
  deps?: RuntimeDeps,
): Promise<CommandOutput> {
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
  const artifactStore = new ArtifactStore(runDir.artifacts);
  const startedAt = Date.now();
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(
    () => {
      timeoutController.abort(timeoutError("run timed out"));
    },
    Math.ceil(timeoutSeconds * 1000),
  );
  let observedUsage: RunSummary["usage"] = null;

  const { toolContext, lockState } = createToolContext({
    command,
    prepared,
    artifactStore,
    runRoot: runDir.root,
    abortSignal: timeoutController.signal,
  });

  await writeInitialTranscript({ runDir, runId, prepared, command });

  const summaryInputs = (): RunSummaryInputs => ({
    sessionMeta,
    runId,
    startedAt,
    command,
    agent,
    role,
    prompt,
    modelId,
    effort,
    effectiveCwd,
    artifactStats: artifactStore.stats(),
  });

  try {
    await debug.emit("run", "started", {
      run_id: runId,
      session_id: sessionMeta.session_id,
      plan_mode: command.options.plan,
      model: modelId,
      provider_model: providerModel,
      cwd: effectiveCwd,
    });
    const providerInput = promptAssembly.input.map((message) => ({
      type: "message" as const,
      role: message.role,
      content: message.content,
    }));
    const agentsSdkInput = promptAssembly.input.map(toAgentsSdkInputItem);
    const loopResult = deps?.createProvider
      ? await runAgentLoop({
          runId,
          provider: deps.createProvider({
            apiKey,
            baseURL: context.config.provider.base_url,
            timeoutSeconds: context.config.provider.timeout,
          }),
          model: providerModel,
          instructions: promptAssembly.instructions,
          initialInput: providerInput,
          tools: exportProviderTools(agent.enabled_tools),
          enabledTools: agent.enabled_tools,
          effort,
          maxOutputTokens: agent.max_output_tokens,
          contextWindowTokens: modelContextWindow,
          toolContext,
          debug,
        })
      : await runAgentsSdkLoop({
          runId,
          config: {
            apiKey,
            baseURL: context.config.provider.base_url,
            timeoutSeconds: context.config.provider.timeout,
          },
          model: providerModel,
          instructions: promptAssembly.instructions,
          initialInput: agentsSdkInput,
          enabledTools: agent.enabled_tools,
          effort,
          maxOutputTokens: agent.max_output_tokens,
          toolContext,
          debug,
        });

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

    const summary = buildRunSummary(summaryInputs(), {
      kind: "completed",
      finalText: loopResult.final_text,
      usage: observedUsage,
    });
    await finalizeRun({
      runDir,
      runId,
      sessionId: sessionMeta.session_id,
      summary,
      debug,
    });

    return {
      stdout: `${loopResult.final_text}\n`,
      stderr: "",
      exitCode: ExitCode.success,
      meta: {
        session_id: sessionMeta.session_id,
        run_id: runId,
      },
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

    const summary = buildRunSummary(summaryInputs(), {
      kind: "failed",
      status: runStatusFromError(rootError),
      terminationReason: terminationReasonFromError(rootError),
      usage: observedUsage,
      error: {
        code: rootError instanceof GoatError ? rootError.code : "FAILED",
        message: formatError(rootError),
      },
    });
    await finalizeRun({
      runDir,
      runId,
      sessionId: sessionMeta.session_id,
      summary,
      debug,
      failureError: rootError,
    });

    throw rootError;
  } finally {
    clearTimeout(timeoutHandle);
    if (lockState.executionLock) {
      await lockState.executionLock.release().catch(() => undefined);
    }
  }
}
