import { describe, expect, it } from "vitest";
import {
  TOOL_CONTENT_BLOCKS_PREFIX,
  USER_CONTENT_BLOCKS_PREFIX,
  agentToOpenAI,
  deserializeToolResultContent,
  deserializeUserContent,
  messageHasProtectedToolPayload,
  normalizeAgentMessages,
  openAIToAgent,
  serializeToolResultBlocks,
  serializeUserContentBlocks,
  type OpenAIMessage,
} from "../src/convert";

describe("openAIToAgent", () => {
  it("emits toolResult content as blocks so transports can safely filter", () => {
    const messages: OpenAIMessage[] = [
      {
        role: "tool",
        content: "tool output",
        tool_call_id: "call_123",
      },
    ];

    const result = openAIToAgent(messages);
    const toolResult = result[0] as {
      role: string;
      content: Array<{ type: string; text?: string }>;
      toolCallId: string;
      tool_use_id: string;
    };

    expect(toolResult.role).toBe("toolResult");
    expect(Array.isArray(toolResult.content)).toBe(true);
    expect(toolResult.content).toEqual([{ type: "text", text: "tool output" }]);
    expect(toolResult.toolCallId).toBe("call_123");
    expect(toolResult.tool_use_id).toBe("call_123");
  });

  it("restores image blocks from structured tool content", () => {
    const imageBlock = {
      type: "image",
      data: "aGVsbG8=",
      mimeType: "image/png",
    };
    const messages: OpenAIMessage[] = [
      {
        role: "tool",
        content: serializeToolResultBlocks([imageBlock]),
        tool_call_id: "call_img",
        name: "view_image",
        _headroomMeta: {
          toolContentBlocks: [imageBlock],
          toolName: "view_image",
        },
      },
    ];

    const result = openAIToAgent(messages);
    expect(result[0]).toMatchObject({
      role: "toolResult",
      toolName: "view_image",
      content: [imageBlock],
    });
  });

  it("prefers preserved toolContentBlocks when proxy lossy-compressed content to plain text", () => {
    const imageBlock = {
      type: "image",
      data: "aGVsbG8=",
      mimeType: "image/png",
    };
    const messages: OpenAIMessage[] = [
      {
        role: "tool",
        content: "[compressed summary only]",
        tool_call_id: "call_img",
        name: "view_image",
        _headroomMeta: {
          toolContentBlocks: [imageBlock],
          toolName: "view_image",
        },
      },
    ];

    const result = openAIToAgent(messages);
    expect(result[0].content).toEqual([imageBlock]);
  });
});

describe("normalizeAgentMessages", () => {
  it("normalizes assistant string content into OpenClaw blocks", () => {
    const result = normalizeAgentMessages([
      {
        role: "assistant",
        content: "hello from headroom",
      },
    ]);

    expect(result[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "hello from headroom" }],
      api: "headroom",
      provider: "headroom",
      model: "headroom",
      stopReason: "stop",
    });
  });

  it("normalizes tool result string content into OpenClaw blocks", () => {
    const result = normalizeAgentMessages([
      {
        role: "toolResult",
        content: "tool output",
      },
    ]);

    expect(result[0]).toMatchObject({
      role: "toolResult",
      content: [{ type: "text", text: "tool output" }],
      toolCallId: "unknown",
      tool_use_id: "unknown",
      toolName: "headroom",
      isError: false,
    });
  });

  it("preserves image blocks in tool results", () => {
    const imageBlock = {
      type: "image",
      data: "abc123",
      mimeType: "image/jpeg",
    };
    const result = normalizeAgentMessages([
      {
        role: "toolResult",
        toolName: "view_image",
        content: [imageBlock],
      },
    ]);

    expect(result[0].content).toEqual([imageBlock]);
  });

  it("preserves unknown assistant block types instead of dropping them", () => {
    const customBlock = { type: "custom_provider_block", payload: { ok: true } };
    const result = normalizeAgentMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: "hi" }, customBlock],
      },
    ]);

    expect(result[0].content).toEqual([
      { type: "text", text: "hi" },
      customBlock,
    ]);
  });
});

describe("agentToOpenAI", () => {
  it("captures assistant metadata needed for OpenClaw round-trips", () => {
    const result = agentToOpenAI([
      {
        role: "assistant",
        content: "hello",
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        stopReason: "stop",
        usage: {
          input: 1,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 3,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    ]);

    expect(result[0]._headroomMeta).toMatchObject({
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      stopReason: "stop",
    });
  });

  it("includes tool name on OpenAI tool messages for proxy protect-list matching", () => {
    const result = agentToOpenAI([
      {
        role: "toolResult",
        toolCallId: "call_browser_1",
        toolName: "browser",
        content: [{ type: "text", text: "screenshot saved" }],
      },
    ]);

    expect(result[0]).toMatchObject({
      role: "tool",
      name: "browser",
      tool_call_id: "call_browser_1",
      content: "screenshot saved",
    });
    expect(result[0]._headroomMeta?.toolName).toBe("browser");
  });

  it("serializes image tool results with structured prefix", () => {
    const imageBlock = {
      type: "image",
      data: "aGVsbG8=",
      mimeType: "image/png",
    };
    const result = agentToOpenAI([
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "view_image",
        content: [imageBlock],
      },
    ]);

    expect(result[0].content).toBe(
      `${TOOL_CONTENT_BLOCKS_PREFIX}${JSON.stringify([imageBlock])}`,
    );
    expect(result[0].name).toBe("view_image");
  });

  it("preserves thinking and toolCall blocks on assistant round-trip", () => {
    const original = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "planning screenshot" },
          { type: "text", text: "I'll capture the screen." },
          {
            type: "toolCall",
            id: "call_browser_1",
            name: "browser",
            arguments: { action: "screenshot" },
          },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        stopReason: "toolUse",
      },
    ];

    const roundTrip = openAIToAgent(agentToOpenAI(original));
    expect(roundTrip[0].content).toEqual(
      expect.arrayContaining([
        { type: "thinking", thinking: "planning screenshot" },
        { type: "text", text: "I'll capture the screen." },
        expect.objectContaining({
          type: "toolCall",
          id: "call_browser_1",
          name: "browser",
        }),
      ]),
    );
  });

  it("round-trips image tool results through openAIToAgent", () => {
    const imageBlock = {
      type: "image",
      data: "aGVsbG8=",
      mimeType: "image/png",
    };
    const original = [
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "view_image",
        content: [imageBlock],
      },
    ];

    const roundTrip = openAIToAgent(agentToOpenAI(original));
    expect(roundTrip[0]).toMatchObject({
      role: "toolResult",
      toolName: "view_image",
      content: [imageBlock],
    });
  });
});

describe("serializeToolResultBlocks / deserializeToolResultContent", () => {
  it("uses plain string for single text block", () => {
    expect(serializeToolResultBlocks([{ type: "text", text: "only text" }])).toBe(
      "only text",
    );
  });

  it("parses structured prefix back to blocks", () => {
    const blocks = [
      { type: "image", data: "x", mimeType: "image/png" },
      { type: "text", text: "caption" },
    ];
    const serialized = serializeToolResultBlocks(blocks);
    expect(deserializeToolResultContent(serialized, {})).toEqual(blocks);
  });
});

describe("user content preservation", () => {
  it("serializes Anthropic-shaped user tool_result blocks", () => {
    const blocks = [
      { type: "text", text: "here is the result" },
      {
        type: "tool_result",
        tool_use_id: "call_1",
        content: [{ type: "text", text: "payload" }],
      },
    ];
    const result = agentToOpenAI([{ role: "user", content: blocks }]);
    expect(result[0].content).toBe(
      `${USER_CONTENT_BLOCKS_PREFIX}${JSON.stringify(blocks)}`,
    );
    expect(result[0]._headroomMeta?.userContentBlocks).toEqual(blocks);
  });

  it("round-trips user tool_result blocks through openAIToAgent", () => {
    const blocks = [
      { type: "text", text: "summary" },
      {
        type: "tool_result",
        tool_use_id: "call_1",
        content: [{ type: "text", text: "payload" }],
      },
    ];
    const roundTrip = openAIToAgent(agentToOpenAI([{ role: "user", content: blocks }]));
    expect(roundTrip[0].content).toEqual(blocks);
  });

  it("restores user blocks from metadata when proxy lossy-compressed content", () => {
    const blocks = [
      {
        type: "tool_result",
        tool_use_id: "call_1",
        content: [{ type: "text", text: "payload" }],
      },
    ];
    const serialized = serializeUserContentBlocks(blocks);
    expect(deserializeUserContent("[summary only]", { userContentBlocks: blocks })).toEqual(
      blocks,
    );
    expect(deserializeUserContent(serialized, {})).toEqual(blocks);
  });
});

describe("inferToolResultIsError via openAIToAgent", () => {
  it("restores isError from JSON error envelope when proxy strips _headroomMeta", () => {
    const messages: OpenAIMessage[] = [
      {
        role: "tool",
        content: JSON.stringify({
          status: "error",
          tool: "view_image",
          error: "Local media path is not under an allowed directory",
        }),
        tool_call_id: "call_err",
        name: "view_image",
      },
    ];

    const result = openAIToAgent(messages);
    expect(result[0].isError).toBe(true);
  });
});

describe("messageHasProtectedToolPayload", () => {
  it("detects image tool results", () => {
    expect(
      messageHasProtectedToolPayload({
        role: "toolResult",
        content: [{ type: "image", data: "x", mimeType: "image/png" }],
      }),
    ).toBe(true);
  });

  it("ignores plain text tool results", () => {
    expect(
      messageHasProtectedToolPayload({
        role: "toolResult",
        content: [{ type: "text", text: "ok" }],
      }),
    ).toBe(false);
  });

  it("detects user messages with embedded tool_result blocks", () => {
    expect(
      messageHasProtectedToolPayload({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: [{ type: "text", text: "ok" }],
          },
        ],
      }),
    ).toBe(true);
  });
});
