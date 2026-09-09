import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  TurnAdvancementStore,
  resolveTurnAdvancementStorePath,
} from "../src/turn-advancement-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "headroom-turn-advancement-"));
  tempDirs.push(dir);
  return join(dir, "turn-advancements.json");
}

describe("TurnAdvancementStore", () => {
  it("commits a turn and returns duplicate on retry with the same key", () => {
    const storePath = makeStorePath();
    const store = new TurnAdvancementStore({ storePath });
    const messages = [{ role: "user", content: "hello" }];

    expect(
      store.commit({
        advancementKey: "turn-1",
        sessionId: "session-1",
        messages,
      }),
    ).toBe("committed");

    expect(
      store.commit({
        advancementKey: "turn-1",
        sessionId: "session-1",
        messages,
      }),
    ).toBe("duplicate");
  });

  it("persists across store restarts", () => {
    const storePath = makeStorePath();
    const messages = [{ role: "assistant", content: "done" }];

    const first = new TurnAdvancementStore({ storePath });
    expect(
      first.commit({
        advancementKey: "turn-restart",
        sessionId: "session-1",
        messages,
      }),
    ).toBe("committed");

    const second = new TurnAdvancementStore({ storePath });
    expect(
      second.commit({
        advancementKey: "turn-restart",
        sessionId: "session-1",
        messages,
      }),
    ).toBe("duplicate");
    expect(second.has("turn-restart")).toBe(true);
  });

  it("throws when a retry presents the same key with different messages", () => {
    const storePath = makeStorePath();
    const store = new TurnAdvancementStore({ storePath });

    store.commit({
      advancementKey: "turn-conflict",
      sessionId: "session-1",
      messages: [{ role: "user", content: "first" }],
    });

    expect(() =>
      store.commit({
        advancementKey: "turn-conflict",
        sessionId: "session-1",
        messages: [{ role: "user", content: "second" }],
      }),
    ).toThrow(/key conflict/i);
  });

  it("does not persist when injectBeforePersist fails", () => {
    const storePath = makeStorePath();
    const store = new TurnAdvancementStore({
      storePath,
      injectBeforePersist: () => {
        throw new Error("disk full");
      },
    });

    expect(() =>
      store.commit({
        advancementKey: "turn-failed",
        sessionId: "session-1",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).toThrow(/disk full/i);

    expect(store.has("turn-failed")).toBe(false);

    const reloaded = new TurnAdvancementStore({ storePath });
    expect(
      reloaded.commit({
        advancementKey: "turn-failed",
        sessionId: "session-1",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).toBe("committed");
    expect(readFileSync(storePath, "utf8")).toContain("turn-failed");
  });
});

describe("resolveTurnAdvancementStorePath", () => {
  it("derives a store path from the session store path", () => {
    expect(
      resolveTurnAdvancementStorePath({
        sessionTarget: {
          storePath: "/tmp/agent/sessions/main.sqlite",
        },
      }),
    ).toBe("/tmp/agent/sessions/headroom-turn-advancements.json");
  });
});
