import {
  acquireLock,
  appendMessages,
  createRunDirectory,
  createSession,
  ensureSessionCanRun,
  forkSession,
  type LockHandle,
  lastActiveSession,
  listRunIds,
  listSessionIds,
  loadSessionMeta,
  type RunPaths,
  readMessages,
  resolveSessionSelector,
  runPaths,
  type SessionPaths,
  sessionPaths,
  stopSession,
  writeSessionMeta,
} from "./session.js";
import type { MessageRecord, SessionMeta, SessionSelector } from "./types.js";

/**
 * Bag-of-methods wrapper around the on-disk session layout. Binds a single
 * `sessionsDir` so callers don't need to pass it through every function, and
 * gives us one place to document or replace the storage surface.
 *
 * The free functions in `session.ts` remain the low-level primitives and are
 * still used directly by existing code paths (tests, `run-persist.ts`, …).
 * New code should prefer going through a `SessionStore` instance.
 */
export class SessionStore {
  public constructor(public readonly sessionsDir: string) {}

  public paths(sessionId: string): SessionPaths {
    return sessionPaths(this.sessionsDir, sessionId);
  }

  public runPaths(sessionId: string, runId: string): RunPaths {
    return runPaths(this.sessionsDir, sessionId, runId);
  }

  public createSession(): Promise<SessionMeta> {
    return createSession(this.sessionsDir);
  }

  public loadMeta(sessionId: string): Promise<SessionMeta> {
    return loadSessionMeta(this.sessionsDir, sessionId);
  }

  public writeMeta(meta: SessionMeta): Promise<void> {
    return writeSessionMeta(this.sessionsDir, meta);
  }

  public listSessionIds(): Promise<string[]> {
    return listSessionIds(this.sessionsDir);
  }

  public lastActiveSession(): Promise<SessionMeta> {
    return lastActiveSession(this.sessionsDir);
  }

  public stop(sessionId: string): Promise<void> {
    return stopSession(this.sessionsDir, sessionId);
  }

  public resolveSelector(selector: SessionSelector): Promise<SessionMeta> {
    return resolveSessionSelector(this.sessionsDir, selector);
  }

  public fork(selector: SessionSelector): Promise<SessionMeta> {
    return forkSession(this.sessionsDir, selector);
  }

  public readMessages(sessionId: string): Promise<MessageRecord[]> {
    return readMessages(this.sessionsDir, sessionId);
  }

  public appendMessages(sessionId: string, records: MessageRecord[]): Promise<void> {
    return appendMessages(this.sessionsDir, sessionId, records);
  }

  public createRunDirectory(sessionId: string, runId: string): Promise<RunPaths> {
    return createRunDirectory(this.sessionsDir, sessionId, runId);
  }

  public listRunIds(sessionId: string): Promise<string[]> {
    return listRunIds(this.sessionsDir, sessionId);
  }

  public ensureSessionCanRun(meta: SessionMeta): Promise<void> {
    return ensureSessionCanRun(meta);
  }

  public acquireSessionLock(sessionId: string): Promise<LockHandle> {
    return acquireLock(this.paths(sessionId).sessionLock);
  }

  public acquireExecutionLock(sessionId: string): Promise<LockHandle> {
    return acquireLock(this.paths(sessionId).executionLock);
  }
}
