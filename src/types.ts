export const EFFORT_VALUES = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;

export type Effort = (typeof EFFORT_VALUES)[number];

export type SessionSelector = "new" | "last" | string;

export type RunCommandName = "new" | "last" | "explicit";

export type DoctorCheckStatus = "PASS" | "FAIL" | "SKIP";

export type ToolAccessClass = "read_only" | "mutating";

/**
 * JSON shape of a function-tool definition as sent to the OpenAI Responses API.
 * Produced by `exportProviderTools` and consumed by the agent loop / provider
 * request construction.
 */
export type ProviderTool = {
  type: "function";
  name: string;
  description: string;
  strict: true;
  parameters: Record<string, unknown>;
};

export type ToolEnvelope =
  | {
      ok: true;
      summary: string;
      data?: Record<string, unknown>;
    }
  | {
      ok: false;
      summary: string;
      data?: Record<string, unknown>;
      error: {
        code: string;
        message: string;
        retryable: boolean;
      };
    };

export type RunOptions = {
  fork: boolean;
  agent: string | null;
  role: string | null;
  noRole: boolean;
  prompt: string | null;
  skills: string[];
  compact: boolean;
  scenario: string | null;
  model: string | null;
  effort: Effort | null;
  timeoutSeconds: number | null;
  plan: boolean;
  cwd: string | null;
  verbose: boolean;
  debug: boolean;
  debugJson: boolean;
};

export type RunCommand = {
  kind: "run";
  name: RunCommandName;
  session: SessionSelector;
  options: RunOptions;
  message: string;
};

export type Command =
  | { kind: "version" }
  | { kind: "doctor" }
  | { kind: "agents" }
  | { kind: "roles" }
  | { kind: "prompts" }
  | { kind: "skills" }
  | { kind: "scenarios" }
  | { kind: "compact.session"; session: SessionSelector }
  | { kind: "sessions.new" }
  | { kind: "sessions.last" }
  | { kind: "sessions.list" }
  | { kind: "sessions.show"; sessionId: string }
  | { kind: "sessions.fork"; sessionId: SessionSelector }
  | { kind: "sessions.stop"; sessionId: string }
  | { kind: "runs.list"; session: SessionSelector }
  | { kind: "runs.show"; session: SessionSelector; runId: string }
  | RunCommand;

export type ProviderUsage = {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_input_tokens: number;
};

export type ArtifactRef = {
  path: string;
  bytes: number;
  sha256: string;
  content_type: string;
};

export type SessionMeta = {
  v: 1;
  session_id: string;
  created_at: string;
  updated_at: string;
  stopped_at: string | null;
  bound: boolean;
  revision: number;
  last_run_usage: ProviderUsage | null;
  message_count: number;
  agent_name: string | null;
  role_name: string | null;
  model: string | null;
  effort: Effort | null;
  cwd: string | null;
};

export type CompactionSummary = {
  current_objective?: string;
  last_user_request?: string;
  user_preferences?: string[];
  constraints?: string[];
  decisions?: string[];
  important_paths?: string[];
  completed_work?: string[];
  edits_made?: string[];
  open_loops?: string[];
  next_best_action?: string;
  [key: string]: unknown;
};

export type CompactionState = {
  v: 1;
  updated_at: string;
  source_revision: number;
  compaction_count: number;
  raw_history_budget_pct: number;
  retained_raw_token_estimate: number;
  summary: CompactionSummary;
};

export type MessageRecord = {
  v: 1;
  ts: string;
  kind: "message";
  run_id: string;
  role: "user" | "assistant";
  source?: "cli_arg" | "stdin" | "assistant_final";
  prompt_name?: string | null;
  content: string;
};

export type TranscriptRecord =
  | {
      v: 1;
      ts: string;
      kind: "run_started";
      run_id: string;
      session_id: string;
      run_kind: "prompt" | "compaction";
      agent_name: string;
      role_name: string | null;
      model: string;
      effort: Effort | null;
      plan_mode: boolean;
      cwd: string;
    }
  | {
      v: 1;
      ts: string;
      kind: "message";
      run_id: string;
      role: "user" | "assistant";
      phase?: "tool_request" | "final";
      content: string;
      tool_calls?: Array<{
        id: string;
        name: string;
        arguments: Record<string, unknown>;
      }>;
      artifact?: ArtifactRef | null;
    }
  | {
      v: 1;
      ts: string;
      kind: "compaction_checkpoint";
      run_id: string;
      summary: string;
      artifact?: ArtifactRef | null;
    }
  | {
      v: 1;
      ts: string;
      kind: "tool_call";
      run_id: string;
      tool_call_id: string;
      tool_name: string;
      arguments: Record<string, unknown>;
      planned: boolean;
    }
  | {
      v: 1;
      ts: string;
      kind: "tool_result";
      run_id: string;
      tool_call_id: string;
      tool_name: string;
      duration_s: number;
      planned: boolean;
      ok: boolean;
      summary: string;
      preview?: string;
      artifact?: ArtifactRef | null;
      envelope?: ToolEnvelope;
    }
  | {
      v: 1;
      ts: string;
      kind: "run_finished";
      run_id: string;
      status: "completed" | "failed" | "interrupted" | "timed_out" | "session_conflict";
      termination_reason: string;
    };

export type ProviderRecord =
  | {
      v: 1;
      ts: string;
      kind: "provider_turn";
      run_id: string;
      provider: "openai_responses";
      transport: "http";
      request_index: number;
      response_id: string | null;
      previous_response_id: string | null;
      model: string;
      status: string;
      tool_call_count: number;
      output_text_chars: number;
      usage: ProviderUsage | null;
    }
  | {
      v: 1;
      ts: string;
      kind: "provider_error";
      run_id: string;
      provider: "openai_responses";
      transport: "http";
      request_index: number;
      error_code: string;
      message: string;
      retryable: boolean;
    };

export type RunSummary = {
  v: 1;
  session_id: string;
  run_id: string;
  run_kind: "prompt" | "compaction";
  status: "completed" | "failed" | "interrupted" | "timed_out" | "session_conflict";
  started_at: string;
  finished_at: string;
  duration_s: number;
  plan_mode: boolean;
  agent_name: string;
  role_name: string | null;
  prompt_name: string | null;
  model: string;
  effort: Effort | null;
  provider: "openai_responses";
  transport: "http";
  cwd: string;
  termination_reason: string;
  usage: ProviderUsage | null;
  artifacts: {
    count: number;
    total_bytes: number;
  };
  final_output: {
    text: string | null;
    chars: number;
    artifact: ArtifactRef | null;
  };
  error: {
    code: string;
    message: string;
  } | null;
};

export type DoctorCheck = {
  name: string;
  status: DoctorCheckStatus;
  reason?: string;
};

export type ConfigRoots = {
  configRoots: string[];
  homeRoot: string;
};

export type GlobalConfig = {
  paths: {
    sessions_dir: string;
  };
  defaults: {
    agent: string | null;
  };
  provider: {
    kind: "openai_responses";
    transport: "http";
    base_url: string;
    api_key: string | null;
    api_key_env: string;
    timeout: number;
  };
  runtime: {
    max_stdin: number;
    run_timeout: number;
    stderr_message_max_chars: number;
  };
  compaction: {
    model: string | null;
    raw_history_budget_pct: number;
    prompt_file: string | null;
  };
  artifacts: {
    preview_limit: number;
    catastrophic_output_limit: number;
  };
  tools: {
    default_shell: string;
    default_shell_args: string[];
    max_output_chars: number;
    max_file_size: number;
    web_search: {
      enabled: boolean;
      api_key: string | null;
      api_key_env: string;
    };
    web_fetch: {
      enabled: boolean;
      block_private_hosts: boolean;
      defuddle_base_url: string | null;
    };
    subagents: {
      enabled: boolean;
      default_model: string;
    };
  };
};

export type SkillDef = {
  id: string;
  name: string;
  description: string;
  path: string;
  content: string;
};

export type ModelDef = {
  id: string;
  provider_model: string;
  aliases: string[];
  context_window: number | null;
  max_output_tokens: number | null;
  source_path: string;
};

export type AgentDef = {
  name: string;
  description: string | null;
  default_model: string;
  default_effort: Effort | null;
  max_output_tokens: number;
  compact_at_tokens: number;
  run_timeout: number | null;
  enabled_tools: string[];
  skills_enabled: boolean;
  skills_path: string | null;
  skills: SkillDef[];
  system_prompt: string;
  source_path: string;
};

export type RoleDef = {
  name: string;
  description: string | null;
  system_prompt: string;
  source_path: string;
};

export type PromptDef = {
  name: string;
  description: string | null;
  text: string;
  source_path: string;
};

export type ScenarioStepDef = {
  id: string;
  agent: string;
  role: string | null;
  prompt: string | null;
  message: string;
  skills: string[];
  model: string | null;
  effort: Effort | null;
  timeoutSeconds: number | null;
  cwd: string | null;
  compact: boolean | null;
};

export type ScenarioDef = {
  name: string;
  description: string | null;
  steps: ScenarioStepDef[];
  source_path: string;
};
