# Goat CLI Architecture

## Overview

`goat` is a session-first, non-interactive agent harness CLI.

It is designed to be the durable core that other interfaces attach to later:

- shell scripts
- local UIs
- editors
- remote supervisors
- future daemonized or interactive shells

V1 is intentionally narrow:

- one process
- one CLI entrypoint
- one session store
- one provider path
- one transport mode
- one tool harness
- one strict stdout/stderr contract

The goal is a boring, reliable core with strong boundaries and durable on-disk state.

Even though V1 ships with one provider and one transport only, the internal boundaries should be modular from day one so future providers or transports can be added without warping the session model, transcript model, or CLI contract.

## Implementation Choice

V1 Goat should be implemented in Bun + TypeScript.

Important intent:

- Bun is the runtime, package manager, and developer toolchain
- the code should prefer Node-compatible filesystem and child-process APIs
- the architecture should not depend on Bun-only semantics unless there is a clear payoff

## Design Goals

- Durable: runs and sessions must remain inspectable after crashes, interrupts, and upgrades.
- Maintainable: module boundaries should stay simple and explicit.
- Modular: providers, tools, and higher-level products should layer on top of stable interfaces.
- Scriptable: stdout must stay machine-safe for the final reply, while stderr carries progress and diagnostics.
- Auditable: every run should leave behind enough artifacts to explain what happened.
- Extensible: future features like skills, web tooling, and subagents should fit without warping the core model.

## Explicit Non-Goals For V1

- no daemon or detached runtime
- no websocket transport
- no Codex auth mode
- no plugin system
- no UI-specific behavior
- no background workers beyond child processes launched by tools
- no hidden database state

## Runtime Shape

The runtime is shaped more like `headless-agent` than `agent-commander` at the CLI layer:

- `goat new`
- `goat last`
- `goat --session <new|last|id>`
- `goat sessions new|last|list|show|stop`
- `goat sessions fork <id|last>`
- `goat runs list [--session <id|last>]`
- `goat runs show --session <id|last> <run-id>`
- `goat agents`
- `goat roles`
- `goat prompts`
- `goat version`
- `goat doctor`

Internally, the execution loop and tool harness borrow the stronger patterns from `agent-commander`:

- OpenAI Responses API tool loop
- normalized tool envelopes
- explicit harness registry
- clear room for subagents later

## V1 Feature Scope

### Included

- durable sessions and runs
- model, agent, role, and prompt definitions loaded from repo or home roots
- OpenAI Responses API over HTTP only
- local tool harness
- custom runtime-owned compaction
- `--plan` mode
- verbose stderr progress and streaming
- per-run transcripts, provider metadata, and artifacts
- strict session conflict handling

### Implemented Tools

- `bash`
- `read_file`
- `write_file`
- `replace_in_file`
- `apply_patch`
- `glob`
- `grep`

### Planned But Stubbed In V1

- `web_search`
  - provider target: Exa
  - shape inspired by `headless-agent`
- `web_fetch`
  - primary engine: Defuddle
  - fallback path: `curl` plus custom parsing
  - shape inspired by `agent-commander`
- `subagents`
  - future tool wrapper around external `subagents` CLI

These tools should have real type definitions, config surface area, and harness seams in V1, but they may return a structured `UNIMPLEMENTED_IN_V1` failure until implemented.

### Reserved But Not Expanded Yet

- `skills/` root in the repo and home configuration root

V1 should resolve and reserve the concept cleanly, but should not build runtime behavior around it yet.

## Core Principles

### 1. Sessions Are The Primary Unit

A session is the durable container for:

- prompt history
- sticky execution settings
- working directory state
- run history
- audit artifacts

The CLI should make it cheap to resume and inspect sessions without requiring a background service.

### 2. Runs Are Immutable Facts

Each invocation creates a run record under a session. A run may fail, be interrupted, or conflict, but its transcript and summary should still be inspectable.

### 3. Stdout Is Sacred

Stdout should contain only:

- the final assistant reply for prompt runs
- the created session id for `goat sessions new`
- the resolved session id for `goat sessions last`
- explicit list/show command output

Everything else goes to stderr:

- streaming deltas
- verbose logs
- tool progress
- debug information
- session creation notices during `goat new` or `goat --session new`

### 4. The CLI Is The Protocol

Future UIs should be able to wrap `goat` without special in-process integration.

That means:

- stable commands
- stable exit codes
- stable file layout
- stable transcript semantics

## High-Level Runtime Flow

For a prompt run:

1. Parse CLI arguments.
2. Resolve configuration roots.
3. Load global config.
4. Create or resolve the target session.
5. Resolve agent, role, one-turn prompt, and working directory.
6. Validate that the effective working directory exists and is a directory.
7. Read stdin if present, enforcing the configured size and UTF-8 rules.
8. Assemble the would-be provider input from system layers and replayable session history.
9. If a conservative pre-send estimate of the initial provider request would exceed the effective `compact_at_tokens` budget, compact durable history first, then reassemble.
10. Create the prompt run directory.
11. Execute the assistant/tool loop, compacting again only at safe points when a continuation request’s conservative pre-send estimate would exceed that budget.
12. Persist run transcript, provider metadata, and summary.
13. Project replayable records and any updated compaction state back into session history.
14. Print only the final assistant text to stdout.

Non-run commands stop earlier and never enter the provider loop.

## Responses Loop Ownership

Goat uses a hybrid ownership model for the OpenAI Responses API.

### Across runs

Across separate Goat runs, Goat is fully stateful on the local filesystem and must not depend on provider-side stored conversation state.

Each new run rebuilds its initial provider input from:

- agent system prompt
- role overlay
- rendered `compaction.json`, if present
- replayable `messages.jsonl`
- current user message
- optional stdin

This keeps cross-run resume durable and provider-independent.

### Within one run

Within a single run, Goat should use OpenAI's `previous_response_id` to continue the Responses API loop across tool turns.

That gives Goat:

- cheaper tool-turn requests
- warmer server-side reasoning state
- better cache locality within the run

The intended model is:

- stateful within a run
- stateless across runs

This is the V1 design point for maximizing provider-side reuse without making durable session replay depend on provider-side storage.

If compaction rebuilds the working set inside a run, Goat must drop the current continuation handle and resume from the rebuilt checkpoint instead of trying to keep the old `previous_response_id` chain alive.

### Retry semantics

Within one run, Goat should track the last successful continuation handle.

Rules:

- only a completed provider turn advances the continuation handle
- retryable request failures must retry from the last successful `previous_response_id`
- failed requests must not advance the chain
- tool execution begins only after a completed provider turn payload is available

### Architectural implication

`src/provider` should expose a per-run continuation handle.

For V1 OpenAI HTTP, that continuation handle is `previous_response_id`.

Future providers may implement a different continuation handle or none at all, but the rest of Goat should still think in terms of:

- start run
- continue run
- finalize run

## Module Boundaries

The codebase should favor a small number of direct modules with explicit ownership.

### `src/cli`

- parse argv
- validate command shapes
- render usage
- keep the public command contract centralized

### `src/app`

- top-level command dispatch
- orchestration of sessions, prompt assembly, and provider execution
- stdout/stderr routing
- exit-code mapping

### `src/config`

- discover repo and home roots
- load config files
- normalize paths
- validate strict schemas

### `src/defs`

- load models
- load agents
- load roles
- load prompts
- reserve the loading surface for skills

### `src/session`

- create, resolve, list, show, stop, and fork sessions
- manage optimistic revision checks
- manage execution lock for mutating runs
- read and append JSONL files
- atomically rewrite replay state during compaction

### `src/prompt`

- assemble the provider prompt stack
- combine agent prompt, optional role overlay, optional compaction summary, retained raw replay, one-turn prompt text, user message, and stdin
- conservatively estimate the next provider request size for pre-send compaction only; see [Token usage and pre-send estimation](#token-usage-and-pre-send-estimation)

### `src/provider`

- define provider interface
- define transport interface
- implement OpenAI Responses HTTP adapter
- normalize usage and response records
- isolate provider-specific request and response handling

The provider boundary should own within-run continuation state such as `previous_response_id`, while `src/session` owns cross-run durability.

V1 has only one provider implementation and one transport implementation, but both boundaries should still be real.

### `src/agent`

- provider/tool loop
- tool-call execution sequencing
- streaming callbacks
- loop termination rules
- plan-mode substitution

### `src/harness`

- tool registry
- argument normalization
- shared limits and guardrails
- subprocess execution and cleanup for `bash`
- output envelope normalization

### `src/tools`

- individual tool definitions and handlers
- tool metadata exposed to the provider
- separation between implemented tools and V1 stubs

### `src/artifacts`

- inline vs file-backed payload decisions
- transcript previews
- artifact path management
- compaction snapshot artifacts

### `src/types`

- shared runtime types
- transcript records
- summary records
- config-owned enums and normalized payload shapes

## Configuration Roots

Goat should resolve configuration from exactly two roots:

1. repo root
2. `~/.goat/`

Resolution order should be home root first, then repo root, with repo values overriding home values.

`--cwd` affects tool execution and sticky session cwd only. It must not affect definition discovery.

## Repository Layout

Planned top-level layout:

```text
goat.toml      Global config
models.toml    Model catalog
package.json   Bun package manifest
agents/        Agent definitions
roles/         Role definitions
prompts/       Prompt definitions and prompt text
skills/        Reserved root for future skill assets
docs/          Architecture and CLI docs
src/           Runtime implementation
tests/         Contract and integration coverage
```

## On-Disk Session Model

Sessions should live under a configurable `sessions_dir`, defaulting to `~/.goat/sessions`.

Session ids and run ids are canonical lowercase ULIDs.

Proposed layout:

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

`docs/persistence.md` is the canonical source for record shapes and field names.

### `meta.json`

Contains sticky session metadata such as:

- `session_id`
- `created_at`
- `updated_at`
- `stopped_at`
- `revision`
- `last_run_usage`
- `agent_name`
- `model`
- `effort`
- `role_name`
- `cwd`

### `messages.jsonl`

Compact replay log for future turns.

It should usually contain:

- retained raw user messages
- retained terminal assistant messages without tool calls

It should not be a full audit trail.

### `compaction.json`

Stores the current structured session summary produced by Goat's custom compaction pass.

If present, prompt assembly should render it into structured checkpoint context before the retained raw replay tail.

### Run Artifacts

Each run should persist detailed records separately:

- `transcript.jsonl`
  - full in-run sequence
  - assistant tool calls
  - tool outputs
  - progress events
  - final assistant message
- `provider.jsonl`
  - raw or normalized provider-side metadata
  - usage summaries
  - request/response diagnostics that should not pollute replay history
- `summary.json`
  - terminal run summary
  - run kind such as `prompt` or `compaction`
  - final text
  - termination reason
  - provider and transport identity
  - usage metadata
  - artifact references
- `artifacts/`
  - oversized tool outputs
  - fetched content
  - large assistant payload spillover when needed

The session root holds the coordination locks:

- `session.lock`
  - session metadata and history coordination
- `execution.lock`
  - serialization of mutating same-session runs when needed

## Session Semantics

### Binding Rules

- sessions start unbound
- the first committed prompt run binds the session to an agent
- later runs reuse stored `role`, `model`, `effort`, and `cwd` unless explicitly overridden
- `--no-role` clears a stored role on commit
- `--plan` is per-run only and must never persist in session metadata

### Forking

Forking should snapshot replayable session history into a new active session with:

- copied `meta.json` state
- copied `compaction.json` state when present
- copied `messages.jsonl`
- empty `runs/`

### Last Session

`goat sessions last` and `goat last` should resolve to the most recently updated active session with committed history.

### Stop Semantics

Stopped sessions:

- cannot accept new runs
- remain inspectable
- do not delete history

## Concurrency Model

Goat should allow concurrent work across different sessions without long-lived global locks.

For a prompt run:

1. read `meta.json`
2. remember `revision`
3. execute provider and tools without holding `session.lock`
4. acquire `session.lock` before replay append and metadata rewrite
5. fail with a session conflict if `revision` changed

Mutating runs add an execution lock:

1. acquire `execution.lock` before the first mutating tool
2. re-check revision under the execution lock
3. keep the lock through commit
4. fail fast on same-session mutation conflicts

When a run ends in `session_conflict`, Goat should preserve the run directory and steer recovery toward inspection or forking rather than silent retry.

## Prompt Assembly

Prompt assembly order should be:

1. agent system prompt
2. role overlay appended after the agent prompt, if present
3. rendered session compaction summary as structured checkpoint context, if present
4. retained raw replay history from `messages.jsonl`
5. current user message, prefixed by named prompt text if present
6. stdin as a second user message, if present

V1 should keep prompt replay simple and explicit:

- no hidden retrieval
- no skill injection yet
- pre-send compaction uses a **conservative** estimate of the fully assembled next request (see [Token usage and pre-send estimation](#token-usage-and-pre-send-estimation)); reported usage from the API is the source of truth after each successful response
- if that pre-send estimate would exceed the effective budget derived from `compact_at_tokens`, Goat compacts lower-priority raw context first instead of sending an oversized request
- durable cross-run history is compacted before the current live loop
- `raw_history_budget_pct` caps how much durable raw history may remain after compaction, and may yield less when the live loop itself is large
- compaction output should be structured and evolvable over time, with preferred sections such as current objective, last user request, plan state, constraints, decisions, important paths, completed work, edits made, open loops, next best action, and user preferences

### Token usage and pre-send estimation

Goat splits token handling into two roles:

1. **Actuals (after each successful provider response).** Persist **provider-reported** input and output token usage (and related fields the API exposes) as the source of truth for `last_run_usage`, run summaries, and diagnostics. Do not replace these with client-side estimates.

2. **Pre-send (before each provider request).** Compute a **conservative** estimate of the would-be request from the **fully assembled** working set (instructions, tools, input messages, continuation fields, and anything else included in the HTTP body). Use this **only** for compaction and gating: it is intentionally pessimistic so the real request usually stays under budget even when the client cannot match the server tokenizer exactly.

Rules:

- **Do not** use the previous response’s usage alone to predict the next request size. The next payload generally **grows** or changes (new user content, tool outputs, replay edits).
- Compare the pre-send estimate to an **effective** budget derived from `compact_at_tokens` (for example threshold minus a fixed margin) so small estimator drift does not cause oversized requests.
- If a request fails or returns no usage, compaction and limits still rely on pre-send estimation and whatever actuals were stored from earlier turns in the run.

### Custom Compaction

Goat's V1 compaction model is runtime-owned and safe-point based:

1. before any provider request, conservatively estimate the would-be input using the current working set and compare to the effective `compact_at_tokens` budget
2. if the estimate is within that budget, continue normally
3. if the estimate exceeds that budget, emit a stderr notice that compaction is starting and compact at the current safe point
4. compact durable cross-run history first by calling the configured compaction model with the current `compaction.json` summary plus the older raw durable history that no longer fits
5. after that pass, retain only as much durable raw history as fits within `raw_history_budget_pct` of the rebuilt request, and possibly less when the current live loop is already large
6. when this happens before the first provider request of a run, persist the new summary and rewritten durable replay immediately through a compaction maintenance run
7. when this happens mid-run because older history is crowding the context, preserve the current objective, current-turn raw input, and the immediate unresolved tool loop raw; update the run working set first and persist the resulting durable summary only if the prompt run later commits successfully
8. if shrinking durable history still is not enough, enter crisis mode by checkpoint-compacting the older portion of the current run while preserving system plus role, current objective or plan, durable session summary, current-turn raw user input, the freshest unresolved tool-loop state, and a structured summary of completed work, findings, edits, and pending next steps
9. any compaction that materially changes the working set must drop `previous_response_id` and continue from the rebuilt checkpoint
10. safe compaction points are: before a provider request, after a provider response is fully received, after tool execution completes, and before tool outputs are sent back

Compaction is not provider-managed context compression. Goat owns both the durable session summary on disk and the rebuilt checkpoint context used when a running loop must continue after compaction.

## Provider Model

V1 uses:

- OpenAI Responses API
- HTTP transport only
- streamed responses

Provider concerns to isolate:

- provider adapter boundary
- transport adapter boundary
- request construction
- tool schema export
- streaming event handling
- usage normalization
- within-run continuation via `previous_response_id`
- retry policy
- failure sanitization

For V1 OpenAI HTTP, the request body should be intentionally lean:

- `model`
- `instructions`
- `input`
- `tools`
- optional `reasoning`
- optional `previous_response_id`
- optional prompt-cache fields when enabled by the runtime
- `stream: true`

Within one provider turn, Goat may receive multiple function calls in one model response. Goat should execute those calls sequentially in listed order and return all resulting `function_call_output` items together on the next continuation request.

V1 should not implement:

- websocket transport
- alternate auth modes
- provider fan-out

Future versions may add additional providers or transports, but V1 should persist enough normalized metadata that those additions do not require rethinking the on-disk model.

## Interrupt Semantics

Interrupt behavior must be explicit because Goat promises durable run artifacts.

### First signal

On the first `SIGINT` or `SIGTERM`, Goat should begin graceful interruption:

1. mark the run as shutting down
2. abort the active provider request
3. signal running child processes spawned by `bash` with `SIGTERM`
4. wait a short grace period
5. send `SIGKILL` to any remaining child processes
6. flush transcript and provider records
7. best-effort write a terminal `summary.json` with:
   - `status: "interrupted"`
   - `termination_reason: "signal"`
   - the received signal identity
8. avoid appending replay history into `messages.jsonl`
9. exit with the interrupt exit code

### Second signal

If a second signal arrives while Goat is already shutting down:

- perform best-effort child termination immediately
- exit as fast as possible

### Commit guard

If Goat has already entered a tiny atomic commit section, it should finish that section rather than allow an interrupt to leave replay history half-written.

## Tool Harness

The harness should expose a consistent output envelope for all tools:

```json
{ "ok": true, "summary": "...", "data": { ... } }
```

or:

```json
{ "ok": false, "summary": "...", "error": { "code": "...", "message": "...", "retryable": false } }
```

Core harness responsibilities:

- validate args against strict schemas
- normalize provider tool schemas
- enforce path and output limits
- centralize logging
- manage `bash` subprocess execution and cleanup
- keep tool contracts deterministic

### Search Tools

- `glob` and `grep` are backed by `rg`
- `goat doctor` should validate that `rg` is available
- missing `rg` should be a setup failure, not a mysterious runtime error

### Stub Tools In V1

The following seams should exist from day one:

- `web_search`
  - Exa-backed later
- `web_fetch`
  - Defuddle plus `curl` fallback later
- `subagents`
  - external `subagents` CLI wrapper later

## Plan Mode

`--plan` should convert tool executions into planned actions instead of real side effects.

In plan mode:

- read-only tools execute for real
- mutating tools must not mutate
- `bash` may execute only a strict parser-validated read-only subset for exploration
- the final assistant output should be based on simulated tool results

Plan mode is a run behavior, not a session property.

## Logging And Artifacts

V1 should favor append-only local files over databases.

Important distinction:

- replay history is compact and stable
- audit logs are richer and per-run

This keeps future resumes cheap while preserving debuggability.

## Error Handling

The runtime should prefer explicit failures over silent fallback behavior.

Important error classes:

- usage errors
- config errors
- provider errors
- tool validation errors
- tool execution errors
- session conflicts
- interrupted runs
- timeout failures

Exit codes should be stable and documented.

## Testing Strategy

V1 should emphasize contract coverage over elaborate fixtures.

Priority coverage:

- CLI parsing
- session resolution rules
- session conflict behavior
- prompt assembly rules
- stdout/stderr contract
- tool schema validation
- `rg`-backed `glob` and `grep`
- `bash` subprocess lifecycle and signal handling
- artifact spillover thresholds
- provider loop behavior with mocked HTTP responses

## V1 To VNext Growth Path

The expected growth path is:

1. solid local CLI core
2. real web tooling
3. real subagents
4. refined compaction strategies
5. richer machine-facing event surfaces
6. higher-level products on top of the CLI contract

The architecture should optimize for that path by keeping V1 small and the seams clean.
