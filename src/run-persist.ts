import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { AgentLoopError } from "./agent.js";
import { ExitCode, GoatError, sessionConflictError } from "./errors.js";
import type { ProviderTurnResult } from "./provider.js";
import type { AppContext } from "./runtime-context.js";
import {
  acquireLock,
  appendMessages,
  loadSessionMeta,
  sessionPaths,
  writeCompactionState,
  writeSessionMeta,
} from "./session.js";
import type {
  Command,
  CompactionState,
  Effort,
  MessageRecord,
  ProviderUsage,
  RunSummary,
  SessionMeta,
  TranscriptRecord,
} from "./types.js";
import { atomicWriteFile, nowIso, stableJson } from "./utils.js";

type RunCommand = Extract<Command, { kind: "run" }>;

export async function appendJsonlRecord(path: string, record: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`);
}

export function buildReplayRecords(
  runId: string,
  command: RunCommand,
  stdinText: string | null,
  finalText: string,
): MessageRecord[] {
  const timestamp = nowIso();
  const records: MessageRecord[] = [
    {
      v: 1,
      ts: timestamp,
      kind: "message",
      run_id: runId,
      role: "user",
      source: "cli_arg",
      prompt_name: command.options.prompt,
      content: command.message,
    },
  ];

  if (stdinText !== null) {
    records.push({
      v: 1,
      ts: timestamp,
      kind: "message",
      run_id: runId,
      role: "user",
      source: "stdin",
      prompt_name: command.options.prompt,
      content: stdinText,
    });
  }

  records.push({
    v: 1,
    ts: timestamp,
    kind: "message",
    run_id: runId,
    role: "assistant",
    source: "assistant_final",
    prompt_name: null,
    content: finalText,
  });

  return records;
}

export async function commitRun(params: {
  context: AppContext;
  sessionMeta: SessionMeta;
  updatedRoleName: string | null;
  modelId: string;
  effort: Effort | null;
  effectiveCwd: string;
  replayRecords: MessageRecord[];
  runUsage: ProviderUsage | null;
  compactionState: CompactionState | null;
  retainedMessages: MessageRecord[];
}): Promise<void> {
  const paths = sessionPaths(params.context.config.paths.sessions_dir, params.sessionMeta.session_id);
  const lock = await acquireLock(paths.sessionLock);
  try {
    const fresh = await loadSessionMeta(params.context.config.paths.sessions_dir, params.sessionMeta.session_id);
    if (fresh.revision !== params.sessionMeta.revision) {
      throw sessionConflictError(`session \`${params.sessionMeta.session_id}\` changed during the run`);
    }

    const updated: SessionMeta = {
      ...fresh,
      bound: true,
      revision: fresh.revision + 1,
      updated_at: nowIso(),
      last_run_usage: params.runUsage,
      message_count: params.retainedMessages.length + params.replayRecords.length,
      agent_name: params.sessionMeta.agent_name,
      role_name: params.updatedRoleName,
      model: params.modelId,
      effort: params.effort,
      cwd: params.effectiveCwd,
    };

    if (params.compactionState) {
      await writeCompactionState(
        params.context.config.paths.sessions_dir,
        params.sessionMeta.session_id,
        params.compactionState,
      );
      const allMessages = [...params.retainedMessages, ...params.replayRecords];
      await atomicWriteFile(paths.messages, `${allMessages.map((record) => JSON.stringify(record)).join("\n")}\n`);
    } else {
      await appendMessages(
        params.context.config.paths.sessions_dir,
        params.sessionMeta.session_id,
        params.replayRecords,
      );
    }

    await writeSessionMeta(params.context.config.paths.sessions_dir, updated);
  } finally {
    await lock.release();
  }
}

export async function persistProviderRecords(
  path: string,
  runId: string,
  turns: ProviderTurnResult[],
  modelId: string,
): Promise<void> {
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index]!;
    await appendJsonlRecord(path, {
      v: 1,
      ts: nowIso(),
      kind: "provider_turn",
      run_id: runId,
      provider: "openai_responses",
      transport: "http",
      request_index: index + 1,
      response_id: turn.response_id,
      previous_response_id: turn.previous_response_id,
      model: modelId,
      status: turn.status,
      tool_call_count: turn.tool_calls.length,
      output_text_chars: turn.output_text.length,
      usage: turn.usage,
    });
  }
}

export function unwrapRunError(error: unknown): unknown {
  return error instanceof AgentLoopError ? error.cause : error;
}

export function runStatusFromError(error: unknown): RunSummary["status"] {
  if (error instanceof GoatError) {
    if (error.exitCode === ExitCode.sessionConflict) {
      return "session_conflict";
    }
    if (error.exitCode === ExitCode.timeout) {
      return "timed_out";
    }
    if (error.exitCode === ExitCode.interrupted) {
      return "interrupted";
    }
  }

  return "failed";
}

export function terminationReasonFromError(error: unknown): string {
  if (error instanceof GoatError) {
    return error.code.toLowerCase();
  }

  return "failed";
}

export async function persistProviderFailureRecord(
  path: string,
  runId: string,
  requestIndex: number,
  error: GoatError,
): Promise<void> {
  if (error.exitCode !== ExitCode.providerFailure) {
    return;
  }

  await appendJsonlRecord(path, {
    v: 1,
    ts: nowIso(),
    kind: "provider_error",
    run_id: runId,
    provider: "openai_responses",
    transport: "http",
    request_index: requestIndex,
    error_code: typeof error.details?.code === "string" ? error.details.code : "provider_error",
    message: error.message,
    retryable: error.details?.retryable === true,
  });
}

export async function persistTranscript(path: string, records: TranscriptRecord[]): Promise<void> {
  for (const record of records) {
    await appendJsonlRecord(path, record);
  }
}

export async function writeSummary(path: string, summary: RunSummary): Promise<void> {
  await atomicWriteFile(path, stableJson(summary));
}
