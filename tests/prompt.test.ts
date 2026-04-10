import { describe, expect, test } from "bun:test";

import { assemblePrompt, renderCompactionCheckpoint } from "../src/prompt.js";
import type { AgentDef, CompactionState, MessageRecord, PromptDef, RoleDef } from "../src/types.js";

const agent: AgentDef = {
  name: "coder",
  description: null,
  default_model: "gpt-5.4-mini",
  default_effort: "medium",
  max_output_tokens: 12000,
  compact_at_tokens: 180000,
  run_timeout: 7200,
  enabled_tools: ["read_file"],
  system_prompt: "You are the coding agent.",
  source_path: "/tmp/agents/coder.toml",
};

const role: RoleDef = {
  name: "auditor",
  description: null,
  system_prompt: "Be careful and review risks.",
  source_path: "/tmp/roles/auditor.toml",
};

const prompt: PromptDef = {
  name: "repo-summary",
  description: null,
  text: "Summarize the repository before changing anything.",
  source_path: "/tmp/prompts/repo-summary.toml",
};

const compaction: CompactionState = {
  v: 1,
  updated_at: "2026-04-10T00:00:00Z",
  source_revision: 5,
  compaction_count: 1,
  raw_history_budget_pct: 0.2,
  retained_raw_token_estimate: 1234,
  summary: {
    current_objective: "Finish the first implementation pass.",
    decisions: ["Use Bun + TypeScript."],
    open_loops: ["Provider retry tuning."],
  },
};

function sessionMessage(role: MessageRecord["role"], content: string): MessageRecord {
  return {
    v: 1,
    ts: "2026-04-10T00:00:00Z",
    kind: "message",
    run_id: "run-1",
    role,
    content,
  };
}

describe("renderCompactionCheckpoint", () => {
  test("renders deterministic checkpoint text", () => {
    expect(renderCompactionCheckpoint(compaction)).toContain("Session checkpoint:");
    expect(renderCompactionCheckpoint(compaction)).toContain(
      "current_objective: Finish the first implementation pass.",
    );
    expect(renderCompactionCheckpoint(compaction)).toContain("decisions:");
  });
});

describe("assemblePrompt", () => {
  test("assembles instructions and ordered input messages", () => {
    const result = assemblePrompt({
      agent,
      role,
      prompt,
      compaction,
      sessionMessages: [sessionMessage("user", "Earlier request"), sessionMessage("assistant", "Earlier answer")],
      userMessage: "Inspect the project",
      stdinText: "Extra stdin",
    });

    expect(result.instructions).toContain(agent.system_prompt);
    expect(result.instructions).toContain(role.system_prompt);
    expect(result.instructions).toContain("Session checkpoint:");
    expect(result.input).toEqual([
      { role: "user", content: "Earlier request" },
      { role: "assistant", content: "Earlier answer" },
      {
        role: "user",
        content: "Summarize the repository before changing anything.\n\nInspect the project",
      },
      { role: "user", content: "Extra stdin" },
    ]);
    expect(result.estimated_tokens).toBeGreaterThan(0);
  });

  test("omits optional layers when not provided", () => {
    const result = assemblePrompt({
      agent,
      role: null,
      prompt: null,
      compaction: null,
      sessionMessages: [],
      userMessage: "Inspect the project",
      stdinText: null,
    });

    expect(result.instructions).toBe(agent.system_prompt);
    expect(result.input).toEqual([{ role: "user", content: "Inspect the project" }]);
    expect(result.compaction_checkpoint).toBeNull();
  });
});
