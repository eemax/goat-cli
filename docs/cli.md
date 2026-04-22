# CLI Reference

## Commands

### Prompt runs

```
goat new [options] "message"
goat last [options] "message"
goat --session <id|new|last> [options] "message"
```

`goat new` creates a new session, runs the prompt, and prints the final assistant reply to stdout.

`goat last` runs against the most recent active session with committed history.

`goat --session` is the canonical form for explicit session targeting. `goat new` and `goat last` are convenience aliases.

### Session management

```
goat sessions new              Create a session, print its ULID
goat sessions last             Print the last active session ID
goat sessions list             List session IDs (newest first)
goat sessions show <id>        Print session meta.json
goat sessions fork <id|last>   Fork a session, print the new ID
goat sessions stop <id>        Mark a session as stopped
```

### Run inspection

```
goat runs list [--session <id|last>]         List run IDs (newest first)
goat runs show --session <id|last> <run-id>  Print run summary.json
```

If `--session` is omitted from `runs list`, it defaults to `last`.

### Compaction

```
goat compact session <id|last>  Run deterministic session-history compaction
```

### Definitions and metadata

```
goat agents      List agent definitions (one per line, sorted)
goat roles       List role definitions
goat prompts     List prompt definitions
goat skills      List resolved skills grouped by agent
goat scenarios   List scenario definitions
goat version     Print the CLI version
goat doctor      Run preflight checks
```

## Run options

| Flag | Description | Sticky |
|------|-------------|--------|
| `--fork` | Fork the target session before running | -- |
| `--agent <name>` | Choose agent (binds on first run) | yes |
| `--role <name>` | Apply a role overlay | yes |
| `--no-role` | Clear the stored role | yes |
| `--prompt <name>` | One-turn prompt prefix | no |
| `--skill <id>` | Invoke one skill for this turn. Repeatable. | no |
| `--compact` | Run deterministic compaction before the prompt turn starts | no |
| `--scenario <id>` | Run a scenario chain. Only valid with new sessions. | no |
| `--model <name>` | Override model | yes |
| `--effort <level>` | Reasoning effort | yes |
| `--timeout <dur>` | Run timeout | no |
| `--plan` | Plan mode | no |
| `--cwd <path>` | Tool working directory | yes |
| `--verbose` | Stream progress to stderr | no |
| `--debug` | Debug diagnostics (implies --verbose) | no |
| `--debug-json` | Debug diagnostics as JSON lines | no |

"Sticky" means the value persists to the session on commit and is reused by later runs unless overridden.

### `--fork`

Fork the target session into a new session before running. Allowed with `goat last`, `goat --session last`, and `goat --session <id>`. Using `--fork` with `goat new` is a usage error.

### `--agent <name>`

A new session may bind to the chosen agent. An already-bound session cannot silently switch agents -- conflicting agent selection fails.

### `--role <name>` / `--no-role`

Roles are mutable overlays. `--role` applies a role; `--no-role` clears it. These flags conflict with each other.

### `--prompt <name>`

Prepends the named prompt text to the user message for one run only. Not sticky.

### `--skill <id>`

Injects a loaded skill into the current user turn. When both `--prompt` and `--skill` are present, the prompt text comes first, then skill invocation text, then the raw message. Skills are never sticky.

### `--compact`

Runs the same deterministic session compaction as `goat compact session <id|last>` after session/fork resolution and before prompt assembly. On a new empty session this is a no-op.

### `--scenario <id>`

Runs a scenario definition from `scenarios/<id>.toml`. Scenario v1 is sequential: each step runs in a fresh session, and the final step's assistant reply is the only prompt-run stdout. `--scenario` cannot be combined with `--agent`, `--role`, `--no-role`, `--prompt`, `--skill`, or `--fork`.

### `--effort <level>`

Values: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`. `none` omits the reasoning-effort parameter from the provider request.

### `--plan`

Plan mode: read-only tools execute normally, mutating tools describe intended actions without executing. `bash` is restricted to a parser-validated read-only allowlist. Per-run only, never persisted.

## Input

Prompt runs accept:

- One required message argument
- Optional stdin as an additional user message

Stdin rules:

- If attached to a terminal, treated as absent
- If non-TTY but zero bytes, treated as absent
- Read fully before provider execution
- Must be valid UTF-8
- Content preserved exactly (no normalization)
- Exceeding `runtime.max_stdin` is exit code 2

When stdin is present, it becomes a second user message (not concatenated with the CLI argument).

## Output

### Stdout

Reserved for user-consumable command results only:

- Prompt runs: final assistant reply
- `goat version`: version string
- `goat sessions new`: session ID
- `goat sessions last`: session ID
- `goat compact session`: compaction run ID when a run is created
- `goat agents/roles/prompts/scenarios`: one name per line
- `goat skills`: skills grouped by agent
- `goat sessions show`: pretty-printed JSON
- `goat runs show`: pretty-printed JSON

### Stderr

Default successful prompt runs write no stderr. Errors go to stderr. With `--verbose`, `--debug`, or `--debug-json`, Goat emits numbered capped events for system status, tool calls/results, and errors. Assistant text deltas and the final assistant reply are never streamed to stderr.

### Doctor output

One line per check: `PASS <name>`, `FAIL <name>: <reason>`, or `SKIP <name>: <reason>`.

## Exit codes

Every non-zero exit is produced by a single `GoatError` subclass, so the
mapping from error code to exit code is stable and documented below.

| Code | Name | Typical triggers |
|------|------|------------------|
| 0 | Success | The command completed normally. |
| 1 | Internal runtime error | Unhandled exception, unexpected invariant failure, or unknown command kind. Anything not classified as a Goat error falls here. |
| 2 | Usage / input error | `USAGE_ERROR` — bad CLI args, conflicting flags, unknown flag, missing prompt argument, stdin larger than `runtime.max_stdin`, effective cwd missing or not a directory, assembled prompt still exceeds `compact_at_tokens` after compaction. |
| 3 | Config / definition error | `CONFIG_ERROR` — invalid `goat.toml` / `models.toml`, duplicate model id or alias, missing default agent, agent enables an unknown tool, agent references an unknown model, bound session cannot switch agents, missing API key. |
| 4 | Not found | `NOT_FOUND` — session, agent, role, prompt, or run id not found; `goat last` with no active session containing committed history. |
| 5 | Stopped session | `STOPPED_SESSION` — the target session has been stopped via `goat sessions stop`. |
| 6 | Session conflict | `SESSION_CONFLICT` — another process committed to the session during the run, or the execution lock could not be acquired. |
| 7 | Provider failure | `PROVIDER_FAILURE` — OpenAI SDK threw a retryable or non-retryable provider error (rate limit, connection error, server error, API error). |
| 8 | Tool failure | `TOOL_FAILURE` — a tool threw a `toolError`, including plan-mode shell guard violations, schema validation failures that bubbled out of the handler, unknown tool names, or disabled tool attempts. |
| 9 | Interrupted | `INTERRUPTED` — user interrupt or deliberate abort. |
| 10 | Timeout | `TIMEOUT` — wall-clock run timeout (`--timeout`, agent `run_timeout`, or `runtime.run_timeout`) elapsed. |
| 11 | Doctor failure | Any `goat doctor` check reported `FAIL`. |

Tool call failures do **not** crash the run — a failing tool returns a
structured error envelope inside the transcript and the agent loop continues.
Exit code 8 is only returned when a tool throws a `GoatError` that escapes
the harness (e.g. the plan-mode guard rejecting the command outright before
the tool executes).

## Session resolution

| Form | Behavior |
|------|----------|
| `goat new` | Create a new session, bind on commit |
| `goat last` | Most recently updated active session with committed history |
| `goat --session new` | Same as `goat new` |
| `goat --session last` | Same as `goat last` |
| `goat --session <id>` | Target an explicit session; fail if stopped |

## Examples

```bash
# Basic usage
goat new "summarize this repository"
goat last --verbose "keep going"

# Session management
goat sessions new
goat sessions fork last
goat sessions stop 01jxyzabc123def456ghi789jk

# Explicit session targeting
goat --session 01jxyzabc123 --cwd /tmp/project "inspect the project"

# Pipe stdin
printf '%s\n' 'extra context' | goat new --plan "propose edits"

# Inspect runs
goat runs list --session last
goat runs show --session last 01jxyzrun123def456ghi789jk
```
