import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { discoverRoots, loadGlobalConfig } from "../src/config.js";
import {
  formatDefinitionList,
  listDefinitionFiles,
  loadDefinitions,
  loadModelCatalog,
  resolveModelId,
} from "../src/defs.js";
import type { ConfigRoots } from "../src/types.js";
import { createTempDir, useCleanup } from "./helpers.js";

const { track } = useCleanup();

function roots(...configRoots: string[]): ConfigRoots {
  return {
    configRoots,
    homeRoot: configRoots[configRoots.length - 1]!,
  };
}

describe("discoverRoots", () => {
  test("uses the global root stack and ignores repo markers", async () => {
    const home = await createTempDir("goat-home-");
    const cwd = await createTempDir("goat-cwd-");
    track(home, cwd);
    await writeFile(join(cwd, "goat.toml"), '[defaults]\nagent = "ignored"\n');

    const discovered = await discoverRoots(cwd, { HOME: home });

    expect(discovered.configRoots).toEqual([join(home, "goat-cli"), join(home, ".config", "goat")]);
    expect(discovered.homeRoot).toBe(join(home, ".config", "goat"));
  });

  test("honors GOAT_HOME_DIR as the highest priority root", async () => {
    const home = await createTempDir("goat-home-");
    const override = await createTempDir("goat-override-");
    track(home, override);

    const discovered = await discoverRoots("/irrelevant", {
      HOME: home,
      GOAT_HOME_DIR: override,
      GOAT_HOME_ROOT: "/ignored",
    });

    expect(discovered.configRoots).toEqual([join(home, "goat-cli"), join(home, ".config", "goat"), override]);
    expect(discovered.homeRoot).toBe(override);
  });
});

describe("loadGlobalConfig", () => {
  test("deep merges ordered global config roots with later roots winning", async () => {
    const base = await createTempDir("goat-base-");
    const mid = await createTempDir("goat-mid-");
    const top = await createTempDir("goat-top-");
    track(base, mid, top);

    await writeFile(
      join(base, "goat.toml"),
      `
[defaults]
agent = "base-agent"

[provider]
timeout = "10s"

[tools]
default_shell_args = ["-lc"]
max_output_chars = "1234"
`,
    );

    await writeFile(
      join(mid, "goat.toml"),
      `
[defaults]
agent = "mid-agent"

[tools]
default_shell_args = ["-c"]
`,
    );

    await writeFile(
      join(top, "goat.toml"),
      `
[defaults]
agent = "top-agent"

[runtime]
stderr_message_max_chars = "99"
`,
    );

    const config = await loadGlobalConfig(roots(base, mid, top));

    expect(config.defaults.agent).toBe("top-agent");
    expect(config.provider.timeout).toBe(10);
    expect(config.tools.default_shell_args).toEqual(["-c"]);
    expect(config.tools.max_output_chars).toBe(1234);
    expect(config.runtime.stderr_message_max_chars).toBe(99);
    expect(config.paths.sessions_dir).toBe(join(top, "sessions"));
  });

  test("resolves `~`, `.`, and relative config paths", async () => {
    const root = await createTempDir("goat-root-");
    track(root);

    await writeFile(
      join(root, "goat.toml"),
      `
[paths]
sessions_dir = "~/.config/goat/sessions"

[compaction]
prompt_file = "./prompts/compact.md"
`,
    );

    const config = await loadGlobalConfig(roots(root));

    expect(config.paths.sessions_dir).toBe(join(homedir(), ".config", "goat", "sessions"));
    expect(config.compaction.prompt_file).toBe(join(root, "prompts", "compact.md"));
  });
});

describe("models and definitions", () => {
  test("merges the model catalog and resolves higher-priority alias precedence", async () => {
    const base = await createTempDir("goat-base-");
    const top = await createTempDir("goat-top-");
    track(base, top);

    await writeFile(
      join(base, "models.toml"),
      `
[[models]]
id = "gpt-5.4-mini"
aliases = ["mini", "small"]

[[models]]
id = "gpt-5.3-codex"
aliases = ["codex"]
`,
    );

    await writeFile(
      join(top, "models.toml"),
      `
[[models]]
id = "gpt-5.4-mini"
aliases = ["mini"]

[[models]]
id = "gpt-5.4"
aliases = ["small"]
`,
    );

    const catalog = await loadModelCatalog(roots(base, top));

    expect(resolveModelId(catalog, "mini")).toBe("gpt-5.4-mini");
    expect(resolveModelId(catalog, "small")).toBe("gpt-5.4");
  });

  test("loads agents, roles, prompts, skills, and scenarios with root shadowing", async () => {
    const base = await createTempDir("goat-base-");
    const top = await createTempDir("goat-top-");
    track(base, top);

    await mkdir(join(base, "agents"), { recursive: true });
    await mkdir(join(base, "roles"), { recursive: true });
    await mkdir(join(base, "prompts"), { recursive: true });
    await mkdir(join(base, "skills", "research"), { recursive: true });
    await mkdir(join(top, "agents"), { recursive: true });
    await mkdir(join(top, "prompts"), { recursive: true });
    await mkdir(join(top, "scenarios"), { recursive: true });

    await writeFile(
      join(base, "models.toml"),
      `
[[models]]
id = "gpt-5.4-mini"
aliases = ["mini"]
`,
    );

    await writeFile(
      join(base, "skills", "research", "SKILL.md"),
      "---\nname: Research\ndescription: Research helper\n---\n\n# Research\n",
    );
    await writeFile(join(base, "agents", "coder.md"), "You are a home coder.\n");
    await writeFile(
      join(base, "agents", "coder.toml"),
      `
name = "coder"
default_model = "mini"
enabled_tools = ["read_file"]
system_prompt_file = "./coder.md"

[skills]
enabled = true
path = "../skills"
`,
    );

    await writeFile(
      join(base, "roles", "auditor.toml"),
      `
name = "auditor"
system_prompt = "Audit the code."
`,
    );

    await writeFile(join(base, "prompts", "repo-summary.md"), "Summarize the repository.\n");
    await writeFile(
      join(base, "prompts", "repo-summary.toml"),
      `
name = "repo-summary"
text_file = "./repo-summary.md"
`,
    );

    await writeFile(
      join(top, "agents", "coder.toml"),
      `
name = "coder"
default_model = "gpt-5.4-mini"
enabled_tools = ["read_file", "write_file"]
system_prompt = "You are a repo coder."

[skills]
enabled = false
`,
    );
    await writeFile(
      join(top, "scenarios", "review-chain.toml"),
      `
name = "review-chain"

[[steps]]
id = "inspect"
agent = "coder"
prompt = "repo-summary"
message = "{{input}}"
`,
    );

    const configRoots = roots(base, top);
    const files = await listDefinitionFiles(configRoots, "agents");
    expect(files.map((file) => file.name)).toEqual(["coder"]);

    const catalog = await loadModelCatalog(configRoots);
    const definitions = await loadDefinitions(configRoots, catalog);
    expect(definitions.agents.get("coder")?.system_prompt).toBe("You are a repo coder.");
    expect(definitions.agents.get("coder")?.skills_enabled).toBe(false);
    expect(definitions.roles.get("auditor")?.system_prompt).toBe("Audit the code.");
    expect(definitions.prompts.get("repo-summary")?.text).toBe("Summarize the repository.\n");
    expect(definitions.scenarios.get("review-chain")?.steps[0]?.agent).toBe("coder");
    expect(formatDefinitionList(definitions.agents.keys())).toBe("coder\n");
  });
});
