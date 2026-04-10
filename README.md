# goat

A session-first, non-interactive agent harness CLI.

Goat is a durable core for AI agent runs. It manages sessions, persists full audit trails, and executes tool-equipped agents through the OpenAI Responses API. Other interfaces -- shell scripts, local UIs, editors, remote supervisors -- can attach on top.

## Quick start

Requires [Bun](https://bun.sh) and an OpenAI API key.

```bash
# Install dependencies
bun install

# Set your API key
export OPENAI_API_KEY="sk-..."

# Run preflight checks
bun run src/main.ts doctor

# Start a new session
bun run src/main.ts new "summarize this repository"

# Continue in the same session
bun run src/main.ts last "now refactor the config loader"
```

Once installed globally (`bun link` or added to `$PATH`), replace `bun run src/main.ts` with `goat`.

## What it does

- **Durable sessions** -- every run is persisted to disk with full transcripts, provider metadata, and terminal summaries. Crashes, interrupts, and upgrades leave inspectable state behind.
- **Local tool harness** -- bash, file I/O, search (grep/glob via `rg`), and a structured patch tool. All tools return normalized JSON envelopes.
- **Session-first model** -- sessions carry sticky settings (agent, role, model, effort, cwd). Fork, stop, and resume without a background service.
- **Custom compaction** -- runtime-owned context management keeps long sessions within model limits.
- **Scriptable** -- stdout is reserved for the final assistant reply. Everything else goes to stderr. Exit codes are stable and documented.

## Commands

```
goat new [options] "message"         # New session + run
goat last [options] "message"        # Continue last session
goat --session <id> [options] "msg"  # Target a specific session

goat sessions new|last|list|show|fork|stop
goat runs list|show

goat agents                          # List agent definitions
goat roles                           # List role definitions
goat prompts                         # List prompt definitions
goat version                         # Print version
goat doctor                          # Preflight checks
```

### Run options

```
--fork              Fork the target session before running
--agent <name>      Choose agent (binds on first run)
--role <name>       Apply a sticky role overlay
--no-role           Clear the stored role
--prompt <name>     One-turn prompt prefix (not sticky)
--model <name>      Override model (sticky)
--effort <level>    Reasoning effort: none|minimal|low|medium|high|xhigh
--timeout <dur>     Run timeout override (not sticky)
--plan              Plan mode: mutating tools describe actions without executing
--cwd <path>        Working directory for tools (sticky)
--verbose           Stream progress and assistant text to stderr
--debug             Debug diagnostics (implies --verbose)
```

## Project layout

```
goat.toml           Global config
models.toml         Model catalog
package.json        Bun package manifest
agents/             Agent definitions (.toml + .md system prompts)
roles/              Role overlay definitions
prompts/            Named one-turn prompt definitions
src/                Runtime implementation (TypeScript)
tests/              Test suite
docs/               Documentation
```

## Configuration

Goat resolves config from two roots:

1. **Repo root** -- nearest ancestor containing `goat.toml` or `.goat`
2. **Home root** -- `~/.goat/`

Repo values override home values. See [docs/configuration.md](docs/configuration.md) for the full reference.

## Tools

V1 ships with seven implemented tools:

| Tool | Access | Description |
|------|--------|-------------|
| `bash` | mutating | Shell command execution |
| `read_file` | read-only | Read UTF-8 files with line slicing |
| `write_file` | mutating | Create or overwrite files |
| `replace_in_file` | mutating | Exact text replacement |
| `apply_patch` | mutating | Structured multi-hunk patches |
| `glob` | read-only | File pattern matching via `rg` |
| `grep` | read-only | Regex/literal search via `rg` |

Three additional tools (`web_search`, `web_fetch`, `subagents`) are defined as stubs for future implementation.

See [docs/tools.md](docs/tools.md) for full schemas and behavior.

## Sessions and persistence

Sessions live under `~/.goat/sessions/` by default. Each session contains:

- `meta.json` -- sticky settings, revision, usage
- `messages.jsonl` -- compact replay history
- `compaction.json` -- structured session summary
- `runs/<run-id>/` -- per-run transcript, provider metadata, summary, and artifacts

See [docs/persistence.md](docs/persistence.md) for record shapes and semantics.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Internal error |
| 2 | Usage / input error |
| 3 | Config / definition error |
| 4 | Not found |
| 5 | Stopped session |
| 6 | Session conflict |
| 7 | Provider failure |
| 8 | Tool failure |
| 9 | Interrupted |
| 10 | Timeout |
| 11 | Doctor failure |

## Development

```bash
bun test              # Run tests
bun run typecheck     # Type-check without emitting
bun run src/main.ts   # Run the CLI
```

## Documentation

- [Architecture](docs/architecture.md) -- design goals, runtime flow, module boundaries
- [CLI reference](docs/cli.md) -- commands, options, input/output contracts
- [Configuration](docs/configuration.md) -- goat.toml, models.toml, agents, roles, prompts
- [Persistence](docs/persistence.md) -- on-disk layout, record shapes, lock semantics
- [Tools](docs/tools.md) -- tool harness, schemas, behavior, plan mode
- [Patch format](docs/patch-format.md) -- structured patch grammar and semantics

## License

Private.
