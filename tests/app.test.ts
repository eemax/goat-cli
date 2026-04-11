import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import { runApp } from "../src/app.js";
import { ExitCode, providerError } from "../src/errors.js";
import type { ProviderClient, ProviderRequest, ProviderTurnResult } from "../src/provider.js";
import { appendMessages, createSession, loadSessionMeta, writeSessionMeta } from "../src/session.js";
import type { MessageRecord } from "../src/types.js";
import { createTempDir, FakeProvider } from "./helpers.js";

class MemoryWritable extends Writable {
  public text = "";

  public override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.text += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    callback();
  }
}

const cleanup: string[] = [];

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(async () => {
  process.exitCode = undefined;
  while (cleanup.length > 0) {
    const path = cleanup.pop();
    if (path) {
      await rm(path, { recursive: true, force: true });
    }
  }
});

async function createRepoFixture(options?: { modelsToml?: string; agentToml?: string }): Promise<{
  repoRoot: string;
  homeRoot: string;
}> {
  const repoRoot = await createTempDir("goat-repo-");
  const homeRoot = await createTempDir("goat-home-");
  cleanup.push(repoRoot, homeRoot);

  await mkdir(join(repoRoot, "agents"), { recursive: true });
  await mkdir(join(repoRoot, "roles"), { recursive: true });
  await mkdir(join(repoRoot, "prompts"), { recursive: true });
  await writeFile(
    join(repoRoot, "goat.toml"),
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
enabled_tools = ["read_file", "write_file"]
system_prompt = "You are the coding agent."
`,
  );

  return { repoRoot, homeRoot };
}

async function runCli(
  argv: string[],
  provider: ProviderClient,
  repoRoot: string,
  homeRoot: string,
  stdinText = "",
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
}> {
  const stderr = new MemoryWritable();
  const stdin = Readable.from(stdinText ? [stdinText] : []);
  (stdin as Readable & { isTTY?: boolean }).isTTY = false;
  const output = await runApp(argv, stdin, stderr, {
    processCwd: repoRoot,
    env: {
      ...process.env,
      GOAT_HOME_ROOT: homeRoot,
      OPENAI_API_KEY: "test-key",
    },
    createProvider: () => provider,
  });

  return {
    stdout: output.stdout,
    stderr: [stderr.text.trim(), output.stderr.join("\n").trim()].filter(Boolean).join("\n"),
    exitCode: output.exitCode,
  };
}

describe("app integration", () => {
  test("runs prompts, persists sessions, and resumes with `last`", async () => {
    const { repoRoot, homeRoot } = await createRepoFixture();
    const provider = new FakeProvider([
      {
        response_id: "resp-1",
        previous_response_id: null,
        status: "completed",
        output_text: "first answer",
        tool_calls: [],
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          reasoning_tokens: 0,
          cached_input_tokens: 0,
        },
        raw_response: {} as any,
      },
      {
        response_id: "resp-2",
        previous_response_id: null,
        status: "completed",
        output_text: "second answer",
        tool_calls: [],
        usage: {
          input_tokens: 11,
          output_tokens: 5,
          reasoning_tokens: 0,
          cached_input_tokens: 0,
        },
        raw_response: {} as any,
      },
    ]);

    const first = await runCli(["new", "inspect the repo"], provider, repoRoot, homeRoot);
    expect(first.stdout).toBe("first answer\n");
    expect(first.exitCode).toBe(0);

    const sessionsDir = join(homeRoot, "sessions");
    const sessionIds = await readdir(sessionsDir);
    expect(sessionIds).toHaveLength(1);
    const sessionId = sessionIds[0]!;

    const meta = JSON.parse(await readFile(join(sessionsDir, sessionId, "meta.json"), "utf8"));
    expect(meta.bound).toBe(true);
    expect(meta.message_count).toBe(2);
    expect(meta.agent_name).toBe("coder");

    const second = await runCli(["last", "keep going"], provider, repoRoot, homeRoot);
    expect(second.stdout).toBe("second answer\n");
    expect(second.exitCode).toBe(0);

    const runIds = await readdir(join(sessionsDir, sessionId, "runs"));
    expect(runIds).toHaveLength(2);
    const summary = JSON.parse(
      await readFile(join(sessionsDir, sessionId, "runs", runIds[0]!, "summary.json"), "utf8"),
    );
    expect(summary.status).toBe("completed");
  });

  test("plan mode simulates mutating tools instead of editing the workspace", async () => {
    const { repoRoot, homeRoot } = await createRepoFixture();
    const provider = new FakeProvider([
      {
        response_id: "resp-plan-1",
        previous_response_id: null,
        status: "completed",
        output_text: "I will prepare a file.",
        tool_calls: [
          {
            call_id: "call-write",
            name: "write_file",
            arguments: JSON.stringify({
              path: "note.txt",
              content: "planned content",
            }),
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          reasoning_tokens: 0,
          cached_input_tokens: 0,
        },
        raw_response: {} as any,
      },
      {
        response_id: "resp-plan-2",
        previous_response_id: "resp-plan-1",
        status: "completed",
        output_text: "Plan complete.",
        tool_calls: [],
        usage: {
          input_tokens: 12,
          output_tokens: 3,
          reasoning_tokens: 0,
          cached_input_tokens: 0,
        },
        raw_response: {} as any,
      },
    ]);

    const result = await runCli(["new", "--plan", "prepare the workspace"], provider, repoRoot, homeRoot);
    expect(result.stdout).toBe("Plan complete.\n");
    expect(result.exitCode).toBe(0);

    await expect(stat(join(repoRoot, "note.txt"))).rejects.toThrow();

    const sessionsDir = join(homeRoot, "sessions");
    const sessionId = (await readdir(sessionsDir))[0]!;
    const runId = (await readdir(join(sessionsDir, sessionId, "runs")))[0]!;
    const transcript = await readFile(join(sessionsDir, sessionId, "runs", runId, "transcript.jsonl"), "utf8");
    expect(transcript).toContain('"planned":true');
  });

  test("emits human-readable debug traces for provider turns and tool execution", async () => {
    const { repoRoot, homeRoot } = await createRepoFixture({
      agentToml: `
name = "coder"
default_model = "mini"
enabled_tools = ["bash"]
system_prompt = "You are the coding agent."
`,
    });
    const provider = new FakeProvider([
      {
        response_id: "resp-debug-1",
        previous_response_id: null,
        status: "completed",
        output_text: "I will inspect the workspace.",
        tool_calls: [
          {
            call_id: "call-bash",
            name: "bash",
            arguments: JSON.stringify({
              command: "pwd",
            }),
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          reasoning_tokens: 0,
          cached_input_tokens: 0,
        },
        raw_response: {} as any,
      },
      {
        response_id: "resp-debug-2",
        previous_response_id: "resp-debug-1",
        status: "completed",
        output_text: "Workspace inspected.",
        tool_calls: [],
        usage: {
          input_tokens: 8,
          output_tokens: 3,
          reasoning_tokens: 0,
          cached_input_tokens: 0,
        },
        raw_response: {} as any,
      },
    ]);

    const result = await runCli(["new", "--debug", "inspect the repo"], provider, repoRoot, homeRoot);
    expect(result.stdout).toBe("Workspace inspected.\n");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("[debug][session]");
    expect(result.stderr).toContain("[debug][context]");
    expect(result.stderr).toContain("[debug][provider]");
    expect(result.stderr).toContain("[debug][tool]");
    expect(result.stderr).toContain("request_index=1");
    expect(result.stderr).toContain("tool_name=bash");
    expect(result.stderr).toContain("command=pwd");
    expect(result.stderr).toContain("exit_code=0");
  });

  test("emits NDJSON debug traces in `--debug-json` mode", async () => {
    const { repoRoot, homeRoot } = await createRepoFixture({
      agentToml: `
name = "coder"
default_model = "mini"
enabled_tools = ["bash"]
system_prompt = "You are the coding agent."
`,
    });
    const provider = new FakeProvider([
      {
        response_id: "resp-json-1",
        previous_response_id: null,
        status: "completed",
        output_text: "I will inspect the workspace.",
        tool_calls: [
          {
            call_id: "call-bash",
            name: "bash",
            arguments: JSON.stringify({
              command: "pwd",
            }),
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          reasoning_tokens: 0,
          cached_input_tokens: 0,
        },
        raw_response: {} as any,
      },
      {
        response_id: "resp-json-2",
        previous_response_id: "resp-json-1",
        status: "completed",
        output_text: "Workspace inspected.",
        tool_calls: [],
        usage: {
          input_tokens: 8,
          output_tokens: 3,
          reasoning_tokens: 0,
          cached_input_tokens: 0,
        },
        raw_response: {} as any,
      },
    ]);

    const result = await runCli(["new", "--debug-json", "inspect the repo"], provider, repoRoot, homeRoot);
    expect(result.stdout).toBe("Workspace inspected.\n");
    expect(result.exitCode).toBe(0);

    const events = result.stderr
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            category: string;
            event: string;
            data: Record<string, unknown>;
          },
      );

    expect(events.some((event) => event.category === "session" && event.event === "resolved")).toBe(true);
    expect(events.some((event) => event.category === "provider" && event.event === "request")).toBe(true);
    expect(events.some((event) => event.category === "tool" && event.event === "finish")).toBe(true);
    expect(events.some((event) => event.category === "run" && event.event === "finished")).toBe(true);

    const requestEvent = events.find((event) => event.category === "provider" && event.event === "request");
    expect(requestEvent?.data.payload).toMatchObject({
      model: "gpt-5.4-mini",
      previous_response_id: null,
    });

    const toolEvent = events.find((event) => event.category === "tool" && event.event === "finish");
    expect(toolEvent?.data).toMatchObject({
      tool_name: "bash",
      exit_code: 0,
      command: "pwd",
    });
  });

  test("rejects missing cwd without creating it", async () => {
    const { repoRoot, homeRoot } = await createRepoFixture();
    const provider = new FakeProvider([]);
    const missingCwd = join(repoRoot, "missing", "workspace");

    const result = await runCli(["new", "--cwd", missingCwd, "inspect the repo"], provider, repoRoot, homeRoot);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("working directory");
    await expect(stat(missingCwd)).rejects.toThrow();
  });

  test("rejects switching agents on a bound session", async () => {
    const { repoRoot, homeRoot } = await createRepoFixture();
    await writeFile(
      join(repoRoot, "agents", "reviewer.toml"),
      `
name = "reviewer"
default_model = "mini"
enabled_tools = ["read_file"]
system_prompt = "You are the reviewer."
`,
    );

    const sessionsDir = join(homeRoot, "sessions");
    const session = await createSession(sessionsDir);
    const meta = await loadSessionMeta(sessionsDir, session.session_id);
    await writeSessionMeta(sessionsDir, {
      ...meta,
      bound: true,
      agent_name: "coder",
      model: "gpt-5.4-mini",
    });

    const provider = new FakeProvider([]);
    const result = await runCli(
      ["--session", session.session_id, "--agent", "reviewer", "inspect the repo"],
      provider,
      repoRoot,
      homeRoot,
    );

    expect(result.exitCode).toBe(ExitCode.config);
    expect(result.stderr).toContain("bound to agent `coder`");
    expect(provider.requests).toHaveLength(0);
  });

  test("fails with a session conflict before the first mutating tool and records the run", async () => {
    const { repoRoot, homeRoot } = await createRepoFixture();
    const sessionsDir = join(homeRoot, "sessions");
    const session = await createSession(sessionsDir);

    const provider: ProviderClient = {
      async runTurn(): Promise<ProviderTurnResult> {
        const meta = await loadSessionMeta(sessionsDir, session.session_id);
        await writeSessionMeta(sessionsDir, {
          ...meta,
          revision: meta.revision + 1,
          updated_at: "2026-04-10T00:00:00.000Z",
        });
        return {
          response_id: "resp-conflict-1",
          previous_response_id: null,
          status: "completed",
          output_text: "Preparing the workspace.",
          tool_calls: [
            {
              call_id: "call-write",
              name: "write_file",
              arguments: JSON.stringify({
                path: "note.txt",
                content: "hello",
              }),
            },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            reasoning_tokens: 0,
            cached_input_tokens: 0,
          },
          raw_response: {} as any,
        };
      },
    };

    const result = await runCli(
      ["--session", session.session_id, "prepare the workspace"],
      provider,
      repoRoot,
      homeRoot,
    );

    expect(result.exitCode).toBe(ExitCode.sessionConflict);
    expect(result.stderr).toContain("changed before the first mutating tool");
    await expect(stat(join(repoRoot, "note.txt"))).rejects.toThrow();

    const runId = (await readdir(join(sessionsDir, session.session_id, "runs")))[0]!;
    const runDir = join(sessionsDir, session.session_id, "runs", runId);
    const transcript = await readFile(join(runDir, "transcript.jsonl"), "utf8");
    const summary = JSON.parse(await readFile(join(runDir, "summary.json"), "utf8"));

    expect(transcript).toContain('"kind":"tool_call"');
    expect(transcript).not.toContain('"kind":"tool_result"');
    expect(summary.status).toBe("session_conflict");
    expect(summary.error.code).toBe("SESSION_CONFLICT");
  });

  test("persists provider failures as terminal audit records", async () => {
    const { repoRoot, homeRoot } = await createRepoFixture();
    const provider: ProviderClient = {
      async runTurn() {
        throw providerError("boom", {
          code: "connection_error",
          retryable: true,
        });
      },
    };

    const result = await runCli(["new", "inspect the repo"], provider, repoRoot, homeRoot);
    expect(result.exitCode).toBe(7);

    const sessionsDir = join(homeRoot, "sessions");
    const sessionId = (await readdir(sessionsDir))[0]!;
    const runId = (await readdir(join(sessionsDir, sessionId, "runs")))[0]!;
    const runDir = join(sessionsDir, sessionId, "runs", runId);
    const transcript = await readFile(join(runDir, "transcript.jsonl"), "utf8");
    const providerLog = await readFile(join(runDir, "provider.jsonl"), "utf8");
    const summary = JSON.parse(await readFile(join(runDir, "summary.json"), "utf8"));

    expect(transcript).toContain('"kind":"run_finished"');
    expect(transcript).toContain('"status":"failed"');
    expect(providerLog).toContain('"kind":"provider_error"');
    expect(providerLog).toContain('"error_code":"connection_error"');
    expect(summary.status).toBe("failed");
    expect(summary.error.message).toBe("boom");
  });

  test("fails clearly when provider emits invalid tool arguments", async () => {
    const { repoRoot, homeRoot } = await createRepoFixture({
      agentToml: `
name = "coder"
default_model = "mini"
enabled_tools = ["read_file"]
system_prompt = "You are the coding agent."
`,
    });
    const provider = new FakeProvider([
      {
        response_id: "resp-bad-args-1",
        previous_response_id: null,
        status: "completed",
        output_text: "I will inspect the workspace.",
        tool_calls: [
          {
            call_id: "call-bad-args",
            name: "read_file",
            arguments: `"note.txt"`,
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          reasoning_tokens: 0,
          cached_input_tokens: 0,
        },
        raw_response: {} as any,
      },
    ]);

    const result = await runCli(["new", "inspect the repo"], provider, repoRoot, homeRoot);
    expect(result.exitCode).toBe(ExitCode.providerFailure);
    expect(result.stderr).toContain("provider emitted non-object tool arguments");

    const sessionsDir = join(homeRoot, "sessions");
    const sessionId = (await readdir(sessionsDir))[0]!;
    const runId = (await readdir(join(sessionsDir, sessionId, "runs")))[0]!;
    const runDir = join(sessionsDir, sessionId, "runs", runId);
    const transcript = await readFile(join(runDir, "transcript.jsonl"), "utf8");
    const providerLog = await readFile(join(runDir, "provider.jsonl"), "utf8");
    const summary = JSON.parse(await readFile(join(runDir, "summary.json"), "utf8"));

    expect(transcript).toContain('"kind":"run_finished"');
    expect(transcript).not.toContain('"kind":"tool_call"');
    expect(providerLog).toContain('"kind":"provider_error"');
    expect(providerLog).toContain('"error_code":"invalid_tool_arguments"');
    expect(summary.status).toBe("failed");
    expect(summary.error.code).toBe("PROVIDER_FAILURE");
  });

  test("times out long provider turns and records a timed-out run summary", async () => {
    const { repoRoot, homeRoot } = await createRepoFixture({
      agentToml: `
name = "coder"
default_model = "mini"
run_timeout = "50ms"
enabled_tools = ["read_file"]
system_prompt = "You are the coding agent."
`,
    });

    const provider: ProviderClient = {
      async runTurn(request: ProviderRequest): Promise<ProviderTurnResult> {
        return await new Promise<ProviderTurnResult>((_resolve, reject) => {
          if (request.abortSignal?.aborted) {
            reject(request.abortSignal.reason);
            return;
          }

          request.abortSignal?.addEventListener(
            "abort",
            () => {
              reject(request.abortSignal?.reason ?? new Error("aborted"));
            },
            { once: true },
          );
        });
      },
    };

    const result = await runCli(["new", "inspect the repo"], provider, repoRoot, homeRoot);
    expect(result.exitCode).toBe(ExitCode.timeout);
    expect(result.stderr).toContain("run timed out");

    const sessionsDir = join(homeRoot, "sessions");
    const sessionId = (await readdir(sessionsDir))[0]!;
    const runId = (await readdir(join(sessionsDir, sessionId, "runs")))[0]!;
    const summary = JSON.parse(await readFile(join(sessionsDir, sessionId, "runs", runId, "summary.json"), "utf8"));

    expect(summary.status).toBe("timed_out");
    expect(summary.termination_reason).toBe("timeout");
    expect(summary.error.code).toBe("TIMEOUT");
  });

  test("session commands do not load broken definitions", async () => {
    const { repoRoot, homeRoot } = await createRepoFixture({
      agentToml: `
name = "coder"
default_model = "mini"
enabled_tools = ["read_file"]
`,
    });

    const result = await runCli(["sessions", "new"], new FakeProvider([]), repoRoot, homeRoot);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).not.toBe("");
  });

  test("translates canonical model ids to provider model ids", async () => {
    const { repoRoot, homeRoot } = await createRepoFixture({
      modelsToml: `
[[models]]
id = "friendly-mini"
provider_model = "gpt-5.4-mini"
aliases = ["mini"]
`,
      agentToml: `
name = "coder"
default_model = "mini"
enabled_tools = ["read_file", "write_file"]
system_prompt = "You are the coding agent."
`,
    });
    const provider = new FakeProvider([
      {
        response_id: "resp-1",
        previous_response_id: null,
        status: "completed",
        output_text: "ok",
        tool_calls: [],
        usage: null,
        raw_response: {} as any,
      },
    ]);

    const result = await runCli(["new", "inspect the repo"], provider, repoRoot, homeRoot);
    expect(result.exitCode).toBe(0);
    expect(provider.requests[0]?.model).toBe("gpt-5.4-mini");

    const sessionsDir = join(homeRoot, "sessions");
    const sessionId = (await readdir(sessionsDir))[0]!;
    const meta = JSON.parse(await readFile(join(sessionsDir, sessionId, "meta.json"), "utf8"));
    expect(meta.model).toBe("friendly-mini");
  });

  test("guards on the fully assembled prompt size before sending the provider request", async () => {
    const { repoRoot, homeRoot } = await createRepoFixture({
      agentToml: `
name = "coder"
default_model = "mini"
compact_at_tokens = "260"
enabled_tools = ["read_file"]
system_prompt = "${"A".repeat(260)}"
`,
    });

    const sessionsDir = join(homeRoot, "sessions");
    const session = await createSession(sessionsDir);
    const history: MessageRecord[] = Array.from({ length: 8 }, (_, index) => [
      {
        v: 1 as const,
        ts: new Date().toISOString(),
        kind: "message" as const,
        run_id: `old-${index + 1}`,
        role: "user" as const,
        source: "cli_arg" as const,
        content: "repeat the same user history message",
      },
      {
        v: 1 as const,
        ts: new Date().toISOString(),
        kind: "message" as const,
        run_id: `old-${index + 1}`,
        role: "assistant" as const,
        source: "assistant_final" as const,
        content: "repeat the same assistant history update",
      },
    ]).flat();
    await appendMessages(sessionsDir, session.session_id, [...history]);
    const meta = await loadSessionMeta(sessionsDir, session.session_id);
    await writeSessionMeta(sessionsDir, {
      ...meta,
      bound: true,
      revision: 1,
      message_count: history.length,
      agent_name: "coder",
      model: "gpt-5.4-mini",
    });

    const provider = new FakeProvider([
      {
        response_id: "resp-compact-1",
        previous_response_id: null,
        status: "completed",
        output_text: "compacted answer",
        tool_calls: [],
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          reasoning_tokens: 0,
          cached_input_tokens: 0,
        },
        raw_response: {} as any,
      },
    ]);

    const result = await runCli(["--session", session.session_id, "continue"], provider, repoRoot, homeRoot);
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("compact_at_tokens");
    expect(provider.requests).toHaveLength(0);
  });
});

describe("goat doctor", () => {
  async function runDoctorCli(
    repoRoot: string,
    homeRoot: string,
    options?: { fetchImpl?: typeof fetch; goatToml?: string },
  ): Promise<{ stdout: string; exitCode: number | undefined }> {
    if (options?.goatToml !== undefined) {
      await writeFile(join(repoRoot, "goat.toml"), options.goatToml);
    }
    const stderr = new MemoryWritable();
    const stdin = Readable.from([]);
    (stdin as Readable & { isTTY?: boolean }).isTTY = false;
    const output = await runApp(["doctor"], stdin, stderr, {
      processCwd: repoRoot,
      env: {
        ...process.env,
        GOAT_HOME_ROOT: homeRoot,
        OPENAI_API_KEY: "test-key",
      },
      fetchImpl: options?.fetchImpl ?? (async () => new Response(null, { status: 200 })),
    });

    return { stdout: output.stdout, exitCode: output.exitCode };
  }

  test("reports real config, models, and definitions checks", async () => {
    const { repoRoot, homeRoot } = await createRepoFixture();
    const { stdout, exitCode } = await runDoctorCli(repoRoot, homeRoot);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("PASS config");
    expect(stdout).toContain("PASS models");
    expect(stdout).toContain("PASS definitions");
    expect(stdout).toContain("SKIP compaction_model");
    expect(stdout).toContain("SKIP compaction_prompt");
    expect(stdout).toContain("PASS sessions_dir");
    expect(stdout).toContain("PASS openai_credentials");
    expect(stdout).toContain("PASS openai_ping");
  });

  test("fails config check when goat.toml is invalid", async () => {
    const { repoRoot, homeRoot } = await createRepoFixture();
    const { stdout, exitCode } = await runDoctorCli(repoRoot, homeRoot, {
      goatToml: "[[[not valid toml",
    });
    expect(exitCode).toBe(11);
    expect(stdout).toContain("FAIL config");
    expect(stdout).not.toContain("PASS models");
  });

  test("fails when compaction model is set but unknown", async () => {
    const { repoRoot, homeRoot } = await createRepoFixture();
    const { stdout, exitCode } = await runDoctorCli(repoRoot, homeRoot, {
      goatToml: `
[defaults]
agent = "coder"

[compaction]
model = "no-such-model"
`,
    });
    expect(exitCode).toBe(11);
    expect(stdout).toContain("FAIL compaction_model");
  });
});
