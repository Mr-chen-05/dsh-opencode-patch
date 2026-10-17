/**
 * The picker, assembled the way the Host assembles it.
 *
 * Every other suite tests one decorator. This one runs the decorators TOGETHER and
 * then builds a model list the way `buildModelCatalog` does, because the bugs that
 * cost the most rounds were not in any single decorator — they were in the seam:
 *
 * - the picker is `listProviders()` × `listModels(id)`, and the internal protocol
 *   routes are hidden from the first while carrying most of the models, so nothing
 *   joined them back (27 of 88 models were reachable);
 * - the Host builds a provider's group with `Promise.all`, caught per PROVIDER, so
 *   one unresolvable model removed every model on the route.
 *
 * The Host's shape is copied from
 * `@deepseek-ai/dsh-api-session-controller/lib/types/catalog.js`, which is not a
 * dependency of this package, so it is reproduced rather than imported:
 *
 * ```js
 * const providers = ctx.llm.listProviders();
 * const catalog = await Promise.all(providers.map(async (provider) => {
 *   const models = await ctx.llm.listModels(provider.id);
 *   const entries = await Promise.all(models.map(async (model) => {
 *     const resolved = await ctx.llm.resolveModelInfo(provider.id, model.id);
 *     return { id: model.id, name: model.name, reasoning: resolved.reasoning };
 *   }));
 *   return { group: provider.id, entries };
 * }));
 * ```
 *
 * @module test/picker-integration.test
 */

import { describe, expect, it } from "vitest";

import {
  decorateModelInfo,
  getLiveGoCatalog,
  getLiveZenCatalog,
  hideResponsesRoute,
  resolveConfig,
  type CordisContext,
} from "../src/index.ts";

/** What the adapter behind a parent route carries: its own protocol's models. */
const adapterBucket = (
  catalog: readonly { id: string; provider_npm?: string }[]
): { id: string; name: string }[] =>
  catalog
    .filter((model) => model.provider_npm === undefined)
    .map((model) => ({ id: model.id, name: model.id }));

/**
 * A Host `llm` registry shaped like the real one.
 *
 * `resolveModelInfo` REFUSES any id its own bucket does not carry, which is what an
 * adapter backed by an installed catalog does — and is the case that used to take
 * the whole group down.
 */
const hostRegistry = (bucket: readonly { id: string; name: string }[]) => {
  const adapters = new Map([
    ["opencode", { adapter: {} }],
    ["opencode-go", { adapter: {} }],
    ["opencode-responses", { adapter: {} }],
    ["opencode-anthropic", { adapter: {} }],
    ["opencode-google", { adapter: {} }],
    ["opencode-go-responses", { adapter: {} }],
    ["opencode-go-anthropic", { adapter: {} }],
  ]);
  const known = new Set(bucket.map((model) => model.id));
  return {
    adapters,
    listConfigurableProviders: () => [{ provider: "opencode" }],
    listModels: async (provider: string) =>
      provider === "opencode" ? bucket : [],
    listProviders: () => [...adapters.keys()].map((id) => ({ id, name: id })),
    resolveModelInfo: async (provider: string, model: string) => {
      if (!known.has(model)) {
        throw new Error(`unknown model ${model}`);
      }
      return { id: model, name: model, provider };
    },
  };
};

/** The Host's `buildModelCatalog`, minus the parts this package does not affect. */
const buildModelCatalog = async (llm: {
  listProviders: () => { id: string; name: string }[];
  listModels: (provider: string) => Promise<{ id: string; name: string }[]>;
  resolveModelInfo: (provider: string, model: string) => Promise<unknown>;
}) => {
  const providers = llm.listProviders();
  return Promise.all(
    providers.map(async (provider) => {
      try {
        const models = await llm.listModels(provider.id);
        const entries = await Promise.all(
          models.map(async (model) => {
            const resolved = (await llm.resolveModelInfo(
              provider.id,
              model.id
            )) as { reasoning?: unknown };
            // The Host reads this immediately. An `undefined` answer is a
            // TypeError here, and the catch below turns it into a lost group.
            return {
              id: model.id,
              name: model.name,
              reasoning: resolved.reasoning,
            };
          })
        );
        return { entries, group: provider.id, kind: "group" as const };
      } catch (error) {
        return {
          error: String(error),
          group: provider.id,
          kind: "failure" as const,
        };
      }
    })
  );
};

describe("picker integration: the Host's own assembly", () => {
  const config = resolveConfig({ enrichModels: true });

  it("publishes the whole Zen catalog under `opencode`, with no failed group", async () => {
    const zen = getLiveZenCatalog();
    const registry = hostRegistry(adapterBucket(zen));
    const ctx = { llm: registry } as never as CordisContext;

    const stopHide = hideResponsesRoute(ctx, config);
    const stopInfo = decorateModelInfo(ctx, config);
    try {
      const groups = await buildModelCatalog(
        registry as never as Parameters<typeof buildModelCatalog>[0]
      );

      // Nothing failed. A `failure` here is the whole route vanishing from the
      // composer, which is what one unresolvable model used to cause.
      const failed = groups.filter((group) => group.kind === "failure");
      expect(failed).toEqual([]);

      const opencode = groups.find((group) => group.group === "opencode");
      expect(opencode?.kind).toBe("group");
      if (opencode?.kind !== "group") {
        throw new TypeError("opencode group missing");
      }

      // The adapter alone carries only the completions bucket; the group must be
      // the catalog. Measured on the live catalog: 27 before the join, 88 after.
      expect(opencode.entries.length).toBeGreaterThan(80);
      const ids = new Set(opencode.entries.map((entry) => entry.id));
      // One per internal protocol, which is what the join exists to publish.
      expect(ids).toContain("gpt-5.4");
      expect(ids).toContain("claude-sonnet-4-5");
      expect(ids.has("gemini-3.8-flash")).toBe(true);

      // And the internal routes themselves stay out of the picker.
      expect(groups.map((group) => group.group)).not.toContain(
        "opencode-responses"
      );
      expect(groups.map((group) => group.group)).not.toContain(
        "opencode-anthropic"
      );
      expect(groups.map((group) => group.group)).not.toContain(
        "opencode-google"
      );
    } finally {
      stopInfo?.();
      stopHide?.();
    }
  });

  it("keeps the Go group alive when its adapter refuses every catalog id", async () => {
    // The Go route's adapter carries its own bucket, and the join publishes the Go
    // catalog on it — so most ids are unknown to it. Every one of those must be
    // answered from the catalog rather than raising.
    const go = getLiveGoCatalog();
    const registry = hostRegistry(adapterBucket(go));
    const ctx = { llm: registry } as never as CordisContext;

    const stopHide = hideResponsesRoute(ctx, config);
    const stopInfo = decorateModelInfo(ctx, config);
    try {
      const groups = await buildModelCatalog(
        registry as never as Parameters<typeof buildModelCatalog>[0]
      );
      expect(groups.filter((group) => group.kind === "failure")).toEqual([]);
      const goGroup = groups.find((group) => group.group === "opencode-go");
      if (goGroup?.kind !== "group") {
        throw new TypeError("opencode-go group missing");
      }
      expect(goGroup.entries.length).toBeGreaterThan(20);
    } finally {
      stopInfo?.();
      stopHide?.();
    }
  });
});
