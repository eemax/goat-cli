import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  InternalServerError,
  RateLimitError,
} from "openai";
import type {
  EasyInputMessage,
  FunctionTool,
  Response,
  ResponseFunctionToolCall,
  ResponseFunctionToolCallOutputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import { providerError } from "./errors.js";
import type { Effort, ProviderTool, ProviderUsage } from "./types.js";

export type ProviderInputItem = EasyInputMessage | ResponseFunctionToolCallOutputItem;

export type ProviderToolCall = {
  call_id: string;
  name: string;
  arguments: string;
};

export type ProviderTurnResult = {
  response_id: string | null;
  previous_response_id: string | null;
  status: string;
  output_text: string;
  tool_calls: ProviderToolCall[];
  usage: ProviderUsage | null;
  raw_response: Response;
};

export type ProviderRequest = {
  model: string;
  instructions: string;
  input: ProviderInputItem[];
  previous_response_id: string | null;
  effort: Effort | null;
  max_output_tokens: number | null;
  tools: ProviderTool[];
  abortSignal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
};

export interface ProviderClient {
  runTurn(request: ProviderRequest): Promise<ProviderTurnResult>;
}

function normalizeUsage(response: Response): ProviderUsage | null {
  if (!response.usage) {
    return null;
  }

  return {
    input_tokens: response.usage.input_tokens ?? 0,
    output_tokens: response.usage.output_tokens ?? 0,
    reasoning_tokens: response.usage.output_tokens_details?.reasoning_tokens ?? 0,
    cached_input_tokens: response.usage.input_tokens_details?.cached_tokens ?? 0,
  };
}

function extractToolCalls(response: Response): ProviderToolCall[] {
  return response.output
    .filter((item): item is ResponseFunctionToolCall => item.type === "function_call")
    .map((item) => ({
      call_id: item.call_id,
      name: item.name,
      arguments: item.arguments,
    }));
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
  return "provider_error";
}

export class OpenAIResponsesProvider implements ProviderClient {
  private readonly client: OpenAI;

  public constructor(config: {
    apiKey: string;
    baseURL: string;
    timeoutSeconds: number;
  }) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      timeout: Math.ceil(config.timeoutSeconds * 1000),
      maxRetries: 0,
    });
  }

  public async runTurn(request: ProviderRequest): Promise<ProviderTurnResult> {
    try {
      const stream = this.client.responses.stream(
        {
          model: request.model,
          instructions: request.instructions,
          input: request.input,
          previous_response_id: request.previous_response_id ?? undefined,
          reasoning: request.effort && request.effort !== "none" ? { effort: request.effort } : undefined,
          max_output_tokens: request.max_output_tokens ?? undefined,
          parallel_tool_calls: false,
          // `ProviderTool` structurally matches the SDK's `FunctionTool` (name,
          // description, parameters, strict, type: "function"); this narrow
          // cast avoids `as any` while still bridging our internal type to
          // the SDK's wider `Tool` union.
          tools: request.tools satisfies ProviderTool[] as FunctionTool[],
          stream: true,
        },
        {
          signal: request.abortSignal,
        },
      );

      if (request.onTextDelta) {
        stream.on(
          "response.output_text.delta",
          (event: Extract<ResponseStreamEvent, { type: "response.output_text.delta" }>) => {
            request.onTextDelta?.(event.delta);
          },
        );
      }

      const finalResponse = await stream.finalResponse();
      return {
        response_id: finalResponse.id ?? null,
        previous_response_id: finalResponse.previous_response_id ?? null,
        status: finalResponse.status ?? "completed",
        output_text: finalResponse.output_text ?? "",
        tool_calls: extractToolCalls(finalResponse),
        usage: normalizeUsage(finalResponse),
        raw_response: finalResponse,
      };
    } catch (error) {
      if (request.abortSignal?.aborted && request.abortSignal.reason !== undefined) {
        throw request.abortSignal.reason;
      }

      throw providerError(error instanceof Error ? error.message : "provider request failed", {
        code: errorCodeFrom(error),
        retryable: isRetryableError(error),
      });
    }
  }
}
