import { readFile } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import pkg from "../package.json" with { type: "json" };

import { parseArgv } from "./cli.js";
import { compactSessionHistory } from "./compaction.js";
import { resolveOpenAIApiKey } from "./config.js";
import { formatDefinitionList, resolveModel } from "./defs.js";
import { runDoctor } from "./doctor.js";
import { configError, ExitCode, GoatError, internalError, notFoundError } from "./errors.js";
import { formatError, writeText } from "./io.js";
import { executeRunCommand } from "./run.js";
import type { CommandOutput, RuntimeDeps } from "./runtime-context.js";
import { loadAppContext, loadBaseContext } from "./runtime-context.js";
import { executeScenarioCommand } from "./scenarios.js";
import {
  createSession,
  ensureSessionCanRun,
  forkSession,
  lastActiveSession,
  listRunIds,
  listSessionIds,
  loadSessionMeta,
  resolveSessionSelector,
  runPaths,
  stopSession,
} from "./session.js";
import { formatSkillsList } from "./skills.js";
import type { Command } from "./types.js";

async function executeCommand(
  command: Command,
  stdin: Readable,
  stderr: Writable,
  deps?: RuntimeDeps,
): Promise<CommandOutput> {
  if (command.kind === "version") {
    return { stdout: `${pkg.version}\n`, stderr: "", exitCode: ExitCode.success };
  }
  if (command.kind === "run") {
    if (command.options.scenario) {
      return executeScenarioCommand(command, stdin, stderr, deps);
    }
    return executeRunCommand(command, stdin, stderr, deps);
  }

  const processCwd = deps?.processCwd ?? process.cwd();
  const env = deps?.env ?? process.env;

  if (command.kind === "doctor") {
    return runDoctor(processCwd, env, deps);
  }

  const baseContext = await loadBaseContext(processCwd, env);

  switch (command.kind) {
    case "agents":
      return {
        stdout: formatDefinitionList((await loadAppContext(baseContext)).definitions.agents.keys()),
        stderr: "",
        exitCode: ExitCode.success,
      };
    case "roles":
      return {
        stdout: formatDefinitionList((await loadAppContext(baseContext)).definitions.roles.keys()),
        stderr: "",
        exitCode: ExitCode.success,
      };
    case "prompts":
      return {
        stdout: formatDefinitionList((await loadAppContext(baseContext)).definitions.prompts.keys()),
        stderr: "",
        exitCode: ExitCode.success,
      };
    case "skills": {
      const context = await loadAppContext(baseContext);
      return {
        stdout: formatSkillsList(context.definitions.agents.values()),
        stderr: "",
        exitCode: ExitCode.success,
      };
    }
    case "scenarios":
      return {
        stdout: formatDefinitionList((await loadAppContext(baseContext)).definitions.scenarios.keys()),
        stderr: "",
        exitCode: ExitCode.success,
      };
    case "compact.session": {
      const context = await loadAppContext(baseContext);
      const session = await resolveSessionSelector(baseContext.config.paths.sessions_dir, command.session);
      await ensureSessionCanRun(session);
      const agentName = session.agent_name ?? context.config.defaults.agent;
      if (!agentName) {
        throw notFoundError("no agent was selected and no default agent is configured");
      }
      const agent = context.definitions.agents.get(agentName);
      if (!agent) {
        throw notFoundError(`agent \`${agentName}\` was not found`);
      }
      const model = resolveModel(context.models, session.model ?? agent.default_model);
      const apiKey = await resolveOpenAIApiKey(context.config, env);
      if (!apiKey) {
        throw configError("OpenAI API key is not configured");
      }
      const result = await compactSessionHistory({
        context,
        sessionMeta: session,
        agent,
        modelId: model.id,
        providerModel: model.provider_model,
        effort: session.effort ?? agent.default_effort,
        cwd: session.cwd ?? processCwd,
        apiKey,
        deps,
      });
      return {
        stdout: result.runId ? `${result.runId}\n` : "",
        stderr: "",
        exitCode: ExitCode.success,
        meta: result.runId
          ? {
              session_id: session.session_id,
              run_id: result.runId,
            }
          : undefined,
      };
    }
    case "sessions.new": {
      const session = await createSession(baseContext.config.paths.sessions_dir);
      return { stdout: `${session.session_id}\n`, stderr: "", exitCode: ExitCode.success };
    }
    case "sessions.last": {
      const session = await lastActiveSession(baseContext.config.paths.sessions_dir);
      return { stdout: `${session.session_id}\n`, stderr: "", exitCode: ExitCode.success };
    }
    case "sessions.list": {
      const sessionIds = await listSessionIds(baseContext.config.paths.sessions_dir);
      return {
        stdout: `${sessionIds.join("\n")}${sessionIds.length ? "\n" : ""}`,
        stderr: "",
        exitCode: ExitCode.success,
      };
    }
    case "sessions.show":
      return {
        stdout: `${JSON.stringify(await loadSessionMeta(baseContext.config.paths.sessions_dir, command.sessionId), null, 2)}\n`,
        stderr: "",
        exitCode: ExitCode.success,
      };
    case "sessions.fork": {
      const session = await forkSession(baseContext.config.paths.sessions_dir, command.sessionId);
      return { stdout: `${session.session_id}\n`, stderr: "", exitCode: ExitCode.success };
    }
    case "sessions.stop":
      await stopSession(baseContext.config.paths.sessions_dir, command.sessionId);
      return { stdout: "", stderr: "", exitCode: ExitCode.success };
    case "runs.list": {
      const session = await resolveSessionSelector(baseContext.config.paths.sessions_dir, command.session);
      const runIds = await listRunIds(baseContext.config.paths.sessions_dir, session.session_id);
      return { stdout: `${runIds.join("\n")}${runIds.length ? "\n" : ""}`, stderr: "", exitCode: ExitCode.success };
    }
    case "runs.show": {
      const session = await resolveSessionSelector(baseContext.config.paths.sessions_dir, command.session);
      const summaryPath = runPaths(baseContext.config.paths.sessions_dir, session.session_id, command.runId).summary;
      const raw = await readFile(summaryPath, "utf8").catch(() => {
        throw notFoundError(`run \`${command.runId}\` was not found in session \`${session.session_id}\``);
      });
      return { stdout: `${JSON.stringify(JSON.parse(raw), null, 2)}\n`, stderr: "", exitCode: ExitCode.success };
    }
    default:
      throw internalError(`unhandled command ${command satisfies never}`);
  }
}

export async function runApp(
  argv: string[],
  stdin: Readable,
  stderr: Writable,
  deps?: RuntimeDeps,
): Promise<CommandOutput> {
  try {
    const command = parseArgv(argv);
    return await executeCommand(command, stdin, stderr, deps);
  } catch (error) {
    return {
      stdout: "",
      stderr: `${formatError(error)}\n`,
      exitCode: error instanceof GoatError ? error.exitCode : ExitCode.internal,
    };
  }
}

export async function main(
  argv: string[],
  stdin: Readable,
  stdout: Writable,
  stderr: Writable,
  deps?: RuntimeDeps,
): Promise<void> {
  const output = await runApp(argv, stdin, stderr, deps);
  if (output.stdout) {
    await writeText(stdout, output.stdout);
  }
  if (output.stderr) {
    await writeText(stderr, output.stderr);
  }
  process.exitCode = output.exitCode;
}
