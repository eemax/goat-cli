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
import { createTempDir, useCleanup } from "./helpers.js";

const { track } = useCleanup();

describe("discoverRoots", () => {
  test("finds the nearest repo marker", async () => {
    const root = await createTempDir("goat-roots-");
    track(root);
    const nested = join(root, "a", "b", "c");
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, ".goat"), "");

    const discovered = await discoverRoots(nested, { HOME: root });
    expect(discovered.repoRoot).toBe(root);
    expect(discovered.homeRoot.endsWith(".goat")).toBe(true);
  });

  test("honors explicit environment overrides", async () => {
    const repo = await createTempDir("goat-repo-");
    const home = await createTempDir("goat-home-");
    track(repo, home);

    const discovered = await discoverRoots("/irrelevant", {
      GOAT_REPO_ROOT: repo,
      GOAT_HOME_ROOT: home,
    });

    expect(discovered).toEqual({
      repoRoot: repo,
      homeRoot: home,
    });
  });
});

describe("loadGlobalConfig", () => {
  test("deep merges home and repo config with repo precedence", async () => {
    const home = await createTempDir("goat-home-");
    const repo = await createTempDir("goat-repo-");
    track(home, repo);

    await writeFile(
      join(home, "goat.toml"),
      `
[defaults]
agent = "home-agent"

[provider]
timeout = "10s"

[tools]
default_shell_args = ["-lc"]
max_output_chars = "1234"
`,
    );

    await writeFile(
      join(repo, "goat.toml"),
      `
[defaults]
agent = "repo-agent"

[tools]
default_shell_args = ["-c"]
`,
    );

    const config = await loadGlobalConfig({
      repoRoot: repo,
      homeRoot: home,
    });

    expect(config.defaults.agent).toBe("repo-agent");
    expect(config.provider.timeout).toBe(10);
    expect(config.tools.default_shell_args).toEqual(["-c"]);
    expect(config.tools.max_output_chars).toBe(1234);
    expect(config.paths.sessions_dir).toBe(join(home, "sessions"));
  });

  test("resolves `~` from home directory and `.` from repo root", async () => {
    const home = await createTempDir("goat-home-");
    const repo = await createTempDir("goat-repo-");
    track(home, repo);

    await writeFile(
      join(home, "goat.toml"),
      `
[paths]
sessions_dir = "~/.goat/sessions"
`,
    );

    await writeFile(
      join(repo, "goat.toml"),
      `
[compaction]
prompt_file = "./prompts/compact.md"
`,
    );

    const config = await loadGlobalConfig({
      repoRoot: repo,
      homeRoot: home,
    });

    expect(config.paths.sessions_dir).toBe(join(homedir(), ".goat", "sessions"));
    expect(config.compaction.prompt_file).toBe(join(repo, "prompts", "compact.md"));
  });

  test("fails when repo-root anchored config paths are used without a repo root", async () => {
    const home = await createTempDir("goat-home-");
    track(home);

    await writeFile(
      join(home, "goat.toml"),
      `
[compaction]
prompt_file = "./prompts/compact.md"
`,
    );

    await expect(
      loadGlobalConfig({
        repoRoot: null,
        homeRoot: home,
      }),
    ).rejects.toThrow("requires a repo root");
  });
});

describe("models and definitions", () => {
  test("merges the model catalog and resolves repo alias precedence", async () => {
    const home = await createTempDir("goat-home-");
    const repo = await createTempDir("goat-repo-");
    track(home, repo);

    await writeFile(
      join(home, "models.toml"),
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
      join(repo, "models.toml"),
      `
[[models]]
id = "gpt-5.4-mini"
aliases = ["mini"]

[[models]]
id = "gpt-5.4"
aliases = ["small"]
`,
    );

    const catalog = await loadModelCatalog({
      repoRoot: repo,
      homeRoot: home,
    });

    expect(resolveModelId(catalog, "mini")).toBe("gpt-5.4-mini");
    expect(resolveModelId(catalog, "small")).toBe("gpt-5.4");
  });

  test("loads agents, roles, and prompts with repo shadowing and relative prompt files", async () => {
    const home = await createTempDir("goat-home-");
    const repo = await createTempDir("goat-repo-");
    track(home, repo);

    await mkdir(join(home, "agents"), { recursive: true });
    await mkdir(join(home, "roles"), { recursive: true });
    await mkdir(join(home, "prompts"), { recursive: true });
    await mkdir(join(repo, "agents"), { recursive: true });
    await mkdir(join(repo, "prompts"), { recursive: true });

    await writeFile(
      join(home, "models.toml"),
      `
[[models]]
id = "gpt-5.4-mini"
aliases = ["mini"]
`,
    );

    await writeFile(join(home, "agents", "coder.md"), "You are a home coder.\n");
    await writeFile(
      join(home, "agents", "coder.toml"),
      `
name = "coder"
default_model = "mini"
enabled_tools = ["read_file"]
system_prompt_file = "./coder.md"
`,
    );

    await writeFile(
      join(home, "roles", "auditor.toml"),
      `
name = "auditor"
system_prompt = "Audit the code."
`,
    );

    await writeFile(join(home, "prompts", "repo-summary.md"), "Summarize the repository.\n");
    await writeFile(
      join(home, "prompts", "repo-summary.toml"),
      `
name = "repo-summary"
text_file = "./repo-summary.md"
`,
    );

    await writeFile(
      join(repo, "agents", "coder.toml"),
      `
name = "coder"
default_model = "gpt-5.4-mini"
enabled_tools = ["read_file", "write_file"]
system_prompt = "You are a repo coder."
`,
    );

    const roots = {
      repoRoot: repo,
      homeRoot: home,
    };

    const files = await listDefinitionFiles(roots, "agents");
    expect(files.map((file) => file.name)).toEqual(["coder"]);

    const catalog = await loadModelCatalog(roots);
    const definitions = await loadDefinitions(roots, catalog);
    expect(definitions.agents.get("coder")?.system_prompt).toBe("You are a repo coder.");
    expect(definitions.roles.get("auditor")?.system_prompt).toBe("Audit the code.");
    expect(definitions.prompts.get("repo-summary")?.text).toBe("Summarize the repository.\n");
    expect(formatDefinitionList(definitions.agents.keys())).toBe("coder\n");
  });
});
