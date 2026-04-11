import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentLoopError, runAgentLoop } from "../src/agent.js";
import { ArtifactStore } from "../src/artifacts.js";
import { exportProviderTools } from "../src/harness.js";
import type { ProviderClient, ProviderRequest, ProviderTurnResult } from "../src/provider.js";
import { createTempDir, FakeProvider, testToolsConfig, useCleanup } from "./helpers.js";

const { track } = useCleanup();

async function createToolContext() {
  const runRoot = await createTempDir("goat-agent-");
  track(runRoot);
  const cwd = join(runRoot, "workspace");
  await mkdir(cwd, { recursive: true });
  return {
    cwd,
    planMode: false,
    config: testToolsConfig,
    catastrophicOutputLimit: 1024,
    artifacts: new ArtifactStore(join(runRoot, "artifacts")),
    runRoot,
    ensureMutationLock: async () => undefined,
  };
}

describe("runAgentLoop", () => {
  test("continues the responses loop through tool calls", async () => {
    const toolContext = await createToolContext();
    await writeFile(join(toolContext.cwd, "note.txt"), "hello\n");
    const provider = new FakeProvider([
      {
        response_id: "resp-1",
        previous_response_id: null,
        status: "completed",
        output_text: "I will inspect the file.",
        tool_calls: [
          {
            call_id: "call-1",
            name: "read_file",
            arguments: JSON.stringify({ path: "note.txt" }),
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          reasoning_tokens: 0,
          cached_input_tokens: 0,
        },
        raw_response: {} as any,
      },
      {
        response_id: "resp-2",
        previous_response_id: "resp-1",
        status: "completed",
        output_text: "The file says hello.",
        tool_calls: [],
        usage: {
          input_tokens: 12,
          output_tokens: 6,
          reasoning_tokens: 0,
          cached_input_tokens: 0,
        },
        raw_response: {} as any,
      },
    ]);

    const result = await runAgentLoop({
      runId: "run-test",
      provider,
      model: "gpt-5.4-mini",
      instructions: "You are a coding agent.",
      initialInput: [{ role: "user", content: "Inspect note.txt", type: "message" }],
      tools: exportProviderTools(["read_file"]),
      enabledTools: ["read_file"],
      effort: "medium",
      maxOutputTokens: 12000,
      toolContext,
    });

    expect(result.final_text).toBe("The file says hello.");
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.previous_response_id).toBe("resp-1");
    expect(provider.requests[1]?.input[0]).toMatchObject({
      type: "function_call_output",
      call_id: "call-1",
    });
    expect(result.transcript.filter((record) => record.kind === "tool_result")).toHaveLength(1);
    for (const record of result.transcript) {
      expect(record.run_id).toBe("run-test");
    }
  });

  test("fails fast when provider emits non-object tool arguments", async () => {
    const toolContext = await createToolContext();
    const provider = new FakeProvider([
      {
        response_id: "resp-1",
        previous_response_id: null,
        status: "completed",
        output_text: "I will inspect the file and validate args.",
        tool_calls: [
          {
            call_id: "call-bad",
            name: "read_file",
            arguments: `"note.txt"`,
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          reasoning_tokens: 1,
          cached_input_tokens: 2,
        },
        raw_response: {} as any,
      },
    ]);

    await expect(
      runAgentLoop({
        runId: "run-multi",
        provider,
        model: "gpt-5.4-mini",
        instructions: "You are a coding agent.",
        initialInput: [{ role: "user", content: "Inspect note.txt", type: "message" }],
        tools: exportProviderTools(["read_file"]),
        enabledTools: ["read_file"],
        effort: "medium",
        maxOutputTokens: 12000,
        toolContext,
      }),
    ).rejects.toMatchObject({
      cause: {
        code: "PROVIDER_FAILURE",
        details: {
          code: "invalid_tool_arguments",
          retryable: false,
        },
      },
    });
  });

  test("wraps partial state when a later provider turn fails", async () => {
    const toolContext = await createToolContext();
    await writeFile(join(toolContext.cwd, "note.txt"), "hello\nworld\n");

    const requests: ProviderRequest[] = [];
    let callCount = 0;
    const provider: ProviderClient = {
      async runTurn(request: ProviderRequest): Promise<ProviderTurnResult> {
        requests.push(request);
        callCount += 1;
        if (callCount === 1) {
          return {
            response_id: "resp-1",
            previous_response_id: null,
            status: "completed",
            output_text: "First tool call.",
            tool_calls: [
              {
                call_id: "call-1",
                name: "read_file",
                arguments: JSON.stringify({ path: "note.txt" }),
              },
            ],
            usage: {
              input_tokens: 10,
              output_tokens: 4,
              reasoning_tokens: 1,
              cached_input_tokens: 0,
            },
            raw_response: {} as any,
          };
        }
        if (callCount === 2) {
          return {
            response_id: "resp-2",
            previous_response_id: "resp-1",
            status: "completed",
            output_text: "Second tool call.",
            tool_calls: [
              {
                call_id: "call-2",
                name: "read_file",
                arguments: JSON.stringify({ path: "note.txt", offset_line: 2, limit_lines: 1 }),
              },
            ],
            usage: {
              input_tokens: 7,
              output_tokens: 3,
              reasoning_tokens: 0,
              cached_input_tokens: 2,
            },
            raw_response: {} as any,
          };
        }
        throw new Error("provider blew up");
      },
    };

    let thrown: unknown;
    try {
      await runAgentLoop({
        runId: "run-fail",
        provider,
        model: "gpt-5.4-mini",
        instructions: "You are a coding agent.",
        initialInput: [{ role: "user", content: "Inspect note.txt", type: "message" }],
        tools: exportProviderTools(["read_file"]),
        enabledTools: ["read_file"],
        effort: "medium",
        maxOutputTokens: 12000,
        toolContext,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AgentLoopError);
    const loopError = thrown as AgentLoopError;
    expect(loopError.cause).toBeInstanceOf(Error);
    expect((loopError.cause as Error).message).toBe("provider blew up");
    expect(requests).toHaveLength(3);
    expect(loopError.state.last_response_id).toBe("resp-2");
    expect(loopError.state.provider_turns).toHaveLength(2);
    expect(loopError.state.usage).toEqual({
      input_tokens: 17,
      output_tokens: 7,
      reasoning_tokens: 1,
      cached_input_tokens: 2,
    });
    expect(loopError.state.transcript.filter((record) => record.kind === "tool_result")).toHaveLength(2);
  });
});
