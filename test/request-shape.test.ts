/**
 * The fetch patch's pure decisions, one branch at a time.
 *
 * Every case here was previously unreachable: the six functions were private
 * inside `fetch-patch.ts`, so their branches only ran when some integration path
 * happened to take them. That is the difference between covered and testable.
 *
 * @module test/request-shape.test
 */
import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_VERSION,
  authHeaderFor,
  gatewayPlaneFor,
  headerSourceOf,
  modelIdOf,
  requestUrlOf,
  toolNamesOf,
} from "../src/utils/request-shape.ts";

describe("request-shape · gatewayPlaneFor", () => {
  it("attributes each endpoint family to its plane", () => {
    // Both families, because a credential's format decides which one a request
    // belongs on and the plane is the same either way.
    expect(
      gatewayPlaneFor("https://opencode.ai/zen/go/v1/chat/completions")
    ).toBe("opencode-go");
    expect(gatewayPlaneFor("https://opencode.ai/zen/v1/chat/completions")).toBe(
      "opencode"
    );
    expect(
      gatewayPlaneFor("https://opencode.ai/inference/go/openai/v1/responses")
    ).toBe("opencode-go");
    expect(
      gatewayPlaneFor("https://opencode.ai/inference/openai/v1/responses")
    ).toBe("opencode");
  });

  it("answers nothing for a URL that is not a gateway URL", () => {
    // A rotation is a side effect, so an unrecognised URL must not guess a
    // plane — and an unparseable one must not throw.
    expect(gatewayPlaneFor("https://example.com/v1/chat")).toBe("");
    expect(gatewayPlaneFor("https://opencode.ai")).toBe("");
    expect(gatewayPlaneFor("not a url")).toBe("");
  });
});

describe("request-shape · authHeaderFor", () => {
  it("reads the header each protocol actually uses", () => {
    expect(authHeaderFor("https://opencode.ai/zen/v1/messages")).toBe(
      "x-api-key"
    );
    expect(
      authHeaderFor(
        "https://opencode.ai/zen/v1/models/gemini-3:streamGenerateContent?alt=sse"
      )
    ).toBe("x-goog-api-key");
    expect(
      authHeaderFor(
        "https://opencode.ai/zen/v1/models/gemini-3:generateContent"
      )
    ).toBe("x-goog-api-key");
  });

  it("defaults to authorization, and survives an unparseable URL", () => {
    expect(authHeaderFor("https://opencode.ai/zen/v1/responses")).toBe(
      "authorization"
    );
    expect(authHeaderFor("https://opencode.ai/zen/v1/chat/completions")).toBe(
      "authorization"
    );
    expect(authHeaderFor("::::")).toBe("authorization");
  });
});

describe("request-shape · requestUrlOf", () => {
  it("reads every form fetch accepts", () => {
    expect(requestUrlOf("https://a.example/x")).toBe("https://a.example/x");
    expect(requestUrlOf(new URL("https://b.example/y"))).toBe(
      "https://b.example/y"
    );
    expect(requestUrlOf(new Request("https://c.example/z"))).toBe(
      "https://c.example/z"
    );
  });

  it("answers an empty string when there is no URL to read", () => {
    expect(requestUrlOf({} as unknown as RequestInfo)).toBe("");
    expect(requestUrlOf({ url: 42 } as unknown as RequestInfo)).toBe("");
    expect(
      requestUrlOf({
        url: new URL("https://d.example/w"),
      } as unknown as RequestInfo)
    ).toBe("https://d.example/w");
  });
});

describe("request-shape · headerSourceOf", () => {
  it("prefers init.headers over the Request's own", () => {
    const request = new Request("https://a.example", {
      headers: { "x-from": "request" },
    });
    const fromInit = headerSourceOf(request, {
      headers: { "x-from": "init" },
    });
    expect(new Headers(fromInit).get("x-from")).toBe("init");
  });

  it("falls back to the Request, then to nothing", () => {
    const request = new Request("https://a.example", {
      headers: { "x-from": "request" },
    });
    expect(new Headers(headerSourceOf(request)).get("x-from")).toBe("request");
    expect(headerSourceOf("https://a.example")).toBeUndefined();
  });
});

describe("request-shape · modelIdOf", () => {
  it("reads the id under `model`, on either JSON route", () => {
    expect(modelIdOf(JSON.stringify({ model: "gpt-5.4" }))).toBe("gpt-5.4");
  });

  it("answers undefined for every shape that names no model", () => {
    for (const body of [
      undefined,
      null,
      "",
      "not json",
      JSON.stringify({}),
      JSON.stringify({ model: "" }),
      JSON.stringify({ model: 42 }),
      JSON.stringify([1, 2]),
      JSON.stringify("a string"),
      Buffer.from(JSON.stringify({ model: "x" })),
    ]) {
      expect(modelIdOf(body as never), String(body)).toBeUndefined();
    }
  });
});

describe("request-shape · toolNamesOf", () => {
  it("reads both wire shapes, comma-joined", () => {
    expect(
      toolNamesOf(
        JSON.stringify({ tools: [{ name: "read" }, { name: "bash" }] })
      )
    ).toBe("read,bash");
    expect(
      toolNamesOf(
        JSON.stringify({
          tools: [
            { function: { name: "read" }, type: "function" },
            { function: { name: "bash" }, type: "function" },
          ],
        })
      )
    ).toBe("read,bash");
  });

  it("answers an empty string for every malformed body", () => {
    for (const body of [
      undefined,
      null,
      "",
      "not json",
      JSON.stringify({}),
      JSON.stringify({ tools: "nope" }),
      JSON.stringify({ tools: [null, 1, "x", {}, { function: {} }] }),
    ]) {
      expect(toolNamesOf(body as never), String(body)).toBe("");
    }
  });
});

describe("request-shape · constants", () => {
  it("sends the Anthropic version the client sends", () => {
    expect(ANTHROPIC_VERSION).toBe("2023-06-01");
  });
});
