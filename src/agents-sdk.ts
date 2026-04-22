import {
  type AgentInputItem,
  type AgentOutputItem,
  MaxTurnsExceededError,
  type ModelResponse,
  OpenAIProvider,
  type RunItem,
  Runner,
  type RunStreamEvent,
  Agent as SdkAgent,
} from "@openai/agents";
import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  InternalServerError,
  RateLimitError,
} from "openai";
import { AgentLoopError, type AgentLoopResult } from "./agent.js";
import { type DebugSink, debugErrorData, sanitizeDebugData, sanitizeToolArguments } from "./debug.js";
import { providerError } from "./errors.js";
import { exportAgentsSdkTools, type ToolContext, type ToolExecutionEvent } from "./harness.js";
import type { ProviderToolCall, ProviderTurnResult } from "./provider.js";
import type { Effort, ProviderUsage, ToolEnvelope, TranscriptRecord } from "./types.js";
import { nowIso } from "./utils.js";

type AgentsSdkLoopConfig = {
  apiKey: string;
  baseURL: string;
  timeoutSeconds: number;
};

type AgentsSdkLoopParams = {
  runId: string;
  config: AgentsSdkLoopConfig;
  model: string;
  instructions: string;
  initialInput: AgentInputItem[];
  enabledTools: string[];
  effort: Effort | null;
  maxOutputTokens: number | null;
  toolContext: ToolContext;
  debug?: DebugSink;
  onTextDelta?: (delta: string) => void | Promise<void>;
};

type RecordLike = Record<string, unknown>;
type OpenAIProviderClient = NonNullable<NonNullable<ConstructorParameters<typeof OpenAIProvider>[0]>["openAIClient"]>;

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function outputToString(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  return JSON.stringify(output);
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return isRecord(parsed) ? parsed : {};
}

function parseToolEnvelope(output: unknown): ToolEnvelope {
  try {
    const parsed = typeof output === "string" ? JSON.parse(output) : output;
    if (isRecord(parsed) && typeof parsed.ok === "boolean" && typeof parsed.summary === "string") {
      return parsed as ToolEnvelope;
    }
  } catch {
    // Fall through to a generic envelope for non-Goat tool outputs.
  }

  return {
    ok: true,
    summary: outputToString(output),
  };
}

function sumDetails(details: Array<Record<string, number>>, keys: string[]): number {
  return details.reduce((total, entry) => total + keys.reduce((sum, key) => sum + (entry[key] ?? 0), 0), 0);
}

function normalizeAgentsUsage(response: ModelResponse): ProviderUsage | null {
  const usage = response.usage;
  if (!usage) {
    return null;
  }

  return {
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    reasoning_tokens: sumDetails(usage.outputTokensDetails ?? [], ["reasoning_tokens", "reasoningTokens"]),
    cached_input_tokens: sumDetails(usage.inputTokensDetails ?? [], ["cached_tokens", "cachedTokens"]),
  };
}

function addUsage(target: ProviderUsage, usage: ProviderUsage | null): boolean {
  if (!usage) {
    return false;
  }
  target.input_tokens += usage.input_tokens;
  target.output_tokens += usage.output_tokens;
  target.reasoning_tokens += usage.reasoning_tokens;
  target.cached_input_tokens += usage.cached_input_tokens;
  return true;
}

function textFromOutputItem(item: AgentOutputItem): string {
  if (item.type !== "message" || item.role !== "assistant") {
    return "";
  }

  return item.content
    .map((content) => {
      if (content.type === "output_text") {
        return content.text;
      }
      if (content.type === "refusal") {
        return content.refusal;
      }
      return "";
    })
    .join("");
}

function textFromOutput(output: AgentOutputItem[]): string {
  return output.map(textFromOutputItem).join("");
}

function toolCallsFromOutput(output: AgentOutputItem[]): ProviderToolCall[] {
  return output
    .filter((item) => item.type === "function_call")
    .map((item) => ({
      call_id: item.callId,
      name: item.name,
      arguments: item.arguments,
    }));
}

function providerTurnsFromResponses(responses: ModelResponse[]): ProviderTurnResult[] {
  return responses.map((response, index) => ({
    response_id: response.responseId ?? null,
    previous_response_id: index > 0 ? (responses[index - 1]?.responseId ?? null) : null,
    status: "completed",
    output_text: textFromOutput(response.output),
    tool_calls: toolCallsFromOutput(response.output),
    usage: normalizeAgentsUsage(response),
    raw_response: response as never,
  }));
}

function rawItemFromRunItem(item: RunItem): unknown {
  return (item as RunItem & { rawItem?: unknown }).rawItem;
}

function messageTextFromRunItem(item: RunItem): string {
  if (item.type !== "message_output_item") {
    return "";
  }
  const rawItem = rawItemFromRunItem(item);
  if (!isRecord(rawItem) || rawItem.role !== "assistant" || !Array.isArray(rawItem.content)) {
    return "";
  }

  return rawItem.content
    .map((content) => {
      if (!isRecord(content)) {
        return "";
      }
      if (content.type === "output_text" && typeof content.text === "string") {
        return content.text;
      }
      if (content.type === "refusal" && typeof content.refusal === "string") {
        return content.refusal;
      }
      return "";
    })
    .join("");
}

function functionCallFromRunItem(item: RunItem): ProviderToolCall | null {
  if (item.type !== "tool_call_item") {
    return null;
  }
  const rawItem = rawItemFromRunItem(item);
  if (
    !isRecord(rawItem) ||
    rawItem.type !== "function_call" ||
    typeof rawItem.callId !== "string" ||
    typeof rawItem.name !== "string" ||
    typeof rawItem.arguments !== "string"
  ) {
    return null;
  }

  return {
    call_id: rawItem.callId,
    name: rawItem.name,
    arguments: rawItem.arguments,
  };
}

function functionCallOutputFromRunItem(item: RunItem): { call_id: string; name: string; output: unknown } | null {
  if (item.type !== "tool_call_output_item") {
    return null;
  }
  const rawItem = rawItemFromRunItem(item);
  if (
    !isRecord(rawItem) ||
    rawItem.type !== "function_call_result" ||
    typeof rawItem.callId !== "string" ||
    typeof rawItem.name !== "string"
  ) {
    return null;
  }

  return {
    call_id: rawItem.callId,
    name: rawItem.name,
    output: rawItem.output,
  };
}

function buildTranscript(
  runId: string,
  items: RunItem[],
  toolExecutions: Map<string, ToolExecutionEvent>,
  planMode: boolean,
): TranscriptRecord[] {
  const transcript: TranscriptRecord[] = [];
  let pendingAssistantText: string | null = null;

  const flushAssistantText = (phase: "final" | "tool_request") => {
    if (pendingAssistantText === null) {
      return;
    }
    if (pendingAssistantText) {
      transcript.push({
        v: 1,
        ts: nowIso(),
        kind: "message",
        run_id: runId,
        role: "assistant",
        phase,
        content: pendingAssistantText,
        tool_calls: [],
      });
    }
    pendingAssistantText = null;
  };

  for (const item of items) {
    if (item.type === "message_output_item") {
      flushAssistantText("final");
      pendingAssistantText = messageTextFromRunItem(item);
      continue;
    }

    const call = functionCallFromRunItem(item);
    if (call) {
      const parsedArguments = parseJsonObject(call.arguments);
      transcript.push({
        v: 1,
        ts: nowIso(),
        kind: "message",
        run_id: runId,
        role: "assistant",
        phase: "tool_request",
        content: pendingAssistantText ?? "",
        tool_calls: [
          {
            id: call.call_id,
            name: call.name,
            arguments: parsedArguments,
          },
        ],
      });
      pendingAssistantText = null;
      transcript.push({
        v: 1,
        ts: nowIso(),
        kind: "tool_call",
        run_id: runId,
        tool_call_id: call.call_id,
        tool_name: call.name,
        arguments: parsedArguments,
        planned: planMode,
      });
      continue;
    }

    const output = functionCallOutputFromRunItem(item);
    if (output) {
      const execution = toolExecutions.get(output.call_id);
      const envelope = parseToolEnvelope(output.output);
      transcript.push({
        v: 1,
        ts: nowIso(),
        kind: "tool_result",
        run_id: runId,
        tool_call_id: output.call_id,
        tool_name: output.name,
        duration_s: Number(((execution?.duration_ms ?? 0) / 1000).toFixed(3)),
        planned: planMode,
        ok: envelope.ok,
        summary: envelope.summary,
        envelope,
      });
    }
  }

  flushAssistantText("final");
  return transcript;
}

function isRetryableError(error: unknown): boolean {
  return (
    error instanceof APIConnectionError ||
    error instanceof APIConnectionTimeoutError ||
    error instanceof RateLimitError ||
    error instanceof InternalServerError
  );
}

function errorCodeFrom(error: unknown): string {
  if (error instanceof RateLimitError) {
    return "rate_limit";
  }
  if (error instanceof APIConnectionTimeoutError) {
    return "timeout";
  }
  if (error instanceof APIConnectionError) {
    return "connection_error";
  }
  if (error instanceof InternalServerError) {
    return "server_error";
  }
  if (error instanceof APIError) {
    return error.code ?? "api_error";
  }
  if (error instanceof MaxTurnsExceededError) {
    return "max_turns_exceeded";
  }
  return "provider_error";
}

function normalizeError(error: unknown, abortSignal?: AbortSignal): unknown {
  if (abortSignal?.aborted && abortSignal.reason !== undefined) {
    return abortSignal.reason;
  }
  if (
    error instanceof APIError ||
    error instanceof APIConnectionError ||
    error instanceof APIConnectionTimeoutError ||
    error instanceof RateLimitError ||
    error instanceof InternalServerError ||
    error instanceof MaxTurnsExceededError
  ) {
    return providerError(error instanceof Error ? error.message : "provider request failed", {
      code: errorCodeFrom(error),
      retryable: isRetryableError(error),
    });
  }
  return error;
}

export async function runAgentsSdkLoop(params: AgentsSdkLoopParams): Promise<AgentLoopResult> {
  const toolExecutions = new Map<string, ToolExecutionEvent>();
  const cumulativeUsage: ProviderUsage = {
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cached_input_tokens: 0,
  };
  let hasUsage = false;
  let providerTurns: ProviderTurnResult[] = [];
  let transcript: TranscriptRecord[] = [];
  let lastResponseId: string | null = null;

  try {
    const client = new OpenAI({
      apiKey: params.config.apiKey,
      baseURL: params.config.baseURL,
      timeout: Math.ceil(params.config.timeoutSeconds * 1000),
      maxRetries: 0,
    });
    const modelProvider = new OpenAIProvider({
      openAIClient: client as unknown as OpenAIProviderClient,
      useResponses: true,
    });

    const sdkAgent = new SdkAgent<ToolContext>({
      name: "Goat",
      instructions: params.instructions,
      model: params.model,
      modelSettings: {
        parallelToolCalls: false,
        maxTokens: params.maxOutputTokens ?? undefined,
        reasoning: params.effort && params.effort !== "none" ? { effort: params.effort } : undefined,
      },
      tools: exportAgentsSdkTools(params.enabledTools, params.toolContext, {
        onStart: async (event) => {
          if (event.tool_call_id) {
            toolExecutions.set(event.tool_call_id, event);
          }
          const rawArguments = isRecord(event.arguments) ? event.arguments : {};
          await params.debug?.emit("tool", "start", {
            tool_call_id: event.tool_call_id,
            tool_name: event.tool_name,
            arguments: sanitizeToolArguments(event.tool_name, rawArguments),
          });
        },
        onFinish: async (event) => {
          if (event.tool_call_id) {
            toolExecutions.set(event.tool_call_id, event);
          }
          const toolData = event.envelope?.data && typeof event.envelope.data === "object" ? event.envelope.data : {};
          await params.debug?.emit("tool", "finish", {
            tool_call_id: event.tool_call_id,
            tool_name: event.tool_name,
            planned: params.toolContext.planMode,
            ok: event.envelope?.ok ?? false,
            summary: event.envelope?.summary,
            duration_ms: event.duration_ms,
            command: typeof toolData.command === "string" ? toolData.command : undefined,
            cwd: typeof toolData.cwd === "string" ? toolData.cwd : undefined,
            path: typeof toolData.path === "string" ? toolData.path : undefined,
            exit_code: typeof toolData.exit_code === "number" ? toolData.exit_code : undefined,
            error: event.envelope?.ok ? null : event.envelope?.error,
            result: sanitizeDebugData(toolData),
          });
        },
      }),
    });

    const runner = new Runner({
      modelProvider,
      tracingDisabled: true,
    });

    await params.debug?.emit("provider", "request", {
      request_index: 1,
      model: params.model,
      input_items: params.initialInput.length,
      tool_count: params.enabledTools.length,
      engine: "agents_sdk",
    });

    const result = await runner.run(sdkAgent, params.initialInput, {
      stream: true,
      signal: params.toolContext.abortSignal,
      context: params.toolContext,
      maxTurns: 100,
    });

    for await (const event of result) {
      await handleStreamEvent(event, params.onTextDelta);
    }
    await result.completed;
    if (result.error) {
      throw result.error;
    }

    providerTurns = providerTurnsFromResponses(result.rawResponses);
    for (const turn of providerTurns) {
      hasUsage = addUsage(cumulativeUsage, turn.usage) || hasUsage;
    }
    transcript = buildTranscript(params.runId, result.newItems, toolExecutions, params.toolContext.planMode);
    lastResponseId = result.lastResponseId ?? null;
    const finalText =
      typeof result.finalOutput === "string" ? result.finalOutput : outputToString(result.finalOutput ?? "");

    for (const [index, turn] of providerTurns.entries()) {
      await params.debug?.emit("provider", "response", {
        request_index: index + 1,
        response_id: turn.response_id,
        previous_response_id: turn.previous_response_id,
        status: turn.status,
        tool_call_count: turn.tool_calls.length,
        output_text_chars: turn.output_text.length,
        usage: turn.usage,
        engine: "agents_sdk",
      });
    }

    return {
      final_text: finalText,
      usage: hasUsage ? cumulativeUsage : null,
      last_response_id: lastResponseId,
      provider_turns: providerTurns,
      transcript,
    };
  } catch (error) {
    const normalized = normalizeError(error, params.toolContext.abortSignal);
    await params.debug?.emit("error", "agents_sdk_run_failed", debugErrorData(normalized));
    throw new AgentLoopError(normalized, {
      usage: hasUsage ? cumulativeUsage : null,
      last_response_id: lastResponseId,
      provider_turns: providerTurns,
      transcript,
    });
  }
}

async function handleStreamEvent(
  event: RunStreamEvent,
  onTextDelta?: (delta: string) => void | Promise<void>,
): Promise<void> {
  if (!onTextDelta || event.type !== "raw_model_stream_event" || event.data.type !== "output_text_delta") {
    return;
  }
  await onTextDelta(event.data.delta);
}
