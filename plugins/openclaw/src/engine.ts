/**
 * HeadroomContextEngine — ContextEngine implementation for OpenClaw.
 *
 * Compresses tool outputs and conversation context using the Headroom proxy.
 * Zero LLM calls — all compression is algorithmic (SmartCrusher, ContentRouter, etc.)
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { compress } from "headroom-ai";
import {
  applyCompactionPlan,
  extractBranchMessages,
  loadBranchMessagesFromSession,
  planHeadroomCompaction,
  resolveSessionTarget,
  type PendingCompaction,
} from "./compaction.js";
import { ProxyManager, defaultLogger, type ProxyManagerConfig, type ProxyManagerLogger } from "./proxy-manager.js";
import {
  TurnAdvancementStore,
  resolveTurnAdvancementStorePath,
} from "./turn-advancement-store.js";
import {
  agentToOpenAI,
  estimateRoughTokens,
  normalizeAgentMessages,
  openAIToAgent,
} from "./convert.js";
import {
  ownsPersistentCompaction,
  resolvePersistentCompactionMode,
  type PersistentCompactionConfig,
  type PersistentCompactionMode,
} from "./compaction-mode.js";
import {
  delegateCompactionToRuntime,
  type OpenClawCompactParams,
  type OpenClawCompactResult,
} from "./openclaw-compaction.js";

type HeadroomCompactParams = OpenClawCompactParams & {
  sessionTarget?: {
    agentId?: string;
    sessionId?: string;
    sessionKey?: string;
    storePath?: string;
  };
  runtimeContext?: {
    tokenBudget?: number;
    cwd?: string;
    workspaceDir?: string;
    rewriteTranscriptEntries?: unknown;
  };
  runtimeSettings?: { resolvedModel?: string | null; promptTokenBudget?: number };
};

/** Race a promise against a timeout and always release the timer. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => reject(new Error(`headroom compress() timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timer]).finally(() => {
    if (timerId !== undefined) clearTimeout(timerId);
  });
}

export interface HeadroomEngineConfig extends ProxyManagerConfig, PersistentCompactionConfig {
  enabled?: boolean;
  requestTimeoutMs?: number;
  circuitBreakerThreshold?: number;
  circuitBreakerCooldownMs?: number;
  /** Override durable turn-advancement store path (primarily for tests). */
  turnAdvancementStorePath?: string;
}

export class HeadroomContextEngine {
  get info() {
    const ownsCompaction = ownsPersistentCompaction(this.persistentCompactionMode);
    return {
      id: "headroom",
      name: "Headroom Context Compression",
      version: "0.1.0",
      ownsCompaction,
      ...(ownsCompaction
        ? {
            // OpenClaw 2026.9.x durable-turn contract for engines that own compaction.
            transcriptSemantics: {
              currentTurnFence: "before-current-turn-entry-v1",
              turnAdvancementIdempotency: "atomic-idempotent-v1",
            },
          }
        : {}),
    };
  }

  private proxyManager: ProxyManager;
  private proxyUrl: string | null = null;
  private config: HeadroomEngineConfig;
  private readonly persistentCompactionMode: PersistentCompactionMode;
  private logger: ProxyManagerLogger;
  private proxyReadyListeners = new Set<(proxyUrl: string) => void | Promise<void>>();
  private proxyStartupPromise: Promise<string> | null = null;
  private proxyStartupError: unknown = null;
  private stats = {
    totalCompressions: 0,
    totalTokensSaved: 0,
    totalTokensBefore: 0,
    compactions: 0,
  };
  private circuit = { errors: 0, openUntilMs: 0 };
  private pendingCompactions = new Map<string, PendingCompaction>();
  private turnAdvancementStores = new Map<string, TurnAdvancementStore>();

  constructor(config: HeadroomEngineConfig = {}, logger?: ProxyManagerLogger) {
    this.config = config;
    this.persistentCompactionMode = resolvePersistentCompactionMode(config);
    this.logger = logger ?? defaultLogger;
    this.proxyManager = new ProxyManager(config, this.logger);
  }

  // === ContextEngine Lifecycle ===

  async bootstrap(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
  }): Promise<{ bootstrapped: boolean; reason?: string }> {
    if (this.config.enabled === false) {
      return { bootstrapped: false, reason: "disabled" };
    }

    this.ensureProxyStarted();
    return { bootstrapped: true, reason: "proxy startup scheduled" };
  }

  async ingest(params: {
    sessionId: string;
    message: any;
    isHeartbeat?: boolean;
  }): Promise<{ ingested: boolean }> {
    // No-op: OpenClaw's runtime stores messages. We don't need a separate store.
    return { ingested: true };
  }

  async ingestBatch?(params: {
    sessionId: string;
    messages: any[];
    isHeartbeat?: boolean;
  }): Promise<{ ingestedCount: number }> {
    return { ingestedCount: params.messages.length };
  }

  /**
   * Assemble context for the model — THE CORE HOOK.
   *
   * Converts AgentMessage[] → OpenAI format → compress() → AgentMessage[]
   */
  async assemble(params: {
    sessionId: string;
    messages: any[];
    tokenBudget?: number;
    model?: string;
    prompt?: string;
  }): Promise<{
    messages: any[];
    estimatedTokens: number;
    systemPromptAddition?: string;
  }> {
    if (!this.proxyUrl || this.config.enabled === false) {
      this.ensureProxyStarted();
      // Fallback: return messages unchanged
      return { messages: normalizeAgentMessages(params.messages), estimatedTokens: 0 };
    }

    if (this.isCircuitOpen()) {
      this.logger.warn("[headroom] Circuit open — using uncompressed messages");
      return { messages: normalizeAgentMessages(params.messages), estimatedTokens: 0 };
    }

    try {
      const budget = params.tokenBudget;
      if (budget != null && budget > 0) {
        const roughTokens = estimateRoughTokens(params.messages);
        // Skip proxy compression when context is clearly under budget — avoids
        // multi-minute Kompress/tokenizer work on 100–200k sessions with 1M windows.
        if (roughTokens < budget * 0.85) {
          this.logger.debug(
            `Assemble skip: ~${roughTokens} tokens under budget ${budget}`,
          );
          return {
            messages: normalizeAgentMessages(params.messages),
            estimatedTokens: roughTokens,
          };
        }
      }

      // Convert AgentMessage → OpenAI format
      const openaiMessages = agentToOpenAI(params.messages);

      // Compress via proxy — pass tokenBudget so RollingWindow enforces it
      const result = await withTimeout(
        compress(openaiMessages, {
          model: params.model ?? "claude-sonnet-4-5",
          baseUrl: this.proxyUrl,
          fallback: true,
          tokenBudget: params.tokenBudget,
        } as any),
        this.config.requestTimeoutMs ?? 30_000,
      );

      if (!result.compressed || result.tokensSaved === 0) {
        this.resetCircuit();
        return {
          messages: normalizeAgentMessages(params.messages),
          estimatedTokens: result.tokensBefore,
        };
      }

      // Convert back to AgentMessage format
      const compressedAgentMessages = openAIToAgent(result.messages);
      this.resetCircuit();

      // Track stats
      this.stats.totalCompressions++;
      this.stats.totalTokensSaved += result.tokensSaved;
      this.stats.totalTokensBefore += result.tokensBefore;

      this.logger.debug(
        `Assembled: ${result.tokensBefore} → ${result.tokensAfter} tokens (saved ${result.tokensSaved})`,
      );

      return {
        messages: compressedAgentMessages,
        estimatedTokens: result.tokensAfter,
        systemPromptAddition:
          result.tokensSaved > 100
            ? `[Context compressed by Headroom: ${result.tokensSaved} tokens saved. Use headroom_retrieve with the hash to get full details.]`
            : undefined,
      };
    } catch (error) {
      this.logger.error(`Assemble failed: ${error}`);
      this.tripCircuit(error);
      // Graceful fallback: return original messages
      return { messages: normalizeAgentMessages(params.messages), estimatedTokens: 0 };
    }
  }

  /**
   * Durable compaction (`/compact`, overflow recovery).
   *
   * - `persistentCompaction: "headroom"` (default): rewrite SQLite via Headroom `/v1/compress` (zero LLM).
   * - `persistentCompaction: "openclaw"`: delegate to OpenClaw native compaction (LLM summarization).
   */
  async compact(params: OpenClawCompactParams): Promise<OpenClawCompactResult> {
    params.abortSignal?.throwIfAborted();

    if (this.persistentCompactionMode === "openclaw") {
      const result = await delegateCompactionToRuntime(params);
      if (result.compacted) {
        this.stats.compactions++;
      }
      this.logger.info(
        `Compaction ${result.compacted ? "completed" : "skipped"} ` +
          `(delegated to OpenClaw, budget: ${params.tokenBudget ?? "none"}, force: ${params.force ?? false})`,
      );
      return result;
    }

    if (!this.proxyUrl) {
      await this.ensureProxyUrl().catch(() => undefined);
    }
    if (!this.proxyUrl) {
      return { ok: false, compacted: false, reason: "Proxy not available" };
    }

    const headroomParams = params as HeadroomCompactParams;
    const sessionTarget = resolveSessionTarget(headroomParams);
    const tokenBudget =
      headroomParams.tokenBudget ??
      headroomParams.runtimeContext?.tokenBudget ??
      headroomParams.runtimeSettings?.promptTokenBudget;

    this.stats.compactions++;
    this.logger.info(
      `Compact started (budget: ${tokenBudget ?? "none"}, force: ${headroomParams.force ?? false}, session: ${headroomParams.sessionId})`,
    );

    try {
      const branchMessages = await loadBranchMessagesFromSession(
        sessionTarget,
        headroomParams.runtimeContext?.cwd ?? headroomParams.runtimeContext?.workspaceDir,
      );
      if (branchMessages.length === 0) {
        return { ok: true, compacted: false, reason: "empty transcript" };
      }

      const plan = await planHeadroomCompaction({
        branchMessages,
        tokenBudget,
        proxyUrl: this.proxyUrl,
        model: headroomParams.runtimeSettings?.resolvedModel ?? undefined,
        timeoutMs: this.config.requestTimeoutMs ?? 30_000,
        abortSignal: headroomParams.abortSignal,
        force: headroomParams.force === true,
      });

      if (plan.mode === "none") {
        return {
          ok: true,
          compacted: false,
          reason: "No durable compaction needed",
          result: { tokensBefore: plan.tokensBefore, tokensAfter: plan.tokensAfter },
        };
      }

      this.pendingCompactions.set(headroomParams.sessionId, {
        sessionId: headroomParams.sessionId,
        ...plan,
      });

      this.logger.info(
        `Compact planned (${plan.mode}): ${plan.tokensBefore} → ${plan.tokensAfter} tokens`,
      );

      return {
        ok: true,
        compacted: true,
        result: {
          tokensBefore: plan.tokensBefore,
          tokensAfter: plan.tokensAfter,
        },
      };
    } catch (error) {
      this.pendingCompactions.delete(headroomParams.sessionId);
      this.logger.error(`Compact failed: ${error}`);
      return {
        ok: false,
        compacted: false,
        reason: String(error),
      };
    }
  }

  async maintain(params: {
    sessionId: string;
    sessionKey?: string;
    sessionTarget?: {
      agentId?: string;
      sessionId?: string;
      sessionKey?: string;
      storePath?: string;
    };
    sessionFile: string;
    runtimeContext?: any;
    abortSignal?: AbortSignal;
  }): Promise<{
    changed: boolean;
    bytesFreed: number;
    rewrittenEntries: number;
    reason?: string;
  }> {
    params.abortSignal?.throwIfAborted();

    if (this.persistentCompactionMode === "openclaw") {
      return {
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
        reason: "persistent compaction delegated to OpenClaw",
      };
    }

    const pending = this.pendingCompactions.get(params.sessionId);
    if (!pending) {
      return { changed: false, bytesFreed: 0, rewrittenEntries: 0, reason: "no pending compaction" };
    }

    this.pendingCompactions.delete(params.sessionId);

    try {
      const sessionTarget = resolveSessionTarget(params);
      const result = await applyCompactionPlan({
        sessionTarget,
        plan: pending,
        rewriteTranscriptEntries: params.runtimeContext?.rewriteTranscriptEntries,
        cwd: params.runtimeContext?.cwd ?? params.runtimeContext?.workspaceDir,
      });

      if (result.changed) {
        this.logger.info(
          `Compact persisted: freed ~${result.bytesFreed} bytes across ${result.rewrittenEntries} entries`,
        );
      }

      return result;
    } catch (error) {
      this.logger.error(`Compact maintenance failed: ${error}`);
      return {
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
        reason: String(error),
      };
    }
  }

  async afterTurn?(params: {
    sessionId: string;
    messages: any[];
    prePromptMessageCount: number;
    isHeartbeat?: boolean;
  }): Promise<void> {
    // Optional: could log stats or trigger learning
  }

  async prepareSubagentSpawn?(params: {
    parentSessionKey: string;
    childSessionKey: string;
    ttlMs?: number;
  }): Promise<{ rollback: () => Promise<void> } | undefined> {
    // Subagent context is compressed naturally via assemble()
    return undefined;
  }

  async onSubagentEnded?(params: {
    childSessionKey: string;
    reason: string;
  }): Promise<void> {
    // No-op
  }

  /**
   * Atomic + idempotent turn commit. OpenClaw calls this once the run for
   * a logical turn completes successfully. We persist the accepted messages
   * keyed by advancementKey so host retries and gateway restarts collapse to
   * the same record even though OpenClaw owns the canonical transcript.
   */
  async commitTurn(params: {
    sessionId: string;
    sessionKey?: string;
    advancementKey: string;
    messages: unknown[];
    admission?: unknown;
    terminal?: unknown;
    sessionTarget?: {
      agentId?: string;
      sessionId?: string;
      sessionKey?: string;
      storePath?: string;
    };
    runtimeSettings?: unknown;
    runtimeContext?: unknown;
    isHeartbeat?: boolean;
  }): Promise<{ status: "committed" | "duplicate" }> {
    const storePath = resolveTurnAdvancementStorePath({
      sessionTarget: params.sessionTarget,
      turnAdvancementStorePath: this.config.turnAdvancementStorePath,
    });
    const store = this.getTurnAdvancementStore(storePath);
    const status = store.commit({
      advancementKey: params.advancementKey,
      sessionId: params.sessionId,
      messages: params.messages,
    });
    return { status };
  }

  async dispose(): Promise<void> {
    await this.proxyManager.stop();
    this.logger.info(
      `Engine disposed. Stats: ${this.stats.totalCompressions} compressions, ` +
        `${this.stats.totalTokensSaved} tokens saved`,
    );
  }

  // --- Public API ---

  getStats() {
    return { ...this.stats };
  }

  getProxyUrl(): string | null {
    return this.proxyUrl;
  }

  getProxyStartupError(): unknown {
    return this.proxyStartupError;
  }

  private isCircuitOpen(): boolean {
    const threshold = this.config.circuitBreakerThreshold ?? 3;
    if (this.circuit.errors < threshold) return false;
    if (Date.now() < this.circuit.openUntilMs) return true;
    this.circuit = { errors: 0, openUntilMs: 0 };
    return false;
  }

  private tripCircuit(error: unknown): void {
    this.circuit.errors += 1;
    const threshold = this.config.circuitBreakerThreshold ?? 3;
    if (this.circuit.errors < threshold) return;
    const cooldownMs = this.config.circuitBreakerCooldownMs ?? 60_000;
    this.circuit.openUntilMs = Date.now() + cooldownMs;
    this.logger.warn(
      `[headroom] Circuit breaker opened after ${this.circuit.errors} errors ` +
        `(last: ${String(error)}); bypassing compression for ${cooldownMs}ms`,
    );
  }

  private resetCircuit(): void {
    this.circuit = { errors: 0, openUntilMs: 0 };
  }

  ensureProxyStarted(): void {
    if (this.config.enabled === false || this.proxyUrl || this.proxyStartupPromise) {
      return;
    }

    this.proxyStartupError = null;
    this.proxyStartupPromise = this.proxyManager
      .start()
      .then(async (proxyUrl) => {
        this.proxyUrl = proxyUrl;
        this.proxyStartupError = null;
        await this.notifyProxyReady(proxyUrl);
        this.logger.info(`Headroom proxy ready at ${proxyUrl}`);
        return proxyUrl;
      })
      .catch((error) => {
        this.proxyStartupError = error;
        this.logger.warn(`Headroom proxy unavailable: ${error}`);
        throw error;
      })
      .finally(() => {
        this.proxyStartupPromise = null;
      });

    // Fire-and-forget lifecycle callers intentionally do not await this promise.
    // Keep the promise rejectable for ensureProxyUrl(), but mark it observed so
    // a missing proxy cannot become a process-level unhandled rejection.
    void this.proxyStartupPromise.catch(() => {});
  }

  onProxyReady(listener: (proxyUrl: string) => void | Promise<void>): () => void {
    this.proxyReadyListeners.add(listener);
    return () => {
      this.proxyReadyListeners.delete(listener);
    };
  }

  async ensureProxyUrl(): Promise<string> {
    if (this.proxyUrl) {
      return this.proxyUrl;
    }

    this.ensureProxyStarted();
    if (!this.proxyStartupPromise) {
      throw new Error("Headroom proxy startup is disabled");
    }
    return this.proxyStartupPromise;
  }

  private getTurnAdvancementStore(storePath: string): TurnAdvancementStore {
    let store = this.turnAdvancementStores.get(storePath);
    if (!store) {
      store = new TurnAdvancementStore({ storePath });
      this.turnAdvancementStores.set(storePath, store);
    }
    return store;
  }

  private async notifyProxyReady(proxyUrl: string): Promise<void> {
    for (const listener of this.proxyReadyListeners) {
      try {
        await listener(proxyUrl);
      } catch (error) {
        this.logger.warn(`Headroom proxy ready listener failed: ${error}`);
      }
    }
  }
}
