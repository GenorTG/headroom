import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  delegateCompactionToRuntime: vi.fn(),
  runTranscriptReplaceHygiene: vi.fn(async () => ({
    changed: true,
    bytesFreed: 512,
    rewrittenEntries: 2,
    tokensBefore: 50_000,
    tokensAfter: 44_000,
  })),
  start: vi.fn(async () => "http://127.0.0.1:8787"),
  stop: vi.fn(async () => undefined),
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("headroom-ai", () => ({
  compress: vi.fn(),
}));

vi.mock("../src/openclaw-compaction.js", () => ({
  delegateCompactionToRuntime: mocked.delegateCompactionToRuntime,
}));

vi.mock("../src/transcript-hygiene.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/transcript-hygiene.js")>();
  return {
    ...actual,
    runTranscriptReplaceHygiene: mocked.runTranscriptReplaceHygiene,
  };
});

vi.mock("../src/proxy-manager.js", () => ({
  ProxyManager: class {
    start = mocked.start;
    stop = mocked.stop;
  },
  defaultLogger: mocked.logger,
}));

import { HeadroomContextEngine } from "../src/engine.js";
import { compress } from "headroom-ai";

afterEach(() => {
  vi.mocked(compress).mockReset();
  mocked.delegateCompactionToRuntime.mockReset();
  mocked.runTranscriptReplaceHygiene.mockReset();
  mocked.runTranscriptReplaceHygiene.mockResolvedValue({
    changed: true,
    bytesFreed: 512,
    rewrittenEntries: 2,
    tokensBefore: 50_000,
    tokensAfter: 44_000,
  });
  mocked.start.mockReset();
  mocked.start.mockResolvedValue("http://127.0.0.1:8787");
  mocked.stop.mockClear();
  mocked.logger.debug.mockClear();
  mocked.logger.error.mockClear();
  mocked.logger.info.mockClear();
  mocked.logger.warn.mockClear();
});

describe("HeadroomContextEngine persistent compaction mode", () => {
  it("defaults to openclaw compaction (OpenClaw owns durable compact)", () => {
    const engine = new HeadroomContextEngine();
    expect(engine.info.ownsCompaction).toBe(false);
    expect(engine.info.transcriptSemantics).toEqual({
      currentTurnFence: "before-current-turn-entry-v1",
      turnAdvancementIdempotency: "atomic-idempotent-v1",
    });
  });

  it("runs hygiene pre-pass then delegates when hybrid compact is requested", async () => {
    const engine = new HeadroomContextEngine({ persistentCompaction: "hybrid" });
    (engine as { proxyUrl: string | null }).proxyUrl = "http://127.0.0.1:8787";
    const params = {
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "session.jsonl",
      tokenBudget: 120_000,
      force: true,
    };
    const delegatedResult = {
      ok: true,
      compacted: true,
      result: { tokensBefore: 20_000, tokensAfter: 8_000 },
    };
    mocked.delegateCompactionToRuntime.mockResolvedValueOnce(delegatedResult);

    await expect(engine.compact(params)).resolves.toEqual(delegatedResult);
    expect(mocked.runTranscriptReplaceHygiene).toHaveBeenCalledWith(
      expect.objectContaining({ force: true, proxyUrl: "http://127.0.0.1:8787" }),
    );
    expect(mocked.delegateCompactionToRuntime).toHaveBeenCalledWith(params);
    expect(engine.getStats().compactions).toBe(1);
    expect(engine.getStats().hygieneRuns).toBe(1);
  });

  it("runs turn-end hygiene in maintain() for hybrid mode", async () => {
    const engine = new HeadroomContextEngine({ persistentCompaction: "hybrid" });
    (engine as { proxyUrl: string | null }).proxyUrl = "http://127.0.0.1:8787";

    await expect(
      engine.maintain({
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        sessionFile: "session.jsonl",
      }),
    ).resolves.toEqual({
      changed: true,
      bytesFreed: 512,
      rewrittenEntries: 2,
      tokensBefore: 50_000,
      tokensAfter: 44_000,
    });

    expect(mocked.runTranscriptReplaceHygiene).toHaveBeenCalledWith(
      expect.objectContaining({ force: false }),
    );
  });

  it("delegates persistent compaction to OpenClaw when configured", async () => {
    const engine = new HeadroomContextEngine({ persistentCompaction: "openclaw" });
    const params = {
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "session.jsonl",
      tokenBudget: 120_000,
      force: false,
    };
    const delegatedResult = {
      ok: true,
      compacted: true,
      result: {
        tokensBefore: 20_000,
        tokensAfter: 8_000,
      },
    };
    mocked.delegateCompactionToRuntime.mockResolvedValueOnce(delegatedResult);

    expect(engine.info.ownsCompaction).toBe(false);
    expect(engine.info.transcriptSemantics?.currentTurnFence).toBe(
      "before-current-turn-entry-v1",
    );
    await expect(engine.compact(params)).resolves.toEqual(delegatedResult);
    expect(mocked.delegateCompactionToRuntime).toHaveBeenCalledWith(params);
    expect(compress).not.toHaveBeenCalled();
    expect(engine.getStats().compactions).toBe(1);
  });

  it("does not count a delegated no-op as a compaction", async () => {
    const engine = new HeadroomContextEngine({ persistentCompaction: "openclaw" });
    mocked.delegateCompactionToRuntime.mockResolvedValueOnce({
      ok: true,
      compacted: false,
      reason: "Below compaction threshold",
    });

    await expect(
      engine.compact({
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
      }),
    ).resolves.toEqual({
      ok: true,
      compacted: false,
      reason: "Below compaction threshold",
    });

    expect(engine.getStats().compactions).toBe(0);
  });

  it("propagates delegated compaction failures without reporting success", async () => {
    const engine = new HeadroomContextEngine({ persistentCompaction: "openclaw" });
    const failure = new Error("native compaction failed");
    mocked.delegateCompactionToRuntime.mockRejectedValueOnce(failure);

    await expect(
      engine.compact({
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
      }),
    ).rejects.toBe(failure);

    expect(engine.getStats().compactions).toBe(0);
    expect(mocked.logger.info).not.toHaveBeenCalled();
  });
});

describe("HeadroomContextEngine proxy startup helpers", () => {
  it("bootstraps by scheduling proxy startup when enabled", async () => {
    const engine = new HeadroomContextEngine();

    await expect(
      engine.bootstrap({
        sessionId: "session-1",
        sessionFile: "session.jsonl",
      }),
    ).resolves.toEqual({
      bootstrapped: true,
      reason: "proxy startup scheduled",
    });
    expect(mocked.start).toHaveBeenCalledTimes(1);
  });

  it("removes unsubscribed proxy listeners before notifying readiness", async () => {
    const engine = new HeadroomContextEngine();
    const first = vi.fn();
    const second = vi.fn();

    const unsubscribeFirst = engine.onProxyReady(first);
    engine.onProxyReady(second);
    unsubscribeFirst();

    engine.ensureProxyStarted();
    await engine.ensureProxyUrl();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("http://127.0.0.1:8787");
  });

  it("returns the existing proxy URL without starting again", async () => {
    const engine = new HeadroomContextEngine();

    (engine as { proxyUrl: string | null }).proxyUrl = "http://127.0.0.1:8787";

    await expect(engine.ensureProxyUrl()).resolves.toBe("http://127.0.0.1:8787");
    expect(mocked.start).not.toHaveBeenCalled();
  });

  it("throws when proxy startup is disabled", async () => {
    const engine = new HeadroomContextEngine({ enabled: false });

    await expect(engine.ensureProxyUrl()).rejects.toThrow("Headroom proxy startup is disabled");
    expect(mocked.start).not.toHaveBeenCalled();
  });

  it("does not emit an unhandledRejection when fire-and-forget startup fails", async () => {
    mocked.start.mockReset();
    mocked.start.mockRejectedValue(new Error("proxy boom"));

    const engine = new HeadroomContextEngine();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      // Fire-and-forget: caller intentionally does not await.
      engine.ensureProxyStarted();
      // Let the startup promise settle and any microtasks/macrotasks flush.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandled).toEqual([]);
      expect(mocked.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Headroom proxy unavailable"),
      );
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("stores the startup failure in getProxyStartupError()", async () => {
    const failure = new Error("proxy boom");
    mocked.start.mockReset();
    mocked.start.mockRejectedValue(failure);

    const engine = new HeadroomContextEngine();
    expect(engine.getProxyStartupError()).toBeNull();

    engine.ensureProxyStarted();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(engine.getProxyStartupError()).toBe(failure);
  });

  it("allows retrying startup after a failure", async () => {
    mocked.start.mockReset();
    mocked.start
      .mockRejectedValueOnce(new Error("proxy boom"))
      .mockResolvedValueOnce("http://127.0.0.1:8787");

    const engine = new HeadroomContextEngine();

    engine.ensureProxyStarted();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(engine.getProxyStartupError()).toBeInstanceOf(Error);

    // A second attempt is possible once the failed promise has cleared.
    const url = await engine.ensureProxyUrl();
    expect(url).toBe("http://127.0.0.1:8787");
    expect(engine.getProxyStartupError()).toBeNull();
    expect(mocked.start).toHaveBeenCalledTimes(2);
  });

  it("ensureProxyUrl rejects cleanly on startup failure without unhandledRejection", async () => {
    const failure = new Error("proxy boom");
    mocked.start.mockReset();
    mocked.start.mockRejectedValue(failure);

    const engine = new HeadroomContextEngine();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      await expect(engine.ensureProxyUrl()).rejects.toBe(failure);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("isolates and logs proxy-ready listener rejections", async () => {
    const engine = new HeadroomContextEngine();
    const failing = vi.fn(async () => {
      throw new Error("listener boom");
    });
    const healthy = vi.fn();

    engine.onProxyReady(failing);
    engine.onProxyReady(healthy);

    engine.ensureProxyStarted();
    // ensureProxyUrl must still resolve despite the listener throwing.
    await expect(engine.ensureProxyUrl()).resolves.toBe("http://127.0.0.1:8787");

    expect(failing).toHaveBeenCalled();
    expect(healthy).toHaveBeenCalledWith("http://127.0.0.1:8787");
    expect(mocked.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Headroom proxy ready listener failed"),
    );
    expect(engine.getProxyStartupError()).toBeNull();
  });

  it("schedules startup and returns original messages when assembling before proxy readiness", async () => {
    const engine = new HeadroomContextEngine();
    const messages = [{ role: "user", content: "hello" }];

    await expect(
      engine.assemble({
        sessionId: "session-1",
        messages,
      }),
    ).resolves.toEqual({
      messages,
      estimatedTokens: 0,
    });
    expect(mocked.start).toHaveBeenCalledTimes(1);
  });

  it("skips proxy compression when context is clearly under token budget", async () => {
    const engine = new HeadroomContextEngine();
    (engine as { proxyUrl: string | null }).proxyUrl = "http://127.0.0.1:8787";
    const messages = [{ role: "user", content: "hello" }];

    await expect(
      engine.assemble({
        sessionId: "session-1",
        messages,
        tokenBudget: 1_000_000,
      }),
    ).resolves.toMatchObject({
      messages,
      estimatedTokens: expect.any(Number),
    });

    expect(compress).not.toHaveBeenCalled();
  });

  it("clears the request timeout after successful compression", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(compress).mockResolvedValue({
        compressed: false,
        messages: [{ role: "user", content: "hello" }],
        tokensBefore: 5,
        tokensAfter: 5,
        tokensSaved: 0,
      });

      const engine = new HeadroomContextEngine({ requestTimeoutMs: 30_000 });
      (engine as { proxyUrl: string | null }).proxyUrl = "http://127.0.0.1:8787";

      await expect(
        engine.assemble({
          sessionId: "session-1",
          messages: [{ role: "user", content: "hello" }],
        }),
      ).resolves.toEqual({
        messages: [{ role: "user", content: "hello" }],
        estimatedTokens: 5,
      });

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens the circuit after consecutive compression failures", async () => {
    vi.mocked(compress).mockRejectedValue(new Error("proxy stalled"));
    const messages = [{ role: "user", content: "hello" }];
    const engine = new HeadroomContextEngine({
      circuitBreakerThreshold: 2,
      circuitBreakerCooldownMs: 60_000,
    });
    (engine as { proxyUrl: string | null }).proxyUrl = "http://127.0.0.1:8787";

    await engine.assemble({ sessionId: "session-1", messages });
    await engine.assemble({ sessionId: "session-1", messages });
    await expect(engine.assemble({ sessionId: "session-1", messages })).resolves.toEqual({
      messages,
      estimatedTokens: 0,
    });

    expect(compress).toHaveBeenCalledTimes(2);
    expect(mocked.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Circuit breaker opened"),
    );
  });

  describe("commitTurn durable advancement", () => {
    const tempDirs: string[] = [];

    afterEach(() => {
      for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    function makeEngine() {
      const dir = mkdtempSync(join(tmpdir(), "headroom-engine-commit-"));
      tempDirs.push(dir);
      return new HeadroomContextEngine({
        turnAdvancementStorePath: join(dir, "turn-advancements.json"),
      });
    }

    const commitParams = {
      sessionId: "session-1",
      advancementKey: "turn-1",
      messages: [{ role: "user", content: "hello" }],
    };

    it("returns committed on first write and duplicate on retry", async () => {
      const engine = makeEngine();

      await expect(engine.commitTurn(commitParams)).resolves.toEqual({
        status: "committed",
      });
      await expect(engine.commitTurn(commitParams)).resolves.toEqual({
        status: "duplicate",
      });
    });

    it("persists across new engine instances after restart", async () => {
      const dir = mkdtempSync(join(tmpdir(), "headroom-engine-restart-"));
      tempDirs.push(dir);
      const storePath = join(dir, "turn-advancements.json");

      const first = new HeadroomContextEngine({ turnAdvancementStorePath: storePath });
      await expect(first.commitTurn(commitParams)).resolves.toEqual({
        status: "committed",
      });

      const second = new HeadroomContextEngine({ turnAdvancementStorePath: storePath });
      await expect(second.commitTurn(commitParams)).resolves.toEqual({
        status: "duplicate",
      });
    });
  });
});
