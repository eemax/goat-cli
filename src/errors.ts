export class GoatError extends Error {
  public readonly code: string;
  public readonly exitCode: number;
  public readonly details?: Record<string, unknown>;

  public constructor(code: string, message: string, exitCode: number, details?: Record<string, unknown>) {
    super(message);
    this.name = "GoatError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function isGoatError(error: unknown): error is GoatError {
  return error instanceof GoatError;
}

export const ExitCode = {
  success: 0,
  internal: 1,
  usage: 2,
  config: 3,
  notFound: 4,
  stoppedSession: 5,
  sessionConflict: 6,
  providerFailure: 7,
  toolFailure: 8,
  interrupted: 9,
  timeout: 10,
  doctorFailure: 11,
} as const;

export function internalError(message: string, details?: Record<string, unknown>): GoatError {
  return new GoatError("INTERNAL_ERROR", message, ExitCode.internal, details);
}

export function usageError(message: string, details?: Record<string, unknown>): GoatError {
  return new GoatError("USAGE_ERROR", message, ExitCode.usage, details);
}

export function configError(message: string, details?: Record<string, unknown>): GoatError {
  return new GoatError("CONFIG_ERROR", message, ExitCode.config, details);
}

export function notFoundError(message: string, details?: Record<string, unknown>): GoatError {
  return new GoatError("NOT_FOUND", message, ExitCode.notFound, details);
}

export function stoppedSessionError(message: string, details?: Record<string, unknown>): GoatError {
  return new GoatError("STOPPED_SESSION", message, ExitCode.stoppedSession, details);
}

export function sessionConflictError(message: string, details?: Record<string, unknown>): GoatError {
  return new GoatError("SESSION_CONFLICT", message, ExitCode.sessionConflict, details);
}

export function providerError(message: string, details?: Record<string, unknown>): GoatError {
  return new GoatError("PROVIDER_FAILURE", message, ExitCode.providerFailure, details);
}

export function toolError(message: string, details?: Record<string, unknown>): GoatError {
  return new GoatError("TOOL_FAILURE", message, ExitCode.toolFailure, details);
}

export function interruptedError(message: string, details?: Record<string, unknown>): GoatError {
  return new GoatError("INTERRUPTED", message, ExitCode.interrupted, details);
}

export function timeoutError(message: string, details?: Record<string, unknown>): GoatError {
  return new GoatError("TIMEOUT", message, ExitCode.timeout, details);
}
