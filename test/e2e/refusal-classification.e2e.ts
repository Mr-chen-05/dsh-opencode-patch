/**
 * End-to-end refusal contract: what the classifier reads off a real socket.
 *
 * `classifyPiAiError` (`@deepseek-ai/dsh-llm-pi-ai`) asks the MESSAGE before
 * it asks anything else — its first branch is `if (/\b(?:401|403)\b/.test(message)) return "AUTH"` —
 * so a rewritten refusal that quotes the code it rewrites away is still read as
 * an invalid API key no matter what status it carries. Exactly that shipped
 * once, with every rewritten body opening `(403 …)`, and the fix moved the text
 * off the token and onto 400 (`fix(errors): the refusal text must not carry the
 * status it rewrites`).
 *
 * The unit suite pins that contract against a stubbed `Response`. This file
 * runs the same decision table where it can actually break: the gateway's bytes
 * arriving over a real `node:http` socket, one shape per refusal the gateway has
 * been measured to send — including a body written in several chunks, which
 * crosses reads the way a refusal on the live gateway does and which no
 * `new Response(body)` fixture produces.
 *
 * The classifier is not exported from the package, so the oracle below is a
 * copy; the first case asserts the installed bundle still carries the branches
 * the verdicts depend on, in their order — a vendor move fails here instead of
 * being absorbed by a stale copy.
 *
 * Opt-in (`OPENCODE_E2E=1`), like the sibling header suite: it binds a port.
 */

import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type ActiveTurnState,
  patchFetch,
  resolveConfig,
} from "../../src/index.ts";

const ENABLED = process.env.OPENCODE_E2E === "1";

/**
 * `classifyPiAiError`'s decision for a message, copied from the installed
 * `@deepseek-ai/dsh-llm-pi-ai` bundle up to the branch a refusal body reaches.
 *
 * Order is the whole point: AUTH is tested FIRST, against the message text,
 * before any status or later branch is consulted — a body that names 401/403 is
 * read as an invalid key whatever it carries. The shipped function continues
 * into SERVER/TIMEOUT/TRANSPORT and `PI_AI_ERROR` below the branch a `(400)`
 * body takes; no message this file feeds the copy can reach those, so the copy
 * stops at the deciding branch, and the first case pins it to the source.
 */
const classify = (message: string): string => {
  if (/\b(?:401|403)\b/u.test(message)) {
    return "AUTH";
  }
  if (/\b429\b|rate.?limit/iu.test(message)) {
    return "RATE_LIMIT";
  }
  if (/\b413\b/u.test(message)) {
    return "INVALID_REQUEST";
  }
  if (/\b400\b|invalid.?request/iu.test(message)) {
    return "INVALID_REQUEST";
  }
  return "OTHER";
};

/** The gateway's own bodies, as measured. */
const BODY = {
  auth: JSON.stringify({
    error: { message: "Invalid API key", type: "AuthError" },
  }),
  entitlement: JSON.stringify({
    error: {
      message: "Upstream request failed: Model access is disabled",
      type: "server_error",
    },
  }),
  freeTier: JSON.stringify({
    error: {
      message: "OpenCode's free tier can only be used from within OpenCode",
      type: "FreeTierError",
    },
  }),
  ok: JSON.stringify({ ok: true }),
  upstreamNamed: JSON.stringify({
    error: {
      message: "upstream answered 403 to the relay",
      type: "relay_error",
    },
  }),
  usage: JSON.stringify({
    error: { message: "Subscription required", type: "usage_restricted" },
  }),
} as const;

/** Between the free-tier writes, so the body genuinely crosses reads. */
const CHUNK_DELAY_MS = 15;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

let server: Server;
let origin: string;

/**
 * Answer one request. Wired to the server through a non-async listener,
 * because an `async` listener hands Node a promise where it expects void.
 */
const handle = async (
  url: string | undefined,
  response: ServerResponse
): Promise<void> => {
  const path = new URL(url ?? "/", "http://127.0.0.1").pathname;
  switch (path) {
    case "/refusal/free-tier": {
      // The measured body, written in three chunks with two flushes between
      // them: what `response.clone().text()` in the patch has to assemble is
      // a body that arrives over several reads, not one buffer.
      response.writeHead(403, { "content-type": "application/json" });
      response.write(BODY.freeTier.slice(0, 21));
      await delay(CHUNK_DELAY_MS);
      response.write(BODY.freeTier.slice(21, 64));
      await delay(CHUNK_DELAY_MS);
      response.end(BODY.freeTier.slice(64));
      return;
    }
    case "/refusal/entitlement": {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(BODY.entitlement);
      return;
    }
    case "/refusal/upstream-named": {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(BODY.upstreamNamed);
      return;
    }
    case "/refusal/waf": {
      response.writeHead(403, { "content-type": "text/plain" });
      response.end("error code: 1010");
      return;
    }
    case "/refusal/unrecognized": {
      // Neither JSON nor 1010: a 403 this patch has no rewrite for.
      response.writeHead(403, { "content-type": "text/plain" });
      response.end("Forbidden");
      return;
    }
    case "/zen/go/v1/usage": {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(BODY.usage);
      return;
    }
    case "/auth": {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(BODY.auth);
      return;
    }
    default: {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(BODY.ok);
    }
  }
};

beforeAll(async () => {
  server = createServer((request, response) => {
    void handle(request.url, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address === "object", "no bound port");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.close();
  await once(server, "close");
});

interface Refusal {
  error: { message: string; type: string };
}

describe.skipIf(!ENABLED)("refusal classification over a real socket", () => {
  const als = new AsyncLocalStorage<ActiveTurnState>();
  const patched = patchFetch(fetch, als, resolveConfig({}));

  const turn = (overrides: Partial<ActiveTurnState> = {}): ActiveTurnState => ({
    model: "gpt-5.4",
    provider: "opencode",
    value: "ses_e2e00000000",
    ...overrides,
  });

  const call = async (
    path: string,
    overrides: Partial<ActiveTurnState> = {}
  ): Promise<Response> =>
    als.run(turn(overrides), () =>
      patched(`${origin}${path}`, {
        body: JSON.stringify({ model: "gpt-5.4", stream: true }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    );

  const get = async (path: string): Promise<Response> =>
    als.run(turn(), () => patched(`${origin}${path}`, { method: "GET" }));

  const refusal = async (
    path: string,
    overrides: Partial<ActiveTurnState> = {}
  ): Promise<{ payload: Refusal; response: Response }> => {
    const response = await call(path, overrides);
    const payload = (await response.json()) as Refusal;
    return { payload, response };
  };

  /**
   * What every rewritten refusal must be: a 400, a named refusal type, and
   * text the classifier reads as a request problem. The classification is the
   * contract — `AUTH` is the first branch, so `INVALID_REQUEST` implies the
   * body carries no 401/403 token — and the `(400)` is the token that branch
   * reads in its place.
   */
  const expectRewritten = (
    result: { payload: Refusal; response: Response },
    type: string,
    needle: string
  ): void => {
    expect(result.response.status).toBe(400);
    expect(result.payload.error.type).toBe(type);
    expect(result.payload.error.message).toContain(needle);
    expect(result.payload.error.message).toContain("(400)");
    expect(classify(result.payload.error.message)).toBe("INVALID_REQUEST");
  };

  it("pins the oracle to the classifier the deployment runs", async () => {
    const source = await readFile(
      new URL(
        "../../node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js",
        import.meta.url
      ),
      "utf8"
    );
    const auth = String.raw`if (/\b(?:401|403)\b/.test(message)) return "AUTH";`;
    const invalid = String.raw`if (/\b400\b|invalid.?request/i.test(message)) return "INVALID_REQUEST";`;
    const authAt = source.indexOf(auth);
    const invalidAt = source.indexOf(invalid);
    expect(
      authAt,
      "the AUTH branch left the installed classifier"
    ).toBeGreaterThanOrEqual(0);
    expect(
      invalidAt,
      "the 400 branch left the installed classifier"
    ).toBeGreaterThanOrEqual(0);
    // Order IS the contract: AUTH runs first, so a body that names 401/403 can
    // never reach the branch the rewrite needs it to take.
    expect(authAt).toBeLessThan(invalidAt);
  });

  it("restates a chunked free-tier refusal so it is not read as a bad key", async () => {
    expectRewritten(
      await refusal("/refusal/free-tier"),
      "free_tier_restricted",
      "FreeTierError"
    );
  });

  it("keeps the gateway's own words in an entitlement refusal", async () => {
    expectRewritten(
      await refusal("/refusal/entitlement"),
      "entitlement_restricted",
      "Model access is disabled"
    );
  });

  it("scrubs a status token the gateway's own message carries", async () => {
    const result = await refusal("/refusal/upstream-named");
    expectRewritten(
      result,
      "entitlement_restricted",
      "upstream answered 4xx to the relay"
    );
    // The upstream named the code; the answer must not repeat it, or the
    // classifier walks straight back into AUTH through the gateway's voice.
    expect(result.payload.error.message).not.toContain("403");
  });

  it("restates the Cloudflare client-identity block", async () => {
    expectRewritten(
      await refusal("/refusal/waf"),
      "client_identity_blocked",
      "1010"
    );
  });

  it("leaves a 403 it has no rewrite for exactly as it arrived", async () => {
    const response = await call("/refusal/unrecognized");
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Forbidden");
  });

  it("leaves /usage's 403 alone, because the meter reads that status", async () => {
    const response = await get("/zen/go/v1/usage");
    expect(response.status).toBe(403);
    const payload = (await response.json()) as Refusal;
    expect(payload.error.type).toBe("usage_restricted");
  });

  it("leaves an unclaimed provider's 403 alone", async () => {
    const response = await call("/refusal/entitlement", {
      provider: "deepseek",
    });
    expect(response.status).toBe(403);
    const payload = (await response.json()) as Refusal;
    expect(payload.error.type).toBe("server_error");
  });

  it("leaves a 401 a 401 — that one really is about the key", async () => {
    const response = await call("/auth");
    expect(response.status).toBe(401);
    const payload = (await response.json()) as Refusal;
    expect(payload.error.type).toBe("AuthError");
    expect(payload.error.message).toBe("Invalid API key");
  });

  it("passes a success through with its body intact", async () => {
    const response = await get("/ok");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(BODY.ok);
  });
});
