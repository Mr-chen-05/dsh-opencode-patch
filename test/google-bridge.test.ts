import { readFileSync } from "node:fs";
/**
 * `google-bridge.ts` — the route this plugin registers for itself, verified
 * against the real `PiAiAdapter` class and the real Google protocol module
 * rather than a stand-in for either.
 *
 * The bridge exists because every supported path to these models was measured
 * and closed: the wrapper's hand-declared table refuses the protocol, a
 * catalog route may only take the catalog provider's own name, and the
 * registration handle that would hand a route back is never seen by a plugin
 * that loads after the wrapper. What this file proves is that the objects the
 * bridge builds by hand are the ones the real consumer accepts.
 */
import { createRequire } from "node:module";

import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import semver from "semver";
import { beforeEach, describe, expect, it } from "vitest";

import { OPENCODE_ZEN_CATALOG } from "../src/catalog-data.ts";
import {
  ambientAuthContext,
  emptyCredentialStore,
  type GoogleBridgeInputs,
  googleProviderFor,
  registerGoogleBridge,
  resolveGatewayKey,
} from "../src/google-bridge.ts";
import { clearOrgs } from "../src/org-cache.ts";
import { GOOGLE_INTERNAL_ROUTE, GOOGLE_SDK } from "../src/responses-routes.ts";
import { createOpencodeStore } from "./test-helpers.ts";

/** The Gemini models of the Zen plane, straight from the generated catalog. */
const geminiSpecs = OPENCODE_ZEN_CATALOG.filter(
  (spec) => spec.provider_npm === GOOGLE_SDK
);

/** One model the provider serves, as this file reads it back. */
interface ModelLike extends Record<string, unknown> {
  api: string;
  baseUrl: string;
  id: string;
  provider: string;
}

/** The provider surface this file exercises. */
interface ProviderLike {
  getModels: () => ModelLike[];
  stream: (
    model: ModelLike,
    context: unknown,
    options?: unknown
  ) => AsyncIterable<unknown>;
  streamSimple: (
    model: ModelLike,
    context: unknown,
    options?: unknown
  ) => AsyncIterable<unknown>;
}

/** The bridge's provider, through the one cast the test needs. */
const providerAs = (specs: typeof geminiSpecs): ProviderLike =>
  googleProviderFor(specs) as unknown as ProviderLike;

/** The `llm` the bridge registers on: it records what the service received. */
const recordingLlm = (): {
  llm: GoogleBridgeInputs["llm"];
  registered: { adapter: unknown; routes: readonly string[] }[];
} => {
  const registered: { adapter: unknown; routes: readonly string[] }[] = [];
  return {
    llm: {
      registerAdapter: (routes, adapter) => {
        registered.push({ adapter, routes });
        return () => {};
      },
    },
    registered,
  };
};

/** The bridge's standard inputs, against the real adapter class. */
const bridgeInputs = (
  llm: GoogleBridgeInputs["llm"],
  apiKeyRef = "OPENCODE_API_KEY"
): GoogleBridgeInputs => ({
  apiKeyRef,
  ctx: {},
  host: { PiAiAdapter },
  llm,
  specs: geminiSpecs,
});

describe("google-bridge · the provider it builds", () => {
  it("carries every Gemini model of the Zen plane with the gateway base", () => {
    const models = providerAs(geminiSpecs).getModels();
    expect(models.length).toBe(geminiSpecs.length);
    for (const model of models) {
      // **The Google family has its own base.** Measured from the vendor's
      // `GET /console/api/config`: `…/inference/google/v1beta`, not the
      // `…/inference/openai/v1` the plane's openai protocols use. Deriving it by
      // string surgery on one plane URL is what sent these models to the wrong
      // endpoint.
      expect(model.api).toBe("google-generative-ai");
      expect(model.baseUrl).toBe("https://opencode.ai/inference/google/v1beta");
      // The provider field names the route, the way the wrapper's own model
      // resolution sets it — not the plane the model was catalogued on.
      expect(model.provider).toBe(GOOGLE_INTERNAL_ROUTE);
    }
  });

  it("keeps every field the installed catalog knows about the model", () => {
    // The regression this guards: building the model object field by field
    // drops everything pi knows that this module does not model — the
    // compatibility switches, the reasoning flag, the thinking-level map, the
    // input limits — and each of those changes the request silently. The
    // wrapper's own materialization spreads the catalog entry for exactly this
    // reason; the claim here is that the bridge does too.
    const pi = builtinProviders().find(
      (provider) => provider.id === "opencode"
    );
    expect(pi).toBeDefined();
    const installed = pi?.getModels() ?? [];
    const ours = providerAs(geminiSpecs).getModels();
    // The fields this module deliberately sets; everything else must come
    // through untouched from the installed entry.
    const oursToSet = new Set([
      "api",
      "baseUrl",
      "contextWindow",
      "cost",
      "id",
      "input",
      "maxTokens",
      "name",
      "provider",
    ]);
    let compared = 0;
    for (const model of ours) {
      const entry = installed.find((candidate) => candidate.id === model.id);
      if (entry === undefined) {
        // pi does not ship this id, so there was nothing to inherit.
        continue;
      }
      for (const [key, value] of Object.entries(entry)) {
        if (oursToSet.has(key)) {
          continue;
        }
        expect(model[key], `${model.id} lost ${key}`).toEqual(value);
        compared += 1;
      }
    }
    // A vacuous pass would compare nothing; say so instead.
    expect(compared).toBeGreaterThan(0);
  });

  it("sends each model to the gateway with the resolved key", async () => {
    const provider = providerAs(geminiSpecs);
    const seen: { headers: Record<string, string>; url: string }[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (
      input: unknown,
      init?: { headers?: unknown }
    ) => {
      let raw: Record<string, string> = {};
      const candidate = init?.headers;
      if (candidate instanceof Headers) {
        raw = {};
        for (const [key, value] of candidate.entries()) {
          raw[key] = value;
        }
      } else if (typeof candidate === "object" && candidate !== null) {
        raw = candidate as Record<string, string>;
      }
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(raw)) {
        headers[key.toLowerCase()] = value;
      }
      seen.push({
        headers,
        url: typeof input === "string" ? input : String(input),
      });
      throw new Error("captured");
    }) as typeof globalThis.fetch;
    try {
      for (const model of provider.getModels()) {
        seen.length = 0;
        try {
          const stream = provider.stream(
            model,
            { messages: [{ role: "user", content: "hi" }] },
            { apiKey: "oc_sk_resolved" }
          );
          for await (const _ of stream) {
            // The capture refuses the call; nothing arrives.
          }
        } catch {
          // Expected: the capture refuses the request.
        }
        expect(seen.length).toBe(1);
        expect(seen[0]?.url).toBe(
          `https://opencode.ai/inference/google/v1beta/models/${model.id}:streamGenerateContent?alt=sse`
        );
        // This protocol's credential header, measured against the gateway:
        // the request-level key rides x-goog-api-key, not Authorization.
        expect(seen[0]?.headers["x-goog-api-key"]).toBe("oc_sk_resolved");
      }
      // `streamSimple` is pi's normalization path into the same wire
      // implementation, so it must reach the same endpoint.
      seen.length = 0;
      const [first] = provider.getModels();
      if (first === undefined) {
        throw new Error("the provider served no models to probe");
      }
      try {
        const simple = provider.streamSimple(
          first as ModelLike,
          { messages: [{ role: "user", content: "hi" }] },
          { apiKey: "oc_sk_resolved" }
        );
        for await (const _ of simple) {
          // The capture refuses the call; nothing arrives.
        }
      } catch {
        // Expected: the capture refuses the request.
      }
      expect(seen.length).toBe(1);
      expect(seen[0]?.url).toBe(
        `https://opencode.ai/inference/google/v1beta/models/${first.id}:streamGenerateContent?alt=sse`
      );
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("google-bridge · the adapter it registers", () => {
  it("registers the route through the real PiAiAdapter class", () => {
    const { llm, registered } = recordingLlm();
    const handle = registerGoogleBridge(bridgeInputs(llm));
    expect(handle).toBeDefined();
    expect(registered.length).toBe(1);
    expect(registered[0]?.routes).toEqual([GOOGLE_INTERNAL_ROUTE]);
  });

  it("answers the service's questions from the profile the real class consumed", () => {
    const { llm, registered } = recordingLlm();
    registerGoogleBridge(bridgeInputs(llm));
    const adapter = registered[0]?.adapter as {
      providerInfo: (provider: string) => { id: string; name: string };
      providerRetryPolicy: (provider: string) => {
        maxRetries: number;
        mode: string;
      };
    };
    expect(adapter).toBeDefined();
    // A profile the real class rejects would make these throw, not lie.
    expect(adapter.providerInfo(GOOGLE_INTERNAL_ROUTE)).toEqual({
      id: GOOGLE_INTERNAL_ROUTE,
      name: "OpenCode (Google)",
    });
    // The defaults were read from the harness's own retry table: five
    // retries is its number, not ours.
    const policy = adapter.providerRetryPolicy(GOOGLE_INTERNAL_ROUTE);
    expect(policy.mode).toBe("normal");
    expect(policy.maxRetries).toBe(5);
  });

  it("declines to mount where no loaded wrapper handed it an adapter", () => {
    const { llm, registered } = recordingLlm();
    const handle = registerGoogleBridge({
      ...bridgeInputs(llm),
      host: undefined,
    });
    expect(handle).toBeUndefined();
    expect(registered.length).toBe(0);
  });
});

describe("google-bridge · the auth injectables it hands the collection", () => {
  it("answers every credential-store read as absent", async () => {
    // The route's key always arrives per request, so this store is never the
    // path a stream call reads — but it must still satisfy the collection's
    // shape honestly rather than pretending to hold something.
    const store = emptyCredentialStore();
    await expect(store.read("opencode-google")).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([]);
    await expect(store.delete("opencode-google")).resolves.toBeUndefined();
  });

  it("passes a modify through with no current credential", async () => {
    // pi's write path sees the current credential; an empty store's is
    // absent, and the callback's answer is the store's answer.
    const store = emptyCredentialStore();
    const written = await store.modify("opencode-google", (current) =>
      Promise.resolve({ current })
    );
    expect(written).toEqual({ current: undefined });
  });

  it("reads the ambient context from the process environment", async () => {
    process.env.BRIDGE_AMBIENT_KEY = "ambient-value";
    try {
      const auth = ambientAuthContext();
      await expect(auth.env("BRIDGE_AMBIENT_KEY")).resolves.toBe(
        "ambient-value"
      );
      await expect(auth.fileExists("/nope")).resolves.toBe(false);
    } finally {
      process.env.BRIDGE_AMBIENT_KEY = "";
    }
  });
});

describe("google-bridge · the request the adapter actually sends", () => {
  /**
   * Everything else in this file exercises a piece. This one runs the whole
   * path the user would: the real `PiAiAdapter`, our profile, pi's Google
   * implementation, and the credential the plugin resolves — with only the
   * network intercepted.
   *
   * It is the test the earlier probe could not stand in for. The probe proved
   * the ENDPOINT answers; this proves the REQUEST the bridge builds is one the
   * endpoint accepts — the Gemini body needs a `role` on each content, and an
   * earlier hand-written probe was rejected for omitting exactly that.
   */
  it("streams through the real adapter to the gateway, credential and all", async () => {
    process.env.BRIDGE_STREAM_KEY = "oc_sk_stream_resolved";
    const { llm, registered } = recordingLlm();
    try {
      registerGoogleBridge(bridgeInputs(llm, "BRIDGE_STREAM_KEY"));
      const adapter = registered[0]?.adapter as {
        stream: (options: unknown) => AsyncIterable<unknown>;
      };
      expect(adapter).toBeDefined();

      const sent: {
        body: string;
        headers: Record<string, string>;
        url: string;
      }[] = [];
      let failure: unknown;
      const real = globalThis.fetch;
      globalThis.fetch = (async (
        input: unknown,
        init?: { body?: unknown; headers?: unknown }
      ) => {
        const headers: Record<string, string> = {};
        const candidate = init?.headers;
        if (candidate instanceof Headers) {
          for (const [key, value] of candidate.entries()) {
            headers[key] = value;
          }
        } else if (typeof candidate === "object" && candidate !== null) {
          for (const [key, value] of Object.entries(
            candidate as Record<string, string>
          )) {
            headers[key] = value;
          }
        }
        const raw = init?.body;
        sent.push({
          body: typeof raw === "string" ? raw : "",
          headers,
          url: typeof input === "string" ? input : String(input),
        });
        throw new Error("captured");
      }) as typeof globalThis.fetch;
      try {
        for await (const _ of adapter.stream({
          // The host's content is a block array, not a bare string: the
          // adapter scans it for images before it resolves the key.
          messages: [{ content: [{ text: "hi", type: "text" }], role: "user" }],
          model: "gemini-3.8-flash",
          provider: GOOGLE_INTERNAL_ROUTE,
        })) {
          // The capture refuses the call; nothing arrives.
        }
      } catch (error) {
        // The capture refuses the request, which surfaces here. Keeping the
        // error means a failure BEFORE the fetch says why, instead of looking
        // like a capture that never fired.
        failure = error;
      } finally {
        globalThis.fetch = real;
      }

      expect(sent.length, `no request reached fetch: ${String(failure)}`).toBe(
        1
      );
      expect(sent[0]?.url).toBe(
        "https://opencode.ai/inference/google/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse"
      );
      // The credential the plugin resolved, on the header this protocol reads.
      expect(sent[0]?.headers["x-goog-api-key"]).toBe("oc_sk_stream_resolved");
      // And a body the gateway has been measured to accept: the role is the
      // part a hand-written probe got wrong.
      const body = JSON.parse(sent[0]?.body ?? "{}") as {
        contents?: { role?: string }[];
      };
      expect(body.contents?.[0]?.role).toBe("user");
    } finally {
      process.env.BRIDGE_STREAM_KEY = "";
    }
  });
});

describe("google-bridge · the key it resolves", () => {
  it("reads a set reference from the environment", async () => {
    process.env.BRIDGE_TEST_KEY = "oc_sk_from_env";
    try {
      await expect(
        resolveGatewayKey({}, "BRIDGE_TEST_KEY", "opencode-google")
      ).resolves.toBe("oc_sk_from_env");
    } finally {
      process.env.BRIDGE_TEST_KEY = "";
    }
  });

  it("fails loud when a named reference resolves to nothing", async () => {
    delete process.env.BRIDGE_TEST_ABSENT;
    // The loud miss is the point: pi would treat `undefined` as "resolve
    // ambient auth instead", billing whatever key it finds first.
    await expect(
      resolveGatewayKey({}, "BRIDGE_TEST_ABSENT", "opencode-google")
    ).rejects.toThrow(/MISSING_CREDENTIAL/);
  });

  it("answers undefined only when no reference was named", async () => {
    await expect(
      resolveGatewayKey({}, undefined, "opencode-google")
    ).resolves.toBeUndefined();
  });
});

describe("google-bridge · the pi copy it may load", () => {
  it("pins a pi version the wrapper's requirement accepts", () => {
    // A second pi beside the wrapper's is the failure this guards: two module
    // instances would drift apart the moment either side bumps. The wrapper
    // states a RANGE, so the claim is that our exact pin satisfies it — both
    // read live, so a harness bump that moves either side turns this red.
    const ours = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const require = createRequire(import.meta.url);
    const wrapperRoot = require.resolve("@deepseek-ai/dsh-llm-pi-ai");
    const wrapperDir = wrapperRoot.slice(
      0,
      wrapperRoot.lastIndexOf("/lib/") + 1
    );
    const wrapper = JSON.parse(
      readFileSync(`${wrapperDir}package.json`, "utf8")
    ) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const ourVersion = ours.dependencies?.["@earendil-works/pi-ai"];
    const required =
      wrapper.dependencies?.["@earendil-works/pi-ai"] ??
      wrapper.peerDependencies?.["@earendil-works/pi-ai"];
    expect(ourVersion).toBeDefined();
    expect(required).toBeDefined();
    expect(semver.satisfies(ourVersion ?? "", required ?? "")).toBe(true);
  });
});

describe("google-bridge · the login's token, when a route names no reference", () => {
  // The org is process-wide state, so a test that asserts it starts from none.
  beforeEach(() => {
    clearOrgs();
  });

  /** Run one stream and hand back the headers the bridge built. */
  const capturedHeaders = async (
    apiKeyRef: string,
    loginToken?: (plane: string) => Promise<string | undefined>,
    readOpencodeStore?: boolean
  ): Promise<Record<string, string>> => {
    const { llm, registered } = recordingLlm();
    registerGoogleBridge({
      ...bridgeInputs(llm, apiKeyRef),
      ...(loginToken === undefined ? {} : { loginToken }),
      ...(readOpencodeStore === undefined ? {} : { readOpencodeStore }),
    });
    const adapter = registered[0]?.adapter as {
      stream: (options: unknown) => AsyncIterable<unknown>;
    };
    const sent: Record<string, string>[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (
      _input: unknown,
      init?: { headers?: unknown }
    ) => {
      const headers: Record<string, string> = {};
      const candidate = init?.headers;
      if (candidate instanceof Headers) {
        for (const [key, value] of candidate.entries()) {
          headers[key] = value;
        }
      } else if (typeof candidate === "object" && candidate !== null) {
        Object.assign(headers, candidate as Record<string, string>);
      }
      sent.push(headers);
      throw new Error("captured");
    }) as typeof globalThis.fetch;
    try {
      for await (const _ of adapter.stream({
        messages: [{ content: [{ text: "hi", type: "text" }], role: "user" }],
        model: "gemini-3.8-flash",
        provider: GOOGLE_INTERNAL_ROUTE,
      })) {
        // The capture refuses the call; nothing arrives.
      }
    } finally {
      globalThis.fetch = real;
    }
    return sent[0] ?? {};
  };

  it("carries it, where the route named no reference", async () => {
    // The chain is the route's own reference, then the login - so a
    // deployment that has signed in should not have to name `apiKeyEnv`. The
    // Google path carries the request key in x-goog-api-key, not Authorization.
    const headers = await capturedHeaders("", () =>
      Promise.resolve("st_from_login")
    );
    expect(headers["x-goog-api-key"]).toBe("st_from_login");
  });

  it("answers undefined when there is no login either", async () => {
    // Which is the adapter's cue to resolve ambient auth, exactly as before.
    const headers = await capturedHeaders("");
    expect(headers["x-goog-api-key"]).toBeUndefined();
  });

  it("falls back to the installation's own store when the row opted in", async () => {
    // The same chain, one step further: after the route's reference and the
    // login, the credential OpenCode itself stored. A switch that read the store
    // for the meter but not for a request would serve nothing here.
    const store = createOpencodeStore([
      { integrationId: "opencode", value: "oc_sk_fixture_zen" },
    ]);
    process.env.XDG_DATA_HOME = store.root;
    try {
      const headers = await capturedHeaders("", undefined, true);
      expect(headers["x-goog-api-key"]).toBe("oc_sk_fixture_zen");
      // Off — the default — the same store answers nothing, so the switch is
      // what decided it rather than the file's presence.
      const off = await capturedHeaders("");
      expect(off["x-goog-api-key"]).toBeUndefined();
    } finally {
      store.cleanup();
      delete process.env.XDG_DATA_HOME;
    }
  });

  it("prefers a stored login over the installation's own store", async () => {
    const store = createOpencodeStore([
      { integrationId: "opencode", value: "oc_sk_fixture_zen" },
    ]);
    process.env.XDG_DATA_HOME = store.root;
    try {
      const headers = await capturedHeaders(
        "",
        () => Promise.resolve("st_from_login"),
        true
      );
      expect(headers["x-goog-api-key"]).toBe("st_from_login");
    } finally {
      store.cleanup();
      delete process.env.XDG_DATA_HOME;
    }
  });

  // The three account cases that used to sit here moved to
  // responses-provider.test.ts, against `loginTokenReader(ctx, true)`. The bridge
  // no longer reads the installation's account - the login reader answers it one
  // level up - so keeping them here would have left them covering a branch that
  // never runs, which is the shape this repository has been audited for.

  it("still answers the installation's key when it holds no login", async () => {
    // The two halves of one switch: an installation with a key and no session
    // keeps resolving exactly what it resolved before the login half existed.
    const store = createOpencodeStore([
      { integrationId: "opencode", value: "oc_sk_fixture_zen" },
    ]);
    process.env.XDG_DATA_HOME = store.root;
    try {
      const headers = await capturedHeaders("", undefined, true);
      expect(headers["x-goog-api-key"]).toBe("oc_sk_fixture_zen");
    } finally {
      store.cleanup();
      delete process.env.XDG_DATA_HOME;
    }
  });
});
