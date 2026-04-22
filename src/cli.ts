import { usageError } from "./errors.js";
import {
  type Command,
  EFFORT_VALUES,
  type Effort,
  type RunCommand,
  type RunOptions,
  type SessionSelector,
} from "./types.js";
import { parseTime } from "./units.js";

const RUN_VALUE_FLAGS = new Set([
  "--agent",
  "--role",
  "--prompt",
  "--skill",
  "--scenario",
  "--model",
  "--effort",
  "--timeout",
  "--cwd",
]);
const BOOL_FLAGS = new Set(["--fork", "--no-role", "--compact", "--plan", "--verbose", "--debug", "--debug-json"]);

function defaultRunOptions(): RunOptions {
  return {
    fork: false,
    agent: null,
    role: null,
    noRole: false,
    prompt: null,
    skills: [],
    compact: false,
    scenario: null,
    model: null,
    effort: null,
    timeoutSeconds: null,
    plan: false,
    cwd: null,
    verbose: false,
    debug: false,
    debugJson: false,
  };
}

function parseEffort(raw: string): Effort {
  if (!EFFORT_VALUES.includes(raw as Effort)) {
    throw usageError(`--effort must be one of: ${EFFORT_VALUES.join(", ")}`);
  }

  return raw as Effort;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const next = argv[index + 1];
  if (!next || next.startsWith("--")) {
    throw usageError(`${flag} requires a value`);
  }

  return next;
}

function parseRun(commandName: RunCommand["name"], session: SessionSelector, argv: string[]): RunCommand {
  const options = defaultRunOptions();
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (RUN_VALUE_FLAGS.has(token)) {
      const value = requireValue(argv, index, token);
      index += 1;
      switch (token) {
        case "--agent":
          options.agent = value;
          break;
        case "--role":
          options.role = value;
          break;
        case "--prompt":
          options.prompt = value;
          break;
        case "--skill":
          options.skills.push(value);
          break;
        case "--scenario":
          options.scenario = value;
          break;
        case "--model":
          options.model = value;
          break;
        case "--effort":
          options.effort = parseEffort(value);
          break;
        case "--timeout":
          options.timeoutSeconds = parseTime(value);
          break;
        case "--cwd":
          options.cwd = value;
          break;
        default:
          throw usageError(`unsupported flag ${token}`);
      }
      continue;
    }

    if (BOOL_FLAGS.has(token)) {
      switch (token) {
        case "--fork":
          options.fork = true;
          break;
        case "--no-role":
          options.noRole = true;
          break;
        case "--compact":
          options.compact = true;
          break;
        case "--plan":
          options.plan = true;
          break;
        case "--verbose":
          options.verbose = true;
          break;
        case "--debug":
          options.debug = true;
          break;
        case "--debug-json":
          options.debug = true;
          options.debugJson = true;
          break;
        default:
          throw usageError(`unsupported flag ${token}`);
      }
      continue;
    }

    if (token.startsWith("--")) {
      throw usageError(`unknown flag ${token}`);
    }

    positionals.push(token);
  }

  if (options.debug && !options.debugJson) {
    options.verbose = true;
  }

  if (options.debugJson && options.verbose) {
    throw usageError("--debug-json cannot be used with --verbose");
  }

  if (options.role && options.noRole) {
    throw usageError("--role and --no-role cannot be used together");
  }

  if (session === "new" && options.fork) {
    throw usageError("--fork cannot be used with `goat new`");
  }

  if (options.scenario) {
    if (session !== "new") {
      throw usageError("--scenario can only be used with `goat new` or `goat --session new`");
    }
    if (
      options.agent ||
      options.role ||
      options.noRole ||
      options.prompt ||
      options.skills.length > 0 ||
      options.fork
    ) {
      throw usageError("--scenario cannot be combined with --agent, --role, --no-role, --prompt, --skill, or --fork");
    }
  }

  if (positionals.length !== 1) {
    throw usageError("prompt runs require exactly one message argument");
  }

  return {
    kind: "run",
    name: commandName,
    session,
    options,
    message: positionals[0],
  };
}

export function parseArgv(argv: string[]): Command {
  if (argv.length === 0) {
    throw usageError("missing command");
  }

  const [first, ...rest] = argv;

  switch (first) {
    case "version":
      return { kind: "version" };
    case "doctor":
      return { kind: "doctor" };
    case "agents":
      return { kind: "agents" };
    case "roles":
      return { kind: "roles" };
    case "prompts":
      return { kind: "prompts" };
    case "skills":
      return { kind: "skills" };
    case "scenarios":
      return { kind: "scenarios" };
    case "new":
      return parseRun("new", "new", rest);
    case "last":
      return parseRun("last", "last", rest);
    case "--session": {
      const selector = requireValue(argv, 0, "--session");
      return parseRun("explicit", selector, argv.slice(2));
    }
    case "sessions":
      return parseSessions(rest);
    case "runs":
      return parseRuns(rest);
    case "compact":
      return parseCompact(rest);
    default:
      throw usageError(`unknown command ${first}`);
  }
}

function parseCompact(argv: string[]): Command {
  if (argv.length === 0) {
    throw usageError("missing `compact` subcommand");
  }

  const [subcommand, ...rest] = argv;
  switch (subcommand) {
    case "session":
      if (rest.length !== 1) {
        throw usageError("`goat compact session` requires exactly one session selector");
      }
      return { kind: "compact.session", session: rest[0] };
    default:
      throw usageError(`unknown \`compact\` subcommand ${subcommand}`);
  }
}

function parseSessions(argv: string[]): Command {
  if (argv.length === 0) {
    throw usageError("missing `sessions` subcommand");
  }

  const [subcommand, ...rest] = argv;
  switch (subcommand) {
    case "new":
      if (rest.length !== 0) {
        throw usageError("`goat sessions new` does not accept arguments");
      }
      return { kind: "sessions.new" };
    case "last":
      if (rest.length !== 0) {
        throw usageError("`goat sessions last` does not accept arguments");
      }
      return { kind: "sessions.last" };
    case "list":
      if (rest.length !== 0) {
        throw usageError("`goat sessions list` does not accept arguments");
      }
      return { kind: "sessions.list" };
    case "show":
      if (rest.length !== 1) {
        throw usageError("`goat sessions show` requires exactly one session id");
      }
      return { kind: "sessions.show", sessionId: rest[0] };
    case "fork":
      if (rest.length !== 1) {
        throw usageError("`goat sessions fork` requires exactly one session selector");
      }
      return { kind: "sessions.fork", sessionId: rest[0] };
    case "stop":
      if (rest.length !== 1) {
        throw usageError("`goat sessions stop` requires exactly one session id");
      }
      return { kind: "sessions.stop", sessionId: rest[0] };
    default:
      throw usageError(`unknown \`sessions\` subcommand ${subcommand}`);
  }
}

function parseRuns(argv: string[]): Command {
  if (argv.length === 0) {
    throw usageError("missing `runs` subcommand");
  }

  const [subcommand, ...rest] = argv;
  switch (subcommand) {
    case "list":
      return parseRunsList(rest);
    case "show":
      return parseRunsShow(rest);
    default:
      throw usageError(`unknown \`runs\` subcommand ${subcommand}`);
  }
}

function parseRunsList(argv: string[]): Command {
  if (argv.length === 0) {
    return { kind: "runs.list", session: "last" };
  }

  if (argv[0] !== "--session") {
    throw usageError("`goat runs list` only accepts an optional --session flag");
  }

  if (argv.length !== 2) {
    throw usageError("`goat runs list --session` requires exactly one value");
  }

  return {
    kind: "runs.list",
    session: argv[1],
  };
}

function parseRunsShow(argv: string[]): Command {
  if (argv[0] !== "--session") {
    throw usageError("`goat runs show` requires --session <id|last>");
  }

  if (argv.length !== 3) {
    throw usageError("`goat runs show --session <id|last> <run-id>` requires exactly one run id");
  }

  return {
    kind: "runs.show",
    session: argv[1],
    runId: argv[2],
  };
}
