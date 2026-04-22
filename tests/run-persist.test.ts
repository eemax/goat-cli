import { describe, expect, test } from "bun:test";

import { AgentLoopError } from "../src/agent.js";
import { configError, interruptedError, providerError, sessionConflictError, timeoutError } from "../src/errors.js";
import {
  buildReplayRecords,
  runStatusFromError,
  terminationReasonFromError,
  unwrapRunError,
} from "../src/run-persist.js";

describe("unwrapRunError", () => {
  test("extracts cause from AgentLoopError", () => {
    const cause = new Error("provider blew up");
    const loopError = new AgentLoopError(cause, {
      usage: null,
      last_response_id: null,
      provider_turns: [],
      transcript: [],
    });
    expect(unwrapRunError(loopError)).toBe(cause);
  });

  test("passes through plain Error unchanged", () => {
    const error = new Error("plain");
    expect(unwrapRunError(error)).toBe(error);
  });

  test("passes through non-Error values unchanged", () => {
    expect(unwrapRunError("string error")).toBe("string error");
    expect(unwrapRunError(null)).toBeNull();
  });
});

describe("runStatusFromError", () => {
  test("maps session conflict to session_conflict", () => {
    expect(runStatusFromError(sessionConflictError("conflict"))).toBe("session_conflict");
  });

  test("maps timeout to timed_out", () => {
    expect(runStatusFromError(timeoutError("timed out"))).toBe("timed_out");
  });

  test("maps interrupted to interrupted", () => {
    expect(runStatusFromError(interruptedError("interrupted"))).toBe("interrupted");
  });

  test("maps other GoatError to failed", () => {
    expect(runStatusFromError(configError("bad config"))).toBe("failed");
    expect(runStatusFromError(providerError("boom"))).toBe("failed");
  });

  test("maps non-GoatError to failed", () => {
    expect(runStatusFromError(new Error("generic"))).toBe("failed");
    expect(runStatusFromError("string")).toBe("failed");
  });
});

describe("terminationReasonFromError", () => {
  test("returns lowercased GoatError code", () => {
    expect(terminationReasonFromError(sessionConflictError("conflict"))).toBe("session_conflict");
    expect(terminationReasonFromError(timeoutError("timed out"))).toBe("timeout");
    expect(terminationReasonFromError(providerError("boom"))).toBe("provider_failure");
  });

  test("returns 'failed' for non-GoatError", () => {
    expect(terminationReasonFromError(new Error("generic"))).toBe("failed");
    expect(terminationReasonFromError(null)).toBe("failed");
  });
});

describe("buildReplayRecords", () => {
  const command = {
    kind: "run" as const,
    name: "new" as const,
    session: "new" as const,
    message: "inspect the repo",
    options: {
      fork: false,
      agent: null,
      role: null,
      noRole: false,
      prompt: "repo-summary",
      skills: [],
      compact: false,
      scenario: null,
      model: null,
      effort: null,
      timeoutSeconds: null,
      plan: false,
      cwd: null,
      verbose: false,
      debug: false,
      debugJson: false,
    },
  };

  test("produces 2 records without stdin", () => {
    const records = buildReplayRecords("run-1", command, null, "all done");
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      role: "user",
      source: "cli_arg",
      content: "inspect the repo",
      prompt_name: "repo-summary",
    });
    expect(records[1]).toMatchObject({
      role: "assistant",
      source: "assistant_final",
      content: "all done",
    });
  });

  test("produces 3 records with stdin", () => {
    const records = buildReplayRecords("run-1", command, "piped input", "all done");
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ role: "user", source: "cli_arg" });
    expect(records[1]).toMatchObject({ role: "user", source: "stdin", content: "piped input" });
    expect(records[2]).toMatchObject({ role: "assistant", source: "assistant_final" });
  });

  test("all records share the same run_id and version", () => {
    const records = buildReplayRecords("run-42", command, "stdin", "done");
    for (const record of records) {
      expect(record.run_id).toBe("run-42");
      expect(record.v).toBe(1);
    }
  });
});
