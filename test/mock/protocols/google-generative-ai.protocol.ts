/**
 * Google Generative AI Wire Protocol & Fixtures (/models/{model}:streamGenerateContent & :generateContent).
 *
 * Implements:
 * - Protocol: google-generative-ai
 * - Wire header: x-goog-api-key: <key>
 * - Model ID extraction from URL path rather than JSON body
 * - Wire stream chunks and finishReason: STOP
 * - Unary candidate payload
 * - Wire stream parsing is handled by the host's `pi-ai` adapter, not hand-wired here.
 *
 * @module test/mock/protocols/google-generative-ai.protocol
 */

export const GOOGLE_PROTOCOL = "google-generative-ai" as const;
export const GOOGLE_KIND = "google" as const;
export const GOOGLE_WIRE_HEADER = "x-goog-api-key" as const;

export const MOCK_TEXT = "Hello from the mock gateway.";

export const GOOGLE_PATH_PATTERN =
  /\/models\/([^/:]+):(?:streamGenerateContent|generateContent)/u;

export interface GooglePart {
  readonly text: string;
}

export interface GoogleCandidate {
  readonly content: {
    readonly parts: readonly GooglePart[];
    readonly role: string;
  };
  readonly finishReason?: string;
  readonly index: number;
}

export interface GoogleUsageMetadata {
  readonly candidatesTokenCount: number;
  readonly promptTokenCount: number;
  readonly totalTokenCount: number;
}

export interface GoogleChunk {
  readonly candidates?: readonly GoogleCandidate[];
  readonly modelVersion?: string;
  readonly usageMetadata?: GoogleUsageMetadata;
}

export interface GoogleUnaryPayload {
  readonly candidates: readonly GoogleCandidate[];
  readonly modelVersion: string;
  readonly usageMetadata: GoogleUsageMetadata;
}

/**
 * Extract model ID from a Google API endpoint URL path.
 */
export const extractGoogleModel = (pathname: string): string | null => {
  const match = GOOGLE_PATH_PATTERN.exec(pathname);
  return match?.[1] ?? null;
};

const sseData = (payload: unknown): string =>
  `data: ${JSON.stringify(payload)}\n\n`;

/**
 * Generate wire streaming SSE chunks for Google Generative AI API.
 */
export const googleStream = (model: string): string =>
  [
    sseData({
      candidates: [
        {
          content: { parts: [{ text: "Hello from " }], role: "model" },
          index: 0,
        },
      ],
      modelVersion: model,
      usageMetadata: {
        candidatesTokenCount: 3,
        promptTokenCount: 5,
        totalTokenCount: 8,
      },
    }),
    sseData({
      candidates: [
        {
          content: { parts: [{ text: "the mock gateway." }], role: "model" },
          finishReason: "STOP",
          index: 0,
        },
      ],
      modelVersion: model,
      usageMetadata: {
        candidatesTokenCount: 6,
        promptTokenCount: 5,
        totalTokenCount: 11,
      },
    }),
  ].join("");

/**
 * Generate wire unary JSON for Google Generative AI API when generateContent is called.
 */
export const googleUnary = (model: string): string =>
  JSON.stringify({
    candidates: [
      {
        content: { parts: [{ text: MOCK_TEXT }], role: "model" },
        finishReason: "STOP",
        index: 0,
      },
    ],
    modelVersion: model,
    usageMetadata: {
      candidatesTokenCount: 6,
      promptTokenCount: 5,
      totalTokenCount: 11,
    },
  });

export const GoogleGenerativeAiProtocol = {
  extractModel: extractGoogleModel,
  kind: GOOGLE_KIND,
  pathPattern: GOOGLE_PATH_PATTERN,
  protocol: GOOGLE_PROTOCOL,
  stream: googleStream,
  unary: googleUnary,
  wireHeader: GOOGLE_WIRE_HEADER,
} as const;
