/**
 * The request shape per configuration, over a socket.
 *
 * Each case states a configuration a user can actually write, sends one
 * request through `patchFetch` to the mock gateway, and asserts the *shape*
 * that request must carry: which session headers, which origin headers, which
 * credential on which wire header, and what the body must contain. The mock
 * refuses anything the vendor would refuse, so a 200 here means the request
 * also satisfies the endpoint's contract — the two halves are asserted
 * together on purpose.
 *
 * @module test/mock/request-shapes.mock
 */

import { AsyncLocalStorage } from "node:async_hooks";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { FetchPatchHooks } from "../../src/fetch-patch.ts";
import {
  clearCapturedApiKeys,
  OPENCODE_UA,
  PARENT_SESSION_ALT_HEADER,
  PARENT_SESSION_HEADER,
  patchFetch,
  resolveConfig,
  SESSION_AFFINITY_HEADER,
  SESSION_HEADER,
  type ActiveTurnState,
  type ResolvedPluginConfig,
} from "../../src/index.ts";
import { startMockGateway, type MockGateway } from "./gateway-server.ts";
import {
  firstSpecFor,
  GO_KEY,
  keyFor,
  MOCK_SESSION,
  sessionTurn,
  ZEN_KEY,
} from "./helpers.ts";
import type { GatewayRequest, MockReply } from "./opencode-gateway.ts";

const PARENT_VALUE = "ses_fedcba987654ZYXWVUTSRQPONM";

const als = new AsyncLocalStorage<ActiveTurnState>();

let forced: MockReply | undefined;
let gateway: MockGateway;

beforeAll(async () => {
  gateway = await startMockGateway({ behavior: () => forced });
});

afterAll(async () => {
  await gateway.close();
});

beforeEach(() => {
  gateway.requests.length = 0;
  forced = undefined;
  clearCapturedApiKeys();
  vi.stubEnv("OPENCODE_API_KEY", ZEN_KEY);
  vi.stubEnv("OPENCODE_GO_API_KEY", GO_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const patchedWith = (
  config: ResolvedPluginConfig,
  hooks?: FetchPatchHooks
): typeof fetch => patchFetch(fetch, als, config, hooks);

const responsesBody = (model: string): Record<string, unknown> => ({
  input: [],
  model,
  stream: true,
});

const post = (
  patched: typeof fetch,
  url: string,
  body: unknown
): Promise<Response> =>
  patched(url, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

const recorded = (): GatewayRequest => {
  const last = gateway.requests.at(-1);
  if (last === undefined) {
    throw new Error("the mock gateway saw no request");
  }
  return last;
};

const responsesUrl = (): string => `${gateway.origin}/zen/v1/responses`;

describe("the request shape per configuration", () => {
  it("sends the session, origin, project, UA and Zen key under the defaults", async () => {
    const response = await als.run(
      sessionTurn({ project: "mock-project" }),
      () =>
        post(
          patchedWith(resolveConfig()),
          responsesUrl(),
          responsesBody("gpt-5.4")
        )
    );
    expect(response.status).toBe(200);
    const request = recorded();
    expect(request.path).toBe("/zen/v1/responses");
    expect(request.plane).toBe("opencode");
    expect(request.headers[SESSION_HEADER]).toBe(MOCK_SESSION);
    expect(request.headers["x-opencode-session-id"]).toBe(MOCK_SESSION);
    expect(request.headers["x-opencode-client"]).toBe("cli");
    expect(request.headers["x-opencode-project"]).toBe("mock-project");
    expect(request.headers["user-agent"]).toBe(OPENCODE_UA);
    expect(request.headers.authorization).toBe(`Bearer ${ZEN_KEY}`);
    expect(request.headers["x-opencode-org-id"]).toBeUndefined();
    expect(request.headers[SESSION_AFFINITY_HEADER]).toBeUndefined();
    expect(request.headers["x-session-id"]).toBeUndefined();
  });

  it("falls the project back to global when the turn carries none", async () => {
    await als.run(sessionTurn(), () =>
      post(
        patchedWith(resolveConfig()),
        responsesUrl(),
        responsesBody("gpt-5.4")
      )
    );
    expect(recorded().headers["x-opencode-project"]).toBe("global");
  });

  it("carries both parent-lineage headers when the turn has a parent", async () => {
    await als.run(sessionTurn({ parentValue: PARENT_VALUE }), () =>
      post(
        patchedWith(resolveConfig()),
        responsesUrl(),
        responsesBody("gpt-5.4")
      )
    );
    const request = recorded();
    expect(request.headers[PARENT_SESSION_HEADER]).toBe(PARENT_VALUE);
    expect(request.headers[PARENT_SESSION_ALT_HEADER]).toBe(PARENT_VALUE);
  });

  it("adds the affinity pair for a relay provider and keeps the session", async () => {
    const config = resolveConfig({ gatewayUrls: [gateway.origin] });
    await als.run(sessionTurn({ provider: "mock-relay" }), () =>
      post(patchedWith(config), responsesUrl(), responsesBody("gpt-5.4"))
    );
    const request = recorded();
    expect(request.headers[SESSION_HEADER]).toBe(MOCK_SESSION);
    expect(request.headers[SESSION_AFFINITY_HEADER]).toBe(MOCK_SESSION);
    expect(request.headers["x-session-id"]).toBe(MOCK_SESSION);
    expect(request.headers.authorization).toBe(`Bearer ${ZEN_KEY}`);
  });

  it("omits the origin headers when injectOriginHeaders is off", async () => {
    await als.run(sessionTurn(), () =>
      post(
        patchedWith(resolveConfig({ injectOriginHeaders: false })),
        responsesUrl(),
        responsesBody("gpt-5.4")
      )
    );
    const request = recorded();
    expect(request.headers["x-opencode-client"]).toBeUndefined();
    expect(request.headers["x-opencode-project"]).toBeUndefined();
    expect(request.headers[SESSION_HEADER]).toBe(MOCK_SESSION);
    expect(request.headers["user-agent"]).toBe(OPENCODE_UA);
  });

  it("keeps the client header and drops the project when injectProject is off", async () => {
    await als.run(sessionTurn(), () =>
      post(
        patchedWith(resolveConfig({ injectProject: false })),
        responsesUrl(),
        responsesBody("gpt-5.4")
      )
    );
    const request = recorded();
    expect(request.headers["x-opencode-client"]).toBe("cli");
    expect(request.headers["x-opencode-project"]).toBeUndefined();
  });

  it("sends a configured originClient verbatim", async () => {
    await als.run(sessionTurn(), () =>
      post(
        patchedWith(resolveConfig({ originClient: "dsh-mock/1.0" })),
        responsesUrl(),
        responsesBody("gpt-5.4")
      )
    );
    expect(recorded().headers["x-opencode-client"]).toBe("dsh-mock/1.0");
  });

  it("sends a configured userAgent verbatim", async () => {
    await als.run(sessionTurn(), () =>
      post(
        patchedWith(resolveConfig({ userAgent: "mock-agent/9.9" })),
        responsesUrl(),
        responsesBody("gpt-5.4")
      )
    );
    expect(recorded().headers["user-agent"]).toBe("mock-agent/9.9");
  });

  it("leaves the UA alone when injectUserAgent is off", async () => {
    await als.run(sessionTurn(), () =>
      post(
        patchedWith(resolveConfig({ injectUserAgent: false })),
        responsesUrl(),
        responsesBody("gpt-5.4")
      )
    );
    expect(recorded().headers["user-agent"]).not.toBe(OPENCODE_UA);
  });

  it("carries a configured credentialOrg on the org header", async () => {
    await als.run(sessionTurn(), () =>
      post(
        patchedWith(resolveConfig({ credentialOrg: "wrk_mock" })),
        responsesUrl(),
        responsesBody("gpt-5.4")
      )
    );
    expect(recorded().headers["x-opencode-org-id"]).toBe("wrk_mock");
  });

  it("authenticates the Messages endpoint with x-api-key and the Bearer fallback", async () => {
    const spec = firstSpecFor("opencode", "@ai-sdk/anthropic");
    if (spec === undefined) {
      throw new Error("the zen catalog serves no anthropic model");
    }
    const response = await als.run(sessionTurn(), () =>
      post(
        patchedWith(resolveConfig()),
        `${gateway.origin}/zen/v1/messages?beta=true`,
        {
          max_tokens: 64,
          messages: [{ content: "hi", role: "user" }],
          model: spec.id,
          stream: true,
        }
      )
    );
    expect(response.status).toBe(200);
    const request = recorded();
    expect(request.headers["x-api-key"]).toBe(ZEN_KEY);
    expect(request.headers.authorization).toBe(`Bearer ${ZEN_KEY}`);
  });

  it("authenticates the Google endpoint with x-goog-api-key", async () => {
    const spec = firstSpecFor("opencode", "@ai-sdk/google");
    if (spec === undefined) {
      throw new Error("the zen catalog serves no Google model");
    }
    const response = await als.run(sessionTurn(), () =>
      post(
        patchedWith(resolveConfig()),
        `${gateway.origin}/zen/v1/models/${spec.id}:streamGenerateContent?alt=sse`,
        { contents: [{ parts: [{ text: "hi" }], role: "user" }] }
      )
    );
    expect(response.status).toBe(200);
    const request = recorded();
    expect(request.headers["x-goog-api-key"]).toBe(ZEN_KEY);
    expect(request.headers.authorization).toBe(`Bearer ${ZEN_KEY}`);
  });

  it("adds the core-tool schemas for a free-tier responses model", async () => {
    const response = await als.run(sessionTurn(), () =>
      post(
        patchedWith(resolveConfig()),
        responsesUrl(),
        responsesBody("muse-spark-1.2-contributor-free")
      )
    );
    expect(response.status).toBe(200);
    const body = recorded().body as { tools?: { name?: string }[] };
    const names = (body.tools ?? []).map((tool) => tool.name);
    expect(names).toContain("read");
    expect(names).toContain("bash");
  });

  it("passes a 403 refusal through with the gateway's status and message", async () => {
    // The status belongs to the gateway. `Model access is disabled` is an
    // entitlement answer, and rewriting it to 400 — to steer DSH's classifier away
    // from its AUTH label — changed a status this plugin does not own. The
    // classifier's label is its reading; the message underneath is accurate.
    forced = {
      body: JSON.stringify({
        error: {
          message: "Upstream request failed: Model access is disabled",
          type: "server_error",
        },
      }),
      status: 403,
    };
    const response = await als.run(sessionTurn(), () =>
      post(
        patchedWith(resolveConfig()),
        responsesUrl(),
        responsesBody("gpt-5.4")
      )
    );
    expect(response.status).toBe(403);
    const payload = (await response.json()) as {
      error: { message: string; type: string };
    };
    expect(payload.error.type).toBe("server_error");
    expect(payload.error.message).toContain("Model access is disabled");
  });

  it("passes a 401 through", async () => {
    forced = {
      body: JSON.stringify({ error: { message: "Invalid API key" } }),
      status: 401,
    };
    const response = await als.run(sessionTurn(), () =>
      post(
        patchedWith(resolveConfig()),
        responsesUrl(),
        responsesBody("gpt-5.4")
      )
    );
    expect(response.status).toBe(401);
  });

  it("sends no credential and warns when none resolves", async () => {
    vi.stubEnv("OPENCODE_API_KEY", "");
    const warnings: unknown[][] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args);
    });
    const response = await als.run(sessionTurn(), () =>
      post(
        patchedWith(resolveConfig()),
        responsesUrl(),
        responsesBody("gpt-5.4")
      )
    );
    expect(response.status).toBe(401);
    expect(recorded().headers.authorization).toBeUndefined();
    expect(warnings.length).toBeGreaterThan(0);
    // The report names the plane, so a reader can tell which credential is
    // missing rather than only that something is.
    expect(String(warnings[0]?.[0])).toContain(
      "no credential resolved for opencode"
    );
  });

  it("uses the Go key for the Go plane", async () => {
    const spec = firstSpecFor("opencode-go", "@ai-sdk/openai");
    if (spec === undefined) {
      throw new Error("the go catalog serves no responses model");
    }
    const response = await als.run(
      sessionTurn({ model: spec.id, provider: "opencode-go" }),
      () =>
        post(
          patchedWith(resolveConfig()),
          `${gateway.origin}/inference/go/openai/v1/responses`,
          responsesBody(spec.id)
        )
    );
    expect(response.status).toBe(200);
    const request = recorded();
    expect(request.plane).toBe("opencode-go");
    expect(request.headers.authorization).toBe(
      `Bearer ${keyFor("opencode-go")}`
    );
  });
});
