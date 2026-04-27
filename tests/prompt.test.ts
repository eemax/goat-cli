import { describe, expect, test } from "bun:test";

import { assemblePrompt } from "../src/prompt.js";
import type { AgentDef, MessageRecord, PromptDef, RoleDef } from "../src/types.js";

const agent: AgentDef = {
  name: "coder",
  description: null,
  default_model: "gpt-5.4-mini",
  default_effort: "medium",
  max_output_tokens: 12000,
  compact_at_tokens: 180000,
  run_timeout: 7200,
  enabled_tools: ["read_file"],
  skills_enabled: true,
  skills_path: "/tmp/skills",
  skills: [
    {
      id: "research",
      name: "Research",
      description: "Find facts & summarize.",
      path: "/tmp/skills/research/SKILL.md",
      content: "---\nname: Research\ndescription: Find facts & summarize.\n---\n\n# Research\n",
    },
  ],
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

describe("assemblePrompt", () => {
  test("assembles instructions and ordered input messages", () => {
    const result = assemblePrompt({
      agent,
      role,
      prompt,
      skills: [agent.skills[0]!],
      sessionMessages: [sessionMessage("user", "Earlier request"), sessionMessage("assistant", "Earlier answer")],
      userMessage: "Inspect the project",
      stdinText: "Extra stdin",
    });

    expect(result.instructions).toContain(agent.system_prompt);
    expect(result.instructions).toContain(role.system_prompt);
    expect(result.instructions).toContain("<available_skills>");
    expect(result.instructions).toContain('<skill name="Research" path="/tmp/skills/research/SKILL.md">');
    expect(result.input).toEqual([
      { role: "user", content: "Earlier request" },
      { role: "assistant", content: "Earlier answer" },
      {
        role: "user",
        content:
          "Summarize the repository before changing anything.\n\nOne-shot skill invocation: /research\nSkill name: Research\nSkill description: Find facts & summarize.\nSkill file (full content):\n---\nname: Research\ndescription: Find facts & summarize.\n---\n\n# Research\n\nApply this skill only for this request. Do not persist skill activation across future turns unless the user invokes it again.\n\nInspect the project",
      },
      { role: "user", content: "Extra stdin" },
    ]);
    expect(result.estimated_tokens).toBeGreaterThan(0);
  });

  test("omits optional layers when not provided", () => {
    const agentWithoutSkills: AgentDef = {
      ...agent,
      skills_enabled: false,
      skills_path: null,
      skills: [],
    };
    const result = assemblePrompt({
      agent: agentWithoutSkills,
      role: null,
      prompt: null,
      skills: [],
      sessionMessages: [],
      userMessage: "Inspect the project",
      stdinText: null,
    });

    expect(result.instructions).toBe(`${agent.system_prompt}\n\n${"<available_skills>\n</available_skills>"}`);
    expect(result.input).toEqual([{ role: "user", content: "Inspect the project" }]);
  });
});
