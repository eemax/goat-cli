# Goat First-Pass Follow-Ups

This file captures the detailed work that did not fully land in the first implementation pass.

## Current Compaction Direction

- Compaction is intentionally manual.
- `goat compact session <id|last>` and `--compact` run a provider-backed turn inside the target session using the built-in compaction prompt.
- The assistant must return a JSON object; Goat validates it and rewrites `messages.jsonl` to the compaction prompt plus normalized JSON checkpoint.
- Goat warns near `compact_at_tokens` but does not automatically compact or block the provider request.
- If the user ignores the warning and the provider rejects the request for context size, the turn fails normally.
- Assistant text is kept off stderr; `--verbose` emits numbered progress events without duplicating the final reply.

## Highest-Value Next Steps

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
