import type { ResponseFunctionToolCallOutputItem } from "openai/resources/responses/responses";

import {
  type DebugSink,
  debugErrorData,
  estimateProviderRequestTokens,
  extractFinishReason,
  sanitizeDebugData,
  sanitizeToolArguments,
  serializeProviderRequestForDebug,
  summarizeProviderInput,
} from "./debug.js";
import { providerError } from "./errors.js";
import { executeToolCall, type ToolContext } from "./harness.js";
import type { ProviderClient, ProviderInputItem, ProviderTurnResult } from "./provider.js";
import type { ProviderTool, ProviderUsage, ToolEnvelope, TranscriptRecord } from "./types.js";
import { nowIso } from "./utils.js";

type AgentLoopResult = {
  final_text: string;
  usage: ProviderUsage | null;
  last_response_id: string | null;
  provider_turns: ProviderTurnResult[];
  transcript: TranscriptRecord[];
};

export class AgentLoopError extends Error {
  public readonly cause: unknown;
  public readonly state: Omit<AgentLoopResult, "final_text">;

  public constructor(cause: unknown, state: Omit<AgentLoopResult, "final_text">) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "AgentLoopError";
    this.cause = cause;
    this.state = state;
  }
}

function toolCallOutput(callId: string, envelope: ToolEnvelope): ResponseFunctionToolCallOutputItem {
  return {
    type: "function_call_output",
    id: `fco_${callId}`,
    call_id: callId,
    output: JSON.stringify(envelope),
    status: "completed",
  };
}

function parseToolArguments(value: string): Record<string, unknown> {
  if (!value.trim()) {
    throw providerError("provider emitted empty tool arguments", {
      code: "invalid_tool_arguments",
      retryable: false,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw providerError("provider emitted invalid JSON for tool arguments", {
      code: "invalid_tool_arguments",
      retryable: false,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw providerError("provider emitted non-object tool arguments", {
      code: "invalid_tool_arguments",
      retryable: false,
    });
  }
  return parsed as Record<string, unknown>;
}

export async function runAgentLoop(params: {
  runId: string;
  provider: ProviderClient;
  model: string;
  instructions: string;
  initialInput: ProviderInputItem[];
  tools: ProviderTool[];
  enabledTools: string[];
  effort: import("./types.js").Effort | null;
  maxOutputTokens: number | null;
  contextWindowTokens?: number | null;
  toolContext: ToolContext;
  debug?: DebugSink;
  onTextDelta?: (delta: string) => void;
}): Promise<AgentLoopResult> {
  let previousResponseId: string | null = null;
  let nextInput = [...params.initialInput];
  let finalText = "";
  const cumulativeUsage: ProviderUsage = {
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cached_input_tokens: 0,
  };
  let hasUsage = false;
  const providerTurns: ProviderTurnResult[] = [];
  const transcript: TranscriptRecord[] = [];

  try {
    while (true) {
      const request = {
        model: params.model,
        instructions: params.instructions,
        input: nextInput,
        previous_response_id: previousResponseId,
        effort: params.effort,
        max_output_tokens: params.maxOutputTokens,
        tools: params.tools,
        abortSignal: params.toolContext.abortSignal,
        onTextDelta: params.onTextDelta,
      };
      const requestIndex = providerTurns.length + 1;
      const estimatedTokens = estimateProviderRequestTokens(request);
      const contextWindow = params.contextWindowTokens ?? null;
      await params.debug?.emit("provider", "request", {
        request_index: requestIndex,
        model: request.model,
        previous_response_id: request.previous_response_id,
        input_items: request.input.length,
        tool_count: request.tools.length,
        estimated_tokens: estimatedTokens,
        context_window: contextWindow,
        approaching_limit: contextWindow !== null && estimatedTokens >= Math.floor(contextWindow * 0.8),
        input_preview: summarizeProviderInput(request.input),
        payload: serializeProviderRequestForDebug(request),
      });

      let turn: ProviderTurnResult;
      const providerStartedAt = performance.now();
      try {
        turn = await params.provider.runTurn(request);
      } catch (error) {
        await params.debug?.emit("error", "provider_request_failed", {
          request_index: requestIndex,
          latency_ms: Number((performance.now() - providerStartedAt).toFixed(1)),
          payload: serializeProviderRequestForDebug(request),
          ...debugErrorData(error),
        });
        throw error;
      }
      providerTurns.push(turn);
      await params.debug?.emit("provider", "response", {
        request_index: requestIndex,
        response_id: turn.response_id,
        previous_response_id: turn.previous_response_id,
        status: turn.status,
        finish_reason: extractFinishReason(turn),
        tool_call_count: turn.tool_calls.length,
        output_text_chars: turn.output_text.length,
        latency_ms: Number((performance.now() - providerStartedAt).toFixed(1)),
        usage: turn.usage,
      });
      if (turn.usage) {
        hasUsage = true;
        cumulativeUsage.input_tokens += turn.usage.input_tokens;
        cumulativeUsage.output_tokens += turn.usage.output_tokens;
        cumulativeUsage.reasoning_tokens += turn.usage.reasoning_tokens;
        cumulativeUsage.cached_input_tokens += turn.usage.cached_input_tokens;
      }
      previousResponseId = turn.response_id;

      if (turn.output_text || turn.tool_calls.length > 0) {
        transcript.push({
          v: 1,
          ts: nowIso(),
          kind: "message",
          run_id: params.runId,
          role: "assistant",
          phase: turn.tool_calls.length > 0 ? "tool_request" : "final",
          content: turn.output_text,
          tool_calls: turn.tool_calls.map((call) => ({
            id: call.call_id,
            name: call.name,
            arguments: parseToolArguments(call.arguments),
          })),
        });
      }

      if (turn.tool_calls.length === 0) {
        finalText = turn.output_text;
        break;
      }

      const toolOutputs: ResponseFunctionToolCallOutputItem[] = [];
      for (const call of turn.tool_calls) {
        const parsedArguments = parseToolArguments(call.arguments);
        await params.debug?.emit("tool", "start", {
          request_index: requestIndex,
          tool_call_id: call.call_id,
          tool_name: call.name,
          arguments: sanitizeToolArguments(call.name, parsedArguments),
        });
        transcript.push({
          v: 1,
          ts: nowIso(),
          kind: "tool_call",
          run_id: params.runId,
          tool_call_id: call.call_id,
          tool_name: call.name,
          arguments: parsedArguments,
          planned: params.toolContext.planMode,
        });
        const startedAt = performance.now();
        const envelope = await executeToolCall(params.toolContext, params.enabledTools, call.name, parsedArguments);
        const durationMs = Number((performance.now() - startedAt).toFixed(1));
        const toolData = envelope.data && typeof envelope.data === "object" ? envelope.data : {};
        await params.debug?.emit("tool", "finish", {
          request_index: requestIndex,
          tool_call_id: call.call_id,
          tool_name: call.name,
          planned: params.toolContext.planMode,
          ok: envelope.ok,
          summary: envelope.summary,
          duration_ms: durationMs,
          command: typeof toolData.command === "string" ? toolData.command : undefined,
          cwd: typeof toolData.cwd === "string" ? toolData.cwd : undefined,
          path: typeof toolData.path === "string" ? toolData.path : undefined,
          exit_code: typeof toolData.exit_code === "number" ? toolData.exit_code : undefined,
          error: envelope.ok ? null : envelope.error,
          result: sanitizeDebugData(toolData),
        });
        transcript.push({
          v: 1,
          ts: nowIso(),
          kind: "tool_result",
          run_id: params.runId,
          tool_call_id: call.call_id,
          tool_name: call.name,
          duration_s: Number((durationMs / 1000).toFixed(3)),
          planned: params.toolContext.planMode,
          ok: envelope.ok,
          summary: envelope.summary,
          envelope,
        });
        toolOutputs.push(toolCallOutput(call.call_id, envelope));
      }
      nextInput = toolOutputs;
    }

    return {
      final_text: finalText,
      usage: hasUsage ? cumulativeUsage : null,
      last_response_id: previousResponseId,
      provider_turns: providerTurns,
      transcript,
    };
  } catch (error) {
    throw new AgentLoopError(error, {
      usage: hasUsage ? cumulativeUsage : null,
      last_response_id: previousResponseId,
      provider_turns: providerTurns,
      transcript,
    });
  }
}
