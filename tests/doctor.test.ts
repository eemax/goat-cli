import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runDoctor } from "../src/doctor.js";
import { createTempDir, useCleanup } from "./helpers.js";

const { track } = useCleanup();

async function makeRepo(options?: { goatToml?: string; modelsToml?: string; agentToml?: string }): Promise<{
  repoRoot: string;
  homeRoot: string;
  env: NodeJS.ProcessEnv;
}> {
  const repoRoot = await createTempDir("goat-doctor-repo-");
  const homeRoot = await createTempDir("goat-doctor-home-");
  track(repoRoot, homeRoot);
  await mkdir(join(repoRoot, "agents"), { recursive: true });
  await writeFile(
    join(repoRoot, "goat.toml"),
    options?.goatToml ??
      `
[defaults]
agent = "coder"
`,
  );
  await writeFile(
    join(repoRoot, "models.toml"),
    options?.modelsToml ??
      `
[[models]]
id = "gpt-5.4-mini"
aliases = ["mini"]
`,
  );
  await writeFile(
    join(repoRoot, "agents", "coder.toml"),
    options?.agentToml ??
      `
name = "coder"
default_model = "mini"
enabled_tools = ["read_file"]
system_prompt = "Coder."
`,
  );
  return {
    repoRoot,
    homeRoot,
    env: {
      GOAT_HOME_ROOT: homeRoot,
      OPENAI_API_KEY: "doctor-test-key",
      PATH: process.env.PATH,
    },
  };
}

describe("runDoctor", () => {
  test("reports PASS openai_credentials when API key comes from the injected env", async () => {
    const { repoRoot, env } = await makeRepo();
    const output = await runDoctor(repoRoot, env, {
      fetchImpl: async () => new Response(null, { status: 200 }),
    });
    expect(output.exitCode).toBe(0);
    expect(output.stdout).toContain("PASS openai_credentials");
    expect(output.stdout).toContain("PASS openai_ping");
  });

  test("reports FAIL openai_credentials when no API key is available", async () => {
    const { repoRoot, env } = await makeRepo();
    const strippedEnv = { GOAT_HOME_ROOT: env.GOAT_HOME_ROOT, PATH: env.PATH };
    const output = await runDoctor(repoRoot, strippedEnv, {
      fetchImpl: async () => new Response(null, { status: 200 }),
    });
    expect(output.exitCode).toBe(11);
    expect(output.stdout).toContain("FAIL openai_credentials");
    // When credentials fail we should never have attempted the ping.
    expect(output.stdout).not.toContain("openai_ping");
  });

  test("reports FAIL openai_ping with HTTP status when the probe returns non-2xx", async () => {
    const { repoRoot, env } = await makeRepo();
    const output = await runDoctor(repoRoot, env, {
      fetchImpl: async () => new Response(null, { status: 401 }),
    });
    expect(output.exitCode).toBe(11);
    expect(output.stdout).toContain("PASS openai_credentials");
    expect(output.stdout).toContain("FAIL openai_ping: HTTP 401");
  });

  test("reports FAIL openai_ping when fetch throws", async () => {
    const { repoRoot, env } = await makeRepo();
    const output = await runDoctor(repoRoot, env, {
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    expect(output.exitCode).toBe(11);
    expect(output.stdout).toContain("FAIL openai_ping");
    expect(output.stdout).toContain("network down");
  });

  test("reports FAIL definitions when an agent has an invalid schema", async () => {
    const { repoRoot, env } = await makeRepo({
      agentToml: `
name = "coder"
default_model = "mini"
enabled_tools = []
system_prompt = "Empty tools — invalid."
`,
    });
    const output = await runDoctor(repoRoot, env, {
      fetchImpl: async () => new Response(null, { status: 200 }),
    });
    expect(output.exitCode).toBe(11);
    expect(output.stdout).toContain("FAIL definitions");
  });

  test("omits web_search checks when not enabled", async () => {
    const { repoRoot, env } = await makeRepo();
    const output = await runDoctor(repoRoot, env, {
      fetchImpl: async () => new Response(null, { status: 200 }),
    });
    expect(output.stdout).not.toContain("web_search_credentials");
  });

  test("reports FAIL web_search_credentials when enabled without a key", async () => {
    const { repoRoot, env } = await makeRepo({
      goatToml: `
[defaults]
agent = "coder"

[tools.web_search]
enabled = true
`,
    });
    const cleanedEnv = { ...env };
    delete cleanedEnv.EXA_API_KEY;
    const output = await runDoctor(repoRoot, cleanedEnv, {
      fetchImpl: async () => new Response(null, { status: 200 }),
    });
    expect(output.exitCode).toBe(11);
    expect(output.stdout).toContain("FAIL web_search_credentials");
  });

  test("reports PASS web_search_credentials when EXA_API_KEY is present", async () => {
    const { repoRoot, env } = await makeRepo({
      goatToml: `
[defaults]
agent = "coder"

[tools.web_search]
enabled = true
`,
    });
    const output = await runDoctor(
      repoRoot,
      { ...env, EXA_API_KEY: "exa-secret" },
      { fetchImpl: async () => new Response(null, { status: 200 }) },
    );
    expect(output.stdout).toContain("PASS web_search_credentials");
  });

  test("honours deps.env over the explicit env parameter when both are provided", async () => {
    // Mirrors how `runApp` composes `env` + `deps.env`. If both set, `deps.env`
    // should still win so app.ts callers see the same behaviour as before.
    const { repoRoot, env } = await makeRepo();
    const misleadingEnv = { GOAT_HOME_ROOT: env.GOAT_HOME_ROOT, PATH: env.PATH };
    const output = await runDoctor(repoRoot, misleadingEnv, {
      env,
      fetchImpl: async () => new Response(null, { status: 200 }),
    });
    expect(output.exitCode).toBe(0);
    expect(output.stdout).toContain("PASS openai_credentials");
  });
});
