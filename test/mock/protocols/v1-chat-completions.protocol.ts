/**
 * OpenAI v1 Chat Completions Wire Protocol & Fixtures (/chat/completions).
 *
 * Implements the v1 wire format for OpenAI Chat Completions:
 * - Endpoint: /chat/completions (or /zen/v1/chat/completions)
 * - Protocol: openai-completions (v1)
 * - Wire header: Authorization: Bearer <key>
 * - Wire stream format: `data: {"object": "chat.completion.chunk", ...}`
 * - Stream termination sentinel: `data: [DONE]`
 * - Unary payload: `{"object": "chat.completion", "choices": [...], ...}`
 * - Wire stream parsing is handled by the host's `pi-ai` adapter, not hand-wired here.
 *
 * @module test/mock/protocols/v1-chat-completions.protocol
 */

export const V1_COMPLETIONS_PROTOCOL = "openai-completions" as const;
export const V1_COMPLETIONS_KIND = "completions" as const;
export const V1_COMPLETIONS_WIRE_HEADER = "authorization" as const;

export const V1_MOCK_TEXT = "Hello from the mock gateway.";

export interface V1Delta {
  readonly content?: string;
  readonly role?: string;
}

export interface V1ChunkChoice {
  readonly delta: V1Delta;
  readonly finish_reason: string | null;
  readonly index: number;
}

export interface V1CompletionChunk {
  readonly choices: readonly V1ChunkChoice[];
  readonly created: number;
  readonly id: string;
  readonly model: string;
  readonly object: "chat.completion.chunk";
  readonly usage?: {
    readonly completion_tokens: number;
    readonly prompt_tokens: number;
    readonly total_tokens: number;
  };
}

export interface V1Choice {
  readonly finish_reason: string;
  readonly index: number;
  readonly message: { readonly content: string; readonly role: string };
}

export interface V1CompletionsUnaryPayload {
  readonly choices: readonly V1Choice[];
  readonly created: number;
  readonly id: string;
  readonly model: string;
  readonly object: "chat.completion";
  readonly usage: {
    readonly completion_tokens: number;
    readonly prompt_tokens: number;
    readonly total_tokens: number;
  };
}

/* -------------------------------------------------------------------------- */
/*                                v1 Fixtures                                 */
/* -------------------------------------------------------------------------- */

/** Format an SSE data line for v1 chunks. */
export const formatV1Chunk = (payload: unknown): string =>
  `data: ${JSON.stringify(payload)}\n\n`;

/** Format the v1 [DONE] completion sentinel. */
export const formatV1Done = (): string => "data: [DONE]\n\n";

/**
 * Generate wire streaming SSE chunks for OpenAI v1 Chat Completions.
 */
export const v1CompletionsStream = (model: string): string =>
  [
    formatV1Chunk({
      choices: [
        { delta: { content: "Hello from ", role: "assistant" }, index: 0 },
      ],
      created: 1_700_000_000,
      id: "chatcmpl_mock",
      model,
      object: "chat.completion.chunk",
    }),
    formatV1Chunk({
      choices: [{ delta: { content: "the mock gateway." }, index: 0 }],
      created: 1_700_000_000,
      id: "chatcmpl_mock",
      model,
      object: "chat.completion.chunk",
    }),
    formatV1Chunk({
      choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
      created: 1_700_000_000,
      id: "chatcmpl_mock",
      model,
      object: "chat.completion.chunk",
      usage: { completion_tokens: 6, prompt_tokens: 5, total_tokens: 11 },
    }),
    formatV1Done(),
  ].join("");

/**
 * Generate wire unary JSON for OpenAI v1 Chat Completions when stream is false.
 */
export const v1CompletionsUnary = (model: string): string =>
  JSON.stringify({
    choices: [
      {
        finish_reason: "stop",
        index: 0,
        message: { content: V1_MOCK_TEXT, role: "assistant" },
      },
    ],
    created: 1_700_000_000,
    id: "chatcmpl_mock",
    model,
    object: "chat.completion",
    usage: { completion_tokens: 6, prompt_tokens: 5, total_tokens: 11 },
  });

export const OpenAIV1CompletionsProtocol = {
  formatChunk: formatV1Chunk,
  formatDone: formatV1Done,
  kind: V1_COMPLETIONS_KIND,
  protocol: V1_COMPLETIONS_PROTOCOL,
  stream: v1CompletionsStream,
  unary: v1CompletionsUnary,
  wireHeader: V1_COMPLETIONS_WIRE_HEADER,
} as const;

// Backward-compatible aliases
export const COMPLETIONS_PROTOCOL = V1_COMPLETIONS_PROTOCOL;
export const COMPLETIONS_KIND = V1_COMPLETIONS_KIND;
export const COMPLETIONS_WIRE_HEADER = V1_COMPLETIONS_WIRE_HEADER;
export const completionsStream = v1CompletionsStream;
export const completionsUnary = v1CompletionsUnary;
export const OpenAICompletionsProtocol = OpenAIV1CompletionsProtocol;
export type CompletionsChunk = V1CompletionChunk;
export type CompletionsChunkChoice = V1ChunkChoice;
export type CompletionsChoice = V1Choice;
export type CompletionsDelta = V1Delta;
export type CompletionsUnaryPayload = V1CompletionsUnaryPayload;
