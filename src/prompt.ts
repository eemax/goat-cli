import { formatAvailableSkillsXml, formatSkillInvocation } from "./skills.js";
import type { AgentDef, CompactionState, MessageRecord, PromptDef, RoleDef } from "./types.js";
import { estimateTokensConservative } from "./utils.js";

export type PromptMessage = {
  role: "user" | "assistant";
  content: string;
};

export type PromptAssembly = {
  instructions: string;
  input: PromptMessage[];
  current_user_content: string;
  estimated_tokens: number;
  compaction_checkpoint: string | null;
};

const SUMMARY_ORDER = [
  "current_objective",
  "last_user_request",
  "user_preferences",
  "constraints",
  "decisions",
  "important_paths",
  "completed_work",
  "edits_made",
  "open_loops",
  "next_best_action",
] as const;

function renderSection(label: string, value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return `${label}: ${value}`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return null;
    }
    return `${label}:\n${value.map((item) => `- ${String(item)}`).join("\n")}`;
  }
  return `${label}: ${JSON.stringify(value, null, 2)}`;
}

export function renderCompactionCheckpoint(state: CompactionState | null): string | null {
  if (!state) {
    return null;
  }

  const lines: string[] = [
    "Session checkpoint:",
    `- source_revision: ${state.source_revision}`,
    `- compaction_count: ${state.compaction_count}`,
    `- raw_history_budget_pct: ${state.raw_history_budget_pct}`,
    `- retained_raw_token_estimate: ${state.retained_raw_token_estimate}`,
  ];

  for (const key of SUMMARY_ORDER) {
    const rendered = renderSection(key, state.summary[key]);
    if (rendered) {
      lines.push(rendered);
    }
  }

  for (const [key, value] of Object.entries(state.summary)) {
    if (SUMMARY_ORDER.includes(key as (typeof SUMMARY_ORDER)[number])) {
      continue;
    }
    const rendered = renderSection(key, value);
    if (rendered) {
      lines.push(rendered);
    }
  }

  return lines.join("\n");
}

function buildInstructions(agent: AgentDef, role: RoleDef | null, checkpoint: string | null): string {
  const parts = [agent.system_prompt];
  if (role) {
    parts.push(role.system_prompt);
  }
  parts.push(formatAvailableSkillsXml(agent.skills));
  if (checkpoint) {
    parts.push(checkpoint);
  }
  return parts.join("\n\n").trim();
}

function buildPrimaryMessage(prompt: PromptDef | null, skills: AgentDef["skills"], rawMessage: string): string {
  const parts: string[] = [];
  if (prompt) {
    parts.push(prompt.text);
  }
  for (const skill of skills) {
    parts.push(formatSkillInvocation(skill));
  }
  parts.push(rawMessage);
  return parts.join("\n\n");
}

export function assemblePrompt(params: {
  agent: AgentDef;
  role: RoleDef | null;
  prompt: PromptDef | null;
  skills: AgentDef["skills"];
  compaction: CompactionState | null;
  sessionMessages: MessageRecord[];
  userMessage: string;
  stdinText: string | null;
}): PromptAssembly {
  const checkpoint = renderCompactionCheckpoint(params.compaction);
  const input: PromptMessage[] = [];

  for (const message of params.sessionMessages) {
    input.push({
      role: message.role,
      content: message.content,
    });
  }

  const currentUserContent = buildPrimaryMessage(params.prompt, params.skills, params.userMessage);
  input.push({
    role: "user",
    content: currentUserContent,
  });

  if (params.stdinText !== null) {
    input.push({
      role: "user",
      content: params.stdinText,
    });
  }

  const instructions = buildInstructions(params.agent, params.role, checkpoint);
  const estimated_tokens = estimateTokensConservative([instructions, ...input.map((message) => message.content)]);

  return {
    instructions,
    input,
    current_user_content: currentUserContent,
    estimated_tokens,
    compaction_checkpoint: checkpoint,
  };
}
