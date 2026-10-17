/**
 * Provider-aware model-discovery decoration.
 *
 * A configured OpenCode route can be answered from its adapter’s installed
 * catalog without a gateway request. In that path, response enrichment never
 * runs, so decorating the discovery answer is the only way to add a missing
 * catalog row or remove a provider-retired row from “fetch available models.”
 *
 * @module test/models-discovery.test
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decorateModelDiscovery,
  decorateModelInfo,
  hideResponsesRoute,
  getLiveZenCatalog,
  isRouteRegistered,
  mergeDiscoveredModels,
  isDeprecatedModelOn,
  parseModelsDevCatalog,
  resolveConfig,
  resolveDiscoveryProvider,
  resolveEffectiveContextWindow,
  RESPONSES_ROUTE,
  type CordisContext,
  type CatalogModelSpec,
} from "../src/index.ts";
import {
  decoratePlaneAdapters,
  isServableModel,
} from "../src/models-discovery.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCODE_SESSION_ID;
});

const providers = new Set(["opencode", "opencode-go"]);
const gatewayUrls = ["opencode.ai/zen"];
const config = { ...resolveConfig(), gatewayUrls, providers };

const catalogRow = (
  id: string,
  name = id,
  inputModalities: string[] = ["text"]
): CatalogModelSpec => ({
  context_window: 1000000,
  id,
  input_modalities: inputModalities,
  max_output_tokens: 131072,
  name,
});

describe("resolveDiscoveryProvider", () => {
  it("prefers an explicitly claimed route ID", () => {
    expect(resolveDiscoveryProvider({ provider: "opencode" }, config)).toBe(
      "zen"
    );
    expect(resolveDiscoveryProvider({ provider: "opencode-go" }, config)).toBe(
      "go"
    );
  });

  it("ignores unclaimed routes and non-OpenCode gateways", () => {
    expect(resolveDiscoveryProvider({ provider: "other" }, config)).toBe(
      undefined
    );
    expect(
      resolveDiscoveryProvider(
        { baseURL: "https://gateway.example.com/v1" },
        config
      )
    ).toBe(undefined);
    expect(resolveDiscoveryProvider(null, config)).toBe(undefined);
  });

  it("classifies an OpenCode gateway draft by its URL path", () => {
    expect(
      resolveDiscoveryProvider(
        { baseURL: "https://opencode.ai/zen/go/v1", provider: "custom-go" },
        { ...config, providers: new Set(["custom-go"]) }
      )
    ).toBe("go");
    expect(
      resolveDiscoveryProvider(
        { baseURL: "https://opencode.ai/zen/v1", provider: "custom-zen" },
        { ...config, providers: new Set(["custom-zen"]) }
      )
    ).toBe("zen");
  });
});

describe("mergeDiscoveredModels", () => {
  it("drops an adapter row the registry has retired", () => {
    // The adapter's installed snapshot is older than the live catalog and still
    // lists ids the vendor has retired — measured: 5 of pi's 85 opencode ids are
    // deprecated in the live catalog, and 6 live-active ids it lacks. Our own
    // catalog drops the retired ones during parse, so without this filter the
    // MERGE is what puts them back, and the picker leads with models that no
    // longer answer.
    parseModelsDevCatalog({
      opencode: {
        api: "https://opencode.ai/zen/v1",
        models: {
          "still-here": { name: "Still Here" },
          "retired-one": { name: "Retired One", status: "deprecated" },
        },
      },
    });

    // The parser saw the retirement…
    expect(isDeprecatedModelOn("zen", "retired-one")).toBe(true);
    expect(isDeprecatedModelOn("zen", "still-here")).toBe(false);

    // …and the merge honours it for a row the ADAPTER offers.
    const merged = mergeDiscoveredModels(
      [
        {
          contextWindow: 1,
          id: "retired-one",
          inputModalities: ["text"],
          maxTokens: 2,
          name: "Retired One",
        },
        {
          contextWindow: 1,
          id: "adapter-only",
          inputModalities: ["text"],
          maxTokens: 2,
          name: "Adapter Only",
        },
      ],
      "zen",
      []
    );
    const ids = merged.map((m) => m.id);
    expect(ids).not.toContain("retired-one");
    // A model the catalog does not describe is NOT dropped: absent-from-catalog
    // is not the same as retired, and an adapter's own row is still its answer.
    expect(ids).toContain("adapter-only");
  });

  it("keeps adapter rows, appends missing rows, and drops an empty id", () => {
    const merged = mergeDiscoveredModels(
      [
        {
          contextWindow: 1,
          id: "adapter-model",
          inputModalities: ["text"],
          maxTokens: 2,
          name: "Adapter Model",
        },
        { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Free" },
        { id: "", name: "Nameless" },
      ],
      "zen",
      [
        catalogRow("adapter-model", "Catalog Adapter Model"),
        catalogRow("space-bunny-free", "Space Bunny Free"),
      ]
    );

    // `muse-spark-1.2-contributor-free` is KEPT now: it answers on the zen plane
    // (measured `403 FreeTierError`), so it is not retired. It used to be dropped
    // here, which is one of the working models that went missing.
    expect(merged.map((model) => model.id)).toEqual([
      "adapter-model",
      "muse-spark-1.2-contributor-free",
      "space-bunny-free",
    ]);
    // The adapter’s own capacities win over the canonical catalog.
    expect(merged[0]).toEqual({
      contextWindow: 1,
      id: "adapter-model",
      inputModalities: ["text"],
      maxTokens: 2,
      name: "Adapter Model",
    });
  });

  it("does not retire Go’s paid Muse 1.2 contributor row", () => {
    const merged = mergeDiscoveredModels(
      [{ id: "muse-spark-1.2-contributor" }],
      "go",
      [catalogRow("space-bunny-free", "Space Bunny Free")]
    );

    expect(merged.map((model) => model.id)).toEqual([
      "muse-spark-1.2-contributor",
      "space-bunny-free",
    ]);
  });

  it("sanitizes candidate modalities to DSH-supported text and image only", () => {
    const merged = mergeDiscoveredModels(
      [
        {
          id: "adapter-multimodal",
          inputModalities: ["text", "image", "video", "audio", "pdf"],
        },
      ],
      "go",
      [
        catalogRow("catalog-multimodal", "Catalog Multimodal", [
          "text",
          "image",
          "video",
        ]),
      ]
    );

    expect(merged).toEqual([
      {
        id: "adapter-multimodal",
        inputModalities: ["text", "image"],
      },
      {
        contextWindow: 1000000,
        id: "catalog-multimodal",
        inputModalities: ["text", "image"],
        maxTokens: 131072,
        name: "Catalog Multimodal",
      },
    ]);
  });

  it("enriches candidate rows missing contextWindow or maxTokens from the catalog spec", () => {
    const merged = mergeDiscoveredModels(
      [
        {
          id: "minimax-m3",
          name: "MiniMax-M3",
        },
      ],
      "go",
      [
        {
          context_window: 1_000_000,
          id: "minimax-m3",
          input_modalities: ["text", "image"],
          max_output_tokens: 131_072,
          name: "MiniMax-M3",
          provider_npm: "@ai-sdk/anthropic",
          reasoning: true,
        },
      ]
    );

    expect(merged[0]).toEqual({
      contextWindow: 1_000_000,
      id: "minimax-m3",
      inputModalities: ["text", "image"],
      maxTokens: 131_072,
      name: "MiniMax-M3",
    });
  });
});

describe("decorateModelDiscovery", () => {
  it("leaves discovery alone when enrichment is disabled", () => {
    const original = async () => [{ id: "adapter-model" }];
    const ctx = {
      llm: { discoverModels: original },
    } as unknown as CordisContext;

    expect(
      decorateModelDiscovery(ctx, resolveConfig({ enrichModels: false }))
    ).toBe(undefined);
    expect(ctx.llm?.discoverModels).toBe(original);
  });

  it("leaves a non-extensible discovery service installed", () => {
    const original = async () => [{ id: "adapter-model" }];
    const ctx = {
      llm: Object.freeze({ discoverModels: original }),
    } as unknown as CordisContext;

    expect(decorateModelDiscovery(ctx, resolveConfig())).toBe(undefined);
    expect(ctx.llm?.discoverModels).toBe(original);
  });

  it("forwards adapter errors and unclaimed routes unchanged", async () => {
    const failure = new Error("boom");
    const original = vi.fn().mockRejectedValue(failure);
    const ctx = {
      llm: { discoverModels: original },
    } as unknown as CordisContext;
    const stop = decorateModelDiscovery(ctx, resolveConfig());
    const wrapped = ctx.llm?.discoverModels;
    expect(typeof wrapped).toBe("function");
    if (typeof wrapped !== "function") {
      throw new TypeError("discovery decorator was not installed");
    }

    await expect(wrapped("llm-pi-ai", { provider: "other" })).rejects.toBe(
      failure
    );
    expect(original).toHaveBeenCalledWith(
      "llm-pi-ai",
      { provider: "other" },
      undefined
    );
    stop?.();
    expect(ctx.llm?.discoverModels).toBe(original);
  });

  it("adds Space Bunny and keeps the 1.2 row the zen plane serves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("offline catalog test"))
    );
    const original = vi
      .fn()
      .mockResolvedValue([
        { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Free" },
      ]);
    const ctx = {
      llm: { discoverModels: original },
    } as unknown as CordisContext;
    const stop = decorateModelDiscovery(ctx, resolveConfig());
    const wrapped = ctx.llm?.discoverModels;
    expect(typeof wrapped).toBe("function");
    if (typeof wrapped !== "function") {
      throw new TypeError("discovery decorator was not installed");
    }

    const merged = (await wrapped("llm-pi-ai", {
      baseURL: "https://opencode.ai/zen/v1",
      provider: "opencode",
    })) as Array<{ id: string }>;
    const ids = merged.map((model) => model.id);
    expect(original).toHaveBeenCalledWith(
      "llm-pi-ai",
      { baseURL: "https://opencode.ai/zen/v1", provider: "opencode" },
      undefined
    );
    expect(ids).toContain("space-bunny-free");
    // Kept, not removed: it answers on zen (measured `403 FreeTierError`), so it
    // is not retired. Removing it was hiding a working model.
    expect(ids).toContain("muse-spark-1.2-contributor-free");
    stop?.();
    expect(ctx.llm?.discoverModels).toBe(original);
  });
});

describe("models-discovery: hiding the internal Responses route", () => {
  const hostWith = () => {
    const seen: string[] = [];
    const ctx = {
      llm: {
        listConfigurableProviders: () => [
          { provider: "opencode" },
          { provider: RESPONSES_ROUTE },
        ],
        listModels: async (provider: string) => {
          seen.push(provider);
          return [{ id: `${provider}-model` }];
        },
        listProviders: () => [
          { id: "opencode", name: "opencode" },
          { id: RESPONSES_ROUTE, name: RESPONSES_ROUTE },
        ],
      },
    } as unknown as CordisContext;
    return { ctx, seen };
  };

  it("removes the route from every listing a user sees", () => {
    // Three surfaces enumerate providers and there is no hidden flag on any of
    // them. `joinProviderDirectory` (Settings → Models) pushes a row for every
    // REGISTERED provider, so filtering only the configurable directory would
    // leave the route on screen — `listProviders` is the one that matters.
    const { ctx } = hostWith();
    const stop = hideResponsesRoute(ctx, resolveConfig());
    expect(stop).toBeDefined();

    expect(ctx.llm?.listProviders?.()).toEqual([
      { id: "opencode", name: "opencode" },
    ]);
    expect(ctx.llm?.listConfigurableProviders?.()).toEqual([
      { provider: "opencode" },
    ]);
  });

  it("still reports the route as registered, so the redirect fires", () => {
    // The redirect asks whether it has somewhere to go. Asked of the FILTERED
    // listing the answer would always be no and the re-dispatch would never
    // happen — which is why the check reads the original.
    const { ctx } = hostWith();
    const stop = hideResponsesRoute(ctx, resolveConfig());

    expect(isRouteRegistered(RESPONSES_ROUTE)).toBe(true);
    expect(ctx.llm?.listProviders?.()).toHaveLength(1);

    stop?.();
    expect(isRouteRegistered(RESPONSES_ROUTE)).toBe(true);
  });

  it("keeps servable models and empties the internal routes", async () => {
    // Filtering `listModels` is not about hiding the internal routes — nothing
    // reaches it for those. It is about what a user CAN pick: a model whose SDK
    // no route serves must not reach a listing they choose from. A model the
    // catalog does not know names no SDK, which is the route's own api.
    const { ctx, seen } = hostWith();
    const stop = hideResponsesRoute(ctx, resolveConfig());

    await expect(ctx.llm?.listModels?.(RESPONSES_ROUTE)).resolves.toEqual([]);
    // The parent route's list is now the JOIN: the adapter's own row first, then
    // every catalog row it lacks. Without that join the models living on the
    // hidden protocol routes (Responses / Messages / Google) were unreachable
    // from the picker — enumerating `opencode` returned the completions bucket
    // alone, so `gpt-5.4`, the Claude rows and the Gemini rows never appeared.
    const listed = (await ctx.llm?.listModels?.("opencode")) as Array<{
      id: string;
    }>;
    expect(Array.isArray(listed)).toBe(true);
    expect(listed[0]).toMatchObject({ id: "opencode-model" });
    // And the catalog's protocol-routed rows are present — one per internal
    // route, which is the whole point: Responses, Messages and Google models are
    // each mounted on a hidden route and were therefore unreachable from the
    // picker. Measured on the live catalog: 27 rows before the join, 87 after.
    const ids = listed.map((m) => m.id);
    expect(ids).toContain("gpt-5.4"); // opencode-responses  (@ai-sdk/openai)
    expect(ids).toContain("claude-sonnet-4-5"); // opencode-anthropic
    expect(ids.some((id) => id.startsWith("gemini-"))).toBe(true); // opencode-google
    expect(listed.length).toBeGreaterThan(1);
    expect(seen).toEqual(["opencode"]);

    stop?.();
    expect(ctx.llm?.listProviders?.()).toHaveLength(2);
  });

  it("lists EVERY servable catalog model on the parent route", async () => {
    // The contract the join exists for. The host's picker is
    // `listProviders()` × `listModels(id)`, and the adapter behind `opencode`
    // only carries its own protocol's models — so the parent route has to publish
    // the union, or the Responses / Messages / Google models are unreachable.
    // Measured on the live catalog: 27 rows before the join, 88 after.
    const { ctx } = hostWith();
    const stop = hideResponsesRoute(ctx, resolveConfig());

    const listed = (await ctx.llm?.listModels?.("opencode")) as Array<{
      id: string;
    }>;
    const ids = new Set(listed.map((m) => m.id));
    const expected = getLiveZenCatalog()
      .filter((m) => isServableModel(m.id, "opencode"))
      .map((m) => m.id);
    // Nothing servable is missing — that is the whole point.
    expect(expected.filter((id) => !ids.has(id))).toEqual([]);
    // And the list is the catalog's size, not the adapter's single fake row.
    expect(ids.size).toBeGreaterThanOrEqual(expected.length);

    stop?.();
  });

  it("degrades to a no-op when the Host exposes no listing at all", () => {
    const ctx = { llm: {} } as unknown as CordisContext;
    expect(hideResponsesRoute(ctx, resolveConfig())).toBeUndefined();
  });
});

describe("models-discovery: the unfiltered registry keeps its receiver", () => {
  it("asks the Host's listing with the service as `this`", () => {
    // The real `listProviders` reads its own state through `this`, so a method
    // read off the service and called detached runs with `this === undefined`
    // and surfaces as "Cannot read properties of undefined (reading 'adapters')"
    // — naming the registry's internals rather than the call that broke the
    // receiver. Every other test here uses an arrow, which cannot catch it.
    const registry = {
      adapters: new Map([["opencode", { id: "opencode" }]]),
      listProviders(this: { adapters: Map<string, unknown> }): unknown {
        return [...this.adapters.values()];
      },
    };
    const ctx = { llm: registry } as unknown as CordisContext;
    const stop = hideResponsesRoute(ctx, resolveConfig());
    expect(stop).toBeTypeOf("function");
    expect(isRouteRegistered("opencode")).toBe(true);
    expect(isRouteRegistered("opencode-responses")).toBe(false);
    stop?.();
  });
});

describe("models-discovery: I1's second clause, for a model no catalog describes", () => {
  it("offers a hand-listed model only where a route can serve it", () => {
    // `undefined` is the completions default, which is right for a model that
    // omits its SDK and wrong for one nobody has described. So the id is asked:
    // a family whose protocol this plane has no route for is not offered.
    // Measured: gemini-3.8-flash answers 400 on the Go plane's completions
    // endpoint, and that plane carries no google route.
    expect(isServableModel("gemini-3.8-flash", "opencode-go")).toBe(false);
    // The same model on the plane that DOES carry the route stays offered.
    expect(isServableModel("gemini-3.1-pro", "opencode")).toBe(true);
    // And a family the rule does not name is left alone, because a missing
    // catalog entry is not evidence of anything for it.
    expect(isServableModel("deepseek-v4.1-flash", "opencode-go")).toBe(true);
    expect(isServableModel("some-unknown-model", "opencode-go")).toBe(true);
  });

  it("keeps the catalog's own answer when there is one", () => {
    // A model the catalog describes is answered by its SDK, and the id rule is
    // never consulted - so this cannot change what already worked.
    expect(isServableModel("gemini-3.1-pro", "opencode")).toBe(true);
  });

  it("leaves an undeclared plane alone, so a Go-only deployment is not touched", () => {
    // The plane overrides are keyed on what the deployment DECLARES. Naming
    // `opencode-go` and not `opencode` means the Zen route keeps exactly the
    // behaviour it had, which is the difference between augmenting a route and
    // replacing the user's choice.
    expect(isServableModel("deepseek-v4.1-flash", "opencode", [])).toBe(true);
    // And a withhold on one plane says nothing about the other: the same id is
    // still offered where it is not named, because the knob is a list of ids
    // and not a per-plane decision.
    expect(
      isServableModel("deepseek-v4.1-flash", "opencode", ["big-pickle"])
    ).toBe(true);
  });

  it("withholds an id a deployment names, outranking every other rule", () => {
    // The deployment's own word about a model beats every rule this file
    // applies - including retention. A deprecated id the gateway still serves
    // but that misfires for a given account belongs in `hiddenModels`, because
    // the reason is the deployment's and not the vendor's.
    expect(
      isServableModel("deepseek-v4.1-flash", "opencode", [
        "deepseek-v4.1-flash",
      ])
    ).toBe(false);
    // And an empty list changes nothing.
    expect(isServableModel("deepseek-v4.1-flash", "opencode", [])).toBe(true);
  });

  it("refuses a model whose plane + SDK combination is declared unserved", () => {
    // gemini-4-argon-contributor is in the Go catalog with @ai-sdk/google,
    // but the Google bridge only mounts on Zen. UNSERVED_PLANE_SDKS marks
    // 'opencode-go + @ai-sdk/google' so it is not offered on Go.
    expect(isServableModel("gemini-4-argon-contributor", "opencode-go")).toBe(
      false
    );
  });

  it("offers Zen's free tier models normally", () => {
    expect(isServableModel("space-bunny-free", "opencode")).toBe(true);
    expect(isServableModel("space-bunny-free", "opencode")).toBe(true);
    expect(isServableModel("muse-spark-1.2-contributor-free", "opencode")).toBe(
      true
    );
  });

  it("still offers the Go plane's free models, because Go has no free tier", () => {
    expect(isServableModel("space-bunny-free", "opencode-go")).toBe(true);
    expect(isServableModel("beam-free", "opencode-go")).toBe(true);
    // And a paid Zen model is untouched by the free-tier rule.
    expect(isServableModel("deepseek-v4.1-flash", "opencode")).toBe(true);
  });
});

/**
 * The picker's Effort row. `buildModelCatalog` in the session controller calls
 * `ctx.llm.resolveModelInfo` per model and renders thinking-level choices only
 * from what comes back, so a plane route whose adapter reports no `reasoning`
 * shows the model with NO Effort row at all. These cases are that surface.
 */
describe("models-discovery: the adapter behind a plane route", () => {
  /**
   * A Host LLM service whose registry holds one adapter per route, as the real
   * registry does - `adapters` is a public `Map` keyed by route id.
   */
  const llmWithAdapters = (
    answer: (provider: string, model: string) => unknown
  ): { adapters: Map<string, { adapter: Record<string, unknown> }> } => {
    const adapters = new Map<string, { adapter: Record<string, unknown> }>();
    for (const route of ["opencode", "opencode-go"]) {
      const adapter: Record<string, unknown> = {
        resolveModel: async (provider: string, model: string) =>
          answer(provider, model),
      };
      adapters.set(route, { adapter });
    }
    return { adapters };
  };

  /** The adapter one route holds, with `resolveModel` typed for the call. */
  const resolveOn = (
    llm: { adapters: Map<string, { adapter: Record<string, unknown> }> },
    route: string
  ): ((provider: string, model: string) => Promise<unknown>) => {
    const adapter = llm.adapters.get(route)?.adapter;
    const fn = adapter?.resolveModel;
    if (typeof fn !== "function") {
      throw new TypeError(`no resolveModel on ${route}`);
    }
    return fn as (provider: string, model: string) => Promise<unknown>;
  };

  it("fills what the adapter left blank, so dispatch sees the model's reasoning", async () => {
    // The seam the modelOverrides attempt missed. `prepareCall` reads the
    // ADAPTER, not the public resolveModelInfo, and the plane route's adapter
    // resolves from pi's installed catalog - which carries no step-5 entry on
    // either plane. So it answers nothing about the model, and a saved effort
    // then fails validation with UNSUPPORTED_REASONING_EFFORT.
    const llm = llmWithAdapters(() => ({}));
    const stop = decoratePlaneAdapters(
      llm as never,
      resolveConfig({ enrichModels: true })
    );

    // The adapter answers an EMPTY record, exactly as pi's does for a model it
    // does not carry.
    const resolved = (await resolveOn(llm, "opencode-go")(
      "opencode-go",
      "cat-jam-free"
    )) as {
      id?: string;
      name?: string;
      context?: { contextWindow?: number };
      defaultMaxTokens?: number;
      reasoning?: { efforts: { id: string }[] };
    };

    // Everything dispatch validates against, filled from our catalog.
    expect(resolved.id).toBe("cat-jam-free");
    expect(resolved.name).toBeTruthy();
    expect(resolved.context?.contextWindow).toBeGreaterThan(0);
    expect(resolved.defaultMaxTokens).toBeGreaterThan(0);
    // And the levels the composer offers - so a saved `high` resolves rather
    // than being rejected. `cat-jam-free` declares five efforts, and the point is
    // that they come from OUR catalog rather than from the empty adapter answer.
    expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);

    stop?.();
  });

  it("keeps an adapter's own answer, because that is what dispatch honours", async () => {
    // A COMPLETE answer, because the wrapper fills only what is absent and an
    // identity field it adds is not it overriding anything.
    const own = {
      context: { contextWindow: 999 },
      defaultMaxTokens: 12345,
      id: "space-bunny-free",
      inputModalities: ["text"],
      name: "Its Own Name",
      provider: "opencode",
      reasoning: { efforts: [{ id: "high", name: "High" }] },
    };
    const llm = llmWithAdapters(() => own);
    const stop = decoratePlaneAdapters(
      llm as never,
      resolveConfig({ enrichModels: true })
    );
    const resolved = await resolveOn(llm, "opencode")(
      "opencode",
      "space-bunny-free"
    );
    expect(resolved).toEqual(own);
    stop?.();
  });

  it("applies modelOverrides in decoratePlaneAdapters when declared", async () => {
    const raw = {
      context: { contextWindow: 1_000_000 },
      defaultMaxTokens: 32_000,
      id: "gpt-5.4",
      name: "GPT-5.4",
    };
    const llm = llmWithAdapters(() => raw);
    const stop = decoratePlaneAdapters(
      llm as never,
      resolveConfig({
        enrichModels: true,
        modelOverrides: {
          "gpt-5.4": {
            contextWindow: 65_536,
            inputModalities: ["text"],
            maxTokens: 8_192,
            name: "GPT-5.4 Adapter Override",
            reasoningEfforts: ["none", "medium"],
          },
        },
      })
    );
    const resolved = (await resolveOn(llm, "opencode")(
      "opencode",
      "gpt-5.4"
    )) as {
      context?: { contextWindow?: number };
      defaultMaxTokens?: number;
      inputModalities?: string[];
      name?: string;
      reasoning?: { efforts: { id: string }[] };
    };
    expect(resolved.context?.contextWindow).toBe(65_536);
    expect(resolved.defaultMaxTokens).toBe(8_192);
    expect(resolved.name).toBe("GPT-5.4 Adapter Override");
    expect(resolved.inputModalities).toEqual(["text"]);
    expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual([
      "none",
      "medium",
    ]);
    stop?.();
  });

  it("restores the adapter's own methods on dispose", () => {
    const llm = llmWithAdapters(() => ({}));
    const before = llm.adapters.get("opencode-go")?.adapter.resolveModel;
    const stop = decoratePlaneAdapters(
      llm as never,
      resolveConfig({ enrichModels: true })
    );
    const after = llm.adapters.get("opencode-go")?.adapter.resolveModel;
    expect(after).not.toBe(before);
    stop?.();
    expect(llm.adapters.get("opencode-go")?.adapter.resolveModel).toBe(before);
  });

  it("calls the original on the adapter, because it is a class method that reads `this`", async () => {
    // The registry holds CLASS instances, not bags of arrows: pi-ai's real
    // `resolveModel` opens with `this.current()`. A wrapper that calls the
    // extracted method detached fails the provider's entire catalog load with
    // "Cannot read properties of undefined", which is the live symptom this
    // case exists for.
    class Adapter {
      calls = 0;
      async resolveModel(provider: string, model: string): Promise<unknown> {
        this.calls += 1;
        return { id: model, provider };
      }
    }
    const adapter = new Adapter();
    const llm = { adapters: new Map([["opencode-go", { adapter }]]) };
    const stop = decoratePlaneAdapters(
      llm as never,
      resolveConfig({ enrichModels: true })
    );

    const resolved = (await resolveOn(llm as never, "opencode-go")(
      "opencode-go",
      "cat-jam-free"
    )) as { context?: { contextWindow?: number } };

    // It ran ON the instance - the counter lives on `this` - and the wrapper
    // still filled the context pi does not carry.
    expect(adapter.calls).toBe(1);
    expect(resolved.context?.contextWindow).toBeGreaterThan(0);

    stop?.();
  });

  it("leaves another provider's adapter alone", () => {
    // Only the plane routes' adapters are this plugin's to replace; a foreign
    // adapter in the same registry keeps its methods, and the stand-down says
    // so by restoring nothing.
    const foreign: Record<string, unknown> = {
      resolveModel: async () => ({}),
    };
    const llm = { adapters: new Map([["commandcode", { adapter: foreign }]]) };
    const stop = decoratePlaneAdapters(
      llm as never,
      resolveConfig({ enrichModels: true })
    );

    expect(llm.adapters.get("commandcode")?.adapter.resolveModel).toBe(
      foreign.resolveModel
    );
    expect(stop).toBeUndefined();
  });

  it("withholds an id a deployment names, whatever the adapter answered", async () => {
    const llm = llmWithAdapters(() => ({}));
    const stop = decoratePlaneAdapters(
      llm as never,
      resolveConfig({
        enrichModels: true,
        hiddenModels: ["space-bunny-free"],
      })
    );
    const resolved = (await resolveOn(llm, "opencode-go")(
      "opencode-go",
      "space-bunny-free"
    )) as { reasoning?: unknown };
    // The deployment's word beats the catalog's.
    expect(resolved.reasoning).toBeUndefined();
    stop?.();
  });

  it("stands down when the host exposes no adapter registry", () => {
    expect(decoratePlaneAdapters({} as never, resolveConfig())).toBeUndefined();
    expect(
      decoratePlaneAdapters(undefined as never, resolveConfig())
    ).toBeUndefined();
  });
});

describe("models-discovery: the Effort row a model reports", () => {
  /** A minimal Host `llm` service whose `resolveModelInfo` answers per route. */
  const llmWith = (answer: (provider: string, model: string) => unknown) => ({
    llm: {
      resolveModelInfo: async (provider: string, model: string) =>
        answer(provider, model),
    },
  });

  const enrichConfig = resolveConfig({ enrichModels: true });
  const patched = (
    ctx: CordisContext
  ): ((...a: unknown[]) => Promise<unknown>) =>
    (ctx.llm as { resolveModelInfo: (...a: unknown[]) => Promise<unknown> })
      .resolveModelInfo;

  it("fills the reasoning a plane route's adapter does not report", async () => {
    const ctx = llmWith(() => ({
      id: "minimax-m3",
      name: "MiniMax-M3",
      provider: "opencode",
    })) as never as CordisContext;
    const stop = decorateModelInfo(ctx, enrichConfig);

    // The plane route is the user's own: it declares no models, so its adapter
    // answers straight from the installed catalog and reports no reasoning.
    const resolved = await patched(ctx)("opencode", "minimax-m3");
    expect(resolved).toMatchObject({
      context: { contextWindow: 512_000 },
      reasoning: { efforts: expect.any(Array) },
    });
    const { efforts } = (
      resolved as { reasoning: { efforts: { id: string; name: string }[] } }
    ).reasoning;
    expect(efforts.length).toBeGreaterThan(0);
    for (const effort of efforts) {
      expect(typeof effort.id).toBe("string");
      expect(typeof effort.name).toBe("string");
      // `off` is never offered: the map pins it to null, which is the
      // adapter's way of saying the model has no off switch.
      expect(effort.id).not.toBe("off");
    }

    stop?.();
  });

  it("leaves the internal routes alone, because their adapter is already right", async () => {
    const answer = (provider: string) => ({
      id: "minimax-m3",
      name: "MiniMax-M3",
      provider,
      reasoning: { efforts: [{ id: "high", name: "High" }] },
    });
    const ctx = llmWith(answer) as never as CordisContext;
    const stop = decorateModelInfo(ctx, enrichConfig);

    const resolved = await patched(ctx)("opencode-anthropic", "minimax-m3");
    // Unchanged: decorating our own route would risk disagreeing with dispatch.
    expect(resolved).toEqual(answer("opencode-anthropic"));

    stop?.();
  });

  it("overrides a STALE adapter answer with the catalog's fresher vintage", async () => {
    // The reason this overrides rather than fills. pi ships its own installed
    // `opencode` catalog the plane routes fall back to, and it is an older
    // snapshot of models.dev: gpt-5.4 at 272k where the vendor and our shim both
    // say 1.05M, claude-sonnet-4-5 at 200k with no thinking map where models.dev
    // declares 1M and a token minimum. Filling only what was BLANK let those
    // stale values survive, and the surfaces reported them.
    const stale = {
      context: { contextWindow: 272_000 },
      defaultMaxTokens: 64_000,
      id: "gpt-5.4",
      name: "GPT-5.4",
      provider: "opencode",
      // pi's stale map offers `medium`; ours says low/medium/high/xhigh.
      reasoning: {
        efforts: [
          { id: "off", name: "Off" },
          { id: "low", name: "Low" },
          { id: "medium", name: "Medium" },
        ],
      },
    };
    const ctx = llmWith(() => stale) as never as CordisContext;
    const stop = decorateModelInfo(ctx, enrichConfig);

    const resolved = (await patched(ctx)("opencode", "gpt-5.4")) as {
      context?: { contextWindow?: number };
      defaultMaxTokens?: number;
      reasoning?: { efforts: { id: string }[] };
    };
    // The window and the cap come from our catalog.
    expect(resolved.context).toEqual({ contextWindow: 1_050_000 });
    expect(resolved.defaultMaxTokens).toBe(128_000);
    // And so do the levels: `off` is not offered and `xhigh` now is.
    expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    // Everything the catalog does not decide is left as the adapter said it.
    expect(resolved).toMatchObject({ id: "gpt-5.4", name: "GPT-5.4" });

    stop?.();
  });

  it("leaves a model the catalog does not describe to its adapter", async () => {
    // The other half of the authority argument: our catalog decides the fields
    // IT carries, and a model it has never heard of is not ours to correct. A
    // hand-declared model in a deployment's profile keeps whatever its adapter
    // says, including a reasoning block this plugin knows nothing about.
    const own = {
      context: { contextWindow: 4096 },
      id: "hand-declared-model",
      name: "Hand Declared",
      provider: "opencode",
      reasoning: { efforts: [{ id: "high", name: "High" }] },
    };
    const ctx = llmWith(() => own) as never as CordisContext;
    const stop = decorateModelInfo(ctx, enrichConfig);

    const resolved = await patched(ctx)("opencode", "hand-declared-model");
    expect(resolved).toEqual(own);

    stop?.();
  });

  it("restores the original method on dispose, and only if it is still ours", () => {
    const before = async () => ({ id: "x" });
    const ctx = { llm: { resolveModelInfo: before } } as never as CordisContext;
    const stop = decorateModelInfo(ctx, enrichConfig);

    expect(patched(ctx)).not.toBe(before);
    stop?.();
    expect(patched(ctx)).toBe(before);
  });

  it("installs nothing when the plugin is not enriching models", () => {
    const before = async () => ({ id: "x" });
    const ctx = { llm: { resolveModelInfo: before } } as never as CordisContext;
    expect(
      decorateModelInfo(ctx, resolveConfig({ enrichModels: false }))
    ).toBeUndefined();
    expect(patched(ctx)).toBe(before);
  });

  it("clamps context window when a deployment maxContextWindow ceiling is configured", async () => {
    const original = { id: "gpt-5.4", name: "GPT-5.4" };
    const ctx = llmWith(() => original) as never as CordisContext;
    // Set deployment context ceiling to 131,072 tokens (clamping gpt-5.4 from 1,050,000)
    const customConfig = resolveConfig({
      enrichModels: true,
      maxContextWindow: 131_072,
    });
    const stop = decorateModelInfo(ctx, customConfig);

    const resolved = (await patched(ctx)("opencode", "gpt-5.4")) as {
      context?: { contextWindow?: number };
    };
    expect(resolved.context?.contextWindow).toBe(131_072);
    stop?.();
  });

  it("preserves custom properties on existing context objects", async () => {
    const withCustomContext = {
      context: { contextWindow: 65_536, reservedTokens: 4096 },
      id: "gpt-5.4",
      name: "GPT-5.4",
    };
    const ctx = llmWith(() => withCustomContext) as never as CordisContext;
    const stop = decorateModelInfo(ctx, enrichConfig);

    const resolved = (await patched(ctx)("opencode", "gpt-5.4")) as {
      context?: { contextWindow?: number; reservedTokens?: number };
    };
    // Canonical catalog spec for gpt-5.4 (1,050,000) overrides adapter context window,
    // while preserving custom fields on context (like reservedTokens).
    expect(resolved.context?.contextWindow).toBe(1_050_000);
    // Custom context property is preserved rather than wiped
    expect(resolved.context?.reservedTokens).toBe(4096);
    stop?.();
  });

  it("applies per-model configuration overrides for context window, caps, and metadata", async () => {
    const original = (_provider: string, model: string) => ({
      id: model,
      name: model === "gpt-5.4" ? "GPT-5.4" : "Claude Sonnet 4.5",
    });
    const ctx = llmWith(original) as never as CordisContext;
    const configWithOverrides = resolveConfig({
      enrichModels: true,
      modelOverrides: {
        "gpt-5.4": {
          contextWindow: 65_536,
          inputModalities: ["text"],
          maxTokens: 16_384,
          name: "GPT-5.4 Custom Name",
          reasoningEfforts: ["none", "high"],
        },
      },
    });
    const stop = decorateModelInfo(ctx, configWithOverrides);

    const resolved = (await patched(ctx)("opencode", "gpt-5.4")) as {
      context?: { contextWindow?: number };
      defaultMaxTokens?: number;
      inputModalities?: string[];
      name?: string;
      reasoning?: { efforts: { id: string; name: string }[] };
    };
    expect(resolved.context?.contextWindow).toBe(65_536);
    expect(resolved.defaultMaxTokens).toBe(16_384);
    expect(resolved.name).toBe("GPT-5.4 Custom Name");
    expect(resolved.inputModalities).toEqual(["text"]);
    expect(resolved.reasoning?.efforts).toEqual([
      { id: "none", name: "None" },
      { id: "high", name: "High" },
    ]);

    // Unrelated models keep their canonical specs
    const sonnet = (await patched(ctx)("opencode", "claude-sonnet-4-5")) as {
      context?: { contextWindow?: number };
      name?: string;
    };
    expect(sonnet.context?.contextWindow).toBe(1_000_000);
    expect(sonnet.name).toBe("Claude Sonnet 4.5");

    stop?.();
  });
});

describe("models-discovery: resolveEffectiveContextWindow", () => {
  it("returns canonical window when neither requested window nor ceiling is set", () => {
    expect(resolveEffectiveContextWindow(1_050_000)).toBe(1_050_000);
    expect(resolveEffectiveContextWindow(200_000)).toBe(200_000);
  });

  it("clamps requested window to canonical window if requested exceeds physical capability", () => {
    // If user/caller requests 2,000,000 tokens on a 1,050,000 model, it clamps to physical limit
    expect(resolveEffectiveContextWindow(1_050_000, 2_000_000)).toBe(1_050_000);
  });

  it("honors lower requested window when below canonical limit", () => {
    // If user tunes context down to 64,000 tokens on a 1M model, it uses 64,000
    expect(resolveEffectiveContextWindow(1_050_000, 64_000)).toBe(64_000);
  });

  it("clamps to maxCeiling when deployment ceiling is configured", () => {
    // If deployment configures ceiling of 262,144 tokens, it clamps 1,050,000 down to 262,144
    expect(resolveEffectiveContextWindow(1_050_000, undefined, 262_144)).toBe(
      262_144
    );
    // If both requested and ceiling exist, it takes the lowest
    expect(resolveEffectiveContextWindow(1_050_000, 100_000, 262_144)).toBe(
      100_000
    );
    expect(resolveEffectiveContextWindow(1_050_000, 500_000, 262_144)).toBe(
      262_144
    );
  });

  it("ignores invalid, non-positive or non-finite values", () => {
    expect(resolveEffectiveContextWindow(1_050_000, -100, "invalid")).toBe(
      1_050_000
    );
    expect(resolveEffectiveContextWindow(1_050_000, 0, null)).toBe(1_050_000);
    expect(
      resolveEffectiveContextWindow(
        1_050_000,
        Number.NaN,
        Number.POSITIVE_INFINITY
      )
    ).toBe(1_050_000);
  });
});
