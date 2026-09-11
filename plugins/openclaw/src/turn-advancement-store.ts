/**
 * Durable, idempotent turn advancement store for OpenClaw's commitTurn contract.
 *
 * Keys turns by advancementKey and persists to disk so host retries and gateway
 * restarts collapse to the same committed record.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type StoreLockOptions, withStoreLock } from "./store-lock.js";

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
  /** Lock tuning (timeouts / stale thresholds); defaults suit production. */
  lockOptions?: StoreLockOptions;
}

interface PersistedTurnAdvancements {
  version: 1;
  records: Record<string, TurnAdvancementRecord>;
}

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

  const homeDir = (() => {
    try {
      return homedir();
    } catch {
      return tmpdir();
    }
  })();
  const stateDir = process.env.OPENCLAW_STATE_DIR ?? join(homeDir, ".openclaw");
  return join(stateDir, "headroom-turn-advancements.json");
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
      // If persist throws, the key is not cached as committed and a retry
      // returns "committed" (not "duplicate") after re-reading disk under lock.
      persistRecords(this.options.storePath, nextRecords, this.options.injectBeforePersist);

      this.syncMemoryFromDisk(nextRecords);
      return "committed";
    }, this.options.lockOptions);
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
