/**
 * Durable, idempotent turn advancement store for OpenClaw's commitTurn contract.
 *
 * Keys turns by advancementKey and persists to disk so host retries and gateway
 * restarts collapse to the same committed record.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

export class TurnAdvancementStore {
  private records = new Map<string, TurnAdvancementRecord>();
  private loaded = false;

  constructor(private readonly options: TurnAdvancementStoreOptions) {}

  commit(params: {
    advancementKey: string;
    sessionId: string;
    messages: unknown[];
  }): "committed" | "duplicate" {
    this.ensureLoaded();

    const digest = digestTurnMessages(params.messages);
    const existing = this.records.get(params.advancementKey);
    if (existing) {
      if (existing.messagesDigest === digest) {
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

    this.options.injectBeforePersist?.();
    this.records.set(params.advancementKey, record);
    this.persist();
    return "committed";
  }

  has(advancementKey: string): boolean {
    this.ensureLoaded();
    return this.records.has(advancementKey);
  }

  private ensureLoaded(): void {
    if (this.loaded) {
      return;
    }

    try {
      const raw = readFileSync(this.options.storePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedTurnAdvancements;
      if (parsed.version === 1 && parsed.records) {
        for (const [key, record] of Object.entries(parsed.records)) {
          this.records.set(key, record);
        }
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        throw error;
      }
    }

    this.loaded = true;
  }

  private persist(): void {
    mkdirSync(dirname(this.options.storePath), { recursive: true });
    const payload: PersistedTurnAdvancements = {
      version: 1,
      records: Object.fromEntries(this.records),
    };
    const tmpPath = `${this.options.storePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(payload), "utf8");
    renameSync(tmpPath, this.options.storePath);
  }
}
