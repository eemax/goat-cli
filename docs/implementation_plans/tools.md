# Goat Tool Harness

## Overview

Goat exposes a local trusted tool harness to the model through the OpenAI Responses function-tool interface.

This design borrows the best structure from `agent-commander` and the durability mindset from `headless-agent`, but it deliberately changes a few things:

- tool contracts are defined before implementation drift can set in
- tool schemas are strict and object-rooted for OpenAI compatibility
- mutability is classified explicitly
- Goat intentionally excludes long-running process control in V1
- stub tools are first-class seams, not accidental placeholders
- Goat intentionally avoids a large set of harness tuning knobs; most operational behavior is runtime-owned in V1

## Tool Design Principles

- every tool has a stable id
- every tool validates arguments against a strict schema
- every tool returns a normalized JSON envelope
- tool outputs are deterministic and bounded
- tool metadata is provider-facing, but tool behavior is runtime-owned
- the harness decides safety and limits, not the model

## Provider-Facing Schema Rules

Every exported function tool must satisfy OpenAI Responses API expectations:

- top-level `parameters` is a JSON Schema object
- no top-level `anyOf`, `oneOf`, `allOf`, `enum`, or `not`
- required fields are explicit
- unknown fields are rejected at runtime

## Common Output Envelope

All tools return one of two shapes.

### Success

```json
{
  "ok": true,
  "summary": "Found 12 matching files.",
  "data": {
    "matches": ["src/app.ts", "src/cli.ts"]
  }
}
```

### Failure

```json
{
  "ok": false,
  "summary": "Patch application failed.",
  "error": {
    "code": "PATCH_CONTEXT_MISMATCH",
    "message": "The patch hunk did not match the target file.",
    "retryable": false
  }
}
```

### Envelope rules

- `summary` is always present
- `data` exists only on success
- `error` exists only on failure
- fields use snake_case
- empty or noisy fields are omitted

### Partial-result contract

When inline tool output exceeds configured bounds, Goat must return an explicitly partial success result rather than silently clipping text.

Recommended shape:

```json
{
  "ok": true,
  "summary": "Search result truncated. Showing the first and last matching lines.",
  "data": {
    "partial": true,
    "truncation_reason": "max_output_chars_exceeded",
    "total_bytes": 512000,
    "total_lines": 9200,
    "preview": {
      "head": "first visible chunk...",
      "tail": "last visible chunk...",
      "head_lines": 80,
      "tail_lines": 80
    },
    "artifact": {
      "path": "artifacts/tool-001.txt",
      "bytes": 512000,
      "sha256": "abc123...",
      "content_type": "text/plain"
    }
  }
}
```

Rules:

- `summary` must say that the result is partial
- text results should expose head and tail preview slices when practical
- binary results should omit inline text preview and return only metadata plus an artifact reference
- the model must not be left guessing whether a result is complete

## Path Resolution Rules

All relative paths resolve from the effective run working directory.

Important rules:

- `--cwd` sets the run working directory
- stored session `cwd` is reused when `--cwd` is omitted
- absolute paths are allowed in V1
- empty paths and non-normalizable paths must fail validation
- tools should fail clearly on missing paths instead of silently returning empty results

## Tool Access Classes

Goat should classify tools into two access classes.

### `read_only`

No side effects on workspace files or external process state.

Examples:

- `read_file`
- `glob`
- `grep`
- future `web_search`
- future `web_fetch`

### `mutating`

May modify workspace files, external process state, or anything Goat cannot safely prove is read-only.

Examples:

- `bash`
- `write_file`
- `replace_in_file`
- `apply_patch`
- future `subagents`

Goat should be conservative. If a tool might mutate, treat it as mutating.

## Execution-Lock Policy

The `execution.lock` exists to protect same-session mutating runs.

Rules:

- `read_only` tools never require `execution.lock`
- the first `mutating` tool in a run acquires `execution.lock`
- once acquired, the lock is held through session commit

This lets read-only runs stay lightweight while protecting same-session mutation safety.

## Plan Mode

When `--plan` is active:

- mutating tools must not perform side effects
- read-only tools execute for real
- `bash` is the one special case: Goat may execute only a strict read-only allowlisted subset for exploration
- `summary` should say what would have happened
- planned tool results should still fit the normal envelope

Recommended convention:

```json
{
  "ok": true,
  "summary": "Would apply patch to src/app.ts.",
  "data": {
    "planned": true,
    "tool": "apply_patch",
    "arguments": { "...": "..." }
  }
}
```

## Implemented V1 Tools

### `bash`

Run a shell command in the local environment.

#### Parameters

| Field | Type | Required | Default |
|---|---|---|---|
| `command` | string | yes | none |
| `cwd` | string | no | run cwd |
| `env` | object | no | none |
| `shell` | string | no | `tools.default_shell` |

#### Behavior

- validates `cwd` before execution
- launches through the configured shell and shell args
- captures `stdout`, `stderr`, and combined output
- truncates output at the configured bounds
- waits for completion and returns completed output
- execution duration is bounded by the overall Goat run timeout rather than per-tool timeout knobs
- should execute in its own process group so interruption can terminate descendants cleanly
- in normal runs, `bash` is intentionally powerful and should be treated as mutating
- in `--plan`, Goat must not execute arbitrary shell text; it may execute only a strict parser-validated allowlisted read-only subset
- in `--plan`, non-empty `env` and `shell` overrides must be rejected

#### Plan-mode allowlist

In `--plan`, Goat must not invoke a shell interpreter. Instead it should:

1. reject commands containing NUL or newline characters
2. tokenize the command string without shell expansion
3. reject any token containing `$`, backticks, `>`, `<`, `|`, `&`, `;`, `(`, or `)`
4. reject inline env-var assignment syntax
5. execute exactly one direct program invocation
6. require `argv[0]` to be in the allowlist below
7. validate arguments against per-command safe patterns

Initial V1 allowlist:

- `pwd` with no arguments
- `ls` with paths and read-only flags such as `-1`, `-a`, `-A`, `-l`, and `-h`
- `rg` with read-only search flags and path arguments only
- `fd` with read-only search flags and path arguments only
- `cat` with one or more file paths
- `head` and `tail` with optional `-n <int>` and file paths
- `wc` with optional `-l`, `-c`, or `-m` and file paths
- `stat` with file paths
- `tree` with optional `-a` and `-L <int>` plus paths
- `git status` with read-only flags
- `git diff` with read-only flags and optional paths
- `git show` with an optional revision plus read-only flags
- `git log` with an optional revision or path plus read-only flags
- `git rev-parse` with read-only query flags only
- `git ls-files` with optional paths
- `git branch --show-current`

Programs such as `find` and `sed` are intentionally excluded from V1 plan-mode shell execution because their flag surfaces are too easy to misuse.

If a `bash` command falls outside that subset, Goat should fail clearly with a plan-mode shell validation error rather than attempting execution.

#### Access class

- `mutating`

Goat should treat all shell execution as mutating because it cannot reliably prove safety from the command string.

### `read_file`

Read UTF-8 text files with optional line slicing.

#### Parameters

| Field | Type | Required | Default |
|---|---|---|---|
| `path` | string | yes | none |
| `offset_line` | integer | no | `1` |
| `limit_lines` | integer | no | all |
| `encoding` | string | no | `utf8` |

#### Behavior

- line numbers are 1-indexed
- only `utf8` and `utf-8` are accepted in V1
- rejects oversized files
- fails when selected output would exceed bounded output limits

#### Access class

- `read_only`

### `write_file`

Create or overwrite a file with exact content.

#### Parameters

| Field | Type | Required | Default |
|---|---|---|---|
| `path` | string | yes | none |
| `content` | string | yes | none |
| `encoding` | string | no | `utf8` |

#### Behavior

- creates parent directories as needed
- overwrites existing files atomically when practical
- rejects directory targets
- rejects oversized payloads

#### Access class

- `mutating`

### `replace_in_file`

Replace exact text in a file.

#### Parameters

| Field | Type | Required | Default |
|---|---|---|---|
| `path` | string | yes | none |
| `old_text` | string | yes | none |
| `new_text` | string | yes | none |
| `replace_all` | boolean | no | `false` |

#### Behavior

- exact UTF-8 byte-for-byte substring matching only
- not regex-based
- no Unicode normalization, line-ending normalization, BOM stripping, or trimming
- fails if the target file is not valid UTF-8 text
- fails if `old_text` is missing
- fails on multiple matches unless `replace_all = true`

#### Access class

- `mutating`

### `apply_patch`

Apply structured patch text.

#### Parameters

| Field | Type | Required | Default |
|---|---|---|---|
| `patch` | string | yes | none |
| `cwd` | string | no | run cwd |

#### Supported patch forms

- the structured Goat patch format defined in [patch-format.md](/Users/max/goat-cli/docs/patch-format.md)

#### Behavior

- validates and bounds patch size
- prefers structured, rollback-capable application paths
- rejects ambiguous patch context
- treats malformed patches as validation failures
- produces deterministic summaries rather than dumping full patch bodies into logs

#### Access class

- `mutating`

## File Mutation Tool Policy

The file mutation tools intentionally overlap, but each has a preferred use:

- `write_file`
  - create a new file or replace an entire file wholesale
- `replace_in_file`
  - make exact local text edits when the target text is known precisely
- `apply_patch`
  - make structured multi-hunk edits, renames, or coordinated file changes

The runtime should keep all three because they encourage different editing strategies and different failure modes.

### `glob`

Find files using `rg --files`.

#### Parameters

| Field | Type | Required | Default |
|---|---|---|---|
| `pattern` | string | yes | none |
| `path` | string | no | `"."` |

#### Behavior

- backed by `rg`
- respects ignore rules
- includes hidden files
- always excludes `.git`
- returns paths relative to the effective run cwd
- reports truncation and partial results explicitly

#### Access class

- `read_only`

### `grep`

Search text files using `rg --json`.

#### Parameters

| Field | Type | Required | Default |
|---|---|---|---|
| `pattern` | string | yes | none |
| `path` | string | no | `"."` |
| `literal` | boolean | no | `false` |
| `case_sensitive` | boolean | no | `true` |

#### Behavior

- backed by `rg --json`
- default mode uses regex semantics
- `literal = true` switches to fixed-string search
- returns structured line matches
- clips and truncates oversized outputs
- reports partial results when some descendants could not be searched cleanly

#### Access class

- `read_only`

## Planned V1 Stub Tools

These tools should exist as real ids with real schemas and explicit `UNIMPLEMENTED_IN_V1` failures until implemented.

### `web_search`

Future backing:

- Exa

V1 expectations:

- defined schema modeled on the full headless-agent Exa shape:
  - `query`
  - `type`
  - `num_results`
  - `published_within_days`
  - `include_domains`
  - `exclude_domains`
- config section in `goat.toml`
- disabled by default
- explicit failure when invoked before implementation

Expected access class:

- `read_only`

### `web_fetch`

Future backing:

- Defuddle as primary
- bounded `curl` plus lightweight custom parsing as fallback

V1 expectations:

- defined schema
- primary parameter: `url`
- private-host blocking by default
- 80/20 extraction focus:
  - text and JSON when straightforward
  - lightweight HTML cleanup
  - deterministic bounded output
- config section in `goat.toml`
- disabled by default
- explicit failure when invoked before implementation

Expected access class:

- `read_only`

### `subagents`

Future model:

- action-based wrapper around external `subagents` CLI
- request and response shape aligned to `subagents.v1alpha1`
- Goat owns the model-facing tool schema and shells out to the external CLI for execution

V1 expectations:

- reserve the tool id and config section
- no runtime behavior beyond explicit unimplemented failure

Expected access class once implemented:

- `mutating`

## Tool Enablement

Tools are enabled per agent.

Rules:

- a tool must be recognized by the runtime
- a tool must be listed in the agent's `enabled_tools`
- disabled or unknown tools must fail clearly

V1 should fail unknown tool names during config validation rather than waiting for runtime.

## Tool Persistence

Tool behavior shows up in per-run state through:

- `transcript.jsonl`
- `summary.json`
- `artifacts/`

Goat should avoid creating a second competing global tool-log store in V1. The run directory is the audit trail.

## Doctor Expectations

`goat doctor` should validate:

- `rg` is installed
- configured shell exists
- OpenAI credentials are discoverable
- the OpenAI provider accepts an authenticated metadata-only ping
- Exa credentials are discoverable when `web_search` is enabled
- Defuddle endpoint configuration is sane when `web_fetch` is enabled

## Future Extensions

The harness should leave clean room for:

- real web search
- real web fetch
- real subagents
- richer artifact typing
- optional observability streams

Those additions should extend the existing contract instead of replacing it.
