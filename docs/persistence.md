# Persistence

## Overview

Goat persists durable state to the local filesystem. The model separates:

- **Replay history** -- compact records for future prompts
- **Audit history** -- full per-run transcripts and provider metadata
- **Terminal summaries** -- canonical per-run digests

## On-disk layout

```
<sessions_dir>/                         Default: ~/.goat/sessions/
  <session-id>/                         Lowercase ULID
    meta.json                           Sticky session state
    compaction.json                     Structured session summary
    messages.jsonl                      Compact replay history
    session.lock                        Metadata coordination lock
    execution.lock                      Mutating run serialization lock
    runs/
      <run-id>/                         Lowercase ULID
        transcript.jsonl                Full run event stream
        provider.jsonl                  Provider metadata
        summary.json                    Terminal run digest
        artifacts/                      Lazy-created artifact store
```

## Core rules

- Session IDs and run IDs are lowercase ULIDs
- JSON files are versioned with `v`
- JSONL files are append-only event streams
- Session replay history may be atomically rewritten during compaction
- JSON files use atomic write-then-rename
- JSONL records append only complete lines
- Durable commit boundaries fsync before reporting success

## meta.json

Stores sticky session state and coarse summary metadata.

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

| Field | Description |
|-------|-------------|
| `v` | Schema version |
| `session_id` | Canonical lowercase ULID |
| `created_at` | Creation timestamp (RFC 3339 UTC) |
| `updated_at` | Last successful commit or stop timestamp |
| `stopped_at` | Stop timestamp, or `null` while active |
| `bound` | Whether the session has committed enough state to bind to an agent |
| `revision` | Optimistic-concurrency revision; increments on `messages.jsonl` changes |
| `last_run_usage` | Token usage from the most recent committed run |
| `message_count` | Cached count from `messages.jsonl` |
| `agent_name`, `role_name`, `model`, `effort`, `cwd` | Sticky session settings (nullable when `bound = false`) |

## compaction.json

Stores the current structured session summary produced by compaction.

```json
{
  "v": 1,
  "updated_at": "2026-04-09T08:09:30Z",
  "source_revision": 12,
  "compaction_count": 2,
  "raw_history_budget_pct": 0.2,
  "retained_raw_token_estimate": 23140,
  "summary": {
    "current_objective": "...",
    "last_user_request": "...",
    "user_preferences": ["..."],
    "constraints": ["..."],
    "decisions": ["..."],
    "important_paths": ["..."],
    "completed_work": ["..."],
    "open_loops": ["..."],
    "next_best_action": "..."
  }
}
```

The `summary` fields are guidance, not a frozen schema. Goat tolerates additive growth. When no compaction has happened, `compaction.json` may be absent.

## messages.jsonl

Retained raw durable replay history. Contains only user messages and final assistant messages that survived the latest compaction or commit.

Does **not** contain: intermediate tool-call turns, tool outputs, provider diagnostics, or failed run history.

### Record shape

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

| Field | Description |
|-------|-------------|
| `kind` | Fixed to `message` in V1 |
| `role` | `user` or `assistant` |
| `source` | `cli_arg`, `stdin`, or `assistant_final` |
| `run_id` | Links back to the run directory |
| `prompt_name` | Optional one-turn prompt name |

## Run directory

Each run gets its own directory under `runs/<run-id>/`. Run directories are created before provider execution begins, so partial and failed runs have a durable home.

### transcript.jsonl

The human- and machine-readable story of the run. Record kinds:

| Kind | Description |
|------|-------------|
| `run_started` | Run metadata (session, agent, model, plan mode, cwd) |
| `message` | Assistant messages (may include `tool_calls`) |
| `compaction_checkpoint` | Mid-run compaction events |
| `tool_call` | Tool invocation details |
| `tool_result` | Tool output with duration, ok/error status, preview/artifact |
| `run_finished` | Terminal status and termination reason |

### provider.jsonl

Normalized provider-side metadata. Record kinds:

| Kind | Description |
|------|-------------|
| `provider_turn` | Successful turn: response_id, previous_response_id, usage, tool call count |
| `provider_error` | Failed request: error code, message, retryable flag |

Every record includes provider and transport identity. The `previous_response_id` chain is recorded for continuation debugging.

### summary.json

Canonical per-run digest. The first file to read for a quick answer about any run.

```json
{
  "v": 1,
  "session_id": "...",
  "run_id": "...",
  "run_kind": "prompt",
  "status": "completed",
  "started_at": "...",
  "finished_at": "...",
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
  "usage": { "input_tokens": 1400, "output_tokens": 220, "reasoning_tokens": 0, "cached_input_tokens": 0 },
  "artifacts": { "count": 1, "total_bytes": 6842 },
  "final_output": { "text": "...", "chars": 312, "artifact": null },
  "error": null
}
```

**Status values**: `completed`, `failed`, `interrupted`, `timed_out`, `session_conflict`

**Run kinds**: `prompt`, `compaction`

### Artifact references

Normalized shape for any record pointing at an artifact:

```json
{
  "path": "artifacts/tool-001.json",
  "bytes": 6842,
  "sha256": "abc123...",
  "content_type": "application/json"
}
```

Paths are relative to the run directory.

## Lock semantics

**`session.lock`** coordinates updates to `meta.json`, `compaction.json`, `messages.jsonl`, and stop-state changes.

**`execution.lock`** serializes mutating same-session runs. Session-scoped, not run-scoped.

## Revision and commit

1. Create run directory, write `run_started`
2. Execute provider and tools without holding `session.lock`
3. Before the first mutating tool, acquire `execution.lock` and revalidate revision
4. On terminal completion, acquire `session.lock` and revalidate revision
5. Append replay records, rewrite metadata, increment revision
6. On revision conflict: keep run directory, write `status = "session_conflict"`, do not modify `messages.jsonl`

## Failure semantics

| Failure | Transcript | Summary | Replay history |
|---------|------------|---------|----------------|
| Provider failure | Records the attempt | `failed` | Not updated |
| Tool failure | Records the call | `failed` (unless agent recovers) | Not updated |
| Compaction failure | Recorded | -- | Unchanged |
| Interrupt/timeout | Best-effort flush | `interrupted` / `timed_out` | Not updated |
| Crash | Partial JSONL may have trailing junk | May be absent | Unchanged |

Loaders skip malformed trailing JSONL lines with a warning. A run directory without `summary.json` indicates an abandoned run.

## Retention

V1 does not delete session or run history automatically.
