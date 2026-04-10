import { describe, expect, test } from "bun:test";

import { maybeCompactReplay } from "../src/compaction.js";

describe("maybeCompactReplay", () => {
  test("returns null compaction state when session has no messages", () => {
    const result = maybeCompactReplay({
      compactionConfig: {
        model: null,

        raw_history_budget_pct: 0.2,
        prompt_file: null,
      },
      sessionMeta: { revision: 1 } as any,
      sessionMessages: [],
      currentMessage: "Do something.",
      stdinText: null,
      compactAtTokens: 100,
      currentCompaction: null,
    });

    expect(result.retainedMessages).toEqual([]);
    expect(result.compactionState).toBeNull();
  });

  test("returns null compaction state when all messages fit within budget", () => {
    const result = maybeCompactReplay({
      compactionConfig: {
        model: null,

        raw_history_budget_pct: 0.5,
        prompt_file: null,
      },
      sessionMeta: { revision: 1 } as any,
      sessionMessages: [
        { role: "user", content: "short" },
        { role: "assistant", content: "reply" },
      ] as any,
      currentMessage: "Continue.",
      stdinText: null,
      compactAtTokens: 10000,
      currentCompaction: null,
    });

    expect(result.retainedMessages).toHaveLength(2);
    expect(result.compactionState).toBeNull();
  });

  test("drops oldest messages and retains newest when budget is tight", () => {
    const messages = [
      { role: "user", content: "A".repeat(90) },
      { role: "assistant", content: "B".repeat(90) },
      { role: "user", content: "C".repeat(30) },
      { role: "assistant", content: "D".repeat(30) },
    ] as any;

    const result = maybeCompactReplay({
      compactionConfig: {
        model: null,

        raw_history_budget_pct: 0.2,
        prompt_file: null,
      },
      sessionMeta: { revision: 2 } as any,
      sessionMessages: messages,
      currentMessage: "Keep going.",
      stdinText: null,
      compactAtTokens: 100,
      currentCompaction: null,
    });

    expect(result.compactionState).not.toBeNull();
    expect(result.retainedMessages.length).toBeLessThan(messages.length);
    expect(result.retainedMessages.at(-1)?.content).toBe("D".repeat(30));
  });

  test("carries forward prior checkpoint state across repeated compactions", () => {
    const first = maybeCompactReplay({
      compactionConfig: {
        model: null,

        raw_history_budget_pct: 0.2,
        prompt_file: null,
      },
      sessionMeta: {
        revision: 3,
      } as any,
      sessionMessages: [
        { role: "user", content: "Investigate the parser." },
        { role: "assistant", content: "Checked the parser implementation and found a mismatch." },
        { role: "user", content: "Tighten the patch grammar." },
        { role: "assistant", content: "Updated the grammar plan and listed the edge cases." },
      ] as any,
      currentMessage: "Continue the review.",
      stdinText: null,
      compactAtTokens: 24,
      currentCompaction: null,
    });

    const second = maybeCompactReplay({
      compactionConfig: {
        model: null,

        raw_history_budget_pct: 0.2,
        prompt_file: null,
      },
      sessionMeta: {
        revision: 4,
      } as any,
      sessionMessages: [
        ...first.retainedMessages,
        { role: "user", content: "Now review the config resolver." },
        { role: "assistant", content: "Found the repo-root path handling issue." },
      ] as any,
      currentMessage: "Keep going.",
      stdinText: null,
      compactAtTokens: 24,
      currentCompaction: first.compactionState,
    });

    expect(first.compactionState?.compaction_count).toBe(1);
    expect(second.compactionState?.compaction_count).toBe(2);
    expect(second.compactionState?.summary.completed_work).toEqual(
      expect.arrayContaining([
        "Checked the parser implementation and found a mismatch.",
        "Found the repo-root path handling issue.",
      ]),
    );
  });
});
