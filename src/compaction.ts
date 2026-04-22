import { sessionConflictError } from "./errors.js";
import { appendJsonlRecord, writeSummary } from "./run-persist.js";
import type { AppContext } from "./runtime-context.js";
import {
  acquireLock,
  createRunDirectory,
  loadCompactionState,
  loadSessionMeta,
  newId,
  readMessages,
  sessionPaths,
  writeCompactionState,
  writeSessionMeta,
} from "./session.js";
import type { AgentDef, CompactionState, GlobalConfig, MessageRecord, RunSummary, SessionMeta } from "./types.js";
import { atomicWriteFile, estimateTextTokens, nowIso } from "./utils.js";

export type CompactionResult = {
  retainedMessages: MessageRecord[];
  compactionState: CompactionState | null;
};

const MAX_COMPLETED_WORK_ITEMS = 12;
const MAX_OPEN_LOOP_ITEMS = 8;
const MAX_SUMMARY_ITEM_CHARS = 240;

function estimateMessageTokens(message: MessageRecord): number {
  return estimateTextTokens(message.content);
}

function summarizeText(text: string, maxChars = MAX_SUMMARY_ITEM_CHARS): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }

  return `${compact.slice(0, maxChars - 3)}...`;
}

function normalizeSummaryList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => String(item).trim())
    .filter(Boolean)
    .map((item) => summarizeText(item));
}

function mergeSummaryList(previous: unknown, additions: string[], limit: number): string[] | undefined {
  const merged = [...normalizeSummaryList(previous), ...additions.map((item) => summarizeText(item))];
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const item of merged) {
    if (!seen.has(item)) {
      seen.add(item);
      deduped.push(item);
    }
  }

  if (deduped.length === 0) {
    return undefined;
  }

  return deduped.slice(-limit);
}

export function maybeCompactReplay(params: {
  compactionConfig: GlobalConfig["compaction"];
  sessionMeta: SessionMeta;
  sessionMessages: MessageRecord[];
  currentMessage: string;
  stdinText: string | null;
  compactAtTokens: number;
  currentCompaction: CompactionState | null;
}): CompactionResult {
  if (params.sessionMessages.length === 0) {
    return {
      retainedMessages: params.sessionMessages,
      compactionState: null,
    };
  }

  const retainedMessages: MessageRecord[] = [];
  let retainedEstimate = 0;
  const rawHistoryBudget = Math.floor(params.compactAtTokens * params.compactionConfig.raw_history_budget_pct);
  for (let index = params.sessionMessages.length - 1; index >= 0; index -= 1) {
    const candidate = params.sessionMessages[index]!;
    const nextEstimate = retainedEstimate + estimateMessageTokens(candidate);
    if (nextEstimate > rawHistoryBudget) {
      continue;
    }
    retainedMessages.unshift(candidate);
    retainedEstimate = nextEstimate;
  }

  const droppedMessages = params.sessionMessages.filter((message) => !retainedMessages.includes(message));
  if (droppedMessages.length === 0) {
    return {
      retainedMessages: params.sessionMessages,
      compactionState: null,
    };
  }

  const latestDroppedUser = [...droppedMessages].reverse().find((message) => message.role === "user");
  const previousSummary = params.currentCompaction?.summary ?? {};

  return {
    retainedMessages,
    compactionState: {
      v: 1,
      updated_at: nowIso(),
      source_revision: params.sessionMeta.revision,
      compaction_count: (params.currentCompaction?.compaction_count ?? 0) + 1,
      raw_history_budget_pct: params.compactionConfig.raw_history_budget_pct,
      retained_raw_token_estimate: retainedEstimate,
      summary: {
        ...previousSummary,
        current_objective: summarizeText(params.currentMessage),
        last_user_request: summarizeText(
          latestDroppedUser?.content ??
            (typeof previousSummary.last_user_request === "string"
              ? previousSummary.last_user_request
              : params.currentMessage),
        ),
        completed_work: mergeSummaryList(
          previousSummary.completed_work,
          droppedMessages.filter((message) => message.role === "assistant").map((message) => message.content),
          MAX_COMPLETED_WORK_ITEMS,
        ),
        open_loops: mergeSummaryList(
          previousSummary.open_loops,
          droppedMessages.filter((message) => message.role === "user").map((message) => message.content),
          MAX_OPEN_LOOP_ITEMS,
        ),
        next_best_action: summarizeText(params.currentMessage),
      },
    },
  };
}

export type ManualCompactionResult = {
  runId: string | null;
  changed: boolean;
  retainedMessages: number;
  originalMessages: number;
  compactionCount: number;
};

export async function compactSessionHistory(params: {
  context: AppContext;
  sessionMeta: SessionMeta;
  agent: AgentDef;
  modelId: string;
  cwd: string;
  reason: string;
}): Promise<ManualCompactionResult> {
  const { context, sessionMeta, agent, modelId, cwd, reason } = params;
  const sessionMessages = await readMessages(context.config.paths.sessions_dir, sessionMeta.session_id);
  if (sessionMessages.length === 0) {
    return {
      runId: null,
      changed: false,
      retainedMessages: 0,
      originalMessages: 0,
      compactionCount: 0,
    };
  }

  const currentCompaction = await loadCompactionState(context.config.paths.sessions_dir, sessionMeta.session_id);
  const result = maybeCompactReplay({
    compactionConfig: context.config.compaction,
    sessionMeta,
    sessionMessages,
    currentMessage: reason,
    stdinText: null,
    compactAtTokens: agent.compact_at_tokens,
    currentCompaction,
  });
  const compactionState = result.compactionState ?? currentCompaction;
  const runId = newId();
  const runDir = await createRunDirectory(context.config.paths.sessions_dir, sessionMeta.session_id, runId);
  const startedAt = Date.now();

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
    effort: sessionMeta.effort ?? agent.default_effort,
    plan_mode: false,
    cwd,
  });
  await atomicWriteFile(runDir.provider, "");

  const changed = result.compactionState !== null;
  if (changed) {
    const paths = sessionPaths(context.config.paths.sessions_dir, sessionMeta.session_id);
    const lock = await acquireLock(paths.sessionLock);
    try {
      const fresh = await loadSessionMeta(context.config.paths.sessions_dir, sessionMeta.session_id);
      if (fresh.revision !== sessionMeta.revision) {
        throw sessionConflictError(`session \`${sessionMeta.session_id}\` changed during compaction`);
      }
      await writeCompactionState(context.config.paths.sessions_dir, sessionMeta.session_id, result.compactionState!);
      await atomicWriteFile(
        paths.messages,
        `${result.retainedMessages.map((record) => JSON.stringify(record)).join("\n")}\n`,
      );
      await writeSessionMeta(context.config.paths.sessions_dir, {
        ...fresh,
        revision: fresh.revision + 1,
        updated_at: nowIso(),
        message_count: result.retainedMessages.length,
      });
    } finally {
      await lock.release();
    }
  }

  await appendJsonlRecord(runDir.transcript, {
    v: 1,
    ts: nowIso(),
    kind: "run_finished",
    run_id: runId,
    status: "completed",
    termination_reason: changed ? "compaction_completed" : "compaction_not_needed",
  });

  const summary: RunSummary = {
    v: 1,
    session_id: sessionMeta.session_id,
    run_id: runId,
    run_kind: "compaction",
    status: "completed",
    started_at: new Date(startedAt).toISOString(),
    finished_at: nowIso(),
    duration_s: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
    plan_mode: false,
    agent_name: agent.name,
    role_name: sessionMeta.role_name,
    prompt_name: null,
    model: modelId,
    effort: sessionMeta.effort ?? agent.default_effort,
    provider: "openai_responses",
    transport: "http",
    cwd,
    termination_reason: changed ? "compaction_completed" : "compaction_not_needed",
    usage: null,
    artifacts: {
      count: 0,
      total_bytes: 0,
    },
    final_output: {
      text: changed ? "Compaction completed." : "Compaction not needed.",
      chars: changed ? "Compaction completed.".length : "Compaction not needed.".length,
      artifact: null,
    },
    error: null,
  };
  await writeSummary(runDir.summary, summary);

  return {
    runId,
    changed,
    retainedMessages: result.retainedMessages.length,
    originalMessages: sessionMessages.length,
    compactionCount: compactionState?.compaction_count ?? 0,
  };
}
