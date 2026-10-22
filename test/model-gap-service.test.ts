/**
 * The catalog gap: what the vendor offers minus what the profile declares, and
 * the one write that closes it.
 *
 * The catalog is seeded through the parser rather than a second fixture list, for
 * the same reason the purge tests do it: "active" and "retired" are the parser's
 * verdict, and a hand-written list would let these tests agree with a bug.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  declaredRowFor,
  declaredRoutes,
  ModelGapService,
} from "../src/model-gap-service.ts";
import { parseModelsDevCatalog } from "../src/models-catalog.ts";
import { createMockContext } from "./test-helpers.ts";

/** A registry reply with two live free models and one retired id per plane. */
const registry = () => ({
  opencode: {
    api: "https://opencode.ai/zen/v1",
    models: {
      "glm-5.3-flash-free": {
        cost: { cache_read: 0, input: 0, output: 0 },
        id: "glm-5.3-flash-free",
        limit: { context: 200_000, output: 32_000 },
        modalities: { input: ["text", "image"] },
        name: "GLM-5.3-Flash Free",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
      },
      "mimo-v2.6-flash-free": {
        cost: { input: 0, output: 0 },
        limit: { context: 200_000, output: 32_000 },
        name: "MiMo-V2.6-Flash Free",
      },
      "paid-model": {
        cost: { input: 1, output: 2 },
        limit: { context: 1_000_000, output: 64_000 },
        name: "Paid Model",
      },
      "gone-free": { name: "Gone", status: "deprecated" },
    },
  },
  "opencode-go": {
    models: {
      "go-free": {
        cost: { input: 0, output: 0 },
        limit: { context: 262_144, output: 65_536 },
        name: "Go Free",
      },
    },
  },
});

const answersRegistry = () => {
  vi.stubGlobal("fetch", () =>
    Promise.resolve({ json: async () => registry(), ok: true })
  );
};

/** The parser is what makes `gone-free` absent; seed it the way the host does. */
const seedCatalog = () => {
  answersRegistry();
  parseModelsDevCatalog(registry());
};

/** A context whose `configEditor` holds one entry declaring both routes. */
const ctxWith = (models: { zen?: unknown[]; go?: unknown[] }) => {
  const entry = {
    options: {
      config: {
        providers: {
          opencode: { models: models.zen ?? [] },
          "opencode-go": { models: models.go ?? [] },
        },
      },
    },
  };
  const edits: unknown[] = [];
  const ctx = {
    get: (name: string) =>
      name === "configEditor"
        ? {
            edit: async (
              target: unknown,
              change: (
                current: Record<string, unknown>
              ) => Record<string, unknown>
            ) => {
              const current = (target as { options: { config: unknown } })
                .options.config as Record<string, unknown>;
              const next = change(current);
              edits.push(next);
              (target as { options: { config: unknown } }).options.config =
                next;
              return next;
            },
            entries: () => [entry],
          }
        : undefined,
    reflect: { provide: () => () => {} },
  };
  return { ctx: ctx as never, edits };
};

/** The models one recorded edit left on a route's declaration. */
const declaredIn = (edit: unknown, route: string): unknown[] => {
  const { providers } = edit as { providers: Record<string, unknown> };
  const { models } = providers[route] as { models: unknown[] };
  return models;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("model-gap-service: reading the gap", () => {
  it("lists the catalog models the profile does not declare, free first", async () => {
    seedCatalog();
    const { ctx } = ctxWith({ zen: [{ id: "mimo-v2.6-flash-free" }] });
    const report = await new ModelGapService(ctx).gap();
    const zen = report.planes.find((plane) => plane.route === "opencode");
    expect(zen?.declared).toEqual(["mimo-v2.6-flash-free"]);
    const ids = zen?.missing.map((entry) => entry.id) ?? [];
    expect(ids).toContain("glm-5.3-flash-free");
    expect(ids).toContain("paid-model");
    // The declared model is not missing, and the retired one is not offered.
    expect(ids).not.toContain("mimo-v2.6-flash-free");
    expect(ids).not.toContain("gone-free");
    // Free first: whatever the id order, a free model leads a paid one.
    const firstPaid = zen?.missing.findIndex((entry) => !entry.free) ?? -1;
    const lastFree = (zen?.missing ?? [])
      .map((entry) => entry.free)
      .lastIndexOf(true);
    expect(lastFree).toBeLessThan(firstPaid);
  });

  it("reports the catalog as read when the registry answered", async () => {
    seedCatalog();
    const { ctx } = ctxWith({});
    const report = await new ModelGapService(ctx).gap();
    expect(report.catalogRead).toBe(true);
  });

  it("reports the catalog as unread when the registry did not answer", async () => {
    // The distinction the card needs: "nothing is missing" and "nothing could be
    // compared" are different answers, and a cold start makes the second ordinary.
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    const { ctx } = ctxWith({});
    const report = await new ModelGapService(ctx).gap();
    expect(report.catalogRead).toBe(false);
  });

  it("treats a route with no declaration as declaring nothing", async () => {
    seedCatalog();
    const { ctx } = ctxWith({});
    const report = await new ModelGapService(ctx).gap();
    const zen = report.planes.find((plane) => plane.route === "opencode");
    expect(zen?.declared).toEqual([]);
    expect((zen?.missing.length ?? 0) > 0).toBe(true);
  });
});

describe("model-gap-service: closing the gap", () => {
  it("appends the catalog row, with the fields the adapter dispatches on", async () => {
    seedCatalog();
    const { ctx, edits } = ctxWith({ zen: [{ id: "mimo-v2.6-flash-free" }] });
    const result = await new ModelGapService(ctx).declare({
      ids: ["glm-5.3-flash-free"],
      route: "opencode",
    });
    expect(result).toEqual({
      added: ["glm-5.3-flash-free"],
      route: "opencode",
    });
    expect(edits).toHaveLength(1);
    const models = declaredIn(edits[0], "opencode");
    expect(models).toHaveLength(2);
    expect(models[1]).toMatchObject({
      contextWindow: 200_000,
      id: "glm-5.3-flash-free",
      maxTokens: 32_000,
      name: "GLM-5.3-Flash Free",
    });
  });

  it("drops ids it cannot serve rather than declaring them blind", async () => {
    // A declaration the adapter cannot serve is worse than an absent one: it
    // appears in the picker and fails on the first turn.
    seedCatalog();
    const { ctx, edits } = ctxWith({ zen: [] });
    const result = await new ModelGapService(ctx).declare({
      ids: ["not-in-the-catalog"],
      route: "opencode",
    });
    expect(result.added).toEqual([]);
    expect(declaredIn(edits[0], "opencode")).toEqual([]);
  });

  it("does not declare a model twice", async () => {
    seedCatalog();
    const { ctx, edits } = ctxWith({
      zen: [{ id: "glm-5.3-flash-free" }],
    });
    const result = await new ModelGapService(ctx).declare({
      ids: ["glm-5.3-flash-free"],
      route: "opencode",
    });
    expect(result.added).toEqual([]);
    expect(declaredIn(edits[0], "opencode")).toHaveLength(1);
  });

  it("refuses a route this plugin does not declare", async () => {
    seedCatalog();
    const { ctx } = ctxWith({});
    await expect(
      new ModelGapService(ctx).declare({
        ids: ["glm-5.3-flash-free"],
        route: "nvidia",
      })
    ).rejects.toThrow(/not a route this plugin declares/u);
  });

  it("refuses when the composition has no config editor", async () => {
    seedCatalog();
    await expect(
      new ModelGapService(createMockContext()).declare({
        ids: ["glm-5.3-flash-free"],
        route: "opencode",
      })
    ).rejects.toThrow(/no config editor/u);
  });
});

describe("model-gap-service: one declared row", () => {
  it("carries the window, the token cap and the modalities", () => {
    const row = declaredRowFor({
      context_window: 200_000,
      id: "glm-5.3-flash-free",
      input_modalities: ["text", "image"],
      max_output_tokens: 32_000,
      name: "GLM-5.3-Flash Free",
      reasoning: true,
      reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
    });
    expect(row).toMatchObject({
      contextWindow: 200_000,
      id: "glm-5.3-flash-free",
      input: ["text", "image"],
      maxTokens: 32_000,
    });
    expect(row.reasoningEfforts).toEqual({
      low: "low",
      high: "high",
      max: "max",
    });
  });

  it("omits reasoningEfforts for a model that declares no reasoning", () => {
    const row = declaredRowFor({
      context_window: 1_000,
      id: "plain",
      input_modalities: ["text"],
      max_output_tokens: 100,
      name: "Plain",
    });
    expect(row).not.toHaveProperty("reasoningEfforts");
  });

  it("writes no null level as an allowed one", () => {
    // `null` in the thinking map means "this model has no such level"; writing it
    // as an allowed level offers a control the model rejects.
    const row = declaredRowFor({
      context_window: 1_000,
      id: "toggled",
      input_modalities: ["text"],
      max_output_tokens: 100,
      name: "Toggled",
      reasoning: true,
      reasoning_options: [{ type: "toggle" }],
    });
    const efforts = row.reasoningEfforts as Record<string, string> | undefined;
    expect(efforts).toBeDefined();
    expect(Object.values(efforts ?? {})).not.toContain(null);
  });
});

describe("model-gap-service: reading the declaration", () => {
  it("answers an empty map for anything that is not a config editor", () => {
    expect(declaredRoutes(null).size).toBe(0);
    expect(declaredRoutes("not an editor").size).toBe(0);
    expect(declaredRoutes({ entries: () => [] }).size).toBe(0);
  });

  it("treats every half-filled entry shape as declaring nothing", () => {
    // Each of these is a row the settings UI can hold before it is filled in. A
    // throw here would take the whole gap away for one malformed row.
    const shapes = [
      null,
      "entry",
      { options: "not an object" },
      { options: { config: 7 } },
      { options: { config: { providers: "not an object" } } },
    ];
    expect(declaredRoutes({ entries: () => shapes }).size).toBe(0);
  });

  it("reads the ids a filled entry declares, and skips bare-string rows", () => {
    const editor = {
      edit: async () => null,
      entries: () => [
        {
          options: {
            config: {
              providers: {
                "opencode-go": { models: ["bare-id"] },
                opencode: { models: [{ id: "row-id" }, 42, { name: "no id" }] },
              },
            },
          },
        },
      ],
    };
    const declared = declaredRoutes(editor);
    expect(declared.get("opencode")).toEqual(["row-id"]);
    expect(declared.get("opencode-go")).toEqual(["bare-id"]);
  });
});

describe("model-gap-service: declare's input guards", () => {
  it("refuses a call with no query at all", async () => {
    seedCatalog();
    const { ctx } = ctxWith({});
    await expect(new ModelGapService(ctx).declare()).rejects.toThrow(
      /not a route this plugin declares/u
    );
  });

  it("treats a non-array ids field as nothing to add", async () => {
    seedCatalog();
    const { ctx, edits } = ctxWith({ zen: [] });
    const result = await new ModelGapService(ctx).declare({
      ids: "glm-5.3-flash-free",
      route: "opencode",
    });
    expect(result.added).toEqual([]);
    expect(declaredIn(edits[0], "opencode")).toEqual([]);
  });

  it("skips a non-string id rather than failing the whole call", async () => {
    seedCatalog();
    const { ctx } = ctxWith({ zen: [] });
    const result = await new ModelGapService(ctx).declare({
      ids: [42, "glm-5.3-flash-free"],
      route: "opencode",
    });
    expect(result.added).toEqual(["glm-5.3-flash-free"]);
  });

  it("does nothing when no entry declares the route", async () => {
    seedCatalog();
    const ctx = {
      get: (name: string) =>
        name === "configEditor"
          ? { edit: async () => null, entries: () => [] }
          : undefined,
      reflect: { provide: () => () => {} },
    } as never;
    const result = await new ModelGapService(ctx).declare({
      ids: ["glm-5.3-flash-free"],
      route: "opencode",
    });
    expect(result.added).toEqual([]);
  });
});

describe("model-gap-service: one declared row", () => {
  it("offers the standard levels when a reasoning model names none", () => {
    // The same fallback `thinkingLevelMapFor` makes for the adapter: a model that
    // says it reasons without saying how still gets the thinking controls.
    const row = declaredRowFor({
      context_window: 1_000,
      id: "unspecified",
      input_modalities: ["text"],
      max_output_tokens: 100,
      name: "Unspecified",
      reasoning: true,
    });
    expect(row.reasoningEfforts).toEqual({
      high: "high",
      low: "low",
      medium: "medium",
    });
  });
});

describe("model-gap-service: declaring onto an awkward profile", () => {
  /** A context whose editor holds exactly the entries given. */
  const ctxOf = (entries: unknown[]) => {
    const edits: unknown[] = [];
    const ctx = {
      get: (name: string) =>
        name === "configEditor"
          ? {
              edit: async (
                target: unknown,
                change: (
                  current: Record<string, unknown>
                ) => Record<string, unknown>
              ) => {
                const holder = target as { options: { config: unknown } };
                const current = holder.options.config as Record<
                  string,
                  unknown
                >;
                const next = change(current);
                edits.push(next);
                holder.options.config = next;
                return next;
              },
              entries: () => entries,
            }
          : undefined,
      reflect: { provide: () => () => {} },
    } as never;
    return { ctx, edits };
  };

  it("creates a route block that the profile does not carry yet", async () => {
    seedCatalog();
    const entry = { options: { config: { providers: { nvidia: {} } } } };
    const { ctx, edits } = ctxOf([entry]);
    const result = await new ModelGapService(ctx).declare({
      ids: ["glm-5.3-flash-free"],
      route: "opencode",
    });
    expect(result.added).toEqual(["glm-5.3-flash-free"]);
    expect(declaredIn(edits[0], "opencode")).toHaveLength(1);
  });

  it("replaces a route block that is not an object", async () => {
    seedCatalog();
    const entry = { options: { config: { providers: { opencode: true } } } };
    const { ctx, edits } = ctxOf([entry]);
    const result = await new ModelGapService(ctx).declare({
      ids: ["glm-5.3-flash-free"],
      route: "opencode",
    });
    expect(result.added).toEqual(["glm-5.3-flash-free"]);
    expect(declaredIn(edits[0], "opencode")).toHaveLength(1);
  });

  it("starts a providers map that the config does not carry", async () => {
    seedCatalog();
    const entry = { options: { config: { providers: "junk" } } };
    const { ctx } = ctxOf([entry]);
    const result = await new ModelGapService(ctx).declare({
      ids: ["glm-5.3-flash-free"],
      route: "opencode",
    });
    // `providers` is not a record, so there is no entry this call can rewrite —
    // and saying "added nothing" is the honest answer.
    expect(result.added).toEqual([]);
  });

  it("skips an entry with no providers at all and uses the next one", async () => {
    seedCatalog();
    const empty = { options: { config: {} } };
    const filled = { options: { config: { providers: { opencode: {} } } } };
    const { ctx, edits } = ctxOf([empty, filled]);
    const result = await new ModelGapService(ctx).declare({
      ids: ["glm-5.3-flash-free"],
      route: "opencode",
    });
    expect(result.added).toEqual(["glm-5.3-flash-free"]);
    expect(edits).toHaveLength(1);
  });
});
