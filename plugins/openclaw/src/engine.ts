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
  agentToOpenAI,
  estimateRoughTokens,
  normalizeAgentMessages,
  openAIToAgent,
} from "./convert.js";

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

export interface HeadroomEngineConfig extends ProxyManagerConfig {
  enabled?: boolean;
  requestTimeoutMs?: number;
  circuitBreakerThreshold?: number;
  circuitBreakerCooldownMs?: number;
}

export class HeadroomContextEngine {
  readonly info = {
    id: "headroom",
    name: "Headroom Context Compression",
    version: "0.1.0",
    ownsCompaction: true,
    // OpenClaw 2026.9.x added a durable-turn contract for context engines: any
    // engine that participates in admitted-turn lifecycle must declare its
    // fencing semantics so the runtime knows how to read prior transcripts
    // before this engine runs, and so turn advancement can be replayed
    // safely on retry. Engines that don't declare this contract are still
    // loaded but are bypassed per logical turn in favor of the legacy
    // engine — which silently disables `assemble()` and the SmartCrusher
    // transforms on every turn.
    //
    // headroom is a compression-only engine that does not own the canonical
    // transcript (OpenClaw's runtime persists messages). We fence on the
    // user-entry boundary so the runtime commits admitted turns up to and
    // including the user entry but excludes the assistant response under
    // construction, and we declare atomic-idempotent advancement so
    // retries collapse to the same turn record.
    transcriptSemantics: {
      currentTurnFence: "before-current-turn-entry-v1",
      turnAdvancementIdempotency: "atomic-idempotent-v1",
    },
  };

  private proxyManager: ProxyManager;
  private proxyUrl: string | null = null;
  private config: HeadroomEngineConfig;
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

  constructor(config: HeadroomEngineConfig = {}, logger?: ProxyManagerLogger) {
    this.config = config;
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
   * Compact context — zero-cost alternative to LLM summarization.
   *
   * Calls compress() with the token budget, which triggers:
   * - SmartCrusher: aggressive JSON compression (70-90% on tool outputs)
   * - Kompress: ModernBERT text compression (40-60% on assistant text)
   * - RollingWindow: drops oldest messages if still over budget
   * - CCR: stores originals for retrieval via headroom_retrieve tool
   *
   * Zero LLM calls. All algorithmic.
   */
  async compact(params: {
    sessionId: string;
    sessionKey?: string;
    sessionTarget?: {
      agentId?: string;
      sessionId?: string;
      sessionKey?: string;
      storePath?: string;
    };
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    runtimeContext?: any;
    runtimeSettings?: { resolvedModel?: string | null; promptTokenBudget?: number };
    abortSignal?: AbortSignal;
  }): Promise<{
    ok: boolean;
    compacted: boolean;
    reason?: string;
    result?: {
      tokensBefore: number;
      tokensAfter?: number;
    };
  }> {
    params.abortSignal?.throwIfAborted();

    if (!this.proxyUrl) {
      await this.ensureProxyUrl().catch(() => undefined);
    }
    if (!this.proxyUrl) {
      return { ok: false, compacted: false, reason: "Proxy not available" };
    }

    const sessionTarget = resolveSessionTarget(params);
    const tokenBudget =
      params.tokenBudget ??
      params.runtimeContext?.tokenBudget ??
      params.runtimeSettings?.promptTokenBudget;

    this.stats.compactions++;
    this.logger.info(
      `Compact started (budget: ${tokenBudget ?? "none"}, force: ${params.force ?? false}, session: ${params.sessionId})`,
    );

    try {
      const branchMessages = await loadBranchMessagesFromSession(
        sessionTarget,
        params.runtimeContext?.cwd ?? params.runtimeContext?.workspaceDir,
      );
      if (branchMessages.length === 0) {
        return { ok: true, compacted: false, reason: "empty transcript" };
      }

      const plan = await planHeadroomCompaction({
        branchMessages,
        tokenBudget,
        proxyUrl: this.proxyUrl,
        model: params.runtimeSettings?.resolvedModel ?? undefined,
        timeoutMs: this.config.requestTimeoutMs ?? 30_000,
        abortSignal: params.abortSignal,
        force: params.force === true,
      });

      if (plan.mode === "none") {
        return {
          ok: true,
          compacted: false,
          reason: "No durable compaction needed",
          result: { tokensBefore: plan.tokensBefore, tokensAfter: plan.tokensAfter },
        };
      }

      this.pendingCompactions.set(params.sessionId, {
        sessionId: params.sessionId,
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
      this.pendingCompactions.delete(params.sessionId);
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
   * a logical turn completes successfully; the engine must acknowledge by
   * either committing the turn (so retries collapse to the same record)
   * or rejecting it. Because headroom does not own the canonical transcript
   * (compression is the only transformation we apply, and the runtime
   * persists messages itself), we always accept the turn and return
   * immediately. The runtime then proceeds to the next logical turn.
   */
  async commitTurn(params: {
    sessionId: string;
    advancementKey: string;
    acceptedTurn: unknown;
  }): Promise<{ status: "committed" | "duplicate"; reason?: string }> {
    // OpenClaw 2026.9.x requires `status: "committed"` (or `"duplicate"`)
    // from commitTurn; the outbox row is deleted only when the runtime sees a
    // recognized status. Returning `{ committed: true }` (old shape) leaves the
    // advancement key stuck in the durable turn outbox, which degrades this
    // engine to legacy for every subsequent turn and blocks assemble().
    return { status: "committed", reason: "compression-only engine; transcript owned by OpenClaw runtime" };
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
