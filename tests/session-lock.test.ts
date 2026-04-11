import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { acquireLock, createSession, LOCK_ACQUIRE_TIMEOUT_MS } from "../src/session.js";
import { createTempDir, useCleanup } from "./helpers.js";

const { track } = useCleanup();

describe("acquireLock", () => {
  test("exports a non-zero acquire timeout so callers can reason about the budget", () => {
    expect(LOCK_ACQUIRE_TIMEOUT_MS).toBeGreaterThan(0);
  });

  test("succeeds on a fresh path and writes the owning PID", async () => {
    const root = await createTempDir("goat-lock-");
    track(root);
    const lockPath = join(root, "test.lock");

    const handle = await acquireLock(lockPath);
    try {
      const raw = await readFile(lockPath, "utf8");
      const [pidToken] = raw.trim().split(":");
      expect(Number.parseInt(pidToken ?? "", 10)).toBe(process.pid);
    } finally {
      await handle.release();
    }
  });

  test("reclaims a stale lock whose recorded PID is not alive", async () => {
    const root = await createTempDir("goat-lock-");
    track(root);
    const lockPath = join(root, "stale.lock");
    await mkdir(root, { recursive: true });
    // PID 0 is guaranteed never to be a live user process.
    await writeFile(lockPath, "0:stale-owner\n");

    const handle = await acquireLock(lockPath);
    try {
      const raw = await readFile(lockPath, "utf8");
      expect(raw).toContain(`${process.pid}:`);
    } finally {
      await handle.release();
    }
  });

  test("rejects when a live process holds the lock", async () => {
    const root = await createTempDir("goat-lock-");
    track(root);
    const lockPath = join(root, "held.lock");
    // The current process is obviously alive — use our own PID as the owner
    // so the stale-lock recovery path refuses to reclaim it.
    await writeFile(lockPath, `${process.pid}:held-owner\n`);

    const started = Date.now();
    await expect(acquireLock(lockPath)).rejects.toMatchObject({
      code: "SESSION_CONFLICT",
    });
    const elapsed = Date.now() - started;
    // Sanity: we should not have blocked longer than the configured budget by
    // more than a scheduling slop margin.
    expect(elapsed).toBeGreaterThanOrEqual(LOCK_ACQUIRE_TIMEOUT_MS - 100);
    expect(elapsed).toBeLessThan(LOCK_ACQUIRE_TIMEOUT_MS + 2_000);
  }, 10_000);

  test("reclaims a zero-length lock file (written but never filled)", async () => {
    // Simulates a writer that opened the lock but crashed before writing the
    // PID payload. We still want the lock to be reclaimable.
    const root = await createTempDir("goat-lock-");
    track(root);
    const lockPath = join(root, "empty.lock");
    await writeFile(lockPath, "");

    const handle = await acquireLock(lockPath);
    try {
      expect(handle).toBeDefined();
    } finally {
      await handle.release();
    }
  });

  test("LockHandle.release removes the on-disk file", async () => {
    const root = await createTempDir("goat-lock-");
    track(root);
    const lockPath = join(root, "release.lock");

    const handle = await acquireLock(lockPath);
    await handle.release();
    await expect(readFile(lockPath, "utf8")).rejects.toThrow();
  });

  test("session creation is unaffected by lock cleanup on unrelated paths", async () => {
    // Smoke-test: createSession does NOT take a lock, but this exercises the
    // surrounding session file layout so lock-related regressions surface
    // in the test run rather than silently.
    const sessionsDir = await createTempDir("goat-lock-sessions-");
    track(sessionsDir);
    const meta = await createSession(sessionsDir);
    expect(meta.session_id).toMatch(/^[0-9a-z]{26}$/);
    expect(meta.bound).toBe(false);
  });
});
