import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GoatError } from "../src/errors.js";
import {
  acquireLock,
  appendMessages,
  createRunDirectory,
  createSession,
  ensureSessionCanRun,
  forkSession,
  lastActiveSession,
  listRunIds,
  listSessionIds,
  loadSessionMeta,
  readMessages,
  sessionPaths,
  stopSession,
} from "../src/session.js";
import type { MessageRecord } from "../src/types.js";
import { createTempDir, useCleanup } from "./helpers.js";

const { track } = useCleanup();

function message(runId: string, role: MessageRecord["role"], content: string): MessageRecord {
  return {
    v: 1,
    ts: new Date().toISOString(),
    kind: "message",
    run_id: runId,
    role,
    content,
  };
}

describe("sessions", () => {
  test("creates, lists, and loads sessions", async () => {
    const sessionsDir = await createTempDir("goat-sessions-");
    track(sessionsDir);

    const created = await createSession(sessionsDir);
    expect(created.bound).toBe(false);
    expect(await listSessionIds(sessionsDir)).toEqual([created.session_id]);

    const loaded = await loadSessionMeta(sessionsDir, created.session_id);
    expect(loaded.session_id).toBe(created.session_id);
  });

  test("skips malformed trailing JSONL lines when reading replay messages", async () => {
    const sessionsDir = await createTempDir("goat-sessions-");
    track(sessionsDir);
    const created = await createSession(sessionsDir);

    await appendMessages(sessionsDir, created.session_id, [message("run-a", "user", "hello")]);
    await writeFile(
      sessionPaths(sessionsDir, created.session_id).messages,
      `${JSON.stringify(message("run-a", "user", "hello"))}\n{bad json\n`,
    );

    const messages = await readMessages(sessionsDir, created.session_id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("hello");
  });

  test("resolves the last active session using committed history only", async () => {
    const sessionsDir = await createTempDir("goat-sessions-");
    track(sessionsDir);

    const empty = await createSession(sessionsDir);
    const populated = await createSession(sessionsDir);
    const populatedMeta = await loadSessionMeta(sessionsDir, populated.session_id);
    populatedMeta.message_count = 2;
    populatedMeta.updated_at = "2026-04-10T00:00:00.000Z";
    await writeFile(sessionPaths(sessionsDir, populated.session_id).meta, JSON.stringify(populatedMeta, null, 2));

    const last = await lastActiveSession(sessionsDir);
    expect(last.session_id).toBe(populated.session_id);
    expect(last.session_id).not.toBe(empty.session_id);
  });

  test("stops sessions and prevents future runs", async () => {
    const sessionsDir = await createTempDir("goat-sessions-");
    track(sessionsDir);

    const created = await createSession(sessionsDir);
    await stopSession(sessionsDir, created.session_id);
    const stopped = await loadSessionMeta(sessionsDir, created.session_id);

    expect(stopped.stopped_at).not.toBeNull();
    await expect(ensureSessionCanRun(stopped)).rejects.toBeInstanceOf(GoatError);
  });

  test("forks session state without copying run directories", async () => {
    const sessionsDir = await createTempDir("goat-sessions-");
    track(sessionsDir);

    const source = await createSession(sessionsDir);
    const meta = await loadSessionMeta(sessionsDir, source.session_id);
    meta.bound = true;
    meta.agent_name = "coder";
    meta.message_count = 2;
    await writeFile(sessionPaths(sessionsDir, source.session_id).meta, JSON.stringify(meta, null, 2));
    await appendMessages(sessionsDir, source.session_id, [message("run-1", "user", "hello")]);
    await mkdir(join(sessionPaths(sessionsDir, source.session_id).runs, "run-1"), { recursive: true });

    const forked = await forkSession(sessionsDir, source.session_id);
    expect(forked.session_id).not.toBe(source.session_id);
    expect(forked.agent_name).toBe("coder");
    expect(await listRunIds(sessionsDir, forked.session_id)).toEqual([]);
    expect((await readMessages(sessionsDir, forked.session_id)).map((record) => record.content)).toEqual(["hello"]);
  });

  test("creates run directories and acquires exclusive locks", async () => {
    const sessionsDir = await createTempDir("goat-sessions-");
    track(sessionsDir);

    const session = await createSession(sessionsDir);
    const run = await createRunDirectory(sessionsDir, session.session_id, "run-1");
    expect(run.summary.endsWith("summary.json")).toBe(true);

    const lock = await acquireLock(sessionPaths(sessionsDir, session.session_id).executionLock);
    await expect(acquireLock(sessionPaths(sessionsDir, session.session_id).executionLock)).rejects.toBeInstanceOf(
      GoatError,
    );
    await lock.release();
  });
});
