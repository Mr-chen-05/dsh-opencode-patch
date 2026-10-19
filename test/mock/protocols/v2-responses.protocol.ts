/**
 * OpenAI v2 Responses Wire Protocol & Fixtures (/responses).
 *
 * Implements the v2 Responses wire format for OpenAI Responses API:
 * - Endpoint: /responses (or /zen/v1/responses)
 * - Protocol: openai-responses (v2)
 * - Wire header: Authorization: Bearer <key>
 * - Wire stream format: typed SSE events (`event: response.created`, `event: response.output_text.delta`, `event: response.completed`)
 * - Unary payload: `{"id": "...", "object": "response", "output": [...], "status": "completed", ...}`
 * - Wire stream parsing is handled by the host's `pi-ai` adapter, not hand-wired here.
 *
 * @module test/mock/protocols/v2-responses.protocol
 */

export const V2_RESPONSES_PROTOCOL = "openai-responses" as const;
export const V2_RESPONSES_KIND = "responses" as const;
export const V2_RESPONSES_WIRE_HEADER = "authorization" as const;

export const V2_MOCK_TEXT = "Hello from the mock gateway.";

export interface V2OutputTextContent {
  readonly text: string;
  readonly type: "output_text";
}

export interface V2OutputItem {
  readonly content: readonly V2OutputTextContent[];
  readonly id: string;
  readonly role: "assistant";
  readonly type: "message";
}

export interface V2ResponsesUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
}

export interface V2ResponsesUnaryPayload {
  readonly id: string;
  readonly model: string;
  readonly object: "response";
  readonly output: readonly V2OutputItem[];
  readonly status: "completed" | "in_progress";
  readonly usage: V2ResponsesUsage;
}

/* -------------------------------------------------------------------------- */
/*                                v2 Fixtures                                 */
/* -------------------------------------------------------------------------- */

/** Format an SSE typed event with payload. */
export const formatV2Event = (name: string, payload: unknown): string =>
  `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;

/**
 * Generate wire streaming SSE events for OpenAI v2 Responses API.
 */
export const v2ResponsesStream = (model: string): string =>
  [
    formatV2Event("response.created", {
      response: { id: "resp_mock", model, status: "in_progress" },
      type: "response.created",
    }),
    formatV2Event("response.output_item.added", {
      item: {
        content: [],
        id: "msg_mock",
        role: "assistant",
        type: "message",
      },
      output_index: 0,
      type: "response.output_item.added",
    }),
    formatV2Event("response.output_text.delta", {
      delta: "Hello from ",
      output_index: 0,
      type: "response.output_text.delta",
    }),
    formatV2Event("response.output_text.delta", {
      delta: "the mock gateway.",
      output_index: 0,
      type: "response.output_text.delta",
    }),
    formatV2Event("response.output_item.done", {
      item: {
        content: [{ text: V2_MOCK_TEXT, type: "output_text" }],
        id: "msg_mock",
        role: "assistant",
        type: "message",
      },
      output_index: 0,
      type: "response.output_item.done",
    }),
    formatV2Event("response.completed", {
      response: {
        id: "resp_mock",
        model,
        status: "completed",
        usage: { input_tokens: 5, output_tokens: 6, total_tokens: 11 },
      },
      type: "response.completed",
    }),
  ].join("");

/**
 * Generate wire unary JSON for OpenAI v2 Responses API when stream is false.
 */
export const v2ResponsesUnary = (model: string): string =>
  JSON.stringify({
    id: "resp_mock",
    model,
    object: "response",
    output: [
      {
        content: [{ text: V2_MOCK_TEXT, type: "output_text" }],
        id: "msg_mock",
        role: "assistant",
        type: "message",
      },
    ],
    status: "completed",
    usage: { input_tokens: 5, output_tokens: 6, total_tokens: 11 },
  });

export const OpenAIV2ResponsesProtocol = {
  formatEvent: formatV2Event,
  kind: V2_RESPONSES_KIND,
  protocol: V2_RESPONSES_PROTOCOL,
  stream: v2ResponsesStream,
  unary: v2ResponsesUnary,
  wireHeader: V2_RESPONSES_WIRE_HEADER,
} as const;

// Backward-compatible aliases
export const RESPONSES_PROTOCOL = V2_RESPONSES_PROTOCOL;
export const RESPONSES_KIND = V2_RESPONSES_KIND;
export const RESPONSES_WIRE_HEADER = V2_RESPONSES_WIRE_HEADER;
export const MOCK_TEXT = V2_MOCK_TEXT;
export const responsesStream = v2ResponsesStream;
export const responsesUnary = v2ResponsesUnary;
export const OpenAIResponsesProtocol = OpenAIV2ResponsesProtocol;
export type ResponsesOutputItem = V2OutputItem;
export type ResponsesUnaryPayload = V2ResponsesUnaryPayload;
export type ResponsesUsage = V2ResponsesUsage;
