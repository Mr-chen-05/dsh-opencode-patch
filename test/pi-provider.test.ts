import { createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { describe, expect, it } from "vitest";

import { OPENCODE_PLANE_API } from "../src/catalog-data.ts";
import type { CatalogModelSpec } from "../src/catalog-data.ts";
import { OPENCODE_USER_AGENT } from "../src/identity.ts";
import {
  BASE_FOR_PROTOCOL,
  piModelFor,
  protocolFor,
} from "../src/pi-provider.ts";

/**
 * The headers this test feeds the model.
 *
 * A fixture, and it lives here because that is what it is. It was exported from
 * `pi-provider.ts` and called only from this file, and it had drifted: it hardcodes
 * `x-opencode-client` and `x-opencode-project` where `fetch-patch.ts`, which
 * actually sends those headers, reads both from config. A fixture that disagrees
 * with the thing it stands in for is worse than no fixture, and production should
 * not carry one.
 */
const gatewayHeaders = (
  sessionId: string | undefined,
  userAgent: string
): Record<string, string> => ({
  "user-agent": userAgent,
  "x-opencode-client": "cli",
  "x-opencode-project": "global",
  ...(sessionId === undefined ? {} : { "x-opencode-session": sessionId }),
});

/** A catalogued model, shaped exactly as `catalog-data.ts` ships them. */
const spec = (id: string, providerNpm?: string): CatalogModelSpec => ({
  context_window: 200_000,
  cost: { cache_read: 0.01, input: 0.1, output: 0.5 },
  id,
  input_modalities: ["text"],
  max_output_tokens: 64_000,
  name: id,
  ...(providerNpm === undefined ? {} : { provider_npm: providerNpm }),
});

/** Wrap one api so every request carries the plugin's gateway headers. */
const withHeaders = (
  streams: Record<string, (...args: never[]) => unknown>,
  sessionId: string
) => {
  const wrap =
    (fn: (...args: never[]) => unknown) =>
    (model: never, context: never, options: Record<string, unknown>) =>
      fn(model, context, {
        ...options,
        headers: {
          ...gatewayHeaders(sessionId, "opencode/1.19.0 dsh-opencode-patch"),
          ...(options?.headers as Record<string, string> | undefined),
        },
      } as never);
  return {
    ...streams,
    stream: wrap(streams.stream as (...args: never[]) => unknown),
    streamSimple: wrap(streams.streamSimple as (...args: never[]) => unknown),
  };
};

/**
 * The request a provider would send for one model, captured before it leaves.
 *
 * The spike that designed this module did the same thing by hand; this is that
 * spike, kept.
 */
const requestFor = async (
  plane: "opencode" | "opencode-go",
  model: CatalogModelSpec
): Promise<{ headers: Record<string, string>; url: string }> => {
  const protocol = protocolFor(model);
  expect(protocol).toBeDefined();
  const provider = createProvider({
    api: {
      "anthropic-messages": withHeaders(
        anthropicMessagesApi() as never,
        "ses_test"
      ),
      "google-generative-ai": withHeaders(
        googleGenerativeAIApi() as never,
        "ses_test"
      ),
      "openai-completions": withHeaders(
        openAICompletionsApi() as never,
        "ses_test"
      ),
      "openai-responses": withHeaders(
        openAIResponsesApi() as never,
        "ses_test"
      ),
    },
    auth: { apiKey: { name: "OpenCode API key" } },
    id: plane,
    models: [piModelFor(plane, model, protocol ?? "")],
    name: plane,
  } as never);

  const seen: { headers: Record<string, string>; url: string }[] = [];
  const real = globalThis.fetch;
  // Some protocols call fetch with a Request rather than a URL plus init, so
  // the headers have to be read off whichever shape arrived.
  globalThis.fetch = (async (input: unknown, init?: { headers?: unknown }) => {
    const url = typeof input === "string" ? input : String(input);
    const request = typeof input === "object" && input !== null ? input : {};
    const raw =
      init?.headers ?? (request as { headers?: unknown }).headers ?? {};
    // A `Headers` instance carries its entries behind a method, not as own
    // properties, so reading it with Object.entries yields nothing at all.
    const headers: Record<string, string> = {};
    if (raw instanceof Headers) {
      for (const [key, value] of raw.entries()) {
        headers[key.toLowerCase()] = value;
      }
    } else {
      for (const [key, value] of Object.entries(
        raw as Record<string, string>
      )) {
        headers[key.toLowerCase()] = value;
      }
    }
    seen.push({ headers, url });
    throw new Error("captured");
  }) as typeof globalThis.fetch;
  try {
    const [only] = provider.getModels();
    expect(only).toBeDefined();
    const stream = provider.stream(
      only as never,
      { messages: [{ role: "user", content: "hi" }] } as never,
      { apiKey: "sk-test", sessionId: "ses_test" } as never
    );
    const iterable = stream as unknown as AsyncIterable<unknown>;
    for await (const _ of iterable) {
      // The capture throws on the first request; nothing arrives here.
    }
  } catch {
    // Expected: the capture refuses the call.
  } finally {
    globalThis.fetch = real;
  }
  expect(seen.length).toBe(1);
  return seen[0] ?? { headers: {}, url: "" };
};

describe("pi-provider · the URL each protocol reaches", () => {
  it("sends a Responses model to the responses endpoint", async () => {
    const { url } = await requestFor(
      "opencode",
      spec("gpt-5.4", "@ai-sdk/openai")
    );
    expect(url).toBe(`${OPENCODE_PLANE_API.zen}/responses`);
  });

  it("sends a Messages model to the messages endpoint", async () => {
    const { url } = await requestFor(
      "opencode",
      spec("claude-opus-5", "@ai-sdk/anthropic")
    );
    // One level shorter than the others, because this SDK appends /v1/messages.
    expect(url).toBe(`${OPENCODE_PLANE_API.zen}/messages?beta=true`);
  });

  it("sends a model with no SDK to the completions endpoint", async () => {
    const { url } = await requestFor("opencode", spec("big-pickle"));
    expect(url).toBe(`${OPENCODE_PLANE_API.zen}/chat/completions`);
  });

  it("sends a Google model to the endpoint a hand-declared route cannot name", async () => {
    const { url } = await requestFor(
      "opencode",
      spec("gemini-3.8-flash", "@ai-sdk/google")
    );
    expect(url).toBe(
      `${OPENCODE_PLANE_API.zen}/models/gemini-3.8-flash:streamGenerateContent?alt=sse`
    );
  });

  it("sends a Go-plane model to the Go base", async () => {
    const { url } = await requestFor(
      "opencode-go",
      spec("deepseek-v4-flash", "@ai-sdk/openai")
    );
    expect(url).toBe(`${OPENCODE_PLANE_API.go}/responses`);
  });
});

describe("pi-provider · the headers every protocol carries", () => {
  it("puts the session id on all four protocols", async () => {
    const cases: [string, string | undefined][] = [
      ["gpt-5.4", "@ai-sdk/openai"],
      ["claude-opus-5", "@ai-sdk/anthropic"],
      ["big-pickle", undefined],
      ["gemini-3.8-flash", "@ai-sdk/google"],
    ];
    for (const [id, sdk] of cases) {
      const { headers } = await requestFor("opencode", spec(id, sdk));
      expect(headers["x-opencode-session"]).toBe("ses_test");
      expect(headers["x-opencode-client"]).toBe("cli");
      expect(headers["x-opencode-project"]).toBe("global");
    }
  });
});

describe("pi-provider · the tables themselves", () => {
  it("keeps the Anthropic base one level shorter on both planes", () => {
    for (const plane of ["opencode", "opencode-go"] as const) {
      const base = BASE_FOR_PROTOCOL[plane];
      expect(base["anthropic-messages"]?.endsWith("/v1")).toBe(false);
      expect(base["openai-responses"]?.endsWith("/v1")).toBe(true);
    }
  });

  it("takes every base from the catalog, so a move follows the data", () => {
    // The base used to be a hard-coded `…/zen` string asserted here. The vendor
    // moved `models.dev`'s provider entry to `…/inference/v1` and a deployment
    // would have stayed on the older endpoint while its own catalog named the
    // newer one - which is why the mount reads `OPENCODE_PLANE_API` now.
    for (const plane of ["opencode", "opencode-go"] as const) {
      for (const [protocol, base] of Object.entries(BASE_FOR_PROTOCOL[plane])) {
        const declared =
          OPENCODE_PLANE_API[plane === "opencode" ? "zen" : "go"];
        // The Anthropic endpoint is the base without its version segment, so it
        // is the one protocol whose base is deliberately SHORTER than declared.
        const expected =
          protocol === "anthropic-messages"
            ? declared.replace(/\/v1$/, "")
            : declared;
        expect(base, protocol).toBe(expected);
      }
    }
  });
});

describe("pi-provider · the User-Agent the stream hook sends", () => {
  // 1.19.0's client sends `opencode/<version>` and nothing more -
  // `packages/opencode/src/session/llm/request.ts:18`. The AI SDK stamps its own
  // `ai-sdk/provider-utils/… runtime/bun/…` tail on a request it sends, which is
  // a different transport's signature, not the client's; and 2.x changed the
  // shape again to `opencode/<channel>/<version>/<client>`.
  it("is the CLI's version and nothing else", () => {
    expect(OPENCODE_USER_AGENT).toBe("opencode/1.19.0");
  });
});

describe("pi-provider · the object pi requires", () => {
  // pi's `Model` declares `reasoning: boolean` and `thinkingLevelMap?`, and a
  // model built here may have no entry in pi's installed catalog at all - the
  // spread that was supposed to carry those fields is then an empty object. So
  // the fields pi requires have to be set, not inherited.
  const requiredSpec = {
    context_window: 1_048_576,
    cost: { input: 1, output: 2 },
    id: "x",
    input_modalities: ["text"],
    max_output_tokens: 65_536,
    name: "X",
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["low", "high"] }],
  };

  it("sets every required field, with no catalog entry to inherit from", () => {
    const model = piModelFor(
      "opencode",
      requiredSpec as never,
      "openai-completions"
    );
    for (const field of [
      "api",
      "baseUrl",
      "contextWindow",
      "cost",
      "id",
      "input",
      "maxTokens",
      "name",
      "provider",
      "reasoning",
    ]) {
      expect(model, field).toHaveProperty(field);
    }
    expect(typeof model.reasoning).toBe("boolean");
  });

  it("says false rather than nothing when a model declares no reasoning", () => {
    const model = piModelFor(
      "opencode",
      {
        ...requiredSpec,
        reasoning: undefined,
        reasoning_options: undefined,
      } as never,
      "openai-completions"
    );
    expect(model.reasoning).toBe(false);
    expect(model.thinkingLevelMap).toBeUndefined();
  });
});
