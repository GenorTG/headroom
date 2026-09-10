/**
 * Durable, idempotent turn advancement store for OpenClaw's commitTurn contract.
 *
 * Keys turns by advancementKey and persists to disk so host retries and gateway
 * restarts collapse to the same committed record.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface TurnAdvancementRecord {
  advancementKey: string;
  messages: unknown[];
  messagesDigest: string;
  sessionId: string;
  committedAtMs: number;
}

export interface TurnAdvancementStoreOptions {
  storePath: string;
  /** Test hook invoked immediately before the atomic persist. */
  injectBeforePersist?: () => void;
}

interface PersistedTurnAdvancements {
  version: 1;
  records: Record<string, TurnAdvancementRecord>;
}

const LOCK_RETRY_MS = 10;
const LOCK_MAX_ATTEMPTS = 200;

export function digestTurnMessages(messages: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

export function resolveTurnAdvancementStorePath(params: {
  sessionTarget?: { storePath?: string };
  turnAdvancementStorePath?: string;
}): string {
  if (params.turnAdvancementStorePath) {
    return params.turnAdvancementStorePath;
  }

  const sessionStorePath = params.sessionTarget?.storePath;
  if (sessionStorePath) {
    return join(dirname(sessionStorePath), "headroom-turn-advancements.json");
  }

  const stateDir =
    process.env.OPENCLAW_STATE_DIR ??
    join(process.env.HOME ?? "/tmp", ".openclaw");
  return join(stateDir, "headroom-turn-advancements.json");
}

function sleepSync(ms: number): void {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // Busy wait keeps commit() synchronous for callers.
  }
}

function isStaleLockPid(pidText: string): boolean {
  const pid = Number.parseInt(pidText.trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

function withStoreLock<T>(lockPath: string, fn: () => T): T {
  mkdirSync(dirname(lockPath), { recursive: true });

  let lockFd: number | undefined;
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) {
    try {
      lockFd = openSync(lockPath, "wx");
      writeSync(lockFd, `${process.pid}\n`);
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") {
        throw error;
      }
      try {
        const owner = readFileSync(lockPath, "utf8");
        if (isStaleLockPid(owner)) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        // Another process may have released the lock between attempts.
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }

  if (lockFd === undefined) {
    throw new Error(`timed out acquiring turn advancement lock at ${lockPath}`);
  }

  try {
    return fn();
  } finally {
    closeSync(lockFd);
    try {
      unlinkSync(lockPath);
    } catch {
      // Best effort — the next acquirer treats stale locks via pid checks.
    }
  }
}

function loadPersistedRecords(storePath: string): Map<string, TurnAdvancementRecord> {
  const records = new Map<string, TurnAdvancementRecord>();
  try {
    const raw = readFileSync(storePath, "utf8");
    const parsed = JSON.parse(raw) as PersistedTurnAdvancements;
    if (parsed.version === 1 && parsed.records) {
      for (const [key, record] of Object.entries(parsed.records)) {
        records.set(key, record);
      }
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      throw error;
    }
  }
  return records;
}

function persistRecords(
  storePath: string,
  records: Map<string, TurnAdvancementRecord>,
  injectBeforePersist?: () => void,
): void {
  mkdirSync(dirname(storePath), { recursive: true });
  injectBeforePersist?.();
  const payload: PersistedTurnAdvancements = {
    version: 1,
    records: Object.fromEntries(records),
  };
  const tmpPath = `${storePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(payload), "utf8");
  renameSync(tmpPath, storePath);
}

export class TurnAdvancementStore {
  private records = new Map<string, TurnAdvancementRecord>();
  private loaded = false;

  constructor(private readonly options: TurnAdvancementStoreOptions) {}

  commit(params: {
    advancementKey: string;
    sessionId: string;
    messages: unknown[];
  }): "committed" | "duplicate" {
    const lockPath = `${this.options.storePath}.lock`;
    return withStoreLock(lockPath, () => {
      const records = loadPersistedRecords(this.options.storePath);
      const digest = digestTurnMessages(params.messages);
      const existing = records.get(params.advancementKey);
      if (existing) {
        if (existing.messagesDigest === digest) {
          this.syncMemoryFromDisk(records);
          return "duplicate";
        }
        throw new Error(
          `turn advancement key conflict for ${params.advancementKey}`,
        );
      }

      const record: TurnAdvancementRecord = {
        advancementKey: params.advancementKey,
        messages: params.messages,
        messagesDigest: digest,
        sessionId: params.sessionId,
        committedAtMs: Date.now(),
      };

      const nextRecords = new Map(records);
      nextRecords.set(params.advancementKey, record);
      try {
        persistRecords(
          this.options.storePath,
          nextRecords,
          this.options.injectBeforePersist,
        );
      } catch (error) {
        throw error;
      }

      this.syncMemoryFromDisk(nextRecords);
      return "committed";
    });
  }

  has(advancementKey: string): boolean {
    this.ensureLoaded();
    return this.records.has(advancementKey);
  }

  private ensureLoaded(): void {
    if (this.loaded) {
      return;
    }
    this.syncMemoryFromDisk(loadPersistedRecords(this.options.storePath));
  }

  private syncMemoryFromDisk(records: Map<string, TurnAdvancementRecord>): void {
    this.records = new Map(records);
    this.loaded = true;
  }
}
