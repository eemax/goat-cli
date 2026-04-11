# Goat First-Pass Follow-Ups

This file captures the detailed work that did not fully land in the first implementation pass.

## Deliberate Deviations In The First Pass

- Compaction currently uses a deterministic local checkpoint heuristic instead of a model-generated compaction run.
- Pre-run compaction is persisted only when the prompt run commits successfully; it is not yet recorded as a separate maintenance run.
- Mid-run crisis compaction and checkpoint rebuilding of the live unresolved loop are not implemented yet.
- Assistant text streaming is surfaced only during `--verbose` runs instead of always writing progress to stderr.

## Highest-Value Next Steps

- Replace the local compaction heuristic with a real provider-backed compaction flow using the built-in prompt in [compaction-prompt.md](../../src/builtins/compaction-prompt.md).
- Persist pre-send compaction as an explicit `compaction` run with its own `transcript.jsonl`, `provider.jsonl`, and `summary.json`.
- Add mid-run safe-point compaction that can rebuild the working set, drop `previous_response_id`, and continue after a checkpoint.
- Preserve and persist richer provider metadata, including normalized retry records and sanitized error details.
- Add real fsync-backed durable commit boundaries instead of the current best-effort atomic rename approach.
- Implement graceful `SIGINT` and `SIGTERM` handling that aborts provider requests, terminates child process groups, and writes terminal interrupted summaries.
- Expand `bash` plan-mode validation to cover a more complete but still safe argument subset for `rg`, `fd`, `git`, and `tree`.
- Improve `glob` and `grep` truncation reporting with explicit head/tail previews, file counts, and artifact metadata that match the spec more closely.
- Add artifact-backed final assistant output when the final reply exceeds inline summary bounds.
- Tighten `doctor` so session-only commands do not require loading all definitions, and so the provider ping is more specifically scoped to the Responses API contract.
- Add a richer retry policy for transient provider failures that reuses the last successful `previous_response_id`.
- Add broader integration coverage for session conflicts, stopped sessions, `goat sessions fork`, `goat runs show`, and doctor failures.

## Nice-To-Have Refinements

- Emit stderr notices for session creation, fork resolution, and compaction start/finish events.
- Differentiate transcript `message.phase` more precisely for assistant commentary versus final answer text.
- Add more complete transcript artifact spillover for very large tool envelopes and large assistant responses.
- Make `goat version` and the session inspection commands load only the minimum runtime context they actually need.
