# Goat Configuration

## Overview

This document defines Goat's configuration surfaces for V1:

- global config in `goat.toml`
- model catalog in `models.toml`
- agent definitions in `agents/*.toml`
- role definitions in `roles/*.toml`
- prompt definitions in `prompts/*.toml`

The design takes inspiration from `headless-agent` and `agent-commander`, but intentionally improves a few things:

- global config uses a specific file name, `goat.toml`, instead of a generic `config.toml`
- provider credentials live in global config, not agent files
- repo-root discovery is explicit and runtime-based, not compiled into the binary
- repo and home config are merged predictably
- definitions stay behavior-focused and do not carry product-specific baggage

## Resolution Model

Goat resolves configuration from exactly two roots:

1. repo root
2. `~/.goat/`

The effective config is built in this order:

1. home root
2. repo root
3. environment fallbacks where documented
4. explicit CLI flags

Repo root values override home root values.

## Repo Root Discovery

Repo root discovery must be explicit.

Goat should determine the repo root by walking upward from the process working directory and selecting the nearest ancestor that contains either:

- `goat.toml`
- `.goat`

If neither marker is found, Goat has no repo root for that invocation and falls back to the home root only.

This is intentional. Goat must not guess that an arbitrary Git repository is a Goat repo just because it contains common directory names.

Important rules:

- `--cwd` does not affect repo-root discovery
- installed binaries must use runtime discovery, never a compiled-in source checkout path
- test harnesses may override discovery with `GOAT_REPO_ROOT` and `GOAT_HOME_ROOT`

## Files And Directories

### Repo root

Expected repo-local surfaces:

```text
goat.toml
models.toml
agents/
roles/
prompts/
skills/
```

### Home root

Expected home-root surfaces:

```text
~/.goat/
  goat.toml
  models.toml
  agents/
  roles/
  prompts/
  skills/
  sessions/
```

`skills/` is reserved in V1 but not expanded beyond directory resolution.

## Merge Semantics

### Global config

Global config is loaded from:

- `<repo-root>/goat.toml`
- `~/.goat/goat.toml`

If both exist, Goat should deep-merge them by section:

- scalar values: repo overrides home
- arrays: repo replaces home
- objects: merge recursively

Unknown keys must fail validation.

### Definitions

Definitions are loaded by name:

- repo definitions shadow home definitions with the same name
- home definitions are used when no repo definition exists for that name

List commands should show the resolved set, not duplicates.

### Models

The model catalog is loaded from:

- `<repo-root>/models.toml`
- `~/.goat/models.toml`

If both exist, entries merge by canonical model `id`:

- repo entries override home entries for the same `id`
- repo aliases shadow colliding home aliases from different models
- collisions inside the same precedence layer are validation errors
- `--model` and agent `default_model` resolve against model `id` or alias
- shadowed aliases should be surfaced by `goat doctor` and `--debug`

## Duration Values

All configurable durations in Goat use seconds, not milliseconds.

Rules:

- integer values are whole seconds
- fractional values are allowed for sub-second durations
- examples:
  - `45`
  - `2.5`
  - `0.25`

## Size Values

All configurable size limits in Goat use megabytes, not raw bytes.

Rules:

- integer values are whole megabytes
- fractional values are allowed
- examples:
  - `1`
  - `16`
  - `0.25`

## Global `goat.toml`

### Example

```toml
[paths]
sessions_dir = "/.goat/sessions"

[defaults]
agent = "coder"

[provider]
kind = "openai_responses"
transport = "http"
base_url = "https://api.openai.com/v1"
api_key_env = "OPENAI_API_KEY"
timeout = 45

[runtime]
max_stdin_mb = 8
run_timeout = 7200

[compaction]
model = "gpt-5.4-mini"
effort = "low"
max_output_tokens = 4000
raw_history_budget_pct = 0.20

[artifacts]
preview_mb = 0.05
catastrophic_output_mb = 16

[tools]
default_shell = "/bin/bash"
default_shell_args = ["-lc"]
max_output_chars = 200000
max_file_size_mb = 1

[tools.web_search]
enabled = false
api_key_env = "EXA_API_KEY"

[tools.web_fetch]
enabled = false
block_private_hosts = true

[tools.subagents]
enabled = false
default_model = "gpt-5.4-mini"
```

## Reference

The global section references below describe `goat.toml`.

`models.toml` has its own schema reference in this section as well.

### `goat.toml` `[paths]`

`sessions_dir`

- type: string path
- default: the resolved home-root `sessions/` directory
- meaning: root directory containing session folders
- notes:
  - `~` and `~/...` resolve from filesystem root
  - `.` and `./...` resolve from the discovered repo root
  - other relative paths resolve relative to the containing `goat.toml`
  - repo-root-anchored paths fail if no repo root was discovered

### `models.toml`

The model catalog is intentionally separated from `goat.toml` so that:

- agent files stay concise
- model aliases and provider-specific ids live in one place
- future provider growth can stay modular

### Example

```toml
[[models]]
id = "gpt-5.4-mini"
provider = "openai_responses"
provider_model = "gpt-5.4-mini"
aliases = ["mini"]
context_window = 400000
max_output_tokens = 128000

[[models]]
id = "gpt-5.3-codex"
provider = "openai_responses"
provider_model = "gpt-5.3-codex"
aliases = ["codex"]
context_window = 400000
max_output_tokens = 128000
```

### Model entry fields

`id`

- type: string
- required
- canonical model id used by Goat

`provider`

- type: enum
- allowed in V1: `openai_responses`
- default: `openai_responses`
- provider adapter identity for this model

`provider_model`

- type: string
- default: same as `id`
- exact model name sent to the provider

`aliases`

- type: array of strings
- default: `[]`
- aliases accepted by `--model` and agent `default_model`

`context_window`

- type: positive integer or `null`
- default: `null`
- optional catalog metadata for later budgeting and diagnostics

`max_output_tokens`

- type: positive integer or `null`
- default: `null`
- optional catalog metadata for later request shaping and diagnostics

### Model catalog rules

- `id` values must be unique
- aliases must be unique within the same precedence layer
- agent `default_model` should resolve through the catalog
- `--model` should resolve through the catalog
- unknown model ids should fail clearly

### `goat.toml` `[defaults]`

`agent`

- type: string
- default: unset
- meaning: fallback agent for unbound runs when `--agent` is omitted

### `goat.toml` `[provider]`

This section is intentionally modular even though V1 supports only one provider and one transport.

`kind`

- type: enum
- allowed in V1: `openai_responses`
- default: `openai_responses`
- meaning: provider adapter identity

`transport`

- type: enum
- allowed in V1: `http`
- default: `http`
- meaning: transport adapter identity

`base_url`

- type: string URL
- default: `"https://api.openai.com/v1"`
- meaning: base URL used by the provider adapter

`api_key`

- type: string
- default: unset
- meaning: explicit provider credential

`api_key_env`

- type: string
- default: `"OPENAI_API_KEY"`
- meaning: environment variable to read when `api_key` is unset

`timeout`

- type: positive number
- default: `45`
- meaning: per-request provider timeout

### `goat.toml` `[runtime]`

`max_stdin_mb`

- type: positive number
- default: `8`
- meaning: hard safety limit for stdin payload size
- notes: Goat reads stdin until EOF before provider execution and fails immediately if this limit is exceeded

`run_timeout`

- type: positive number
- default: `7200`
- meaning: total wall-clock timeout for the entire run

### `goat.toml` `[compaction]`

Custom session-history compaction is part of V1.

`model`

- type: string or unset
- default: unset
- meaning: model override used for compaction runs
- notes: when unset, Goat may reuse the session's effective model
- must resolve through `models.toml` when set

`effort`

- type: enum
- allowed: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`
- default: `low`
- meaning: reasoning effort used for compaction runs

`max_output_tokens`

- type: positive integer
- default: `4000`
- meaning: cap for the compaction model response

`raw_history_budget_pct`

- type: number between `0` and `1`
- default: `0.20`
- meaning: cap for how much durable raw history may remain after compaction
- notes: Goat walks backward through committed history until the retained durable raw slice fits within this budget; the current live loop may force the retained durable slice lower

`prompt_file`

- type: string path or unset
- default: unset
- meaning: optional override for Goat's built-in compaction prompt
- notes: when set, it is resolved relative to the `goat.toml` file that defines it
- when unset, Goat uses the built-in prompt sourced from `src/builtins/compaction-prompt.md` and embedded into the release artifact at build time

### `goat.toml` `[artifacts]`

`preview_mb`

- type: positive number
- default: `0.05`
- meaning: inline preview size before payloads spill into `artifacts/`

`catastrophic_output_mb`

- type: positive number
- default: `16`
- meaning: emergency cap for oversized assistant or tool payloads

### `goat.toml` `[tools]`

`default_shell`

- type: string
- default: `"/bin/bash"`
- meaning: shell used by `bash` unless overridden

`default_shell_args`

- type: array of strings
- default: `["-lc"]`
- meaning: arguments passed before the shell command

`max_output_chars`

- type: positive integer
- default: `200000`
- meaning: tool output truncation boundary
- notes: when inline tool output exceeds this boundary, Goat must return an explicit partial result with preview metadata and an artifact reference rather than silently clipping

`max_file_size_mb`

- type: positive number
- default: `1`
- meaning: file-size safety cap for file and patch tools

### `goat.toml` `[tools.web_search]`

This section is reserved in V1 even when the tool is stubbed.

`enabled`

- type: boolean
- default: `false`
- meaning: whether the tool may be exposed once implemented

`api_key`

- type: string
- default: unset
- meaning: explicit Exa API key

`api_key_env`

- type: string
- default: `"EXA_API_KEY"`
- meaning: environment variable fallback for Exa

### `goat.toml` `[tools.web_fetch]`

`enabled`

- type: boolean
- default: `false`
- meaning: whether the tool may be exposed once implemented

`block_private_hosts`

- type: boolean
- default: `true`
- meaning: block private-network fetch targets by default

`defuddle_base_url`

- type: string URL or unset
- default: unset
- meaning: preferred Defuddle endpoint once `web_fetch` is implemented

### `goat.toml` `[tools.subagents]`

`enabled`

- type: boolean
- default: `false`
- meaning: whether the tool may be exposed once implemented

`default_model`

- type: string
- default: `"gpt-5.4-mini"`
- meaning: default subagent model
- must resolve through `models.toml`

## Credential Precedence

For the OpenAI provider in V1, credential precedence should be:

1. `provider.api_key`, if non-empty
2. environment variable named by `provider.api_key_env`
3. `OPENAI_API_KEY`

For Exa in future `web_search`, precedence should be:

1. `tools.web_search.api_key`, if non-empty
2. environment variable named by `tools.web_search.api_key_env`
3. `EXA_API_KEY`

## Agent Files

Supported locations:

- `<repo-root>/agents/<name>.toml`
- `~/.goat/agents/<name>.toml`

Agent files define runnable behavior. They should not contain provider credentials.

### Example

```toml
name = "coder"
description = "General coding agent"
default_model = "gpt-5.4-mini"
default_effort = "medium"
max_output_tokens = 12000
compact_at_tokens = 180000
run_timeout = 7200
enabled_tools = [
  "bash",
  "read_file",
  "write_file",
  "replace_in_file",
  "apply_patch",
  "glob",
  "grep",
]
system_prompt_file = "../prompts/coder.md"
```

### Required fields

`name`

- type: string
- must be non-empty

`default_model`

- type: string
- must resolve through `models.toml`

`enabled_tools`

- type: array of strings
- must contain at least one recognized tool id

Exactly one of:

- `system_prompt`
- `system_prompt_file`

### Optional fields

`description`

- type: string

`default_effort`

- type: enum
- allowed: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`
- `none` omits an explicit provider reasoning-effort override in V1

`max_output_tokens`

- type: positive integer
- default: `12000`

`compact_at_tokens`

- type: positive integer
- default: `180000`
- defines the budget against which Goat compares a **conservative pre-send estimate** of the fully assembled next provider request (see `docs/architecture.md`, “Token usage and pre-send estimation”)
- **reported usage** from successful API responses is the source of truth for persisted metadata and diagnostics; it does not replace the pre-send estimate for deciding whether to compact
- if the pre-send estimate would exceed the effective budget (threshold minus any implementation margin), Goat runs custom compaction first and then retries prompt assembly
- this is intended to be the maximum safe projected input size for the model, already chosen with the model's output limits in mind

`run_timeout`

- type: positive number
- default: inherit from global `runtime.run_timeout`

### Notes

- `system_prompt_file` is resolved relative to the agent file
- unknown `enabled_tools` entries must fail validation instead of being silently ignored

## Role Files

Supported locations:

- `<repo-root>/roles/<name>.toml`
- `~/.goat/roles/<name>.toml`

Roles are sticky system-prompt overlays.

### Example

```toml
name = "auditor"
description = "Code review overlay"
system_prompt_file = "./auditor.md"
```

### Required fields

`name`

- type: string

Exactly one of:

- `system_prompt`
- `system_prompt_file`

### Optional fields

`description`

- type: string

## Prompt Files

Supported locations:

- `<repo-root>/prompts/<name>.toml`
- `~/.goat/prompts/<name>.toml`

Prompts are one-turn user-message overlays. They are never sticky session state.

### Example

```toml
name = "repo-summary"
description = "Summarize the repository before changing anything"
text_file = "./repo-summary.md"
```

### Required fields

`name`

- type: string

Exactly one of:

- `text`
- `text_file`

### Optional fields

`description`

- type: string

## Runtime Precedence

Effective run values should resolve in this order:

1. explicit CLI flags
2. stored sticky session settings
3. agent defaults
4. global defaults

`--prompt` and `--plan` are intentionally excluded from sticky precedence because they are run-local behaviors.

## Validation Rules

- unknown keys fail validation
- empty strings are treated as invalid for required fields
- path fields must normalize successfully
- relative file references are resolved relative to the definition or config file that contains them
- invalid or duplicate definition names fail list and run commands clearly

## Doctor Expectations

`goat doctor` should validate at least:

- global config readability and schema validity
- model catalog readability and schema validity
- agent file readability and schema validity
- role file readability and schema validity
- prompt file readability and schema validity
- repo-root discovery behavior
- sessions directory writability
- OpenAI credential discoverability
- metadata-only authenticated provider reachability with no billed generation request
- compaction model resolution and compaction prompt-file readability when configured
- `rg` availability
- optional Exa and Defuddle discoverability when their config sections are enabled

## Reserved For Later

V1 should make room for:

- active `skills/` behavior
- additional provider kinds
- additional transport kinds
- richer subagent policy

Those extensions should fit into the existing config sections instead of forcing a new top-level layout.
