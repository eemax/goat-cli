import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { configError } from "./errors.js";
import type { SkillDef } from "./types.js";

type ParsedFrontmatter = {
  name: string;
  description: string;
};

const SKILL_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

export function toSkillId(folderName: string): string {
  return folderName.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

function parseFrontmatter(content: string, path: string): ParsedFrontmatter {
  if (!content.startsWith("---\n")) {
    throw configError(`missing YAML frontmatter in skill ${path}`);
  }

  const closingIndex = content.indexOf("\n---", 4);
  if (closingIndex === -1) {
    throw configError(`unterminated YAML frontmatter in skill ${path}`);
  }

  const block = content.slice(4, closingIndex).trim();
  if (!block) {
    throw configError(`empty YAML frontmatter in skill ${path}`);
  }

  const values = new Map<string, string>();
  for (const line of block.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key && value) {
      values.set(key, value);
    }
  }

  const name = values.get("name") ?? "";
  const description = values.get("description") ?? "";
  if (!name || !description) {
    throw configError(`frontmatter in skill ${path} must include non-empty \`name\` and \`description\``);
  }

  return { name, description };
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) {
      throw configError(`skills path \`${path}\` is not a directory`);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw configError(`skills path \`${path}\` was not found`);
    }
    throw error;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function loadSkillsFromDirectory(skillsPath: string): Promise<SkillDef[]> {
  await ensureDirectory(skillsPath);
  const entries = await readdir(skillsPath, { withFileTypes: true });
  const skills: SkillDef[] = [];

  for (const entry of entries
    .filter((item) => item.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const skillPath = join(skillsPath, entry.name, "SKILL.md");
    if (!(await isFile(skillPath))) {
      continue;
    }

    const id = toSkillId(entry.name);
    if (!SKILL_ID_PATTERN.test(id)) {
      throw configError(`invalid skill id \`${id}\` from ${skillPath}`);
    }

    const content = await readFile(skillPath, "utf8");
    const frontmatter = parseFrontmatter(content, skillPath);
    skills.push({
      id,
      name: frontmatter.name,
      description: frontmatter.description,
      path: skillPath,
      content,
    });
  }

  const seen = new Set<string>();
  for (const skill of skills) {
    if (seen.has(skill.id)) {
      throw configError(`duplicate skill id \`${skill.id}\` in ${skillsPath}`);
    }
    seen.add(skill.id);
  }

  return skills;
}

export function formatAvailableSkillsXml(skills: SkillDef[]): string {
  if (skills.length === 0) {
    return "<available_skills>\n</available_skills>";
  }

  const entries = skills
    .map((skill) => `<skill name="${skill.name}" path="${skill.path}">\n${skill.description}\n</skill>`)
    .join("\n");
  return `<available_skills>\n${entries}\n</available_skills>`;
}

export function formatSkillInvocation(skill: SkillDef): string {
  return [
    `One-shot skill invocation: /${skill.id}`,
    `Skill name: ${skill.name}`,
    `Skill description: ${skill.description}`,
    "Skill file (full content):",
    skill.content.trim(),
    "",
    "Apply this skill only for this request. Do not persist skill activation across future turns unless the user invokes it again.",
  ]
    .join("\n")
    .trim();
}

export function formatSkillsList(
  agents: Iterable<{ name: string; skills_enabled: boolean; skills: SkillDef[] }>,
): string {
  const lines: string[] = [];
  for (const agent of [...agents].sort((left, right) => left.name.localeCompare(right.name))) {
    lines.push(`${agent.name}:`);
    if (!agent.skills_enabled) {
      lines.push("  (skills disabled)");
      continue;
    }
    if (agent.skills.length === 0) {
      lines.push("  (no skills)");
      continue;
    }
    for (const skill of agent.skills) {
      lines.push(`  ${skill.id}\t${skill.name}\t${skill.path}`);
    }
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

export function containingDirectory(path: string): string {
  return dirname(path);
}

export function skillFolderName(path: string): string {
  return basename(dirname(path));
}
