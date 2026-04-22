import { describe, expect, test } from "bun:test";
import { parseArgv } from "../src/cli.js";
import { GoatError } from "../src/errors.js";

describe("parseArgv", () => {
  test("parses top-level listing commands", () => {
    expect(parseArgv(["version"])).toEqual({ kind: "version" });
    expect(parseArgv(["doctor"])).toEqual({ kind: "doctor" });
    expect(parseArgv(["agents"])).toEqual({ kind: "agents" });
    expect(parseArgv(["roles"])).toEqual({ kind: "roles" });
    expect(parseArgv(["prompts"])).toEqual({ kind: "prompts" });
    expect(parseArgv(["skills"])).toEqual({ kind: "skills" });
    expect(parseArgv(["scenarios"])).toEqual({ kind: "scenarios" });
  });

  test("parses `goat new` run options", () => {
    expect(
      parseArgv([
        "new",
        "--agent",
        "coder",
        "--role",
        "auditor",
        "--prompt",
        "repo-summary",
        "--skill",
        "research",
        "--skill",
        "review",
        "--model",
        "gpt-5.4-mini",
        "--effort",
        "medium",
        "--timeout",
        "2m 3s",
        "--plan",
        "--cwd",
        "/tmp/project",
        "--verbose",
        "--debug",
        "inspect the repo",
      ]),
    ).toEqual({
      kind: "run",
      name: "new",
      session: "new",
      message: "inspect the repo",
      options: {
        fork: false,
        agent: "coder",
        role: "auditor",
        noRole: false,
        prompt: "repo-summary",
        skills: ["research", "review"],
        compact: false,
        scenario: null,
        model: "gpt-5.4-mini",
        effort: "medium",
        timeoutSeconds: 123,
        plan: true,
        cwd: "/tmp/project",
        verbose: true,
        debug: true,
        debugJson: false,
      },
    });
  });

  test("parses `goat last --fork`", () => {
    expect(parseArgv(["last", "--fork", "keep going"])).toEqual({
      kind: "run",
      name: "last",
      session: "last",
      message: "keep going",
      options: {
        fork: true,
        agent: null,
        role: null,
        noRole: false,
        prompt: null,
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
    });
  });

  test("parses explicit session selector", () => {
    expect(parseArgv(["--session", "abc123", "--no-role", "continue"])).toEqual({
      kind: "run",
      name: "explicit",
      session: "abc123",
      message: "continue",
      options: {
        fork: false,
        agent: null,
        role: null,
        noRole: true,
        prompt: null,
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
    });
  });

  test("parses `--debug-json` as structured debug mode without verbose streaming", () => {
    expect(parseArgv(["new", "--debug-json", "inspect the repo"])).toEqual({
      kind: "run",
      name: "new",
      session: "new",
      message: "inspect the repo",
      options: {
        fork: false,
        agent: null,
        role: null,
        noRole: false,
        prompt: null,
        skills: [],
        compact: false,
        scenario: null,
        model: null,
        effort: null,
        timeoutSeconds: null,
        plan: false,
        cwd: null,
        verbose: false,
        debug: true,
        debugJson: true,
      },
    });
  });

  test("parses sessions and runs inspection commands", () => {
    expect(parseArgv(["sessions", "new"])).toEqual({ kind: "sessions.new" });
    expect(parseArgv(["sessions", "last"])).toEqual({ kind: "sessions.last" });
    expect(parseArgv(["sessions", "list"])).toEqual({ kind: "sessions.list" });
    expect(parseArgv(["sessions", "show", "sid"])).toEqual({ kind: "sessions.show", sessionId: "sid" });
    expect(parseArgv(["sessions", "fork", "last"])).toEqual({ kind: "sessions.fork", sessionId: "last" });
    expect(parseArgv(["sessions", "stop", "sid"])).toEqual({ kind: "sessions.stop", sessionId: "sid" });
    expect(parseArgv(["runs", "list"])).toEqual({ kind: "runs.list", session: "last" });
    expect(parseArgv(["runs", "list", "--session", "sid"])).toEqual({ kind: "runs.list", session: "sid" });
    expect(parseArgv(["runs", "show", "--session", "last", "rid"])).toEqual({
      kind: "runs.show",
      session: "last",
      runId: "rid",
    });
    expect(parseArgv(["compact", "session", "last"])).toEqual({ kind: "compact.session", session: "last" });
  });

  test("parses scenario and compact run options", () => {
    expect(parseArgv(["new", "--scenario", "review-chain", "--compact", "inspect"])).toEqual({
      kind: "run",
      name: "new",
      session: "new",
      message: "inspect",
      options: {
        fork: false,
        agent: null,
        role: null,
        noRole: false,
        prompt: null,
        skills: [],
        compact: true,
        scenario: "review-chain",
        model: null,
        effort: null,
        timeoutSeconds: null,
        plan: false,
        cwd: null,
        verbose: false,
        debug: false,
        debugJson: false,
      },
    });
  });

  test("rejects invalid combinations", () => {
    const forkNew = () => parseArgv(["new", "--fork", "nope"]);
    const forkExplicitNew = () => parseArgv(["--session", "new", "--fork", "nope"]);
    const conflictingRole = () => parseArgv(["new", "--role", "auditor", "--no-role", "nope"]);
    const missingMessage = () => parseArgv(["new", "--plan"]);
    const conflictingDebug = () => parseArgv(["new", "--debug-json", "--verbose", "nope"]);
    const scenarioConflict = () => parseArgv(["new", "--scenario", "chain", "--agent", "coder", "nope"]);
    const scenarioExistingSession = () => parseArgv(["last", "--scenario", "chain", "nope"]);

    for (const candidate of [
      forkNew,
      forkExplicitNew,
      conflictingRole,
      missingMessage,
      conflictingDebug,
      scenarioConflict,
      scenarioExistingSession,
    ]) {
      expect(candidate).toThrow(GoatError);
    }
  });
});
