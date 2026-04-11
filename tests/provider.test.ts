import { describe, expect, test } from "bun:test";
import { APIConnectionTimeoutError, APIError, RateLimitError } from "openai";

import { timeoutError } from "../src/errors.js";
import { OpenAIResponsesProvider } from "../src/provider.js";

describe("OpenAIResponsesProvider", () => {
  test("extracts usage, tool calls, and text deltas from streamed responses", async () => {
    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      baseURL: "https://api.openai.com/v1",
      timeoutSeconds: 45,
    });

    const deltas: string[] = [];
    const requests: Array<{ request: unknown; options: unknown }> = [];
    const finalResponse = {
      id: "resp-1",
      previous_response_id: "resp-0",
      status: "completed",
      output_text: "Hello",
      output: [
        {
          type: "function_call",
          call_id: "call-1",
          name: "read_file",
          arguments: '{"path":"note.txt"}',
        },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        output_tokens_details: {
          reasoning_tokens: 2,
        },
        input_tokens_details: {
          cached_tokens: 3,
        },
      },
    };

    (provider as any).client = {
      responses: {
        stream(request: unknown, options: unknown) {
          requests.push({ request, options });
          return {
            on(event: string, handler: (event: unknown) => void) {
              if (event === "response.output_text.delta") {
                handler({ type: event, delta: "Hel" });
                handler({ type: event, delta: "lo" });
              }
            },
            async finalResponse() {
              return finalResponse;
            },
          };
        },
      },
    };

    const result = await provider.runTurn({
      model: "gpt-5.4-mini",
      instructions: "Test instructions",
      input: [],
      previous_response_id: "resp-0",
      effort: "medium",
      max_output_tokens: 1234,
      tools: [
        {
          type: "function",
          name: "read_file",
          description: "Read a file.",
          strict: true,
          parameters: { type: "object" },
        },
      ],
      onTextDelta: (delta) => {
        deltas.push(delta);
      },
    });

    expect(deltas).toEqual(["Hel", "lo"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.request).toMatchObject({
      model: "gpt-5.4-mini",
      previous_response_id: "resp-0",
      max_output_tokens: 1234,
      parallel_tool_calls: false,
      stream: true,
      reasoning: {
        effort: "medium",
      },
    });
    expect(result.response_id).toBe("resp-1");
    expect(result.previous_response_id).toBe("resp-0");
    expect(result.tool_calls).toEqual([
      {
        call_id: "call-1",
        name: "read_file",
        arguments: '{"path":"note.txt"}',
      },
    ]);
    expect(result.usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      reasoning_tokens: 2,
      cached_input_tokens: 3,
    });
  });

  test("rethrows abort reasons so timeout classification survives", async () => {
    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      baseURL: "https://api.openai.com/v1",
      timeoutSeconds: 45,
    });

    (provider as any).client = {
      responses: {
        stream() {
          throw new Error("aborted");
        },
      },
    };

    const controller = new AbortController();
    controller.abort(timeoutError("run timed out"));

    await expect(
      provider.runTurn({
        model: "gpt-5.4-mini",
        instructions: "Test instructions",
        input: [],
        previous_response_id: null,
        effort: null,
        max_output_tokens: null,
        tools: [],
        abortSignal: controller.signal,
      }),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
    });
  });

  test("maps provider errors to GoatError details", async () => {
    const cases = [
      {
        error: new RateLimitError(429, { message: "slow down" } as any, undefined, new Headers()),
        code: "rate_limit",
        retryable: true,
      },
      {
        error: new APIConnectionTimeoutError({ message: "timed out upstream" }),
        code: "timeout",
        retryable: true,
      },
      {
        error: new APIError(400, { message: "bad request" } as any, undefined, new Headers()),
        code: "api_error",
        retryable: false,
      },
    ];

    for (const testCase of cases) {
      const provider = new OpenAIResponsesProvider({
        apiKey: "test-key",
        baseURL: "https://api.openai.com/v1",
        timeoutSeconds: 45,
      });

      (provider as any).client = {
        responses: {
          stream() {
            throw testCase.error;
          },
        },
      };

      let thrown: unknown;
      try {
        await provider.runTurn({
          model: "gpt-5.4-mini",
          instructions: "Test instructions",
          input: [],
          previous_response_id: null,
          effort: null,
          max_output_tokens: null,
          tools: [],
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toMatchObject({
        code: "PROVIDER_FAILURE",
        details: {
          code: testCase.code,
          retryable: testCase.retryable,
        },
      });
    }
  });
});
