/**
 * Convert between OpenClaw's AgentMessage format and OpenAI message format.
 *
 * AgentMessage uses:
 *   role: "user" | "assistant" | "toolResult"
 *   content: string | ContentBlock[]
 *
 * OpenAI uses:
 *   role: "user" | "assistant" | "system" | "tool"
 *   content: string
 *   tool_calls?: ToolCall[]
 *   tool_call_id?: string
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Rough token estimate (~4 chars/token) for assemble budget short-circuit. */
export function estimateRoughTokens(messages: any[]): number {
  let chars = 0;
  for (const msg of messages) {
    const content = msg?.content;
    if (typeof content === "string") {
      chars += content.length;
      continue;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string") {
          chars += block.text.length;
        } else {
          chars += JSON.stringify(block).length;
        }
      }
      continue;
    }
    if (content != null) {
      chars += JSON.stringify(content).length;
    }
  }
  return Math.max(1, Math.ceil(chars / 4));
}

export interface OpenAIMessage {
  role: string;
  content: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
  _headroomMeta?: Record<string, unknown>;
}

/** Prefix for structured toolResult block arrays in OpenAI tool message content. */
export const TOOL_CONTENT_BLOCKS_PREFIX = "__HR_TOOL_BLOCKS__";

/** Prefix for structured user content block arrays in OpenAI user message content. */
export const USER_CONTENT_BLOCKS_PREFIX = "__HR_USER_BLOCKS__";

/** True when a message carries multimodal or tool payloads that must not be lossy-rewritten. */
function blockIsProtectedPayload(block: unknown): boolean {
  if (!isRecord(block) || typeof block.type !== "string") return false;
  return (
    block.type === "image" ||
    block.type === "toolCall" ||
    block.type === "tool_use" ||
    block.type === "tool_result"
  );
}

export function messageHasProtectedToolPayload(message: any): boolean {
  if (!isRecord(message)) return false;
  const role = message.role;
  if (
    role !== "toolResult" &&
    role !== "tool_result" &&
    role !== "assistant" &&
    role !== "user"
  ) {
    return false;
  }
  const content = message.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => blockIsProtectedPayload(block));
}

/** Serialize normalized toolResult blocks for OpenAI tool role (string content only). */
export function serializeToolResultBlocks(blocks: any[]): string {
  if (blocks.length === 0) return "";
  if (blocks.length === 1 && blocks[0]?.type === "text" && typeof blocks[0].text === "string") {
    return blocks[0].text;
  }
  const textOnly = blocks.every(
    (block) => block?.type === "text" && typeof block.text === "string",
  );
  if (textOnly) {
    return blocks.map((block) => block.text).join("\n");
  }
  return `${TOOL_CONTENT_BLOCKS_PREFIX}${JSON.stringify(blocks)}`;
}

/** Restore block arrays from OpenAI string content and preserved metadata. */
export function deserializeStructuredContent(
  content: string | null | undefined,
  meta: Record<string, unknown>,
  options: {
    prefix: string;
    metaKey: "toolContentBlocks" | "userContentBlocks";
  },
): any[] {
  const trimmed = typeof content === "string" ? content : "";
  if (trimmed.startsWith(options.prefix)) {
    try {
      const parsed = JSON.parse(trimmed.slice(options.prefix.length));
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      // fall through to meta / plain text
    }
  }

  const fromMeta = meta[options.metaKey];
  if (Array.isArray(fromMeta) && fromMeta.length > 0) {
    const metaHasStructured = fromMeta.some(
      (block) => isRecord(block) && block.type !== "text",
    );
    if (metaHasStructured || !trimmed) {
      return fromMeta;
    }
  }

  return [{ type: "text", text: trimmed }];
}

/** Restore toolResult blocks from OpenAI tool content and preserved metadata. */
export function deserializeToolResultContent(
  content: string | null | undefined,
  meta: Record<string, unknown>,
): any[] {
  return deserializeStructuredContent(content, meta, {
    prefix: TOOL_CONTENT_BLOCKS_PREFIX,
    metaKey: "toolContentBlocks",
  });
}

/** Restore user content blocks from OpenAI user content and preserved metadata. */
export function deserializeUserContent(
  content: string | null | undefined,
  meta: Record<string, unknown>,
): any[] {
  return deserializeStructuredContent(content, meta, {
    prefix: USER_CONTENT_BLOCKS_PREFIX,
    metaKey: "userContentBlocks",
  });
}

/** Serialize normalized user content blocks for OpenAI user role (string content only). */
export function serializeUserContentBlocks(blocks: any[]): string {
  if (blocks.length === 0) return "";
  if (blocks.length === 1 && blocks[0]?.type === "text" && typeof blocks[0].text === "string") {
    return blocks[0].text;
  }
  const textOnly = blocks.every(
    (block) => block?.type === "text" && typeof block.text === "string",
  );
  if (textOnly) {
    return blocks.map((block) => block.text).join("\n");
  }
  return `${USER_CONTENT_BLOCKS_PREFIX}${JSON.stringify(blocks)}`;
}

/**
 * Convert AgentMessage[] to OpenAI message format for compression.
 */
export function agentToOpenAI(messages: any[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  for (const msg of messages) {
    const normalized = normalizeAgentMessage(msg);
    const role = normalized.role;

    const buildMeta = (): Record<string, unknown> => {
      const meta = { ...normalized } as Record<string, unknown>;
      delete meta.role;
      delete meta.content;
      return meta;
    };

    if (role === "system") {
      result.push({
        role: "system",
        content:
          typeof normalized.content === "string"
            ? normalized.content
            : extractText(normalized.content),
        _headroomMeta: buildMeta(),
      });
      continue;
    }

    if (role === "user") {
      const content = normalized.content;
      if (typeof content === "string") {
        result.push({
          role: "user",
          content,
          _headroomMeta: buildMeta(),
        });
        continue;
      }

      if (Array.isArray(content)) {
        const userBlocks = normalizeUserContent(content);
        const meta = {
          ...buildMeta(),
          userContentBlocks: userBlocks,
        };
        result.push({
          role: "user",
          content: serializeUserContentBlocks(userBlocks),
          _headroomMeta: meta,
        });
        continue;
      }

      result.push({
        role: "user",
        content: JSON.stringify(content),
        _headroomMeta: buildMeta(),
      });
      continue;
    }

    if (role === "assistant") {
      const content = normalized.content;
      if (typeof content === "string") {
        result.push({ role: "assistant", content, _headroomMeta: buildMeta() });
        continue;
      }

      // Content blocks: extract text and tool call blocks.
      // OpenClaw uses `toolCall`; some adapters still emit legacy `tool_use`.
      if (Array.isArray(content)) {
        const normalizedBlocks = normalizeAssistantContent(content);
        const textParts: string[] = [];
        const toolCalls: any[] = [];
        const preservedBlocks: any[] = [];

        for (const block of normalizedBlocks) {
          if (typeof block === "string") {
            textParts.push(block);
            preservedBlocks.push({ type: "text", text: block });
          } else if (block.type === "text" && typeof block.text === "string") {
            textParts.push(block.text);
            preservedBlocks.push(block);
          } else if (block.type === "tool_use" || block.type === "toolCall") {
            const args =
              block.type === "toolCall"
                ? block.arguments
                : block.input;
            toolCalls.push({
              id: block.id,
              type: "function",
              function: {
                name: block.name,
                arguments:
                  typeof args === "string"
                    ? args
                    : JSON.stringify(args ?? {}),
              },
            });
            preservedBlocks.push(block);
          } else {
            preservedBlocks.push(block);
          }
        }

        const openaiMsg: OpenAIMessage = {
          role: "assistant",
          content: textParts.length > 0 ? textParts.join("") : null,
          _headroomMeta: {
            ...buildMeta(),
            assistantContentBlocks: preservedBlocks,
          },
        };
        if (toolCalls.length > 0) {
          openaiMsg.tool_calls = toolCalls;
        }
        result.push(openaiMsg);
      }
      continue;
    }

    if (role === "toolResult" || role === "tool_result") {
      const toolBlocks =
        typeof normalized.content === "string"
          ? [{ type: "text", text: normalized.content }]
          : Array.isArray(normalized.content)
            ? normalizeToolResultContent(normalized.content)
            : [{ type: "text", text: JSON.stringify(normalized.content) }];
      const toolName =
        typeof normalized.toolName === "string" ? normalized.toolName : undefined;
      const meta = {
        ...buildMeta(),
        toolContentBlocks: toolBlocks,
        ...(toolName ? { toolName } : {}),
      };

      result.push({
        role: "tool",
        content: serializeToolResultBlocks(toolBlocks),
        tool_call_id:
          normalized.toolCallId ??
          normalized.tool_use_id ??
          normalized.id ??
          "unknown",
        ...(toolName ? { name: toolName } : {}),
        _headroomMeta: meta,
      });
      continue;
    }

    // Fallback: pass through as user message
    result.push({
      role: "user",
      content:
        typeof normalized.content === "string"
          ? normalized.content
          : JSON.stringify(normalized.content),
      _headroomMeta: buildMeta(),
    });
  }

  return result;
}

/**
 * Convert compressed OpenAI messages back to AgentMessage format.
 */
export function openAIToAgent(messages: OpenAIMessage[]): any[] {
  const result: any[] = [];

  for (const msg of messages) {
    const meta = (msg._headroomMeta ?? {}) as Record<string, unknown>;
    const timestamp =
      typeof meta.timestamp === "number" ? meta.timestamp : Date.now();

    if (msg.role === "system") {
      result.push({
        role: "system",
        content: msg.content ?? "",
        timestamp,
      });
      continue;
    }

    if (msg.role === "user") {
      const blocks = deserializeUserContent(msg.content, meta);
      const content =
        blocks.length === 1 && blocks[0]?.type === "text" && typeof blocks[0].text === "string"
          ? blocks[0].text
          : blocks;
      result.push({
        ...(meta as object),
        role: "user",
        content,
        timestamp,
      });
      continue;
    }

    if (msg.role === "assistant") {
      const preserved = Array.isArray(meta.assistantContentBlocks)
        ? (meta.assistantContentBlocks as any[])
        : null;
      const blocks: any[] = preserved ? [...preserved] : [];

      if (!preserved) {
        if (msg.content) {
          blocks.push({ type: "text", text: msg.content });
        }
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            let input: any;
            try {
              input = JSON.parse(tc.function.arguments);
            } catch {
              input = tc.function.arguments ?? {};
            }
            blocks.push({
              type: "toolCall",
              id: tc.id,
              name: tc.function.name,
              arguments: input,
            });
          }
        }
      } else if (msg.content) {
        const textIndex = blocks.findIndex((block) => block?.type === "text");
        if (textIndex >= 0) {
          blocks[textIndex] = { type: "text", text: msg.content };
        } else {
          blocks.unshift({ type: "text", text: msg.content });
        }
      }
      // OpenClaw's Pi agent expects content to always be an array for assistant messages
      // (it calls .flatMap() on it). Never flatten to a string.
      result.push({
        ...(meta as object),
        role: "assistant",
        content: blocks,
        api: typeof meta.api === "string" ? meta.api : "headroom",
        provider: typeof meta.provider === "string" ? meta.provider : "headroom",
        model: typeof meta.model === "string" ? meta.model : "headroom",
        usage:
          isRecord(meta.usage)
            ? meta.usage
            : {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
        stopReason:
          typeof meta.stopReason === "string" ? meta.stopReason : "stop",
        timestamp,
      });
      continue;
    }

    if (msg.role === "tool") {
      const rawContent =
        typeof msg.content === "string"
          ? msg.content
          : msg.content == null
            ? ""
            : JSON.stringify(msg.content);
      const toolCallId = msg.tool_call_id ?? "unknown";
      const toolName =
        typeof msg.name === "string"
          ? msg.name
          : typeof meta.toolName === "string"
            ? meta.toolName
            : "headroom";
      const content = deserializeToolResultContent(rawContent, meta);
      result.push({
        ...(meta as object),
        role: "toolResult",
        content,
        toolCallId:
          typeof meta.toolCallId === "string" ? meta.toolCallId : toolCallId,
        tool_use_id:
          typeof meta.tool_use_id === "string" ? meta.tool_use_id : toolCallId,
        toolName,
        isError: inferToolResultIsError(content, meta),
        timestamp,
      });
      continue;
    }
  }

  return result;
}

export function normalizeAgentMessages(messages: any[]): any[] {
  return messages.map((message) => normalizeAgentMessage(message));
}

/**
 * Extract text from content blocks.
 */
function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);

  return content
    .map((block: any) => {
      if (typeof block === "string") return block;
      if (block.type === "text") return block.text;
      if (block.type === "tool_result") {
        return typeof block.content === "string" ? block.content : JSON.stringify(block.content);
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeAgentMessage(message: any): any {
  if (!isRecord(message)) return message;

  if (message.role === "assistant") {
    return normalizeAssistantMessage(message);
  }

  if (message.role === "toolResult" || message.role === "tool_result") {
    return normalizeToolResultMessage(message);
  }

  return message;
}

function normalizeAssistantMessage(message: Record<string, any>): Record<string, any> {
  const normalizedContent = normalizeAssistantContent(message.content);

  return {
    ...message,
    content: normalizedContent,
    api: typeof message.api === "string" ? message.api : "headroom",
    provider: typeof message.provider === "string" ? message.provider : "headroom",
    model: typeof message.model === "string" ? message.model : "headroom",
    usage: isRecord(message.usage)
      ? message.usage
      : {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
    stopReason: typeof message.stopReason === "string" ? message.stopReason : "stop",
    timestamp: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
  };
}

function normalizeToolResultMessage(message: Record<string, any>): Record<string, any> {
  const normalizedContent = normalizeToolResultContent(message.content);
  const toolCallId =
    typeof message.toolCallId === "string"
      ? message.toolCallId
      : typeof message.tool_use_id === "string"
        ? message.tool_use_id
        : typeof message.id === "string"
          ? message.id
          : "unknown";

  return {
    ...message,
    role: "toolResult",
    content: normalizedContent,
    toolCallId,
    tool_use_id:
      typeof message.tool_use_id === "string" ? message.tool_use_id : toolCallId,
    toolName: typeof message.toolName === "string" ? message.toolName : "headroom",
    isError: typeof message.isError === "boolean" ? message.isError : false,
    timestamp: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
  };
}

function normalizeAssistantContent(content: unknown): any[] {
  if (Array.isArray(content)) {
    return content.flatMap((block) => {
      if (typeof block === "string") return [{ type: "text", text: block }];
      if (!isRecord(block) || typeof block.type !== "string") return [];
      if (block.type === "text" && typeof block.text === "string") return [block];
      if (block.type === "thinking" && typeof block.thinking === "string") return [block];
      if (
        (block.type === "toolCall" || block.type === "tool_use") &&
        typeof block.name === "string"
      ) {
        return [
          {
            type: "toolCall",
            id: typeof block.id === "string" ? block.id : "unknown",
            name: block.name,
            arguments:
              "arguments" in block
                ? block.arguments
                : "input" in block
                  ? block.input
                  : {},
          },
        ];
      }
      return [block];
    });
  }

  if (typeof content === "string" && content.length > 0) {
    return [{ type: "text", text: content }];
  }

  if (content == null) {
    return [];
  }

  return [{ type: "text", text: JSON.stringify(content) }];
}

function normalizeUserContent(content: unknown): any[] {
  if (Array.isArray(content)) {
    return content.flatMap((block) => {
      if (typeof block === "string") return [{ type: "text", text: block }];
      if (!isRecord(block) || typeof block.type !== "string") return [];
      if (block.type === "text" && typeof block.text === "string") return [block];
      if (block.type === "tool_result" && "content" in block) {
        return [
          {
            type: "tool_result",
            tool_use_id:
              typeof block.tool_use_id === "string"
                ? block.tool_use_id
                : typeof block.id === "string"
                  ? block.id
                  : "unknown",
            content: normalizeToolResultContent(block.content),
          },
        ];
      }
      return [block];
    });
  }

  if (typeof content === "string" && content.length > 0) {
    return [{ type: "text", text: content }];
  }

  if (content == null) {
    return [];
  }

  return [{ type: "text", text: JSON.stringify(content) }];
}

function normalizeToolResultContent(content: unknown): any[] {
  if (Array.isArray(content)) {
    return content.flatMap((block) => {
      if (typeof block === "string") return [{ type: "text", text: block }];
      if (!isRecord(block) || typeof block.type !== "string") return [];
      if (block.type === "text" && typeof block.text === "string") return [block];
      if (
        block.type === "image" &&
        typeof block.data === "string" &&
        typeof block.mimeType === "string"
      ) {
        return [block];
      }
      if (block.type === "tool_result" && "content" in block) {
        return normalizeToolResultContent(block.content);
      }
      return [block];
    });
  }

  if (typeof content === "string" && content.length > 0) {
    return [{ type: "text", text: content }];
  }

  if (content == null) {
    return [];
  }

  return [{ type: "text", text: JSON.stringify(content) }];
}

function inferToolResultIsError(
  blocks: unknown[],
  meta: Record<string, unknown>,
): boolean {
  if (typeof meta.isError === "boolean") return meta.isError;
  for (const block of blocks) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
      continue;
    }
    const trimmed = block.text.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { status?: string };
      if (parsed.status === "error") return true;
    } catch {
      // not JSON — ignore
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
