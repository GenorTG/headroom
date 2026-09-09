import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
const sessionManagerMock = vi.hoisted(() => ({
  getBranch: vi.fn(() => []),
  branch: vi.fn(),
  resetLeaf: vi.fn(),
  appendMessage: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-sessions", () => ({
  SessionManager: {
    open: vi.fn(() => sessionManagerMock),
  },
}));

vi.mock("../src/proxy-manager.js", () => ({
  ProxyManager: class {
    start = vi.fn(async () => "http://127.0.0.1:8787");
    stop = vi.fn(async () => undefined);
  },
  defaultLogger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { HeadroomContextEngine } from "../src/engine.js";
import { planHeadroomCompaction } from "../src/compaction.js";

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  sessionManagerMock.getBranch.mockReset();
  sessionManagerMock.getBranch.mockReturnValue([]);
  sessionManagerMock.branch.mockReset();
  sessionManagerMock.resetLeaf.mockReset();
  sessionManagerMock.appendMessage.mockReset();
  vi.unstubAllGlobals();
});

function mockCompressResponse(payload: {
  messages: unknown[];
  tokens_before: number;
  tokens_after: number;
  tokens_saved: number;
}) {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => payload,
  });
}

describe("planHeadroomCompaction", () => {
  it("forces truncate when headroom returns noop on a huge session", async () => {
    mockCompressResponse({
      messages: [{ role: "user", content: "hello" }],
      tokens_before: 900_000,
      tokens_after: 900_000,
      tokens_saved: 0,
    });

    const branchMessages = Array.from({ length: 100 }, (_, index) => ({
      entryId: `entry-${index}`,
      parentId: index === 0 ? null : `entry-${index - 1}`,
      message: { role: "user", content: `msg-${index}`, timestamp: index },
    }));

    const plan = await planHeadroomCompaction({
      branchMessages,
      tokenBudget: 120_000,
      proxyUrl: "http://127.0.0.1:8787",
      timeoutMs: 30_000,
      force: true,
    });

    expect(plan.mode).toBe("truncate");
    expect(plan.appendMessages?.length).toBeGreaterThan(0);
    expect(plan.appendMessages?.length).toBeLessThan(branchMessages.length);
  });
});

describe("HeadroomContextEngine durable compaction", () => {
  it("returns compacted:false for small noop sessions without force", async () => {
    mockCompressResponse({
      messages: [{ role: "user", content: "hello" }],
      tokens_before: 100,
      tokens_after: 100,
      tokens_saved: 0,
    });
    sessionManagerMock.getBranch.mockReturnValue([
      {
        type: "message",
        id: "entry-1",
        parentId: null,
        message: { role: "user", content: "hello", timestamp: 1 },
      },
    ]);

    const engine = new HeadroomContextEngine();
    (engine as { proxyUrl: string | null }).proxyUrl = "http://127.0.0.1:8787";

    await expect(
      engine.compact({
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        sessionFile: "ignored",
        tokenBudget: 50_000,
      }),
    ).resolves.toMatchObject({
      ok: true,
      compacted: false,
      reason: "No durable compaction needed",
    });
  });

  it("plans replace compaction and persists via maintain()", async () => {
    mockCompressResponse({
      messages: [{ role: "user", content: "hi" }],
      tokens_before: 1000,
      tokens_after: 200,
      tokens_saved: 800,
    });
    sessionManagerMock.getBranch.mockReturnValue([
      {
        type: "message",
        id: "entry-1",
        parentId: null,
        message: { role: "user", content: "hello ".repeat(200), timestamp: 1 },
      },
    ]);

    const rewriteTranscriptEntries = vi.fn(async () => ({
      changed: true,
      bytesFreed: 500,
      rewrittenEntries: 1,
    }));

    const engine = new HeadroomContextEngine();
    (engine as { proxyUrl: string | null }).proxyUrl = "http://127.0.0.1:8787";

    const compactResult = await engine.compact({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile: "ignored",
      tokenBudget: 50_000,
      force: true,
    });

    expect(compactResult.compacted).toBe(true);
    expect(compactResult.result?.tokensBefore).toBe(1000);
    expect(compactResult.result?.tokensAfter).toBe(200);

    const maintainResult = await engine.maintain({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile: "ignored",
      runtimeContext: { rewriteTranscriptEntries },
    });

    expect(maintainResult.changed).toBe(true);
    expect(rewriteTranscriptEntries).toHaveBeenCalledTimes(1);
  });
});
