/**
 * Anthropic Messages Wire Protocol & Fixtures (/messages).
 *
 * Implements:
 * - Protocol: anthropic-messages
 * - Wire header: x-api-key: <key>
 * - Wire stream events (message_start, content_block_delta, message_delta, message_stop)
 * - Unary message payload
 * - Wire stream parsing is handled by the host's `pi-ai` adapter, not hand-wired here.
 *
 * @module test/mock/protocols/anthropic-messages.protocol
 */

export const MESSAGES_PROTOCOL = "anthropic-messages" as const;
export const MESSAGES_KIND = "messages" as const;
export const MESSAGES_WIRE_HEADER = "x-api-key" as const;

export const MOCK_TEXT = "Hello from the mock gateway.";

export interface MessagesContentItem {
  readonly text: string;
  readonly type: "text";
}

export interface MessagesUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

export interface MessagesUnaryPayload {
  readonly content: readonly MessagesContentItem[];
  readonly id: string;
  readonly model: string;
  readonly role: "assistant";
  readonly stop_reason: string;
  readonly stop_sequence: string | null;
  readonly type: "message";
  readonly usage: MessagesUsage;
}

const sseEvent = (name: string, payload: unknown): string =>
  `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;

/**
 * Generate wire streaming SSE events for Anthropic Messages API.
 */
export const anthropicStream = (model: string): string =>
  [
    sseEvent("message_start", {
      message: {
        content: [],
        id: "msg_mock",
        model,
        role: "assistant",
        stop_reason: null,
        stop_sequence: null,
        type: "message",
        usage: { input_tokens: 5, output_tokens: 1 },
      },
      type: "message_start",
    }),
    sseEvent("content_block_start", {
      content_block: { text: "", type: "text" },
      index: 0,
      type: "content_block_start",
    }),
    sseEvent("content_block_delta", {
      delta: { text: "Hello from ", type: "text_delta" },
      index: 0,
      type: "content_block_delta",
    }),
    sseEvent("content_block_delta", {
      delta: { text: "the mock gateway.", type: "text_delta" },
      index: 0,
      type: "content_block_delta",
    }),
    sseEvent("content_block_stop", { index: 0, type: "content_block_stop" }),
    sseEvent("message_delta", {
      delta: { stop_reason: "end_turn", stop_sequence: null },
      type: "message_delta",
      usage: { output_tokens: 6 },
    }),
    sseEvent("message_stop", { type: "message_stop" }),
  ].join("");

/**
 * Generate wire unary JSON for Anthropic Messages API when stream is false.
 */
export const anthropicUnary = (model: string): string =>
  JSON.stringify({
    content: [{ text: MOCK_TEXT, type: "text" }],
    id: "msg_mock",
    model,
    role: "assistant",
    stop_reason: "end_turn",
    stop_sequence: null,
    type: "message",
    usage: { input_tokens: 5, output_tokens: 6 },
  });

export const AnthropicMessagesProtocol = {
  kind: MESSAGES_KIND,
  protocol: MESSAGES_PROTOCOL,
  stream: anthropicStream,
  unary: anthropicUnary,
  wireHeader: MESSAGES_WIRE_HEADER,
} as const;
