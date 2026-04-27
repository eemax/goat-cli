import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { SessionStore } from "../src/session-store.js";
import type { MessageRecord } from "../src/types.js";
import { createTempDir, useCleanup } from "./helpers.js";

const { track } = useCleanup();

async function makeStore(): Promise<SessionStore> {
  const sessionsDir = await createTempDir("goat-session-store-");
  track(sessionsDir);
  return new SessionStore(sessionsDir);
}

describe("SessionStore", () => {
  test("creates and reloads session metadata", async () => {
    const store = await makeStore();
    const meta = await store.createSession();
    expect(meta.session_id).toMatch(/^[0-9a-z]{26}$/);
    expect(meta.bound).toBe(false);
    expect(meta.message_count).toBe(0);

    const reloaded = await store.loadMeta(meta.session_id);
    expect(reloaded.session_id).toBe(meta.session_id);
  });

  test("paths() matches the on-disk layout", async () => {
    const store = await makeStore();
    const meta = await store.createSession();
    const paths = store.paths(meta.session_id);
    expect(paths.root).toBe(join(store.sessionsDir, meta.session_id));
    expect(paths.meta).toBe(join(paths.root, "meta.json"));
    expect(paths.executionLock).toBe(join(paths.root, "execution.lock"));
    expect(paths.messages).toBe(join(paths.root, "messages.jsonl"));

    // The meta.json file created above should actually exist at the reported path.
    const raw = await readFile(paths.meta, "utf8");
    expect(raw).toContain(meta.session_id);
  });

  test("runPaths() nests under the session runs directory", async () => {
    const store = await makeStore();
    const meta = await store.createSession();
    const paths = store.runPaths(meta.session_id, "run-123");
    expect(paths.transcript).toBe(join(store.sessionsDir, meta.session_id, "runs", "run-123", "transcript.jsonl"));
  });

  test("append/read message round-trip", async () => {
    const store = await makeStore();
    const meta = await store.createSession();
    const records: MessageRecord[] = [
      {
        v: 1,
        ts: new Date().toISOString(),
        kind: "message",
        run_id: "run-1",
        role: "user",
        source: "cli_arg",
        content: "hello",
      },
      {
        v: 1,
        ts: new Date().toISOString(),
        kind: "message",
        run_id: "run-1",
        role: "assistant",
        source: "assistant_final",
        content: "hi",
      },
    ];
    await store.appendMessages(meta.session_id, records);

    const reloaded = await store.readMessages(meta.session_id);
    expect(reloaded).toHaveLength(2);
    expect(reloaded[0]?.content).toBe("hello");
    expect(reloaded[1]?.content).toBe("hi");
  });

  test("createRunDirectory mkdir-p's the artifacts subdir", async () => {
    const store = await makeStore();
    const meta = await store.createSession();
    const paths = await store.createRunDirectory(meta.session_id, "run-abc");
    expect(paths.artifacts).toBe(join(store.sessionsDir, meta.session_id, "runs", "run-abc", "artifacts"));
    // listRunIds should now see the new run.
    const ids = await store.listRunIds(meta.session_id);
    expect(ids).toContain("run-abc");
  });

  test("fork copies messages but creates a fresh id", async () => {
    const store = await makeStore();
    const source = await store.createSession();
    await store.appendMessages(source.session_id, [
      {
        v: 1,
        ts: new Date().toISOString(),
        kind: "message",
        run_id: "run-source",
        role: "user",
        source: "cli_arg",
        content: "first turn",
      },
    ]);
    // Mark the source as bound so it satisfies the active-session contract.
    const sourceMeta = await store.loadMeta(source.session_id);
    await store.writeMeta({
      ...sourceMeta,
      bound: true,
      agent_name: "coder",
      message_count: 1,
    });

    const forked = await store.fork(source.session_id);
    expect(forked.session_id).not.toBe(source.session_id);
    expect(forked.bound).toBe(true);
    expect(forked.agent_name).toBe("coder");
    const forkedMessages = await store.readMessages(forked.session_id);
    expect(forkedMessages).toHaveLength(1);
    expect(forkedMessages[0]?.content).toBe("first turn");
  });

  test("stop marks the session as stopped_at and ensureSessionCanRun rejects afterwards", async () => {
    const store = await makeStore();
    const meta = await store.createSession();
    await store.stop(meta.session_id);
    const stopped = await store.loadMeta(meta.session_id);
    expect(stopped.stopped_at).toBeTruthy();
    await expect(store.ensureSessionCanRun(stopped)).rejects.toMatchObject({
      code: "STOPPED_SESSION",
    });
  });

  test("session and execution locks are acquired via the store", async () => {
    const store = await makeStore();
    const meta = await store.createSession();
    const sessionLock = await store.acquireSessionLock(meta.session_id);
    try {
      expect(sessionLock.path).toBe(store.paths(meta.session_id).sessionLock);
    } finally {
      await sessionLock.release();
    }
    const executionLock = await store.acquireExecutionLock(meta.session_id);
    try {
      expect(executionLock.path).toBe(store.paths(meta.session_id).executionLock);
    } finally {
      await executionLock.release();
    }
  });
});
