import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  TurnAdvancementStore,
  digestTurnMessages,
  resolveTurnAdvancementStorePath,
} from "../src/turn-advancement-store.js";

const tempDirs: string[] = [];
const pluginRoot = fileURLToPath(new URL("..", import.meta.url));

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

    const persisted = JSON.parse(readFileSync(storePath, "utf8"));
    expect(persisted.records["turn-restart"].messages).toEqual(messages);
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

  it("allows retry after a real filesystem persist failure", () => {
    const storePath = makeStorePath();
    mkdirSync(`${storePath}.tmp`, { recursive: true });

    const store = new TurnAdvancementStore({ storePath });
    const messages = [{ role: "user", content: "hello" }];

    expect(() =>
      store.commit({
        advancementKey: "turn-eisdir",
        sessionId: "session-1",
        messages,
      }),
    ).toThrow();

    expect(store.has("turn-eisdir")).toBe(false);

    rmSync(`${storePath}.tmp`, { recursive: true, force: true });

    expect(
      store.commit({
        advancementKey: "turn-eisdir",
        sessionId: "session-1",
        messages,
      }),
    ).toBe("committed");

    const reloaded = new TurnAdvancementStore({ storePath });
    expect(
      reloaded.commit({
        advancementKey: "turn-eisdir",
        sessionId: "session-1",
        messages,
      }),
    ).toBe("duplicate");
  });

  it("preserves both keys when two store instances commit different turns", () => {
    const storePath = makeStorePath();
    const storeA = new TurnAdvancementStore({ storePath });
    const storeB = new TurnAdvancementStore({ storePath });

    expect(
      storeA.commit({
        advancementKey: "turn-a",
        sessionId: "session-1",
        messages: [{ role: "user", content: "a" }],
      }),
    ).toBe("committed");

    expect(
      storeB.commit({
        advancementKey: "turn-b",
        sessionId: "session-1",
        messages: [{ role: "user", content: "b" }],
      }),
    ).toBe("committed");

    const persisted = JSON.parse(readFileSync(storePath, "utf8"));
    expect(Object.keys(persisted.records).sort()).toEqual(["turn-a", "turn-b"]);

    const storeC = new TurnAdvancementStore({ storePath });
    expect(
      storeC.commit({
        advancementKey: "turn-a",
        sessionId: "session-1",
        messages: [{ role: "user", content: "a" }],
      }),
    ).toBe("duplicate");
    expect(
      storeC.commit({
        advancementKey: "turn-b",
        sessionId: "session-1",
        messages: [{ role: "user", content: "b" }],
      }),
    ).toBe("duplicate");
  });

  it("preserves both keys across two processes on the same store path", () => {
    const distModule = join(pluginRoot, "dist/turn-advancement-store.js");
    if (!existsSync(distModule)) {
      const build = spawnSync("npm", ["run", "build"], {
        cwd: pluginRoot,
        encoding: "utf8",
      });
      expect(build.status).toBe(0);
    }

    const storePath = makeStorePath();
    const childScript = `
      import { TurnAdvancementStore } from ${JSON.stringify(distModule)};

      const store = new TurnAdvancementStore({ storePath: process.env.STORE_PATH });
      const status = store.commit({
        advancementKey: "turn-child",
        sessionId: "session-1",
        messages: [{ role: "user", content: "child" }],
      });
      process.stdout.write(status);
    `;

    const parent = new TurnAdvancementStore({ storePath });
    expect(
      parent.commit({
        advancementKey: "turn-parent",
        sessionId: "session-1",
        messages: [{ role: "user", content: "parent" }],
      }),
    ).toBe("committed");

    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", childScript],
      {
        cwd: pluginRoot,
        env: { ...process.env, STORE_PATH: storePath },
        encoding: "utf8",
      },
    );

    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    expect(child.stdout.trim()).toBe("committed");

    const persisted = JSON.parse(readFileSync(storePath, "utf8"));
    expect(Object.keys(persisted.records).sort()).toEqual([
      "turn-child",
      "turn-parent",
    ]);
  });

  it("reloads from disk on commit even when the in-memory cache is stale", () => {
    const storePath = makeStorePath();
    const storeA = new TurnAdvancementStore({ storePath });
    const storeB = new TurnAdvancementStore({ storePath });

    expect(storeB.has("turn-a")).toBe(false);

    expect(
      storeA.commit({
        advancementKey: "turn-a",
        sessionId: "session-1",
        messages: [{ role: "user", content: "a" }],
      }),
    ).toBe("committed");

    expect(storeB.has("turn-a")).toBe(false);

    expect(
      storeB.commit({
        advancementKey: "turn-b",
        sessionId: "session-1",
        messages: [{ role: "user", content: "b" }],
      }),
    ).toBe("committed");

    const persisted = JSON.parse(readFileSync(storePath, "utf8"));
    expect(Object.keys(persisted.records).sort()).toEqual(["turn-a", "turn-b"]);
  });

  it("detects key conflicts from disk even when the local cache is empty", () => {
    const storePath = makeStorePath();
    const writer = new TurnAdvancementStore({ storePath });
    writer.commit({
      advancementKey: "turn-conflict",
      sessionId: "session-1",
      messages: [{ role: "user", content: "first" }],
    });

    const reader = new TurnAdvancementStore({ storePath });
    expect(() =>
      reader.commit({
        advancementKey: "turn-conflict",
        sessionId: "session-1",
        messages: [{ role: "user", content: "second" }],
      }),
    ).toThrow(/key conflict/i);
  });

  it("re-persists the same key after the store file is deleted", () => {
    const storePath = makeStorePath();
    const store = new TurnAdvancementStore({ storePath });
    const messages = [{ role: "user", content: "hello" }];

    expect(
      store.commit({
        advancementKey: "turn-resurrect",
        sessionId: "session-1",
        messages,
      }),
    ).toBe("committed");

    rmSync(storePath, { force: true });

    expect(
      store.commit({
        advancementKey: "turn-resurrect",
        sessionId: "session-1",
        messages,
      }),
    ).toBe("committed");

    const reloaded = new TurnAdvancementStore({ storePath });
    expect(
      reloaded.commit({
        advancementKey: "turn-resurrect",
        sessionId: "session-1",
        messages,
      }),
    ).toBe("duplicate");
  });

  it("does not lose an earlier key when a later commit fails to persist", () => {
    const storePath = makeStorePath();
    const store = new TurnAdvancementStore({ storePath });

    expect(
      store.commit({
        advancementKey: "turn-ok",
        sessionId: "session-1",
        messages: [{ role: "user", content: "ok" }],
      }),
    ).toBe("committed");

    mkdirSync(`${storePath}.tmp`, { recursive: true });
    expect(() =>
      store.commit({
        advancementKey: "turn-fail",
        sessionId: "session-1",
        messages: [{ role: "user", content: "fail" }],
      }),
    ).toThrow();

    const persisted = JSON.parse(readFileSync(storePath, "utf8"));
    expect(Object.keys(persisted.records)).toEqual(["turn-ok"]);
    expect(persisted.records["turn-ok"].messages).toEqual([
      { role: "user", content: "ok" },
    ]);
  });

  it("preserves all keys when two instances commit in alternating order", () => {
    const storePath = makeStorePath();
    const storeA = new TurnAdvancementStore({ storePath });
    const storeB = new TurnAdvancementStore({ storePath });
    const keys: string[] = [];

    for (let index = 0; index < 20; index += 1) {
      const advancementKey = `turn-${index}`;
      keys.push(advancementKey);
      const store = index % 2 === 0 ? storeA : storeB;
      expect(
        store.commit({
          advancementKey,
          sessionId: "session-1",
          messages: [{ role: "user", content: `msg-${index}` }],
        }),
      ).toBe("committed");
    }

    const persisted = JSON.parse(readFileSync(storePath, "utf8"));
    expect(Object.keys(persisted.records).sort()).toEqual(keys.sort());
  });

  it("throws when the store file contains invalid JSON", () => {
    const storePath = makeStorePath();
    writeFileSync(storePath, "{not-json", "utf8");

    const store = new TurnAdvancementStore({ storePath });
    expect(() =>
      store.commit({
        advancementKey: "turn-bad-json",
        sessionId: "session-1",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).toThrow();
  });

  it("starts fresh when the store file has an unsupported version", () => {
    const storePath = makeStorePath();
    writeFileSync(
      storePath,
      JSON.stringify({ version: 99, records: { stale: { advancementKey: "stale" } } }),
      "utf8",
    );

    const store = new TurnAdvancementStore({ storePath });
    expect(
      store.commit({
        advancementKey: "turn-new",
        sessionId: "session-1",
        messages: [{ role: "user", content: "fresh" }],
      }),
    ).toBe("committed");

    const persisted = JSON.parse(readFileSync(storePath, "utf8"));
    expect(Object.keys(persisted.records)).toEqual(["turn-new"]);
  });

  it("does not leave a lock file behind after successful commits", () => {
    const storePath = makeStorePath();
    const store = new TurnAdvancementStore({ storePath });

    store.commit({
      advancementKey: "turn-lock",
      sessionId: "session-1",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(existsSync(`${storePath}.lock`)).toBe(false);
  });
});

describe("digestTurnMessages", () => {
  it("treats equivalent payloads with different key order as different digests", () => {
    const first = digestTurnMessages([{ role: "user", content: "hello" }]);
    const second = digestTurnMessages([{ content: "hello", role: "user" }]);
    expect(first).not.toBe(second);
  });

  it("hashes nested message payloads deterministically", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "café 🦞" }],
        toolCalls: [{ id: "call-1", name: "read", args: { path: "/tmp/a" } }],
      },
    ];
    expect(digestTurnMessages(messages)).toBe(digestTurnMessages(structuredClone(messages)));
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

  it("prefers an explicit override path", () => {
    expect(
      resolveTurnAdvancementStorePath({
        turnAdvancementStorePath: "/custom/turn-advancements.json",
        sessionTarget: {
          storePath: "/tmp/agent/sessions/main.sqlite",
        },
      }),
    ).toBe("/custom/turn-advancements.json");
  });

  it("falls back to OPENCLAW_STATE_DIR when no session target is provided", () => {
    const previous = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-state";
    try {
      expect(resolveTurnAdvancementStorePath({})).toBe(
        "/tmp/openclaw-state/headroom-turn-advancements.json",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previous;
      }
    }
  });
});
