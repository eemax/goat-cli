const IMPLEMENTED_TOOL_IDS = [
  "bash",
  "read_file",
  "write_file",
  "replace_in_file",
  "apply_patch",
  "glob",
  "grep",
] as const;

const WEB_TOOL_IDS = ["web_search", "web_fetch"] as const;

export const ALL_TOOL_IDS = [...IMPLEMENTED_TOOL_IDS, ...WEB_TOOL_IDS] as const;

type ToolId = (typeof ALL_TOOL_IDS)[number];

export function isKnownToolId(value: string): value is ToolId {
  return ALL_TOOL_IDS.includes(value as ToolId);
}
