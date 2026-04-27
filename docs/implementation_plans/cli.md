# Goat CLI Contract

> Historical note: this planning document predates the simplified manual compaction model. Current CLI behavior is documented in `docs/cli.md`: `goat compact session` and `--compact` run explicit provider-backed compaction, while ordinary prompt runs only warn near the threshold.

## Overview

`goat` is a non-interactive, session-first CLI for agent runs.

The command surface is intentionally compact:

- prompt runs happen through `goat new`, `goat last`, or `goat --session ...`
- inspection happens through top-level plural nouns such as `goat agents` and `goat runs`
- session management stays under `goat sessions ...`

Style rule:

- top-level resource command groups use plural nouns
- flags that select one concrete resource use singular names such as `--session`, `--agent`, `--role`, and `--prompt`

## Core Commands

```text
goat version
goat doctor
goat agents
goat roles
goat prompts
goat sessions new
goat sessions last
goat sessions list
goat sessions show <id>
goat sessions fork <id|last>
goat sessions stop <id>
goat runs list [--session <id|last>]
goat runs show --session <id|last> <run-id>
goat new [run options] "message"
goat last [run options] "message"
goat --session <id|new|last> [run options] "message"
```

## Command Intent

### `goat version`

Print the CLI version to stdout.

### `goat doctor`

Run local preflight checks and print results to stdout.

V1 checks should include:

- required config readability
- model catalog readability
- agent, role, and prompt parse validation
- compaction model resolution and compaction prompt readability when configured
- provider credential discoverability
- metadata-only authenticated provider ping with no billed generation request
- session root writability
- `rg` availability
- optional dependency discoverability for stubbed future tools where useful

### `goat agents`

List resolvable agent definitions.

### `goat roles`

List resolvable role definitions.

### `goat prompts`

List resolvable named prompt definitions.

### `goat sessions new`

Create a new session and print its lowercase ULID to stdout.

### `goat sessions last`

Print the resolved last active session id to stdout.

### `goat sessions list`

List known session ids.

### `goat sessions show <id>`

Print pretty-printed JSON from the session's `meta.json`.

Fresh sessions must use the same JSON shape as bound sessions:

- `bound: false`
- nullable sticky fields such as `agent_name`, `role_name`, `model`, `effort`, and `cwd`
- `revision: 0`
- `message_count: 0`

### `goat sessions fork <id|last>`

Fork a session without running a prompt and print the new session id to stdout.

### `goat sessions stop <id>`

Mark a session as stopped. It should not print anything on success.

### `goat runs list [--session <id|last>]`

List run ids for a session.

If `--session` is omitted, it should default to `last`.

### `goat runs show --session <id|last> <run-id>`

Print pretty-printed JSON from the run's `summary.json`.

Run inspection is session-scoped in V1 so Goat does not need a global run index.

### `goat new`

Create a new session, run the prompt, and print only the final assistant reply to stdout.

### `goat last`

Run the prompt against the most recent active session with committed history.

### `goat --session <id|new|last>`

Canonical run form for explicit session targeting.

`goat new` and `goat last` are convenience aliases for the common cases.

Session ids and run ids are canonical lowercase ULIDs.

## Run Options

```text
--fork
--agent <name>
--role <name>
--no-role
--prompt <name>
--model <name>
--effort <none|minimal|low|medium|high|xhigh>
--timeout <seconds>
--plan
--cwd <path>
--verbose
--debug
```

## Run Option Semantics

### `--fork`

Fork the target session into a new active session before the run.

Allowed with:

- `goat last`
- `goat --session last`
- `goat --session <id>`

Using `--fork` with `goat new` is a usage error.

### `--agent <name>`

Choose the agent for the run.

Rules:

- a new session may bind to the chosen agent
- an already bound session must not silently switch to a different agent
- conflicting agent selection should fail clearly

The asymmetry with roles is intentional: the agent is part of the session's core identity and capability boundary.

### `--role <name>`

Apply a sticky role overlay for the session when the run commits.

Roles are mutable overlays and may change over the life of a session.

### `--no-role`

Clear the stored role when the run commits.

This flag conflicts with `--role`.

### `--prompt <name>`

Apply a named one-turn prompt.

This is not sticky session state.

Terminology:

- the agent contributes the system prompt
- the role contributes a role overlay appended after the system prompt
- `--prompt` contributes a one-turn prompt inserted before the user's message for that run only

Goat prepends the named prompt text to the primary user message for that run only.
If stdin is present, it remains a separate user message.

### `--model <name>`

Override the model for the run and store it on commit.

### `--effort <...>`

Override reasoning effort for the run and store it on commit.

In V1:

- `none` omits an explicit provider reasoning-effort override
- `minimal`, `low`, `medium`, `high`, and `xhigh` pass through to the provider adapter

### `--timeout <seconds>`

Override the total run timeout for the current invocation only.

This value is not persisted to the session.

### `--plan`

Run in plan mode.

Plan mode is per-run only and must not persist to session metadata.

### `--cwd <path>`

Use the given working directory for the run and store it on commit.

This affects tool execution, not definition discovery.

Goat must validate that the effective cwd exists and is a directory before provider execution starts.

### `--verbose`

Enable numbered stderr progress events for system status and tool progress. Assistant text deltas and final replies must stay off stderr.

### `--debug`

Enable additional stderr diagnostics intended for development and troubleshooting.

`--debug` always implies `--verbose`.

## Stdout And Stderr Contract

### Stdout

Stdout is reserved for user-consumable command results only.

For prompt runs, stdout must contain only the final assistant reply.

For non-run commands, stdout contains the direct command result such as:

- version text
- a session id
- listed definition names
- rendered session metadata

### Stderr

Stderr is used for:

- validation failures
- provider and tool errors
- numbered verbose progress logs
- tool call/result traces
- created or forked session notices during run commands
- numbered debug diagnostics

This split is a hard contract and should not drift over time.

## Output Formats

Default output formats are part of the CLI contract.

`goat version`

- prints the version string only

`goat agents`, `goat roles`, `goat prompts`

- print one resolved name per line
- sorted ascending lexicographically

`goat sessions list`

- prints one session id per line
- sorted newest first by `updated_at`

`goat runs list`

- prints one run id per line
- sorted newest first

`goat sessions show <id>`

- prints pretty-printed JSON from `meta.json`

`goat runs show --session <id|last> <run-id>`

- prints pretty-printed JSON from `summary.json`

`goat doctor`

- prints one line per check
- line format is `PASS <name>`, `FAIL <name>: <reason>`, or `SKIP <name>: <reason>`

## Input Contract

Prompt runs accept:

- one required message argument
- optional stdin as an additional user message when present

Stdin rules:

- if stdin is attached to a terminal, it is treated as absent
- if stdin is non-TTY but zero bytes are read before EOF, it is treated as absent
- Goat reads stdin fully before provider execution and only until EOF
- if stdin exceeds `runtime.max_stdin` while reading, Goat must fail before provider execution
- stdin must be valid UTF-8 text
- stdin content is preserved exactly as read, with no newline or Unicode normalization
- stdin read time counts toward the overall run timeout

When stdin is present, it remains a second user message. Goat should not silently concatenate it into the primary CLI message argument.

## Session Resolution Rules

### New Session

`goat new` and `goat --session new` should:

- create the session immediately
- emit the creation notice to stderr if appropriate
- bind the session only if the run commits

### Last Session

`goat last` and `goat --session last` should resolve to the most recently updated active session with committed history.

### Existing Session

`goat --session <id>` targets an explicit existing session.

If the session is stopped, the run must fail.

If the session conflicts during commit, the failed run remains inspectable via `goat runs show --session <id|last> <run-id>`.

## Expected Usage Examples

```bash
goat version
goat agents
goat sessions new
goat sessions fork last
goat runs list --session last
goat new "summarize this repository"
goat last --verbose "keep going"
goat runs show --session last 01jxyzrun123def456ghi789jk
goat --session 01jxyzabc123 --cwd /tmp/project "inspect the project"
printf '%s\n' 'extra context' | goat new --plan "propose edits"
```

## Definition Roots

Goat resolves definitions from an ordered global root stack:

1. `~/goat-cli/`
2. `~/.config/goat/`
3. `$GOAT_HOME_DIR`, when set

Expected definition and catalog surfaces:

```text
models.toml
agents/
roles/
prompts/
skills/
scenarios/
```

V1 should expose list commands for:

- agents
- roles
- prompts
- skills
- scenarios

Skills are loaded from agent-configured skill folders and exposed through `goat skills` plus repeatable `--skill <id>` turn injection.

`models.toml` is used for model resolution by agents and `--model`, but does not require a top-level listing command in V1.

## Tool Exposure In V1

### Enabled And Intended For Real Use

- `bash`
- `read_file`
- `write_file`
- `replace_in_file`
- `apply_patch`
- `glob`
- `grep`

### Present As Planned Stubs

- `web_search`
  - future backing: Exa
- `web_fetch`
  - future backing: Defuddle, then `curl` fallback and custom parsing
- `subagents`
  - future model: action-based wrapper around external `subagents` CLI

These stubs should fail clearly with a structured error rather than pretending to work.

## Tool Output Shape

Provider-facing tool calls should return a normalized envelope:

```json
{ "ok": true, "summary": "...", "data": { ... } }
```

or:

```json
{ "ok": false, "summary": "...", "error": { "code": "...", "message": "...", "retryable": false } }
```

The assistant loop should treat this as the canonical tool result contract.

Partial tool results must be explicit and include preview metadata plus an artifact reference when inline output is truncated.

## `glob` And `grep`

`glob` and `grep` must be backed by `rg`.

Important behaviors:

- respect ignore files
- include hidden files where appropriate
- always exclude `.git`
- fail clearly when `rg` is missing
- keep outputs bounded and structured

## Provider Contract

V1 provider behavior:

- OpenAI Agents SDK runtime backed by the Responses API
- HTTP transport through the OpenAI client
- SDK event handling enabled, with assistant text kept on stdout only
- no websocket support
- no Codex auth mode

This should be reflected in the CLI docs and in `goat doctor`.

V1 exposes one OpenAI runtime, while keeping the low-level provider seam available for injected tests and compatibility.

## Plan Mode Contract

When `--plan` is active:

- read-only tools execute for real
- mutating tools must describe intended actions
- `bash` may execute only a strict parser-validated read-only subset
- final assistant output still prints to stdout

## Output Persistence

Every prompt run should leave behind:

- replayable session history
- per-run transcript
- provider metadata
- final run summary
- artifact files when outputs are too large to inline

These files are part of the CLI contract even though they are not printed directly.

`docs/persistence.md` is the canonical source for record shapes and field names.

Expected layout:

```text
<sessions_dir>/
  <session-id>/                 # lowercase ULID
    meta.json
    compaction.json
    messages.jsonl
    session.lock
    execution.lock
    runs/
      <run-id>/                 # lowercase ULID
        transcript.jsonl
        provider.jsonl
        summary.json
        artifacts/
```

## Exit Behavior

Exit codes are part of the CLI protocol.

Stable V1 table:

- `0`: success
- `1`: internal runtime error
- `2`: usage or invocation-input error
- `3`: config, definition, or invalid session-state error
- `4`: not found
- `5`: stopped session
- `6`: session conflict
- `7`: provider failure
- `8`: tool failure
- `9`: interrupted
- `10`: timeout
- `11`: doctor failure

Clarifications:

- stdin exceeding `runtime.max_stdin` is exit code `2`
- plan-mode shell guard violations are exit code `8`
- compaction failures use the underlying failure class and should be distinguished in `summary.json.termination_reason`

## Future-Compatible Boundaries

The CLI contract should leave room for future additions without forcing breaking changes:

- web tooling moving from stub to real implementation
- subagents moving from stub to real implementation
- additional scenario inspection commands
- additional inspection commands

The top-level shape should remain compact and consistent as those features arrive.
