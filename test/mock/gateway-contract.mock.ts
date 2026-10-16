/**
 * The mock gateway's own contract, exercised over a socket.
 *
 * These cases are the teeth behind the other suites: a request shape they call
 * compatible must be one this server *accepts*, and these prove it refuses the
 * shapes it should — a model on an endpoint that cannot speak its format, a
 * missing session header, a placeholder credential, the double-`/v1` path
 * class. Without them a mock that answered 200 to everything would make the
 * request-shape suite pass.
 *
 * Raw fetches, no plugin: the point here is the server, not the patch.
 *
 * @module test/mock/gateway-contract.mock
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startMockGateway, type MockGateway } from "./gateway-server.ts";
import { catalogFor, firstSpecFor, MOCK_SESSION, ZEN_KEY } from "./helpers.ts";
import type { GatewayRequest } from "./opencode-gateway.ts";

let gateway: MockGateway;

beforeAll(async () => {
  gateway = await startMockGateway();
});

afterAll(async () => {
  await gateway.close();
});

beforeEach(() => {
  gateway.requests.length = 0;
});

const post = (
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> =>
  fetch(`${gateway.origin}${path}`, {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${ZEN_KEY}`,
      "content-type": "application/json",
      "x-opencode-session-id": MOCK_SESSION,
      ...headers,
    },
    method: "POST",
  });

const recorded = (): GatewayRequest => {
  const last = gateway.requests.at(-1);
  if (last === undefined) {
    throw new Error("the mock gateway saw no request");
  }
  return last;
};

const responsesBody = (model: string): Record<string, unknown> => ({
  input: [],
  model,
  stream: true,
});

describe("the mock gateway", () => {
  it("answers a well-formed responses request with the SSE shape", async () => {
    const response = await post("/zen/v1/responses", responsesBody("gpt-5.4"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("response.created");
    expect(text).toContain("response.output_text.delta");
    expect(text).toContain("response.completed");
    expect(text).toContain("Hello from ");
    expect(text).toContain("the mock gateway.");
    const request = recorded();
    expect(request.plane).toBe("opencode");
    expect(request.kind).toBe("responses");
    expect(request.protocol).toBe("openai-responses");
    expect(request.model).toBe("gpt-5.4");
    expect(request.reject).toBeNull();
    expect(request.status).toBe(200);
  });

  it("refuses a model on an endpoint that cannot speak its format", async () => {
    const response = await post(
      "/zen/v1/chat/completions",
      responsesBody("gpt-5.4")
    );
    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      error: { message: string; type: string };
    };
    expect(payload.error.message).toContain("ModelProtocolUnsupported");
    expect(recorded().reject).toBe("protocol");
  });

  it("refuses a model the plane does not serve", async () => {
    const response = await post(
      "/zen/v1/responses",
      responsesBody("mock-unknown-model-9000")
    );
    expect(response.status).toBe(404);
    const payload = (await response.json()) as { error: { type: string } };
    expect(payload.error.type).toBe("model_not_found");
  });

  it("refuses a request with no session header", async () => {
    const response = await fetch(`${gateway.origin}/zen/v1/responses`, {
      body: JSON.stringify(responsesBody("gpt-5.4")),
      headers: {
        authorization: `Bearer ${ZEN_KEY}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { message: string } };
    expect(payload.error.message).toBe("MissingSessionID");
    expect(recorded().reject).toBe("session");
  });

  it("refuses the adapter's placeholder credential", async () => {
    const response = await post("/zen/v1/responses", responsesBody("gpt-5.4"), {
      authorization: "Bearer unused",
    });
    expect(response.status).toBe(401);
    expect(recorded().reject).toBe("credential");
  });

  it("refuses the wrong auth header for the protocol", async () => {
    const spec = firstSpecFor("opencode", "@ai-sdk/anthropic");
    if (spec === undefined) {
      throw new Error("the zen catalog serves no anthropic model");
    }
    // A valid Bearer is present, and that is exactly the point: the Messages
    // endpoint reads x-api-key, so a request carrying only authorization is
    // unauthenticated there.
    const response = await post("/zen/v1/messages?beta=true", {
      max_tokens: 64,
      messages: [{ content: "hi", role: "user" }],
      model: spec.id,
      stream: true,
    });
    expect(response.status).toBe(401);
    expect(recorded().reject).toBe("credential");
  });

  it("refuses the double-/v1 path class as an unknown endpoint", async () => {
    const response = await post("/zen/v1/v1/messages", {
      max_tokens: 64,
      messages: [{ content: "hi", role: "user" }],
      model: "gpt-5.4",
      stream: true,
    });
    expect(response.status).toBe(404);
    expect(recorded().reject).toBe("unknown_endpoint");
  });

  it("refuses a family it does not serve", async () => {
    const response = await post("/v1/responses", responsesBody("gpt-5.4"));
    expect(response.status).toBe(404);
    expect(recorded().reject).toBe("no_route");
  });

  it("answers a Google streamGenerateContent request with its SSE shape", async () => {
    const spec = firstSpecFor("opencode", "@ai-sdk/google");
    if (spec === undefined) {
      throw new Error("the zen catalog serves no Google model");
    }
    const response = await fetch(
      `${gateway.origin}/zen/v1/models/${spec.id}:streamGenerateContent?alt=sse`,
      {
        body: JSON.stringify({
          contents: [{ parts: [{ text: "hi" }], role: "user" }],
        }),
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": ZEN_KEY,
          "x-opencode-session-id": MOCK_SESSION,
        },
        method: "POST",
      }
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("finishReason");
    expect(text).toContain("Hello from ");
    expect(text).toContain("the mock gateway.");
    const request = recorded();
    expect(request.kind).toBe("google");
    expect(request.model).toBe(spec.id);
    expect(request.query).toBe("?alt=sse");
  });

  it("answers the models listing with the vendor's envelope", async () => {
    const response = await fetch(`${gateway.origin}/zen/v1/models`, {
      headers: {
        authorization: `Bearer ${ZEN_KEY}`,
        "x-opencode-session-id": MOCK_SESSION,
      },
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      data: { id: string }[];
      object: string;
    };
    expect(payload.object).toBe("list");
    const [first] = catalogFor("opencode");
    if (first === undefined) {
      throw new Error("the zen catalog is empty");
    }
    const ids = payload.data.map((row) => row.id);
    expect(ids).toContain(first.id);
    expect(ids).toContain("mock-unknown-model");
  });
});
