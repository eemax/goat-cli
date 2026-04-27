# Goat Persistence Model

> Historical note: this planning document predates the simplified manual compaction model. Current persistence is documented in `docs/persistence.md`: there is no active `compaction.json`; manual compaction rewrites `messages.jsonl` to the compaction prompt plus the assistant's normalized JSON checkpoint.

## Overview

Goat persists durable state to the local filesystem.

The persistence model intentionally separates:

- replay history for future prompts
- full per-run audit history
- compact terminal summaries

This takes the strongest ideas from `headless-agent` and improves them by making the run summary first-class and by documenting explicit record shapes early.

## Core Rules

- session ids are lowercase ULIDs
- run ids are lowercase ULIDs
- JSON files are versioned with `v`
- per-run JSONL files are append-only event streams
- session replay history may be atomically rewritten during durable compaction
- replay history must stay compact
- full run details belong in the run directory

## On-Disk Layout

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

`artifacts/` is created lazily when needed.

## What Goat Intentionally Changes

Compared with the reference repos, Goat intentionally makes these persistence choices:

- `summary.json` is the canonical per-run digest
- replay history and audit history are documented as different things, not accidental byproducts
- compaction state is first-class and persisted explicitly
- ids are normalized to lowercase ULIDs everywhere
- provider metadata is normalized enough to survive future provider additions

## Session Root Files

### `meta.json`

`meta.json` stores sticky session state and coarse summary metadata.

Suggested shape:

```json
{
  "v": 1,
  "session_id": "01jxyzabc123def456ghi789jk",
  "created_at": "2026-04-09T08:00:00Z",
  "updated_at": "2026-04-09T08:12:34Z",
  "stopped_at": null,
  "bound": true,
  "revision": 3,
  "last_run_usage": {
    "input_tokens": 18234,
    "output_tokens": 912,
    "reasoning_tokens": 0,
    "cached_input_tokens": 0
  },
  "message_count": 14,
  "agent_name": "coder",
  "role_name": "auditor",
  "model": "gpt-5.4-mini",
  "effort": "medium",
  "cwd": "/Users/max/project"
}
```

### Field semantics

`v`

- schema version for `meta.json`

`session_id`

- canonical lowercase ULID

`created_at`

- first session creation timestamp in RFC 3339 UTC form

`updated_at`

- last successful session commit or stop timestamp

`stopped_at`

- timestamp when `goat sessions stop` succeeded
- `null` while active

`bound`

- boolean indicating whether the session has committed enough state to bind to an agent
- `false` for fresh or otherwise unbound sessions

`revision`

- optimistic-concurrency revision for replay history
- increments only when `messages.jsonl` changes

`last_run_usage`

- token usage copied from the most recent successful API response summary for the committed run
- intended as recent operational metadata, not as the canonical size of replay history
- updated only after a successful committed run
- not a substitute for pre-send size checks: the next request is estimated conservatively before send (see `docs/architecture.md`, “Token usage and pre-send estimation”)

`message_count`

- cached replayable message count derived from `messages.jsonl` at successful commit time
- `messages.jsonl` remains the canonical source of replay-count truth

`agent_name`, `role_name`, `model`, `effort`, `cwd`

- sticky session settings reused by later runs
- these fields may be `null` when `bound = false`

## Session Compaction State

### `compaction.json`

`compaction.json` stores Goat's current structured session summary.

Suggested shape:

```json
{
  "v": 1,
  "updated_at": "2026-04-09T08:09:30Z",
  "source_revision": 12,
  "compaction_count": 2,
  "raw_history_budget_pct": 0.2,
  "retained_raw_token_estimate": 23140,
  "summary": {
    "current_objective": "Finalize the Goat CLI implementation spec.",
    "last_user_request": "Update the compaction spec to handle mid-run loops and percentage-based history retention.",
    "user_preferences": ["Prefer simple, minimalist designs."],
    "constraints": ["No daemon in V1."],
    "decisions": ["Plan mode allows only read-only bash commands."],
    "important_paths": ["docs/architecture.md", "docs/persistence.md"],
    "completed_work": ["Reviewed source repos and aligned compaction semantics."],
    "open_loops": ["Lock the final checkpoint artifact shape."],
    "next_best_action": "Update the architecture and persistence docs to reflect safe-point compaction."
  }
}
```

### Compaction notes

- the preferred `summary` fields above are guidance, not a permanently frozen exhaustive set
- Goat should tolerate additive growth in the summary shape over time
- prompt assembly should render `compaction.json` deterministically into structured checkpoint context before the retained raw replay tail
- `raw_history_budget_pct` is a cap on durable raw history after compaction, not a guarantee
- `compaction.json` should not duplicate replay message counts that are already derivable from `messages.jsonl`
- when no compaction has happened yet, `compaction.json` may be absent
- mid-run checkpoint compactions may leave run-local artifacts or transcript records without rewriting `compaction.json` or `messages.jsonl` until the prompt run commits successfully

## Replay History

### `messages.jsonl`

`messages.jsonl` is the retained raw durable replay history for future prompts.

It is not a full audit log.

It should contain only:

- raw user messages that Goat retained after the latest successful compaction or prompt-run commit
- raw final assistant messages that Goat retained after the latest successful compaction or prompt-run commit

It should not contain:

- intermediate assistant tool-call turns
- tool outputs
- provider diagnostics
- failed or conflicted run history
- the structured compaction summary itself

### Record shape

Suggested record shape:

```json
{
  "v": 1,
  "ts": "2026-04-09T08:10:00Z",
  "kind": "message",
  "run_id": "01jxyzrun123def456ghi789jk",
  "role": "user",
  "source": "cli_arg",
  "prompt_name": "repo-summary",
  "content": "Summarize this repository."
}
```

```json
{
  "v": 1,
  "ts": "2026-04-09T08:10:12Z",
  "kind": "message",
  "run_id": "01jxyzrun123def456ghi789jk",
  "role": "assistant",
  "source": "assistant_final",
  "content": "This repository contains..."
}
```

### Field notes

`kind`

- fixed to `message` in V1

`run_id`

- links the replay record back to the run directory that produced it

`source`

- intended values in V1:
  - `cli_arg`
  - `stdin`
  - `assistant_final`

`prompt_name`

- optional name of the one-turn prompt used for the run

## Run Audit History

Each run gets its own directory under `runs/<run-id>/`.

Run directories should be created before provider execution begins so that partial and failed runs still have a durable home.

Explicit compaction maintenance passes should also create real run directories. They are internal maintenance runs, but they are still durable facts.

Mid-run checkpoint compactions should be recorded inside the active prompt run as transcript events or artifacts rather than as separate session commits.

## `transcript.jsonl`

`transcript.jsonl` is the human- and machine-readable story of the run.

It should capture the ordered sequence of durable run events without dumping raw provider wire payloads.

### Recommended record kinds

- `run_started`
- `message`
- `compaction_checkpoint`
- `tool_call`
- `tool_result`
- `run_finished`

### Example records

```json
{
  "v": 1,
  "ts": "2026-04-09T08:10:00Z",
  "kind": "run_started",
  "run_id": "01jxyzrun123def456ghi789jk",
  "session_id": "01jxyzabc123def456ghi789jk",
  "run_kind": "prompt",
  "agent_name": "coder",
  "role_name": "auditor",
  "model": "gpt-5.4-mini",
  "effort": "medium",
  "plan_mode": false,
  "cwd": "/Users/max/project"
}
```

```json
{
  "v": 1,
  "ts": "2026-04-09T08:10:01Z",
  "kind": "message",
  "run_id": "01jxyzrun123def456ghi789jk",
  "role": "assistant",
  "phase": "tool_request",
  "content": "I will inspect the repository structure first.",
  "tool_calls": [
    {
      "id": "call_123",
      "name": "glob",
      "arguments": {
        "pattern": "**/*.ts",
        "path": "."
      }
    }
  ]
}
```

```json
{
  "v": 1,
  "ts": "2026-04-09T08:10:02Z",
  "kind": "tool_result",
  "run_id": "01jxyzrun123def456ghi789jk",
  "tool_call_id": "call_123",
  "tool_name": "glob",
  "duration_s": 0.019,
  "planned": false,
  "ok": true,
  "summary": "Found 12 matching files.",
  "preview": "src/app.ts\nsrc/cli.ts\n...",
  "artifact": null
}
```

```json
{
  "v": 1,
  "ts": "2026-04-09T08:10:12Z",
  "kind": "run_finished",
  "run_id": "01jxyzrun123def456ghi789jk",
  "status": "completed",
  "termination_reason": "assistant_final"
}
```

### Transcript guidance

- `message` records may include large content inline when safe
- oversized content should move into `artifacts/` with a preview
- `tool_result` should store the normalized tool envelope or an artifact reference to it
- `tool_result` should include `duration_s` as a decimal number of wall-clock seconds
- progress chatter that matters for debugging may be persisted, but assistant text deltas do not need to be

## `provider.jsonl`

`provider.jsonl` stores normalized provider-side metadata.

It should be detailed enough to debug the provider loop, but stable enough to survive future provider additions.

Within one Goat run, `provider.jsonl` should capture the `previous_response_id` chain so the continuation model is inspectable.

### Recommended record kinds

- `provider_turn`
- `provider_error`

### Example success record

```json
{
  "v": 1,
  "ts": "2026-04-09T08:10:02Z",
  "kind": "provider_turn",
  "run_id": "01jxyzrun123def456ghi789jk",
  "provider": "openai_responses",
  "transport": "http",
  "request_index": 1,
  "response_id": "resp_abc123",
  "previous_response_id": null,
  "model": "gpt-5.4-mini",
  "status": "completed",
  "tool_call_count": 1,
  "output_text_chars": 53,
  "usage": {
    "input_tokens": 1400,
    "output_tokens": 220,
    "reasoning_tokens": 0,
    "cached_input_tokens": 0
  }
}
```

### Example failure record

```json
{
  "v": 1,
  "ts": "2026-04-09T08:10:05Z",
  "kind": "provider_error",
  "run_id": "01jxyzrun123def456ghi789jk",
  "provider": "openai_responses",
  "transport": "http",
  "request_index": 2,
  "error_code": "rate_limit",
  "message": "OpenAI returned HTTP 429.",
  "retryable": true
}
```

### Provider normalization rules

- include provider and transport identity on every record
- keep token accounting normalized into stable field names
- record `previous_response_id` and resulting `response_id` for within-run continuation
- sanitize secrets from request and error metadata
- avoid storing giant opaque raw payloads inline in V1

### Retry and continuation rules

- only a completed provider turn advances the continuation chain
- retryable request failures must retry from the last successful `previous_response_id`
- failed requests do not advance the chain
- tool execution begins only after a completed provider turn payload is available

## `summary.json`

`summary.json` is the canonical per-run digest.

This is the file that future tools and UIs should read first when they want a quick answer to:

- what happened
- how long it took
- what settings were used
- how many tokens were spent
- where the large outputs live

### Shape

Suggested shape:

```json
{
  "v": 1,
  "session_id": "01jxyzabc123def456ghi789jk",
  "run_id": "01jxyzrun123def456ghi789jk",
  "run_kind": "prompt",
  "status": "completed",
  "started_at": "2026-04-09T08:10:00Z",
  "finished_at": "2026-04-09T08:10:12Z",
  "duration_s": 12.034,
  "plan_mode": false,
  "agent_name": "coder",
  "role_name": "auditor",
  "prompt_name": "repo-summary",
  "model": "gpt-5.4-mini",
  "effort": "medium",
  "provider": "openai_responses",
  "transport": "http",
  "cwd": "/Users/max/project",
  "termination_reason": "assistant_final",
  "usage": {
    "input_tokens": 1400,
    "output_tokens": 220,
    "reasoning_tokens": 0,
    "cached_input_tokens": 0
  },
  "artifacts": {
    "count": 1,
    "total_bytes": 6842
  },
  "final_output": {
    "text": "This repository contains...",
    "chars": 312,
    "artifact": null
  },
  "error": null
}
```

### Status values

Recommended V1 terminal statuses:

- `completed`
- `failed`
- `interrupted`
- `timed_out`
- `session_conflict`

### Run kinds

Recommended V1 run kinds:

- `prompt`
- `compaction`

### Final output rules

- keep final text inline when reasonably sized
- spill oversized final text to `artifacts/` and use `final_output.artifact`
- always include `chars`

## Artifact References

Any record that points at an artifact should use a normalized shape:

```json
{
  "path": "artifacts/tool-001.json",
  "bytes": 6842,
  "sha256": "abc123...",
  "content_type": "application/json"
}
```

Paths should be relative to the run directory.

## Lock Semantics

### `session.lock`

Coordinates updates to:

- `meta.json`
- `compaction.json`
- `messages.jsonl`
- stop-state changes

### `execution.lock`

Coordinates mutating same-session runs.

It is session-scoped, not run-scoped.

## Revision And Commit Rules

`revision` exists to protect session replay state, not the entire `runs/` tree.

Recommended V1 rules:

1. create run directory
2. write `run_started` transcript record
3. execute provider and tools without holding `session.lock`
4. before the first mutating tool, acquire `execution.lock` and revalidate revision
5. on successful terminal completion, acquire `session.lock` and revalidate revision again
6. update replay state:
   - prompt runs append replayable records to `messages.jsonl`
   - prompt runs that performed mid-run compaction may also rewrite `compaction.json` and compact the historical portion of `messages.jsonl` during the same final commit
   - compaction maintenance runs atomically rewrite `compaction.json` and `messages.jsonl`
7. rewrite `meta.json`
8. increment `revision`

While one run holds `execution.lock`, any other same-session run that reaches commit should fail fast with `session_conflict` rather than waiting and committing ahead of the mutating run.

If the revision changed before commit, the run should:

- keep its run directory
- write `status = "session_conflict"` to `summary.json`
- avoid modifying `messages.jsonl`

Recommended recovery path:

- inspect the failed run with `goat runs show --session <id|last> <run-id>`
- rerun against the latest session state
- use `goat sessions fork <id|last>` if you want to isolate from further conflicts

## Failure Semantics

### Provider failure

- `transcript.jsonl` and `provider.jsonl` should still show the attempt
- `summary.json` should end in `failed`
- `messages.jsonl` should not be updated

### Tool failure

- failing tool call and its envelope should remain in `transcript.jsonl`
- `summary.json` should end in `failed` unless the assistant recovers and completes normally

### Compaction failure

- an explicit compaction maintenance run should still leave behind `transcript.jsonl`, `provider.jsonl`, and `summary.json`
- a failed mid-run checkpoint compaction may leave run-local artifacts in the active prompt run
- `compaction.json` and `messages.jsonl` must remain unchanged on failure
- the pending continuation should not proceed after a failed compaction step

### Interrupt or timeout

- first `SIGINT` or `SIGTERM` should begin graceful interruption
- abort the active provider request
- signal running child processes spawned by `bash` with `SIGTERM`, then `SIGKILL` after a short grace period if needed
- flush transcript and provider records if possible
- write terminal `summary.json` with `status = "interrupted"` and `termination_reason = "signal"` when possible
- do not append replay history
- use a distinct non-zero interrupt exit code

### Crash during run

Goat should try hard to avoid partial JSON writes:

- JSON files should use atomic write-then-rename
- JSONL records should append only complete lines
- terminal JSON writes that define durable completion should fsync the file and containing directory before being treated as durable
- session commit boundaries should fsync replay history and metadata before reporting success
- fsync is required at durable commit boundaries, not on every streaming append to `transcript.jsonl` or `provider.jsonl`

Loaders should be resilient to crash tails:

- malformed or partial trailing JSONL lines should be skipped with a warning rather than failing the entire session load
- the presence of a run directory without a terminal `summary.json` is evidence of an abandoned run

If Goat receives a second signal while already shutting down, it may exit immediately after best-effort child termination, even if terminal summary write is incomplete.

## What Is Not Persisted In V1

V1 intentionally does not persist:

- provider-side cached conversation state outside run files
- live assistant text delta logs as a separate persistent channel
- skill execution state

## Retention

V1 should not delete session or run history automatically.

If retention is added later, it should apply only to:

- run-local artifacts
- optional diagnostic payloads
- explicitly configured archival policies

Replay history and run summaries should remain durable by default.
