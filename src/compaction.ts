import type { CompactionState, GlobalConfig, MessageRecord, SessionMeta } from "./types.js";
import { nowIso } from "./utils.js";

export type CompactionResult = {
  retainedMessages: MessageRecord[];
  compactionState: CompactionState | null;
};

const MAX_COMPLETED_WORK_ITEMS = 12;
const MAX_OPEN_LOOP_ITEMS = 8;
const MAX_SUMMARY_ITEM_CHARS = 240;

function estimateMessageTokens(message: MessageRecord): number {
  return Math.ceil(message.content.length / 3);
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
  const deduped: string[] = [];
  for (const item of merged) {
    if (!deduped.includes(item)) {
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
