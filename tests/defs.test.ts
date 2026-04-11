import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { listDefinitionFiles, loadDefinitions, loadModelCatalog, resolveModel, resolveModelId } from "../src/defs.js";
import { createTempDir, useCleanup } from "./helpers.js";

const { track } = useCleanup();

describe("loadModelCatalog", () => {
  test("rejects duplicate model ids within a single layer", async () => {
    const home = await createTempDir("goat-defs-");
    track(home);
    await writeFile(
      join(home, "models.toml"),
      `
[[models]]
id = "gpt-5.4-mini"

[[models]]
id = "gpt-5.4-mini"
`,
    );

    await expect(loadModelCatalog({ repoRoot: null, homeRoot: home })).rejects.toThrow(/duplicate model id/);
  });

  test("rejects duplicate aliases within a single layer", async () => {
    const home = await createTempDir("goat-defs-");
    track(home);
    await writeFile(
      join(home, "models.toml"),
      `
[[models]]
id = "gpt-5.4-mini"
aliases = ["m"]

[[models]]
id = "gpt-5.4"
aliases = ["m"]
`,
    );

    await expect(loadModelCatalog({ repoRoot: null, homeRoot: home })).rejects.toThrow(/duplicate model alias/);
  });

  test("records shadowed aliases when repo layer overrides home", async () => {
    const home = await createTempDir("goat-defs-home-");
    const repo = await createTempDir("goat-defs-repo-");
    track(home, repo);

    await writeFile(
      join(home, "models.toml"),
      `
[[models]]
id = "gpt-5.4-mini"
aliases = ["shared"]
`,
    );
    await writeFile(
      join(repo, "models.toml"),
      `
[[models]]
id = "gpt-5.4"
aliases = ["shared"]
`,
    );

    const catalog = await loadModelCatalog({ repoRoot: repo, homeRoot: home });
    expect(catalog.shadowedAliases).toContain("shared");
    expect(resolveModelId(catalog, "shared")).toBe("gpt-5.4");
  });

  test("resolveModel surfaces unknown ids clearly", async () => {
    const home = await createTempDir("goat-defs-");
    track(home);
    await writeFile(
      join(home, "models.toml"),
      `
[[models]]
id = "gpt-5.4-mini"
`,
    );
    const catalog = await loadModelCatalog({ repoRoot: null, homeRoot: home });
    expect(() => resolveModel(catalog, "nonsense")).toThrow(/unknown model/);
  });

  test("accepts the legacy provider field used by checked-in models.toml", async () => {
    const home = await createTempDir("goat-defs-");
    track(home);
    await writeFile(
      join(home, "models.toml"),
      `
[[models]]
id = "gpt-5.4-mini"
provider = "openai_responses"
provider_model = "gpt-5.4-mini"
aliases = ["mini"]
`,
    );
    const catalog = await loadModelCatalog({ repoRoot: null, homeRoot: home });
    expect(resolveModelId(catalog, "mini")).toBe("gpt-5.4-mini");
  });

  test("returns empty catalog when no models.toml layer exists", async () => {
    const home = await createTempDir("goat-defs-");
    track(home);
    const catalog = await loadModelCatalog({ repoRoot: null, homeRoot: home });
    expect(catalog.byId.size).toBe(0);
    expect(catalog.aliasToId.size).toBe(0);
    expect(catalog.shadowedAliases).toEqual([]);
  });
});

describe("loadDefinitions validation", () => {
  async function writeMinimalCatalog(root: string): Promise<void> {
    await writeFile(
      join(root, "models.toml"),
      `
[[models]]
id = "gpt-5.4-mini"
aliases = ["mini"]
`,
    );
  }

  test("rejects an agent that enables an unknown tool id", async () => {
    const home = await createTempDir("goat-defs-");
    track(home);
    await writeMinimalCatalog(home);
    await mkdir(join(home, "agents"), { recursive: true });
    await writeFile(
      join(home, "agents", "coder.toml"),
      `
name = "coder"
default_model = "mini"
enabled_tools = ["read_file", "magic_tool"]
system_prompt = "..."
`,
    );
    const catalog = await loadModelCatalog({ repoRoot: null, homeRoot: home });
    await expect(loadDefinitions({ repoRoot: null, homeRoot: home }, catalog)).rejects.toThrow(/enables unknown tool/);
  });

  test("rejects an agent with neither inline prompt nor prompt file", async () => {
    const home = await createTempDir("goat-defs-");
    track(home);
    await writeMinimalCatalog(home);
    await mkdir(join(home, "agents"), { recursive: true });
    await writeFile(
      join(home, "agents", "coder.toml"),
      `
name = "coder"
default_model = "mini"
enabled_tools = ["read_file"]
`,
    );
    const catalog = await loadModelCatalog({ repoRoot: null, homeRoot: home });
    await expect(loadDefinitions({ repoRoot: null, homeRoot: home }, catalog)).rejects.toThrow(
      /exactly one of.*system_prompt/,
    );
  });

  test("rejects an agent with BOTH inline prompt and prompt file", async () => {
    const home = await createTempDir("goat-defs-");
    track(home);
    await writeMinimalCatalog(home);
    await mkdir(join(home, "agents"), { recursive: true });
    await writeFile(join(home, "agents", "coder.md"), "from file");
    await writeFile(
      join(home, "agents", "coder.toml"),
      `
name = "coder"
default_model = "mini"
enabled_tools = ["read_file"]
system_prompt = "inline"
system_prompt_file = "./coder.md"
`,
    );
    const catalog = await loadModelCatalog({ repoRoot: null, homeRoot: home });
    await expect(loadDefinitions({ repoRoot: null, homeRoot: home }, catalog)).rejects.toThrow(/exactly one of/);
  });

  test("rejects an agent referencing an unknown default model", async () => {
    const home = await createTempDir("goat-defs-");
    track(home);
    await writeMinimalCatalog(home);
    await mkdir(join(home, "agents"), { recursive: true });
    await writeFile(
      join(home, "agents", "coder.toml"),
      `
name = "coder"
default_model = "does-not-exist"
enabled_tools = ["read_file"]
system_prompt = "..."
`,
    );
    const catalog = await loadModelCatalog({ repoRoot: null, homeRoot: home });
    await expect(loadDefinitions({ repoRoot: null, homeRoot: home }, catalog)).rejects.toThrow(/unknown model/);
  });

  test("rejects a prompt definition with neither text nor text_file", async () => {
    const home = await createTempDir("goat-defs-");
    track(home);
    await writeMinimalCatalog(home);
    await mkdir(join(home, "prompts"), { recursive: true });
    await writeFile(
      join(home, "prompts", "summary.toml"),
      `
name = "summary"
description = "broken"
`,
    );
    const catalog = await loadModelCatalog({ repoRoot: null, homeRoot: home });
    await expect(loadDefinitions({ repoRoot: null, homeRoot: home }, catalog)).rejects.toThrow(/exactly one of.*text/);
  });

  test("applies agent defaults when optional fields are omitted", async () => {
    const home = await createTempDir("goat-defs-");
    track(home);
    await writeMinimalCatalog(home);
    await mkdir(join(home, "agents"), { recursive: true });
    await writeFile(
      join(home, "agents", "coder.toml"),
      `
name = "coder"
default_model = "mini"
enabled_tools = ["read_file"]
system_prompt = "..."
`,
    );
    const catalog = await loadModelCatalog({ repoRoot: null, homeRoot: home });
    const defs = await loadDefinitions({ repoRoot: null, homeRoot: home }, catalog);
    const coder = defs.agents.get("coder");
    expect(coder).toBeDefined();
    expect(coder?.max_output_tokens).toBe(12000);
    expect(coder?.compact_at_tokens).toBe(180000);
    expect(coder?.default_effort).toBeNull();
    expect(coder?.run_timeout).toBeNull();
  });
});

describe("listDefinitionFiles shadowing", () => {
  test("repo layer shadows home entries of the same name", async () => {
    const home = await createTempDir("goat-defs-home-");
    const repo = await createTempDir("goat-defs-repo-");
    track(home, repo);
    await mkdir(join(home, "agents"), { recursive: true });
    await mkdir(join(repo, "agents"), { recursive: true });
    await writeFile(join(home, "agents", "coder.toml"), "# home");
    await writeFile(join(repo, "agents", "coder.toml"), "# repo");
    await writeFile(join(home, "agents", "reviewer.toml"), "# reviewer only in home");

    const files = await listDefinitionFiles({ repoRoot: repo, homeRoot: home }, "agents");
    const names = files.map((file) => file.name);
    expect(names).toEqual(["coder", "reviewer"]);
    const coder = files.find((file) => file.name === "coder");
    expect(coder?.path).toBe(join(repo, "agents", "coder.toml"));
  });
});
