import { formatAvailableSkillsXml, formatSkillInvocation } from "./skills.js";
import type { AgentDef, MessageRecord, PromptDef, RoleDef } from "./types.js";
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
};

function buildInstructions(agent: AgentDef, role: RoleDef | null): string {
  const parts = [agent.system_prompt];
  if (role) {
    parts.push(role.system_prompt);
  }
  parts.push(formatAvailableSkillsXml(agent.skills));
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
  sessionMessages: MessageRecord[];
  userMessage: string;
  stdinText: string | null;
}): PromptAssembly {
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

  const instructions = buildInstructions(params.agent, params.role);
  const estimated_tokens = estimateTokensConservative([instructions, ...input.map((message) => message.content)]);

  return {
    instructions,
    input,
    current_user_content: currentUserContent,
    estimated_tokens,
  };
}
