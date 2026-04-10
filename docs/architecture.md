# Architecture

## Overview

Goat is a session-first, non-interactive agent harness CLI. It is the durable core that other interfaces attach to: shell scripts, local UIs, editors, remote supervisors, future daemonized or interactive shells.

V1 is intentionally narrow:

- One process, one CLI entrypoint
- One session store (local filesystem)
- One provider (OpenAI Responses API over HTTP)
- One tool harness
- One strict stdout/stderr contract

The goal is a boring, reliable core with strong boundaries and durable on-disk state.

## Design goals

- **Durable** -- runs and sessions remain inspectable after crashes, interrupts, and upgrades.
- **Maintainable** -- module boundaries are simple and explicit.
- **Modular** -- providers, tools, and higher-level products layer on top of stable interfaces.
- **Scriptable** -- stdout is machine-safe for the final reply; stderr carries progress and diagnostics.
- **Auditable** -- every run leaves behind enough artifacts to explain what happened.
- **Extensible** -- future features (skills, web tooling, subagents) fit without warping the core model.

## Implementation

Goat is implemented in TypeScript running on [Bun](https://bun.sh). Bun serves as the runtime, package manager, and developer toolchain. The code prefers Node-compatible filesystem and child-process APIs and does not depend on Bun-only semantics unless there is a clear payoff.

## Runtime flow

For a prompt run:

1. Parse CLI arguments
2. Resolve configuration roots (repo + home)
3. Load global config, model catalog, and definitions
4. Create or resolve the target session
5. Resolve agent, role, one-turn prompt, and working directory
6. Validate the effective working directory
7. Read stdin if present, enforcing size and UTF-8 rules
8. Assemble the provider input from system layers and replayable session history
9. If a conservative pre-send estimate exceeds `compact_at_tokens`, compact first
10. Create the run directory
11. Execute the assistant/tool loop, compacting at safe points when needed
12. Persist run transcript, provider metadata, and summary
13. Project replayable records back into session history
14. Print the final assistant text to stdout

Non-run commands (version, doctor, sessions, runs, agents, roles, prompts) stop earlier and never enter the provider loop.

## Responses API ownership

Goat uses a hybrid ownership model for the OpenAI Responses API.

**Across runs**: fully stateful on the local filesystem. Each new run rebuilds its provider input from agent prompt, role overlay, compaction summary, replay history, and the current user message. No dependency on provider-side stored conversation state.

**Within a run**: uses `previous_response_id` to continue the Responses API loop across tool turns. This gives cheaper tool-turn requests, warmer server-side reasoning state, and better cache locality.

If compaction rebuilds the working set mid-run, the continuation handle is dropped and the loop resumes from the rebuilt checkpoint.

## Module boundaries

| Module | Responsibility |
|--------|---------------|
| `src/cli.ts` | Argument parsing, command shape validation |
| `src/app.ts` | Command dispatch, session/prompt orchestration, stdout/stderr routing |
| `src/config.ts` | Root discovery, config loading, schema validation |
| `src/defs.ts` | Model/agent/role/prompt definition loading |
| `src/session.ts` | Session lifecycle: create, resolve, list, show, stop, fork, locking |
| `src/prompt.ts` | Prompt stack assembly, pre-send token estimation |
| `src/provider.ts` | Provider adapter, transport, request/response handling, usage normalization |
| `src/agent.ts` | Provider/tool loop, tool-call sequencing, streaming, plan-mode |
| `src/harness.ts` | Tool registry, argument validation, limits, output envelope normalization |
| `src/tools-*.ts` | Individual tool implementations |
| `src/artifacts.ts` | Inline vs file-backed payloads, artifact path management |
| `src/compaction.ts` | Conversation history compaction |
| `src/run.ts` | Run command execution orchestration |
| `src/run-prepare.ts` | Pre-run setup and validation |
| `src/run-persist.ts` | Session state persistence after runs |
| `src/types.ts` | Shared runtime types, transcript/summary records |

## Stdout/stderr contract

**Stdout** contains only:
- The final assistant reply (for prompt runs)
- Created/resolved session IDs (for session commands)
- Explicit list/show command output

**Stderr** contains everything else:
- Streaming deltas, verbose logs, tool progress
- Debug information, session creation notices
- Validation failures, provider and tool errors

This split is a hard contract.

## Concurrency model

Goat allows concurrent work across different sessions without global locks.

For a prompt run:

1. Read `meta.json` and remember `revision`
2. Execute provider and tools without holding `session.lock`
3. Before the first mutating tool, acquire `execution.lock`
4. At commit time, acquire `session.lock` and validate revision
5. Fail with `session_conflict` if revision changed

Failed runs remain inspectable. Recovery paths: inspect with `goat runs show`, rerun, or fork with `goat sessions fork`.

## Session semantics

- Sessions start unbound
- The first committed run binds the session to an agent
- Later runs reuse sticky settings unless explicitly overridden
- `--plan` is per-run only, never persisted
- Forking snapshots replay history into a new session with empty runs
- Stopped sessions cannot accept new runs but remain inspectable

## Compaction

Goat owns context management through runtime-controlled compaction:

1. Before each provider request, estimate the next request size
2. If it exceeds the effective `compact_at_tokens` budget, compact at the current safe point
3. Compact durable cross-run history first
4. Retain only as much raw history as fits within `raw_history_budget_pct`
5. If that is still not enough, enter crisis mode to checkpoint-compact the current run

Safe compaction points: before a provider request, after a response, after tool execution, before tool outputs are sent back.

Compaction that changes the working set drops `previous_response_id` and continues from the rebuilt checkpoint.

## Token estimation

Token handling splits into two roles:

- **Actuals** (after each response): provider-reported usage is the source of truth for summaries and diagnostics.
- **Pre-send** (before each request): a conservative client-side estimate of the full request payload, used only for compaction gating. Intentionally pessimistic.

## Growth path

1. Solid local CLI core (V1)
2. Real web tooling (web_search, web_fetch)
3. Real subagents
4. Refined compaction strategies
5. Richer machine-facing event surfaces
6. Higher-level products on top of the CLI contract
