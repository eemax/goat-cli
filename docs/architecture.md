# Architecture

## Overview

Goat is a session-first, non-interactive agent harness CLI. It is the durable core that other interfaces attach to: shell scripts, local UIs, editors, remote supervisors, future daemonized or interactive shells.

V1 is intentionally narrow:

- One process, one CLI entrypoint
- One session store (local filesystem)
- One OpenAI runtime (Responses API)
- One tool harness
- One strict stdout/stderr contract

The goal is a boring, reliable core with strong boundaries and durable on-disk state.

## Design goals

- **Durable** -- runs and sessions remain inspectable after crashes, interrupts, and upgrades.
- **Maintainable** -- module boundaries are simple and explicit.
- **Modular** -- providers, tools, and higher-level products layer on top of stable interfaces.
- **Scriptable** -- stdout is machine-safe for the final reply; stderr carries progress and diagnostics.
- **Auditable** -- every run leaves behind enough artifacts to explain what happened.
- **Extensible** -- skills, scenarios, and web tooling fit without warping the core model.

## Implementation

Goat is implemented in TypeScript running on [Bun](https://bun.sh). Bun serves as the runtime, package manager, and developer toolchain. The code prefers Node-compatible filesystem and child-process APIs and does not depend on Bun-only semantics unless there is a clear payoff.

## Runtime flow

For a prompt run:

1. Parse CLI arguments
2. Resolve the ordered global configuration root stack
3. Load global config, model catalog, and definitions
4. Create or resolve the target session
5. Resolve agent, role, one-turn prompt, skill invocations, and working directory
6. Validate the effective working directory
7. Read stdin if present, enforcing size and UTF-8 rules
8. Assemble the provider input from system layers and replayable session history
9. If the assembled estimate nears `compact_at_tokens`, emit a warning suggesting manual compaction
10. Create the run directory
11. Execute the assistant/tool loop
12. Persist run transcript, provider metadata, and summary
13. Project replayable records back into session history
14. Print the final assistant text to stdout

Scenario runs expand into sequential prompt runs in fresh sessions. Non-provider commands (version, doctor, sessions, runs, agents, roles, prompts, skills, scenarios) stop earlier and never enter the assistant/tool loop. `goat compact session` is a provider-backed maintenance run.

## Responses API ownership

Goat owns the OpenAI Responses API loop directly.

**Across runs**: fully stateful on the local filesystem. Each new run rebuilds its provider input from agent prompt, role overlay, replay history, and the current user message. No dependency on provider-side stored conversation state.

**Within a run**: Goat calls the Responses API, executes requested local tools, then sends function-call outputs back until the provider returns a final assistant message. Goat records provider turns, transcripts, usage, local tool envelopes, and session commits.

## Module boundaries

| Module | Responsibility |
|--------|---------------|
| `src/cli.ts` | Argument parsing, command shape validation |
| `src/app.ts` | Command dispatch, session/prompt orchestration, stdout/stderr routing |
| `src/config.ts` | Root discovery, config loading, schema validation |
| `src/defs.ts` | Model/agent/role/prompt/scenario definition loading |
| `src/session.ts` | Session lifecycle: create, resolve, list, show, stop, fork, locking |
| `src/prompt.ts` | Prompt stack assembly, pre-send token estimation |
| `src/provider.ts` | Responses provider adapter |
| `src/agent.ts` | Provider/tool loop |
| `src/harness.ts` | Tool registry, argument validation, limits, output envelope normalization |
| `src/tools-*.ts` | Individual tool implementations |
| `src/skills.ts` | Skill loading, listing, and one-turn invocation rendering |
| `src/scenarios.ts` | Scenario chain execution and template expansion |
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

**Stderr** contains:
- Validation failures, provider errors, and tool errors
- Numbered progress events when `--verbose` is set
- Numbered diagnostic events when `--debug` or `--debug-json` is set

Assistant text deltas and final replies are not streamed to stderr. Successful prompt runs without verbose/debug flags normally write no stderr.

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

Goat keeps compaction deliberately manual:

1. Prompt assembly estimates the request size with the conservative local token heuristic.
2. At 80% of `compact_at_tokens`, Goat writes a stderr warning recommending `goat compact session <id>`.
3. Goat still sends the request; if the provider rejects an oversized context, that turn fails normally and remains inspectable.
4. `goat compact session <id|last>` sends the full session replay plus the compaction prompt to the same agent/model.
5. The assistant must return a JSON object. Goat validates it, then rewrites `messages.jsonl` to the compaction prompt and the normalized JSON checkpoint.

`--compact` runs that same explicit compaction after session/fork resolution and before the requested prompt turn. Empty sessions are a no-op.

## Token estimation

Token handling splits into two roles:

- **Actuals** (after each response): provider-reported usage is the source of truth for summaries and diagnostics.
- **Pre-send** (before each request): a conservative client-side estimate of the full request payload, used only for warnings and diagnostics. Intentionally pessimistic.

## Growth path

1. Solid local CLI core (V1)
2. Web tooling (web_search, web_fetch)
3. Refined compaction strategies
4. Richer machine-facing event surfaces
5. Higher-level products on top of the CLI contract
