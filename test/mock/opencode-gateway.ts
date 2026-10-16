/**
 * The OpenCode gateway, mocked — the vendor's endpoints as a Vite plugin.
 *
 * The live suite (`test/e2e/`) proves the vendor still answers the shapes this
 * plugin was built against; it cannot prove what the plugin sends, because it
 * needs a key and the public internet. This server is the other half: a
 * deterministic stand-in for `opencode.ai` that serves every endpoint the
 * gateway serves, in the wire format its protocol speaks, and *refuses* a
 * request that does not carry the shape that endpoint requires — an unknown
 * path, a model sent to an endpoint that cannot speak its format, a missing
 * session header, a placeholder credential.
 *
 * It is a Vite plugin rather than a bare `node:http` handler because that is
 * what this stack already runs: `vite-plus` re-exports Vite, so the mock boots
 * as a normal middleware-mode dev server (`gateway-server.ts`), and the same
 * plugin can be dropped into any `vite.config.ts` to answer these endpoints
 * during a manual run.
 *
 * The contract encoded here is the vendor's, written down again on purpose:
 * the family roots, the per-protocol paths and auth headers, and the
 * model → protocol map come from `docs/redirect-planes.md`, which records what
 * was measured. A copy that cannot disagree with the code under test could not
 * fail it.
 *
 * @module dsh-opencode-patch/mock-gateway
 */

import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

import type { Plugin } from "vite-plus";

import {
  OPENCODE_GO_CATALOG,
  OPENCODE_PLANE_API,
  OPENCODE_ZEN_CATALOG,
} from "../../src/catalog-data.ts";
import { isRecord } from "../../src/guards.ts";

/** The plane a request's base URL belongs to. */
export type GatewayPlane = "opencode" | "opencode-go";

/** The endpoint family a path names, by the last segment it carries. */
export type GatewayKind =
  | "completions"
  | "google"
  | "messages"
  | "models"
  | "responses";

/** One request the gateway saw, in the shape the tests assert on. */
export interface GatewayRequest {
  /** The parsed JSON body, when the body was JSON. */
  body: unknown;
  /** The raw body text, so a shape assertion does not depend on parsing. */
  bodyText: string;
  /** Lower-cased request headers; repeated headers are joined with ", ". */
  headers: Record<string, string>;
  /** The endpoint family, when the path matched one. */
  kind: GatewayKind | null;
  method: string;
  /** The model id: from the body, or from the path for Google requests. */
  model: string | null;
  /** The request path, without the query. */
  path: string;
  /** The plane the base URL belongs to, when the path matched a family. */
  plane: GatewayPlane | null;
  /** The protocol the matched endpoint speaks. */
  protocol: string | null;
  /** The query string as received, including the leading "?". */
  query: string;
  /** Why the gateway refused, or null when it answered. */
  reject: string | null;
  /** The status the gateway answered with. */
  status: number;
}

/** A reply the behaviour override may substitute for the fixture. */
export interface MockReply {
  body: string;
  contentType?: string;
  status: number;
}

/** Decides the answer for a request that passed every contract check. */
export type GatewayBehavior = (
  request: GatewayRequest
) => MockReply | undefined;

export interface OpenCodeGatewayOptions {
  /** Substitute or reshape a reply after validation, e.g. a forced 403. */
  behavior?: GatewayBehavior;
  /** Called once per request, with the same record the tests read. */
  onRequest?: (request: GatewayRequest) => void;
}

/** What the middleware hands the handler: method, URL, headers and raw body. */
export interface GatewayExchange {
  bodyText: string;
  headers: IncomingHttpHeaders;
  method: string;
  url: string;
}

/** The record and the reply for one exchange. */
export interface GatewayDecision {
  record: GatewayRequest;
  reply: MockReply;
}

/** The text every protocol fixture streams, in two deltas. */
export const MOCK_TEXT = "Hello from the mock gateway.";

const JSON_CONTENT_TYPE = "application/json";
const SSE_CONTENT_TYPE = "text/event-stream";

/**
 * The base each plane answers on, both families.
 *
 * The legacy roots are the measured constants; the catalog family is read from
 * the generated shim, because following the vendor's own address is what
 * `auto` means — a move there is a shim regeneration, not a bug this server
 * should report.
 *
 * Order does not matter here: the matcher requires the root to be followed by
 * a `/`, so `/zen/v1` cannot claim a `/zen/go/v1/…` path and the two
 * `inference` roots cannot claim each other's either.
 */
const FAMILY_ROOTS: readonly { plane: GatewayPlane; root: string }[] = [
  { plane: "opencode-go", root: "/zen/go/v1" },
  { plane: "opencode", root: "/zen/v1" },
  { plane: "opencode-go", root: new URL(OPENCODE_PLANE_API.go).pathname },
  { plane: "opencode", root: new URL(OPENCODE_PLANE_API.zen).pathname },
];

/** One endpoint, matched against the path left after the family root. */
const ENDPOINTS: readonly {
  kind: GatewayKind;
  pattern: RegExp;
  protocol: string | null;
}[] = [
  {
    kind: "responses",
    pattern: /^\/responses$/u,
    protocol: "openai-responses",
  },
  {
    kind: "completions",
    pattern: /^\/chat\/completions$/u,
    protocol: "openai-completions",
  },
  {
    kind: "messages",
    pattern: /^\/messages$/u,
    protocol: "anthropic-messages",
  },
  {
    kind: "google",
    pattern: /^\/models\/([^/]+):(?:streamGenerateContent|generateContent)$/u,
    protocol: "google-generative-ai",
  },
  { kind: "models", pattern: /^\/models$/u, protocol: null },
];

/** Which wire header each endpoint's credential travels in. */
const WIRE_HEADER: Readonly<Record<GatewayKind, string>> = {
  completions: "authorization",
  google: "x-goog-api-key",
  messages: "x-api-key",
  models: "authorization",
  responses: "authorization",
};

/** The adapter's placeholders, which the gateway answers with 401. */
const PLACEHOLDER_KEYS: ReadonlySet<string> = new Set([
  "none",
  "null",
  "undefined",
  "unused",
]);

/** The SDK a model declares → the protocol its endpoint must speak. */
const SDK_PROTOCOL: Readonly<Record<string, string>> = {
  "@ai-sdk/anthropic": "anthropic-messages",
  "@ai-sdk/google": "google-generative-ai",
  "@ai-sdk/openai": "openai-responses",
  "@ai-sdk/openai-compatible": "openai-completions",
};

type CatalogSpec = (typeof OPENCODE_ZEN_CATALOG)[number];

const catalogFor = (plane: GatewayPlane): readonly CatalogSpec[] =>
  plane === "opencode" ? OPENCODE_ZEN_CATALOG : OPENCODE_GO_CATALOG;

/**
 * The protocol this plane must serve `id` on, or undefined when the plane has
 * no such model. A model the catalog does not describe is unknown; a model
 * whose declared SDK has no served protocol is unsupported everywhere.
 */
const protocolForModel = (
  plane: GatewayPlane,
  id: string
): string | undefined => {
  const spec = catalogFor(plane).find((entry) => entry.id === id);
  if (spec === undefined) {
    return undefined;
  }
  if (spec.provider_npm === undefined) {
    return "openai-completions";
  }
  return SDK_PROTOCOL[spec.provider_npm] ?? "unsupported";
};

const sseEvent = (name: string, payload: unknown): string =>
  `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;

const sseData = (payload: unknown): string =>
  `data: ${JSON.stringify(payload)}\n\n`;

/** The Responses-API stream pi's parser requires, in its own event order. */
const responsesStream = (model: string): string =>
  [
    sseEvent("response.created", {
      response: { id: "resp_mock", model, status: "in_progress" },
      type: "response.created",
    }),
    sseEvent("response.output_item.added", {
      item: {
        content: [],
        id: "msg_mock",
        role: "assistant",
        type: "message",
      },
      output_index: 0,
      type: "response.output_item.added",
    }),
    sseEvent("response.output_text.delta", {
      delta: "Hello from ",
      output_index: 0,
      type: "response.output_text.delta",
    }),
    sseEvent("response.output_text.delta", {
      delta: "the mock gateway.",
      output_index: 0,
      type: "response.output_text.delta",
    }),
    sseEvent("response.output_item.done", {
      item: {
        content: [{ text: MOCK_TEXT, type: "output_text" }],
        id: "msg_mock",
        role: "assistant",
        type: "message",
      },
      output_index: 0,
      type: "response.output_item.done",
    }),
    sseEvent("response.completed", {
      response: {
        id: "resp_mock",
        model,
        status: "completed",
        usage: { input_tokens: 5, output_tokens: 6, total_tokens: 11 },
      },
      type: "response.completed",
    }),
  ].join("");

/** The Anthropic Messages stream, event for event. */
const anthropicStream = (model: string): string =>
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

/** The Chat Completions stream, ending in the sentinel the SDK waits for. */
const completionsStream = (model: string): string =>
  [
    sseData({
      choices: [
        { delta: { content: "Hello from ", role: "assistant" }, index: 0 },
      ],
      created: 1_700_000_000,
      id: "chatcmpl_mock",
      model,
      object: "chat.completion.chunk",
    }),
    sseData({
      choices: [{ delta: { content: "the mock gateway." }, index: 0 }],
      created: 1_700_000_000,
      id: "chatcmpl_mock",
      model,
      object: "chat.completion.chunk",
    }),
    sseData({
      choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
      created: 1_700_000_000,
      id: "chatcmpl_mock",
      model,
      object: "chat.completion.chunk",
      usage: { completion_tokens: 6, prompt_tokens: 5, total_tokens: 11 },
    }),
    "data: [DONE]\n\n",
  ].join("");

/** The Google `streamGenerateContent` stream, ending on `finishReason`. */
const googleStream = (model: string): string =>
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

/** One row of the listing envelope the gateway's `/models` answers with. */
interface ModelRow {
  created: number;
  id: string;
  object: string;
  owned_by: string;
}

/**
 * The `/models` listing: one catalogued row and one the catalog does not
 * describe, because the gateway adds models before the shim knows them.
 */
const modelsListing = (plane: GatewayPlane): string => {
  const rows: ModelRow[] = [
    {
      created: 1_700_000_000,
      id: "mock-unknown-model",
      object: "model",
      owned_by: "opencode",
    },
  ];
  const [first] = catalogFor(plane);
  if (first !== undefined) {
    rows.unshift({
      created: 1_700_000_000,
      id: first.id,
      object: "model",
      owned_by: "opencode",
    });
  }
  return JSON.stringify({ data: rows, object: "list" });
};

/**
 * The fixture for one streaming endpoint. `/models` never reaches this — its
 * listing answers earlier, before any model check.
 */
/** The stream fixture each streaming endpoint answers with. */
const STREAM_FOR_KIND: Readonly<
  Record<Exclude<GatewayKind, "models">, (model: string) => string>
> = {
  completions: completionsStream,
  google: googleStream,
  messages: anthropicStream,
  responses: responsesStream,
};

/**
 * The fixture for one streaming endpoint. `/models` never reaches this — its
 * listing answers earlier, before any model check.
 */
const fixtureReply = (
  kind: Exclude<GatewayKind, "models">,
  model: string
): MockReply => ({
  body: STREAM_FOR_KIND[kind](model),
  contentType: SSE_CONTENT_TYPE,
  status: 200,
});

const errorReply = (
  status: number,
  message: string,
  type: string
): MockReply => ({
  body: JSON.stringify({ error: { message, type } }),
  contentType: JSON_CONTENT_TYPE,
  status,
});

const flattenHeaders = (
  headers: IncomingHttpHeaders
): Record<string, string> => {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    flat[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return flat;
};

const parseBody = (bodyText: string): { ok: boolean; parsed: unknown } => {
  if (bodyText.length === 0) {
    return { ok: false, parsed: undefined };
  }
  try {
    return { ok: true, parsed: JSON.parse(bodyText) };
  } catch {
    return { ok: false, parsed: undefined };
  }
};

const modelFromBody = (body: unknown): string | null => {
  if (!isRecord(body)) {
    return null;
  }
  const { model } = body;
  return typeof model === "string" && model.length > 0 ? model : null;
};

/** A credential the gateway would accept: present, non-empty, not a sentinel. */
const isCredential = (value: string | undefined): boolean => {
  if (value === undefined) {
    return false;
  }
  const bare = value
    .replace(/^Bearer\s+/iu, "")
    .trim()
    .toLowerCase();
  return bare.length > 0 && !PLACEHOLDER_KEYS.has(bare);
};

interface RouteMatch {
  endpoint: (typeof ENDPOINTS)[number] | undefined;
  match: RegExpExecArray | null;
  plane: GatewayPlane;
}

/**
 * Match a path against both families and every endpoint.
 *
 * A path under a known family with no known endpoint returns a match with an
 * undefined endpoint, so the refusal can say "unknown endpoint on <plane>"
 * rather than the misleading "no route" — that is the shape of the historical
 * double-`/v1` bug (`…/zen/v1/v1/messages`), and the reason the distinction is
 * kept.
 */
const matchRoute = (path: string): RouteMatch | undefined => {
  for (const family of FAMILY_ROOTS) {
    if (!path.startsWith(`${family.root}/`)) {
      continue;
    }
    const remainder = path.slice(family.root.length);
    for (const endpoint of ENDPOINTS) {
      const match = endpoint.pattern.exec(remainder);
      if (match !== null) {
        return { endpoint, match, plane: family.plane };
      }
    }
    return { endpoint: undefined, match: null, plane: family.plane };
  }
  return undefined;
};

/**
 * Answer one exchange against the vendor contract.
 *
 * The checks run in the gateway's own order — route, method, credential,
 * session, body, model, protocol — so each refusal names exactly one fault and
 * a test can assert the reason without disentangling several.
 */
export const handleGatewayRequest = (
  exchange: GatewayExchange,
  options: OpenCodeGatewayOptions = {}
): GatewayDecision => {
  const url = new URL(exchange.url, "http://mock.invalid");
  const headers = flattenHeaders(exchange.headers);
  const record: GatewayRequest = {
    body: undefined,
    bodyText: exchange.bodyText,
    headers,
    kind: null,
    method: exchange.method.toUpperCase(),
    model: null,
    path: url.pathname,
    plane: null,
    protocol: null,
    query: url.search,
    reject: null,
    status: 0,
  };

  const refuse = (
    status: number,
    message: string,
    type: string,
    reject: string
  ): GatewayDecision => {
    record.reject = reject;
    record.status = status;
    options.onRequest?.(record);
    return { record, reply: errorReply(status, message, type) };
  };

  const accept = (reply: MockReply): GatewayDecision => {
    record.status = reply.status;
    options.onRequest?.(record);
    return { record, reply };
  };

  const matched = matchRoute(url.pathname);
  if (matched === undefined) {
    return refuse(404, `no route for ${url.pathname}`, "not_found", "no_route");
  }
  const { endpoint, match, plane } = matched;
  record.plane = plane;
  if (endpoint === undefined) {
    return refuse(
      404,
      `unknown endpoint ${url.pathname} on ${plane}`,
      "not_found",
      "unknown_endpoint"
    );
  }
  record.kind = endpoint.kind;
  record.protocol = endpoint.protocol;

  const expectedMethod = endpoint.kind === "models" ? "GET" : "POST";
  if (record.method !== expectedMethod) {
    return refuse(
      405,
      `${endpoint.kind} answers ${expectedMethod}`,
      "method_not_allowed",
      "method"
    );
  }

  const wireHeader = WIRE_HEADER[endpoint.kind];
  if (!isCredential(headers[wireHeader])) {
    return refuse(401, "Invalid API key", "invalid_api_key", "credential");
  }

  const session = headers["x-opencode-session-id"];
  if (session === undefined || session.length === 0) {
    return refuse(400, "MissingSessionID", "missing_session_id", "session");
  }

  if (endpoint.kind === "models") {
    const listing = options.behavior?.(record);
    return accept(
      listing ?? {
        body: modelsListing(plane),
        contentType: JSON_CONTENT_TYPE,
        status: 200,
      }
    );
  }

  const { ok, parsed } = parseBody(exchange.bodyText);
  if (!ok) {
    return refuse(
      400,
      "the request body is not JSON",
      "invalid_request",
      "body"
    );
  }
  record.body = parsed;

  const model =
    endpoint.kind === "google"
      ? (match?.[1] ?? null)
      : modelFromBody(record.body);
  record.model = model;
  if (model === null) {
    return refuse(
      400,
      "the request names no model",
      "invalid_request",
      "model"
    );
  }
  const expected = protocolForModel(plane, model);
  if (expected === undefined) {
    return refuse(
      404,
      `unknown model: ${model}`,
      "model_not_found",
      "model_unknown"
    );
  }
  if (expected !== endpoint.protocol) {
    return refuse(
      400,
      `ModelProtocolUnsupported: ${model} is not served on this endpoint`,
      "model_protocol_unsupported",
      "protocol"
    );
  }

  const override = options.behavior?.(record);
  return accept(override ?? fixtureReply(endpoint.kind, model));
};

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });

/**
 * The mock as a Vite plugin: every request the server receives is answered
 * here, so nothing is read from disk and no other middleware runs.
 */
export const openCodeGateway = (
  options: OpenCodeGatewayOptions = {}
): Plugin => ({
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      void (async () => {
        try {
          const bodyText = await readBody(request);
          const { reply } = handleGatewayRequest(
            {
              bodyText,
              headers: request.headers,
              method: request.method ?? "GET",
              url: request.url ?? "/",
            },
            options
          );
          response.writeHead(reply.status, {
            "cache-control": "no-store",
            "content-type": reply.contentType ?? JSON_CONTENT_TYPE,
          });
          response.end(reply.body);
        } catch (error) {
          next(error);
        }
      })();
    });
  },
  name: "dsh-opencode-mock-gateway",
});
