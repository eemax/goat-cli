import type { Readable, Writable } from "node:stream";

import { Readable as ReadableStream } from "node:stream";
import { createDebugSink } from "./debug.js";
import { usageError } from "./errors.js";
import { executeRunCommand } from "./run.js";
import type { CommandOutput, RuntimeDeps } from "./runtime-context.js";
import { loadAppContext, loadBaseContext } from "./runtime-context.js";
import type { Command, RunCommand, RunOptions, ScenarioDef } from "./types.js";

type ScenarioRunCommand = Extract<Command, { kind: "run" }>;

type StepResult = {
  id: string;
  output: string;
  session_id: string;
  run_id: string;
};

async function readAllStdin(stdin: Readable): Promise<string | null> {
  const maybeTty = stdin as Readable & { isTTY?: boolean };
  if (maybeTty.isTTY) {
    return null;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return null;
  }
  const buffer = Buffer.concat(chunks);
  return buffer.length === 0 ? null : buffer.toString("utf8");
}

function stripOneFinalNewline(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function replaceAllLiteral(value: string, search: string, replacement: string): string {
  return value.split(search).join(replacement);
}

function expandTemplate(template: string, input: string, steps: StepResult[]): string {
  let expanded = replaceAllLiteral(template, "{{input}}", input);
  expanded = replaceAllLiteral(expanded, "{{previous_output}}", steps.at(-1)?.output ?? "");
  for (const step of steps) {
    expanded = replaceAllLiteral(expanded, `{{steps.${step.id}.output}}`, step.output);
    expanded = replaceAllLiteral(expanded, `{{steps.${step.id}.session_id}}`, step.session_id);
    expanded = replaceAllLiteral(expanded, `{{steps.${step.id}.run_id}}`, step.run_id);
  }
  return expanded;
}

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

function buildStepCommand(
  scenarioCommand: ScenarioRunCommand,
  scenario: ScenarioDef,
  stepIndex: number,
  steps: StepResult[],
  input: string,
): RunCommand {
  const step = scenario.steps[stepIndex]!;
  return {
    kind: "run",
    name: "new",
    session: "new",
    message: expandTemplate(step.message, input, steps),
    options: {
      ...defaultRunOptions(),
      agent: step.agent,
      role: step.role,
      prompt: step.prompt,
      skills: step.skills,
      compact: step.compact ?? scenarioCommand.options.compact,
      model: step.model ?? scenarioCommand.options.model,
      effort: step.effort ?? scenarioCommand.options.effort,
      timeoutSeconds: step.timeoutSeconds ?? scenarioCommand.options.timeoutSeconds,
      plan: scenarioCommand.options.plan,
      cwd: step.cwd ?? scenarioCommand.options.cwd,
      verbose: scenarioCommand.options.verbose,
      debug: scenarioCommand.options.debug,
      debugJson: scenarioCommand.options.debugJson,
    },
  };
}

export async function executeScenarioCommand(
  command: ScenarioRunCommand,
  stdin: Readable,
  stderr: Writable,
  deps?: RuntimeDeps,
): Promise<CommandOutput> {
  if (!command.options.scenario) {
    throw usageError("scenario command requires --scenario");
  }
  if (command.session !== "new") {
    throw usageError("--scenario can only be used with `goat new` or `goat --session new`");
  }

  const processCwd = deps?.processCwd ?? process.cwd();
  const env = deps?.env ?? process.env;
  const context = await loadAppContext(await loadBaseContext(processCwd, env));
  const scenario = context.definitions.scenarios.get(command.options.scenario);
  if (!scenario) {
    throw usageError(`scenario \`${command.options.scenario}\` was not found`);
  }

  const debug = createDebugSink(stderr, command.options);
  debug.setMaxChars(context.config.runtime.stderr_message_max_chars);
  await debug.emit("run", "scenario_started", {
    scenario: scenario.name,
    steps: scenario.steps.map((step) => step.id),
  });

  const stdinText = await readAllStdin(stdin);
  const scenarioInput = stdinText ? `${command.message}\n\n${stdinText}` : command.message;
  const results: StepResult[] = [];
  let finalOutput: CommandOutput | null = null;

  for (let index = 0; index < scenario.steps.length; index += 1) {
    const step = scenario.steps[index]!;
    await debug.emit("run", "scenario_step_started", {
      scenario: scenario.name,
      step: step.id,
      index: index + 1,
    });
    const stepCommand = buildStepCommand(command, scenario, index, results, scenarioInput);
    const stepOutput = await executeRunCommand(stepCommand, ReadableStream.from([]), stderr, deps);
    const sessionId = stepOutput.meta?.session_id;
    const runId = stepOutput.meta?.run_id;
    if (!sessionId || !runId) {
      throw usageError(`scenario step \`${step.id}\` did not return run metadata`);
    }
    results.push({
      id: step.id,
      output: stripOneFinalNewline(stepOutput.stdout),
      session_id: sessionId,
      run_id: runId,
    });
    finalOutput = stepOutput;
    await debug.emit("run", "scenario_step_finished", {
      scenario: scenario.name,
      step: step.id,
      session_id: sessionId,
      run_id: runId,
    });
  }

  await debug.emit("run", "scenario_finished", {
    scenario: scenario.name,
    steps: results.length,
  });

  return {
    stdout: finalOutput?.stdout ?? "",
    stderr: "",
    exitCode: finalOutput?.exitCode ?? 0,
    meta: finalOutput?.meta,
  };
}
