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

### Definitions and metadata

```
goat agents      List agent definitions (one per line, sorted)
goat roles       List role definitions
goat prompts     List prompt definitions
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
| `--model <name>` | Override model | yes |
| `--effort <level>` | Reasoning effort | yes |
| `--timeout <dur>` | Run timeout | no |
| `--plan` | Plan mode | no |
| `--cwd <path>` | Tool working directory | yes |
| `--verbose` | Stream progress to stderr | no |
| `--debug` | Debug diagnostics (implies --verbose) | no |

"Sticky" means the value persists to the session on commit and is reused by later runs unless overridden.

### `--fork`

Fork the target session into a new session before running. Allowed with `goat last`, `goat --session last`, and `goat --session <id>`. Using `--fork` with `goat new` is a usage error.

### `--agent <name>`

A new session may bind to the chosen agent. An already-bound session cannot silently switch agents -- conflicting agent selection fails.

### `--role <name>` / `--no-role`

Roles are mutable overlays. `--role` applies a role; `--no-role` clears it. These flags conflict with each other.

### `--prompt <name>`

Prepends the named prompt text to the user message for one run only. Not sticky.

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
- `goat agents/roles/prompts`: one name per line
- `goat sessions show`: pretty-printed JSON
- `goat runs show`: pretty-printed JSON

### Stderr

Everything else: streaming deltas, verbose progress, tool traces, session notices, errors, debug diagnostics.

### Doctor output

One line per check: `PASS <name>`, `FAIL <name>: <reason>`, or `SKIP <name>: <reason>`.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Internal runtime error |
| 2 | Usage or input error (including stdin overflow) |
| 3 | Config, definition, or invalid session-state error |
| 4 | Not found |
| 5 | Stopped session |
| 6 | Session conflict |
| 7 | Provider failure |
| 8 | Tool failure (including plan-mode shell guard violations) |
| 9 | Interrupted |
| 10 | Timeout |
| 11 | Doctor failure |

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
