import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { appendFile, copyFile, mkdir, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { monotonicFactory } from "ulid";

import { configError, notFoundError, sessionConflictError, stoppedSessionError } from "./errors.js";
import type { MessageRecord, SessionMeta } from "./types.js";
import { atomicWriteFile, isErrnoException, nowIso, parseJsonLine, stableJson } from "./utils.js";

const nextUlid = monotonicFactory();

export type SessionPaths = {
  root: string;
  meta: string;
  messages: string;
  sessionLock: string;
  executionLock: string;
  runs: string;
};

export type RunPaths = {
  root: string;
  transcript: string;
  provider: string;
  summary: string;
  artifacts: string;
};

export class LockHandle {
  public constructor(
    public readonly path: string,
    private readonly handle: FileHandle,
  ) {}

  public async release(): Promise<void> {
    await this.handle.close().catch(() => undefined);
    await rm(this.path, { force: true }).catch(() => undefined);
  }
}

export function newId(): string {
  return nextUlid().toLowerCase();
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function sessionPaths(sessionsDir: string, sessionId: string): SessionPaths {
  const root = join(sessionsDir, sessionId);
  return {
    root,
    meta: join(root, "meta.json"),
    messages: join(root, "messages.jsonl"),
    sessionLock: join(root, "session.lock"),
    executionLock: join(root, "execution.lock"),
    runs: join(root, "runs"),
  };
}

export function runPaths(sessionsDir: string, sessionId: string, runId: string): RunPaths {
  const root = join(sessionsDir, sessionId, "runs", runId);
  return {
    root,
    transcript: join(root, "transcript.jsonl"),
    provider: join(root, "provider.jsonl"),
    summary: join(root, "summary.json"),
    artifacts: join(root, "artifacts"),
  };
}

/**
 * Maximum wall-clock time `acquireLock` will spend retrying before surrendering
 * with a session-conflict error. Keeps us from blocking forever on a stuck
 * process while still absorbing short races between concurrent runs.
 */
export const LOCK_ACQUIRE_TIMEOUT_MS = 2_000;
const LOCK_RETRY_BACKOFF_MS = [25, 50, 100, 200, 400] as const;
const EMPTY_LOCK_STALE_AFTER_MS = 5_000;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: no such process → stale. EPERM: owned by another user → still
    // alive, we just lack permission to signal it.
    return isErrnoException(error) && error.code === "EPERM";
  }
}

async function removeStaleLock(path: string): Promise<boolean> {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw === null) {
    // Already gone; treat as fair game.
    return true;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    // Empty lock files are only reclaimed once they've sat untouched long
    // enough to outlive a normal open(...) -> write(...) handoff.
    const info = await stat(path).catch(() => null);
    if (!info) {
      return true;
    }
    if (Date.now() - info.mtimeMs < EMPTY_LOCK_STALE_AFTER_MS) {
      return false;
    }
    await rm(path, { force: true }).catch(() => undefined);
    return true;
  }
  const [pidToken] = trimmed.split(":");
  const pid = Number.parseInt(pidToken ?? "", 10);
  if (Number.isNaN(pid)) {
    // Malformed payload — treat as corrupted / stale.
    await rm(path, { force: true }).catch(() => undefined);
    return true;
  }
  if (isProcessAlive(pid)) {
    return false;
  }
  await rm(path, { force: true }).catch(() => undefined);
  return true;
}

export async function acquireLock(path: string): Promise<LockHandle> {
  await mkdir(join(path, ".."), { recursive: true });

  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  let attempt = 0;

  while (true) {
    try {
      const handle = await open(path, "wx");
      await handle.writeFile(`${process.pid}:${randomUUID()}\n`);
      return new LockHandle(path, handle);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "EEXIST") {
        throw sessionConflictError(`could not acquire lock ${basename(path)}`);
      }
    }

    if (await removeStaleLock(path)) {
      // Retry immediately after reclaiming a stale lock.
      continue;
    }

    if (Date.now() >= deadline) {
      throw sessionConflictError(`could not acquire lock ${basename(path)}`);
    }

    const backoff = LOCK_RETRY_BACKOFF_MS[Math.min(attempt, LOCK_RETRY_BACKOFF_MS.length - 1)];
    attempt += 1;
    await sleep(backoff);
  }
}

export async function createSession(sessionsDir: string): Promise<SessionMeta> {
  const sessionId = newId();
  const paths = sessionPaths(sessionsDir, sessionId);
  await mkdir(paths.runs, { recursive: true });
  await writeFile(paths.messages, "");
  const meta = createFreshSessionMeta(sessionId);
  await atomicWriteFile(paths.meta, stableJson(meta));
  return meta;
}

export function createFreshSessionMeta(sessionId: string): SessionMeta {
  const timestamp = nowIso();
  return {
    v: 1,
    session_id: sessionId,
    created_at: timestamp,
    updated_at: timestamp,
    stopped_at: null,
    bound: false,
    revision: 0,
    last_run_usage: null,
    message_count: 0,
    agent_name: null,
    role_name: null,
    model: null,
    effort: null,
    cwd: null,
  };
}

export async function loadSessionMeta(sessionsDir: string, sessionId: string): Promise<SessionMeta> {
  const paths = sessionPaths(sessionsDir, sessionId);
  if (!(await exists(paths.meta))) {
    throw notFoundError(`session \`${sessionId}\` was not found`);
  }
  const raw = await readFile(paths.meta, "utf8");
  return JSON.parse(raw) as SessionMeta;
}

export async function writeSessionMeta(sessionsDir: string, meta: SessionMeta): Promise<void> {
  const paths = sessionPaths(sessionsDir, meta.session_id);
  await atomicWriteFile(paths.meta, stableJson(meta));
}

export async function listSessionIds(sessionsDir: string): Promise<string[]> {
  if (!(await exists(sessionsDir))) {
    return [];
  }
  const entries = await readdir(sessionsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export async function lastActiveSession(sessionsDir: string): Promise<SessionMeta> {
  const ids = await listSessionIds(sessionsDir);
  const candidates: SessionMeta[] = [];
  for (const id of ids) {
    const meta = await loadSessionMeta(sessionsDir, id);
    if (meta.stopped_at === null && meta.message_count > 0) {
      candidates.push(meta);
    }
  }
  candidates.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  const match = candidates[0];
  if (!match) {
    throw notFoundError("no active session with committed history was found");
  }
  return match;
}

export async function stopSession(sessionsDir: string, sessionId: string): Promise<void> {
  const paths = sessionPaths(sessionsDir, sessionId);
  const lock = await acquireLock(paths.sessionLock);
  try {
    const meta = await loadSessionMeta(sessionsDir, sessionId);
    if (meta.stopped_at !== null) {
      return;
    }
    const timestamp = nowIso();
    meta.stopped_at = timestamp;
    meta.updated_at = timestamp;
    await writeSessionMeta(sessionsDir, meta);
  } finally {
    await lock.release();
  }
}

export async function resolveSessionSelector(sessionsDir: string, selector: string): Promise<SessionMeta> {
  if (selector === "last") {
    return lastActiveSession(sessionsDir);
  }
  if (selector === "new") {
    throw configError("`new` is not a valid selector in this command");
  }
  return loadSessionMeta(sessionsDir, selector);
}

export async function forkSession(sessionsDir: string, selector: string): Promise<SessionMeta> {
  const source = await resolveSessionSelector(sessionsDir, selector);
  const sourcePaths = sessionPaths(sessionsDir, source.session_id);
  const forked = createFreshSessionMeta(newId());
  forked.bound = source.bound;
  forked.last_run_usage = source.last_run_usage;
  forked.message_count = source.message_count;
  forked.agent_name = source.agent_name;
  forked.role_name = source.role_name;
  forked.model = source.model;
  forked.effort = source.effort;
  forked.cwd = source.cwd;

  const forkPaths = sessionPaths(sessionsDir, forked.session_id);
  await mkdir(forkPaths.runs, { recursive: true });
  if (await exists(sourcePaths.messages)) {
    await copyFile(sourcePaths.messages, forkPaths.messages);
  } else {
    await writeFile(forkPaths.messages, "");
  }
  await writeSessionMeta(sessionsDir, forked);
  return forked;
}

export async function readMessages(sessionsDir: string, sessionId: string): Promise<MessageRecord[]> {
  const path = sessionPaths(sessionsDir, sessionId).messages;
  if (!(await exists(path))) {
    return [];
  }
  const raw = await readFile(path, "utf8");
  const messages: MessageRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const parsed = parseJsonLine<MessageRecord>(line);
    if (parsed) {
      messages.push(parsed);
    }
  }
  return messages;
}

export async function appendMessages(sessionsDir: string, sessionId: string, records: MessageRecord[]): Promise<void> {
  if (records.length === 0) {
    return;
  }
  const path = sessionPaths(sessionsDir, sessionId).messages;
  const lines = records.map((record) => JSON.stringify(record)).join("\n");
  await appendFile(path, `${lines}\n`);
}

export async function createRunDirectory(sessionsDir: string, sessionId: string, runId: string): Promise<RunPaths> {
  const paths = runPaths(sessionsDir, sessionId, runId);
  await mkdir(paths.artifacts, { recursive: true });
  return paths;
}

export async function listRunIds(sessionsDir: string, sessionId: string): Promise<string[]> {
  const directory = sessionPaths(sessionsDir, sessionId).runs;
  if (!(await exists(directory))) {
    return [];
  }
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export async function ensureSessionCanRun(meta: SessionMeta): Promise<void> {
  if (meta.stopped_at) {
    throw stoppedSessionError(`session \`${meta.session_id}\` has been stopped`);
  }
}
