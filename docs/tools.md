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

**Plan mode**: arbitrary shell execution is blocked. The command is tokenized
by a small internal parser (no shell) and matched against a per-program
allowlist. Anything outside the allowlist is rejected before any process is
spawned.

Commands containing `$`, backticks, `>`, `<`, `|`, `&`, `;`, `(`, or `)` are
rejected outright, as are any payloads containing NUL bytes or newlines.
Inline environment assignments (`FOO=bar cat …`) are rejected. Non-empty `env`
overrides and explicit `shell` overrides are rejected in plan mode.

Programs and flags allowed in plan mode:

| Program | Allowed flags / forms | Notes |
|---------|----------------------|-------|
| `pwd` | *(no arguments)* | |
| `ls` | `-1`, `-a`, `-A`, `-l`, `-h`, and common combinations (`-la`, `-al`, `-lah`, `-ahl`, `-lha`, `-hal`) | Paths are unrestricted positional args |
| `cat`, `stat` | *(paths only)* | At least one path required |
| `head`, `tail` | Optional `-n <positive int>`, then paths | At least one path required |
| `wc` | `-l`, `-c`, `-m`, then paths | At least one path required |
| `tree` | `-a`, `-L <positive int>` | Flags must appear before paths |
| `rg` | `--files`, `--hidden`, `-n`/`--line-number`, `-i`/`--ignore-case`, `-F`/`--fixed-strings`, `-S`/`--smart-case`, `-l`/`--files-with-matches`, `-uu`; value flags `-g`/`--glob`, `-m`/`--max-count` | Must supply a pattern unless `--files` is set |
| `fd` | `-H`/`--hidden`, `-I`/`--no-ignore`, `-a`/`--absolute-path`, `-g`/`--glob`; value flags `-t`/`--type`, `-d`/`--max-depth` | Up to two positional arguments |
| `git status` | `--short`/`-s`, `--branch`/`-b`, `--porcelain` | |
| `git diff` | `--stat`, `--name-only`, `--name-status`, `--cached`/`--staged`, `--summary`, `--no-ext-diff` | |
| `git show` | `--stat`, `--name-only`, `--name-status`, `--summary`, `--no-patch`, `--no-ext-diff` | Up to two positionals |
| `git log` | `--oneline`, `--stat`, `--name-only`, `--name-status`, `--decorate`, `--graph`, `--no-ext-diff`; value flags `-n`/`--max-count` | Up to two positionals |
| `git rev-parse` | `--show-toplevel`, `--git-dir`, `--show-prefix`, `--show-cdup`, `--is-inside-work-tree`, `--abbrev-ref` | Up to one positional |
| `git ls-files` | `--others`, `--cached`, `--modified`, `--deleted`, `--ignored`, `--exclude-standard` | |
| `git branch` | Exactly `--show-current` | All other forms rejected |

Any flag or subcommand not listed above is rejected with
`unsupported <program> flag in plan mode: <arg>`.

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

These tools have real IDs, schemas, and config sections but return structured
`UNIMPLEMENTED_IN_V1` failure envelopes when invoked. They are reserved so
agent definitions, doctor checks, and the provider tool payload can be
stabilized now and back-filled with real implementations later without
breaking sessions that already enable them.

| Tool | Future backing | Access class |
|------|---------------|--------------|
| `web_search` | Exa | read_only |
| `web_fetch` | Defuddle + curl fallback | read_only |
| `subagents` | External subagents CLI | mutating |

### `web_search` (stub)

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search query string |
| `type` | string | no | Search profile / strategy hint |
| `num_results` | integer | no | Positive integer upper bound |
| `published_within_days` | integer | no | Positive integer recency window |
| `include_domains` | string[] | no | Allowlist of hostnames |
| `exclude_domains` | string[] | no | Denylist of hostnames |

### `web_fetch` (stub)

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string (URL) | yes | Absolute URL to fetch |

### `subagents` (stub)

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | yes | Subagent dispatch action identifier |

All three return:

```json
{
  "ok": false,
  "summary": "<tool> is not implemented in V1.",
  "error": {
    "code": "UNIMPLEMENTED_IN_V1",
    "message": "<tool> is not implemented in V1.",
    "retryable": false
  }
}
```

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
