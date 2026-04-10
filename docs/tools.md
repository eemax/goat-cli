# Tools

## Overview

Goat exposes a local trusted tool harness to the model through the OpenAI Responses function-tool interface. Tools are enabled per agent via `enabled_tools` in the agent definition.

## Output envelope

All tools return a normalized JSON envelope.

**Success:**

```json
{
  "ok": true,
  "summary": "Found 12 matching files.",
  "data": { "matches": ["src/app.ts", "src/cli.ts"] }
}
```

**Failure:**

```json
{
  "ok": false,
  "summary": "Patch application failed.",
  "error": { "code": "PATCH_CONTEXT_MISMATCH", "message": "...", "retryable": false }
}
```

Rules: `summary` is always present. `data` exists only on success. `error` exists only on failure.

### Partial results

When inline output exceeds configured bounds, tools return an explicitly partial result with head/tail previews and an artifact reference:

```json
{
  "ok": true,
  "summary": "Search result truncated.",
  "data": {
    "partial": true,
    "truncation_reason": "max_output_chars_exceeded",
    "preview": { "head": "...", "tail": "...", "head_lines": 80, "tail_lines": 80 },
    "artifact": { "path": "artifacts/tool-001.txt", "bytes": 512000 }
  }
}
```

## Access classes

| Class | Description | Execution lock |
|-------|-------------|----------------|
| `read_only` | No side effects on workspace or processes | Never required |
| `mutating` | May modify files, processes, or external state | Acquired on first use, held through commit |

## Path resolution

All relative paths resolve from the effective run working directory (set by `--cwd` or stored session `cwd`). Absolute paths are allowed. Empty or non-normalizable paths fail validation.

## Implemented tools

### bash

Run a shell command in the local environment.

| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| `command` | string | yes | -- |
| `cwd` | string | no | run cwd |
| `env` | object | no | -- |
| `shell` | string | no | `tools.default_shell` |

- Launches through the configured shell and shell args
- Captures stdout, stderr, and combined output
- Truncates at configured bounds
- Executes in its own process group for clean interruption
- Access class: **mutating**

**Plan mode**: arbitrary shell execution is blocked. Only a parser-validated read-only subset is allowed:

- `pwd`, `ls`, `cat`, `head`, `tail`, `wc`, `stat`, `tree`
- `rg`, `fd` (read-only flags only)
- `git status`, `git diff`, `git show`, `git log`, `git rev-parse`, `git ls-files`, `git branch --show-current`

Commands containing `$`, backticks, `>`, `<`, `|`, `&`, `;`, `(`, `)` are rejected. Non-empty `env` and `shell` overrides are rejected in plan mode.

### read_file

Read UTF-8 text files with optional line slicing.

| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| `path` | string | yes | -- |
| `offset_line` | integer | no | 1 |
| `limit_lines` | integer | no | all |
| `encoding` | string | no | `utf8` |

- Line numbers are 1-indexed
- Only `utf8`/`utf-8` accepted in V1
- Rejects oversized files
- Access class: **read_only**

### write_file

Create or overwrite a file with exact content.

| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| `path` | string | yes | -- |
| `content` | string | yes | -- |
| `encoding` | string | no | `utf8` |

- Creates parent directories as needed
- Atomic overwrite when practical
- Rejects directory targets and oversized payloads
- Access class: **mutating**

### replace_in_file

Replace exact text in a file.

| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| `path` | string | yes | -- |
| `old_text` | string | yes | -- |
| `new_text` | string | yes | -- |
| `replace_all` | boolean | no | `false` |

- Exact byte-for-byte substring match (not regex)
- No Unicode normalization, line-ending normalization, or trimming
- Fails if target is not valid UTF-8
- Fails if `old_text` is not found
- Fails on multiple matches unless `replace_all = true`
- Access class: **mutating**

### apply_patch

Apply structured patch text using the [Goat patch format](patch-format.md).

| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| `patch` | string | yes | -- |
| `cwd` | string | no | run cwd |

- Validates and bounds patch size
- Rejects ambiguous context
- Malformed patches are validation failures (no partial application)
- Access class: **mutating**

### glob

Find files using `rg --files`.

| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| `pattern` | string | yes | -- |
| `path` | string | no | `"."` |

- Backed by `rg`
- Respects ignore rules, includes hidden files, always excludes `.git`
- Returns paths relative to the run cwd
- Reports truncation explicitly
- Access class: **read_only**

### grep

Search text files using `rg --json`.

| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| `pattern` | string | yes | -- |
| `path` | string | no | `"."` |
| `literal` | boolean | no | `false` |
| `case_sensitive` | boolean | no | `true` |

- Default: regex semantics. `literal = true` for fixed-string search.
- Returns structured line matches
- Clips oversized outputs, reports partial results
- Access class: **read_only**

## Stub tools (V1)

These tools have real IDs, schemas, and config sections but return structured `UNIMPLEMENTED_IN_V1` errors when invoked.

| Tool | Future backing | Access class |
|------|---------------|--------------|
| `web_search` | Exa | read_only |
| `web_fetch` | Defuddle + curl fallback | read_only |
| `subagents` | External subagents CLI | mutating |

## Plan mode behavior

| Tool class | Behavior |
|------------|----------|
| read_only | Execute normally |
| mutating (non-bash) | Return planned action description, no side effects |
| bash | Execute only allowlisted read-only subset |

Planned results use the normal envelope with `"planned": true` in data.

## Doctor checks

`goat doctor` validates:

- `rg` is installed
- Configured shell exists
- OpenAI credentials are discoverable
- Provider accepts authenticated ping
- Exa/Defuddle credentials when their sections are enabled
