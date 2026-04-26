import { spawn } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";

import { discoverRoots, loadGlobalConfig, resolveOpenAIApiKey } from "./config.js";
import { loadDefinitions, loadModelCatalog, resolveModel } from "./defs.js";
import { ExitCode } from "./errors.js";
import { formatError } from "./io.js";
import type { CommandOutput, RuntimeDeps } from "./runtime-context.js";
import type { ConfigRoots, DoctorCheck, GlobalConfig } from "./types.js";

function renderDoctorCheck(check: DoctorCheck): string {
  return check.reason ? `${check.status} ${check.name}: ${check.reason}` : `${check.status} ${check.name}`;
}

async function pathIsWritable(path: string): Promise<boolean> {
  try {
    await mkdir(path, { recursive: true });
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function commandExists(command: string): Promise<boolean> {
  return await new Promise<boolean>((resolveExists) => {
    const child = spawn("sh", ["-lc", `command -v ${command}`], {
      stdio: "ignore",
    });
    child.on("close", (code) => resolveExists(code === 0));
    child.on("error", () => resolveExists(false));
  });
}

function doctorResult(checks: DoctorCheck[]): CommandOutput {
  const hasFailure = checks.some((check) => check.status === "FAIL");
  return {
    stdout: `${checks.map(renderDoctorCheck).join("\n")}\n`,
    stderr: "",
    exitCode: hasFailure ? ExitCode.doctorFailure : ExitCode.success,
  };
}

export async function runDoctor(
  processCwd: string,
  env: NodeJS.ProcessEnv,
  deps?: RuntimeDeps,
): Promise<CommandOutput> {
  const checks: DoctorCheck[] = [];
  let roots: ConfigRoots;
  try {
    roots = await discoverRoots(processCwd, env);
  } catch (error) {
    checks.push({ name: "config", status: "FAIL", reason: formatError(error) });
    return doctorResult(checks);
  }

  let config: GlobalConfig;
  try {
    config = await loadGlobalConfig(roots);
  } catch (error) {
    checks.push({ name: "config", status: "FAIL", reason: formatError(error) });
    return doctorResult(checks);
  }

  checks.push({ name: "config", status: "PASS" });

  let models: Awaited<ReturnType<typeof loadModelCatalog>> | null = null;
  try {
    models = await loadModelCatalog(roots);
    checks.push({ name: "models", status: "PASS" });
  } catch (error) {
    checks.push({ name: "models", status: "FAIL", reason: formatError(error) });
  }

  if (models) {
    try {
      await loadDefinitions(roots, models);
      checks.push({ name: "definitions", status: "PASS" });
    } catch (error) {
      checks.push({ name: "definitions", status: "FAIL", reason: formatError(error) });
    }
  } else {
    checks.push({ name: "definitions", status: "SKIP", reason: "model catalog did not load" });
  }

  if (config.compaction.model) {
    if (models) {
      try {
        resolveModel(models, config.compaction.model);
        checks.push({ name: "compaction_model", status: "PASS" });
      } catch (error) {
        checks.push({ name: "compaction_model", status: "FAIL", reason: formatError(error) });
      }
    } else {
      checks.push({
        name: "compaction_model",
        status: "FAIL",
        reason: "cannot verify compaction model without a valid model catalog",
      });
    }
  } else {
    checks.push({ name: "compaction_model", status: "SKIP", reason: "not configured" });
  }

  if (config.compaction.prompt_file) {
    try {
      await readFile(config.compaction.prompt_file, "utf8");
      checks.push({ name: "compaction_prompt", status: "PASS" });
    } catch (error) {
      checks.push({ name: "compaction_prompt", status: "FAIL", reason: formatError(error) });
    }
  } else {
    checks.push({ name: "compaction_prompt", status: "SKIP", reason: "not configured" });
  }

  if (await pathIsWritable(config.paths.sessions_dir)) {
    checks.push({ name: "sessions_dir", status: "PASS" });
  } else {
    checks.push({ name: "sessions_dir", status: "FAIL", reason: "session directory is not writable" });
  }

  const hasRg = await commandExists("rg");
  checks.push({
    name: "rg",
    status: hasRg ? "PASS" : "FAIL",
    reason: hasRg ? undefined : "ripgrep is not installed",
  });

  // Prefer the explicit `env` parameter so callers that inject an env without
  // passing the full `RuntimeDeps` struct still get their API key resolved.
  const apiKey = await resolveOpenAIApiKey(config, deps?.env ?? env);
  if (!apiKey) {
    checks.push({ name: "openai_credentials", status: "FAIL", reason: "OpenAI API key is not configured" });
  } else {
    checks.push({ name: "openai_credentials", status: "PASS" });
    try {
      const base = config.provider.base_url.replace(/\/$/, "");
      const response = await (deps?.fetchImpl ?? fetch)(`${base}/models`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
      if (!response.ok) {
        checks.push({ name: "openai_ping", status: "FAIL", reason: `HTTP ${response.status}` });
      } else {
        checks.push({ name: "openai_ping", status: "PASS" });
      }
    } catch (error) {
      checks.push({ name: "openai_ping", status: "FAIL", reason: formatError(error) });
    }
  }

  if (config.tools.web_search.enabled) {
    const searchKey = config.tools.web_search.api_key ?? env[config.tools.web_search.api_key_env];
    if (searchKey) {
      checks.push({ name: "web_search_credentials", status: "PASS" });
    } else {
      checks.push({
        name: "web_search_credentials",
        status: "FAIL",
        reason: `set tools.web_search.api_key or ${config.tools.web_search.api_key_env}`,
      });
    }
  }

  if (config.tools.web_fetch.enabled) {
    const hasDefuddle = await commandExists(config.tools.web_fetch.command);
    checks.push({
      name: "web_fetch_defuddle",
      status: hasDefuddle ? "PASS" : "FAIL",
      reason: hasDefuddle ? undefined : `${config.tools.web_fetch.command} not found in PATH`,
    });
  }

  if (config.tools.subagents.enabled) {
    const hasSubagents = await commandExists("subagents");
    checks.push({
      name: "subagents_cli",
      status: hasSubagents ? "PASS" : "FAIL",
      reason: hasSubagents ? undefined : "subagents CLI not found in PATH",
    });
  }

  return doctorResult(checks);
}
