/** How Headroom handles durable `/compact` and overflow-recovery compaction. */
export type PersistentCompactionMode = "headroom" | "openclaw";

export interface PersistentCompactionConfig {
  /** @deprecated Prefer `persistentCompaction`. */
  durableCompaction?: boolean;
  persistentCompaction?: PersistentCompactionMode | boolean;
}

/** Resolve configured durable compaction ownership (default: Headroom). */
export function resolvePersistentCompactionMode(
  config: PersistentCompactionConfig = {},
): PersistentCompactionMode {
  const { persistentCompaction, durableCompaction } = config;

  if (persistentCompaction === "openclaw" || persistentCompaction === false) {
    return "openclaw";
  }
  if (persistentCompaction === "headroom" || persistentCompaction === true) {
    return "headroom";
  }
  if (persistentCompaction !== undefined) {
    throw new Error(
      `Invalid headroom persistentCompaction value: ${String(persistentCompaction)} (expected "headroom" or "openclaw")`,
    );
  }

  if (durableCompaction === false) {
    return "openclaw";
  }
  if (durableCompaction === true) {
    return "headroom";
  }

  return "headroom";
}

export function ownsPersistentCompaction(mode: PersistentCompactionMode): boolean {
  return mode === "headroom";
}
