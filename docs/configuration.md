# Configuration

## Resolution model

Goat resolves configuration from an ordered global root stack:

The effective config is built in this order (later overrides earlier):

1. `~/goat-cli/`
2. `~/.config/goat/`
3. `$GOAT_HOME_DIR`, when set
4. Environment variable fallbacks
5. Explicit CLI flags

`GOAT_HOME_ROOT`, `GOAT_REPO_ROOT`, `~/.goat/`, cwd markers, and repo-local discovery are ignored. `--cwd` affects tool execution only. It does not affect definition resolution.

## Directory structure

### Config root

```
goat.toml           Global config
models.toml         Model catalog
agents/             Agent definitions
roles/              Role definitions
prompts/            Prompt definitions
skills/             Skill folders containing SKILL.md
scenarios/          Scenario definitions
sessions/           Session storage (default: highest-priority root only)
```

## Merge semantics

**Global config** (`goat.toml`): deep-merge by section. Scalars: higher-priority roots override lower-priority roots. Arrays: higher-priority roots replace lower-priority roots. Objects: merge recursively. Unknown keys fail validation.

**Definitions** (agents, roles, prompts, scenarios): higher-priority roots shadow lower-priority definitions with the same filename. List commands show the resolved set without duplicates.

**Model catalog** (`models.toml`): merge by canonical `id`. Higher-priority entries override lower-priority entries for the same ID. Alias collisions across layers are resolved in favor of higher-priority roots. Collisions within the same layer are validation errors.

## goat.toml reference

### `[paths]`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `sessions_dir` | string | `<highest-priority-root>/sessions/` | Root directory for session storage |

Path resolution: `~` resolves from the OS home directory. `.` and relative paths resolve from the containing `goat.toml`.

### `[defaults]`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `agent` | string | -- | Fallback agent for unbound runs |

### `[provider]`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `kind` | enum | `openai_responses` | Provider adapter (V1: `openai_responses` only) |
| `transport` | enum | `http` | Transport adapter (V1: `http` only) |
| `base_url` | string | `https://api.openai.com/v1` | Provider base URL |
| `api_key` | string | -- | Explicit API key |
| `api_key_env` | string | `OPENAI_API_KEY` | Environment variable for API key |
| `timeout` | duration | `45s` | Per-request provider timeout |

Credential precedence: `api_key` > env var named by `api_key_env` > `OPENAI_API_KEY`.

### `[runtime]`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `max_stdin` | size | `8mb` | Hard upper bound on stdin payload. Exceeding this fails with exit code 2 (`USAGE_ERROR`). |
| `run_timeout` | duration | `2h` | Total wall-clock run timeout. Applies to the whole prompt run (provider turns + tool execution). |
| `stderr_message_max_chars` | tokens | `2k` | Per-event cap for numbered verbose/debug stderr messages. Truncation uses `…[+X chars]`. |

**Timeout precedence**. The effective run timeout is resolved in order:

1. `--timeout <duration>` on the command line (not sticky; per-run only)
2. Agent `run_timeout` from the agent definition
3. `[runtime].run_timeout` from `goat.toml`

The lowest layer that is set wins. When the timeout elapses, the run's
`AbortSignal` fires, the provider stream is cancelled, the run summary is
written with `status = "timed_out"`, and the CLI exits with code 10
(`TIMEOUT`).

### `[compaction]`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `prompt_file` | string | -- | Override for built-in compaction prompt |

Compaction is a normal provider-backed turn inside the target session. It uses the session's resolved agent, model, effort, and output limits. `prompt_file` resolves relative to the `goat.toml` that defines it.

### `[artifacts]`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `preview_limit` | size | `50kb` | Inline preview size before artifact spillover |
| `catastrophic_output_limit` | size | `16mb` | Emergency cap for oversized payloads |

### `[tools]`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `default_shell` | string | `/bin/bash` | Shell used by the `bash` tool in normal mode. Ignored in plan mode. |
| `default_shell_args` | string[] | `["-lc"]` | Arguments passed to `default_shell` before the user command. |
| `max_output_chars` | size | `200k` | Inline tool output ceiling. When a tool's stdout/stdout+stderr exceeds this, the envelope switches to a `partial: true` shape with a head/tail preview and an artifact reference under `runs/<id>/artifacts/`. The preview itself is capped at `min(max_output_chars, 4000)` characters. |
| `max_file_size` | size | `1mb` | Hard cap enforced by `read_file`, `write_file`, and `replace_in_file`. Reads or writes that would exceed this fail with `TOOL_FAILURE`. |

### `[tools.web_search]`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `false` | Enable Exa-backed web search |
| `api_key` | string | unset | Exa API key |
| `api_key_env` | string | `EXA_API_KEY` | Exa API key env var |
| `base_url` | string | `https://api.exa.ai` | Exa API base URL |
| `type` | enum | `auto` | Exa search mode: `auto`, `neural`, or `deep` |

### `[tools.web_fetch]`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `false` | Enable Defuddle CLI web fetch |
| `block_private_hosts` | bool | `true` | Block private-network targets |
| `command` | string | `defuddle` | Defuddle CLI command |
| `timeout` | duration | `45s` | Defuddle command timeout |

### `[tools.subagents]`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `false` | Enable subagents (stub in V1) |
| `default_model` | string | `gpt-5.4-mini` | Default subagent model |

## models.toml

The model catalog maps canonical model IDs to provider-specific details.

```toml
[[models]]
id = "gpt-5.4-mini"
provider = "openai_responses"
provider_model = "gpt-5.4-mini"
aliases = ["mini"]
context_window = "400k"
max_output_tokens = "128k"
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Canonical model ID |
| `provider` | enum | no | Provider adapter (default: `openai_responses`) |
| `provider_model` | string | no | Name sent to provider (default: same as `id`) |
| `aliases` | string[] | no | Short names for `--model` and agent configs |
| `context_window` | tokens | no | Context window size |
| `max_output_tokens` | tokens | no | Max output tokens |

Model IDs must be unique. Aliases must be unique within a precedence layer. Resolution: `--model` and agent `default_model` resolve against `id` or alias.

## Agent files

Location: `<root>/agents/<name>.toml` with an accompanying system prompt file.

```toml
name = "coder"
description = "General coding agent"
default_model = "gpt-5.4-mini"
default_effort = "medium"
max_output_tokens = "12k"
compact_at_tokens = "180k"
run_timeout = "2h"
enabled_tools = [
  "bash", "read_file", "write_file",
  "replace_in_file", "apply_patch",
  "glob", "grep",
]
system_prompt_file = "./coder.md"

[skills]
enabled = true
path = "../skills"
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Agent name |
| `default_model` | string | yes | Must resolve through models.toml |
| `enabled_tools` | string[] | yes | At least one recognized tool ID |
| `system_prompt` or `system_prompt_file` | string | yes (one) | Inline or file-based system prompt |
| `description` | string | no | Human-readable description |
| `default_effort` | enum | no | Default reasoning effort |
| `max_output_tokens` | tokens | no | Output token cap (default: 12k) |
| `compact_at_tokens` | tokens | no | Warning threshold for manual compaction (default: 180k) |
| `run_timeout` | duration | no | Inherits from `runtime.run_timeout` |
| `[skills].enabled` | bool | no | Enables skills for this agent. Missing means disabled. |
| `[skills].path` | string | when enabled | Folder containing skill subfolders with `SKILL.md`. Resolves relative to the agent file. |

`system_prompt_file` resolves relative to the agent file. Unknown `enabled_tools` entries fail validation. Enabled skills scan immediate child folders; each `SKILL.md` must include frontmatter with `name` and `description`.

## Role files

Location: `<root>/roles/<name>.toml` with an accompanying prompt file.

```toml
name = "auditor"
description = "Code review overlay"
system_prompt_file = "./auditor.md"
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Role name |
| `system_prompt` or `system_prompt_file` | string | yes (one) | Prompt text |
| `description` | string | no | Description |

Roles are sticky system-prompt overlays appended after the agent prompt.

## Prompt files

Location: `<root>/prompts/<name>.toml` with an accompanying text file.

```toml
name = "repo-summary"
description = "Summarize the repository before changing anything"
text_file = "./repo-summary.md"
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Prompt name |
| `text` or `text_file` | string | yes (one) | Prompt text |
| `description` | string | no | Description |

Prompts are one-turn user-message prefixes. They are never sticky.

## Skill files

Location: `<agent skills path>/<skill-folder>/SKILL.md`.

```markdown
---
name: Research
description: Find facts and summarize them
---

# Research

Use this workflow for research-heavy turns.
```

Skill ids come from folder names normalized to lowercase with non-alphanumeric characters replaced by `_`. Skills are listed in the system instructions for the selected agent and are injected for one turn only when requested with `--skill <id>`.

## Scenario files

Location: `<root>/scenarios/<name>.toml`.

```toml
name = "review-chain"
description = "Inspect, then review"

[[steps]]
id = "inspect"
agent = "coder"
message = "{{input}}"

[[steps]]
id = "review"
agent = "auditor"
message = "Review this output:\n\n{{previous_output}}"
```

Scenario steps run sequentially, each in a fresh session. Supported template variables are `{{input}}`, `{{previous_output}}`, `{{steps.<id>.output}}`, `{{steps.<id>.session_id}}`, and `{{steps.<id>.run_id}}`.

## Runtime precedence

Effective run values resolve in this order:

1. Explicit CLI flags
2. Stored sticky session settings
3. Agent defaults
4. Global defaults

`--prompt` and `--plan` are excluded from sticky precedence (run-local only).

## Unit formats

Goat config values accept human-readable units:

- **Duration**: `45s`, `2h`, `500ms`
- **Size**: `8mb`, `50kb`, `1gb`
- **Tokens**: `4k`, `128k`, `180000`
