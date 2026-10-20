/**
 * The purge action: it deletes the deployment's own declaration entries, and it
 * says which of the several ways it can refuse happened.
 *
 * The catalog is the only source of "retired" — `extractSpecs` records a
 * `status: "deprecated"` id and drops it from the active set — so these tests
 * seed the module through the parser rather than inventing a second list.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseModelsDevCatalog } from "../src/models-catalog.ts";
import { ModelPurgeService } from "../src/purge-service.ts";
import { createMockContext } from "./test-helpers.ts";

/** A registry reply with one retired id per plane and one live id beside it. */
const registry = () => ({
  opencode: {
    models: {
      "fledge-alpha-free": { status: "deprecated" },
      "mimo-v2.6-flash-free": { name: "MiMo", limit: { context: 200_000 } },
    },
  },
  "opencode-go": {
    models: {
      "step-5-preview-free": { status: "deprecated" },
      "deepseek-v4.1-flash": { name: "DeepSeek", limit: { context: 200_000 } },
    },
  },
});

/** A fetch that answers the registry, for `refreshCatalog` to land on. */
const answersRegistry = () => {
  vi.stubGlobal("fetch", () =>
    Promise.resolve({ json: async () => registry(), ok: true })
  );
};

/** A config editor holding one entry that declares both opencode routes. */
const editorWith = (models: {
  zen: readonly { id: string }[];
  go: readonly { id: string }[];
}) => {
  const entry = {
    options: {
      config: {
        providers: {
          opencode: { api: "openai-completions", models: [...models.zen] },
          "opencode-go": { api: "openai-completions", models: [...models.go] },
        },
      },
      id: "llm-pi-ai",
    },
  };
  const edit = vi.fn(
    async (
      _entry: unknown,
      change: (current: Record<string, unknown>) => Record<string, unknown>
    ) => {
      const current = (entry.options.config ?? {}) as Record<string, unknown>;
      entry.options.config = change(current) as typeof entry.options.config;
    }
  );
  return { edit, entries: () => [entry], entry };
};

/** A Cordis-shaped context: the Remote base needs `reflect`, the service `get`. */
const ctxWith = (editor: unknown) =>
  ({
    ...(createMockContext() as object),
    get: (name: string) => (name === "configEditor" ? editor : undefined),
  }) as never;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("purge: deleting what the catalog retired", () => {
  it("removes the retired ids and leaves every live one", async () => {
    parseModelsDevCatalog(registry());
    answersRegistry();
    const editor = editorWith({
      zen: [{ id: "fledge-alpha-free" }, { id: "mimo-v2.6-flash-free" }],
      go: [{ id: "step-5-preview-free" }, { id: "deepseek-v4.1-flash" }],
    });

    const result = await new ModelPurgeService(ctxWith(editor)).purge();

    expect(result.removed).toEqual([
      { id: "fledge-alpha-free", provider: "opencode" },
      { id: "step-5-preview-free", provider: "opencode-go" },
    ]);
    const written = editor.entry.options.config.providers;
    expect(written.opencode.models).toEqual([{ id: "mimo-v2.6-flash-free" }]);
    expect(written["opencode-go"].models).toEqual([
      { id: "deepseek-v4.1-flash" },
    ]);
    expect(result.catalogRead).toBe(true);
  });

  it("writes nothing when the deployment declares no retired model", async () => {
    parseModelsDevCatalog(registry());
    answersRegistry();
    const editor = editorWith({
      zen: [{ id: "mimo-v2.6-flash-free" }],
      go: [{ id: "deepseek-v4.1-flash" }],
    });

    const result = await new ModelPurgeService(ctxWith(editor)).purge();

    expect(result.removed).toEqual([]);
    expect(editor.entry.options.config.providers.opencode.models).toEqual([
      { id: "mimo-v2.6-flash-free" },
    ]);
  });
});

describe("purge: the refusals it can report", () => {
  it("refuses when the composition has no config editor", async () => {
    const service = new ModelPurgeService(ctxWith(undefined as never));
    await expect(service.purge()).rejects.toMatchObject({
      code: "opencode/purge-unavailable",
    });
  });

  it("refuses when no entry declares an opencode provider", async () => {
    const service = new ModelPurgeService(
      ctxWith({
        edit: vi.fn(),
        entries: () => [{ options: { config: {}, id: "something-else" } }],
      })
    );
    await expect(service.purge()).rejects.toMatchObject({
      code: "opencode/purge-unavailable",
    });
  });

  it("reports a catalog it could not read, instead of 'nothing retired'", async () => {
    // A fresh module has never parsed a registry, so `isCatalogFresh()` is false
    // and the answer must say so — the empty removal list alone cannot.
    vi.resetModules();
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    const { ModelPurgeService: Fresh } =
      await import("../src/purge-service.ts");
    const editor = editorWith({
      zen: [{ id: "mimo-v2.6-flash-free" }],
      go: [],
    });

    const result = await new Fresh(ctxWith(editor)).purge();

    expect(result.catalogRead).toBe(false);
    expect(result.removed).toEqual([]);
  });
  it("reports nothing when the edit was rejected", async () => {
    // `configEditor.edit` throws after the change has been computed — "Profile
    // patch must be a YAML sequence" on a damaged document, "Configuration
    // entry is no longer available" after a reload. Pushing into `removed` from
    // inside the callback meant those ids were reported as purged for an edit
    // that never landed.
    answersRegistry();
    const { entry } = editorWith({ zen: [{ id: "ll-alpha-free" }], go: [] });
    const editor = {
      edit: vi.fn(() =>
        Promise.reject(new Error("Profile patch must be a YAML sequence"))
      ),
      entries: () => [entry],
    };
    const service = new ModelPurgeService(
      ctxWith(editor as unknown as Parameters<typeof ctxWith>[0])
    );
    await expect(service.purge()).rejects.toThrow(/YAML sequence/u);
    // The edit was ATTEMPTED (so the decision was made) and then rejected: the
    // ids that decision named must not be reported as purged.
    expect(editor.edit).toHaveBeenCalledTimes(1);
  });

  it("does not inherit an EARLIER refresh's success when this one fails", async () => {
    // The defect this replaces: `catalogRead` read `isCatalogFresh()`, which
    // advances only on success and so stays true for hours. A process that
    // refreshed fine this morning and is offline now reported `catalogRead:
    // true` — telling the card "nothing is deprecated" about a read that never
    // happened. `refreshCatalog` never rejects, so its promise resolving is no
    // evidence either; only the per-attempt flag is.
    vi.resetModules();
    const mod = await import("../src/models-catalog.ts");
    // A successful refresh first...
    vi.stubGlobal("fetch", () => Promise.resolve(Response.json(registry())));
    await mod.refreshCatalog(undefined, true);
    expect(mod.isCatalogFresh()).toBe(true);
    // ...then the network goes away, and a purge must say so.
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    const { ModelPurgeService: Live } = await import("../src/purge-service.ts");
    const result = await new Live(
      ctxWith(editorWith({ zen: [{ id: "mimo-v2.6-flash-free" }], go: [] }))
    ).purge();
    expect(result.catalogRead).toBe(false);
  });
});

describe("purge: the shapes a profile row can take", () => {
  it("skips a provider block with no models and a row with no id", async () => {
    parseModelsDevCatalog(registry());
    answersRegistry();
    const entry = {
      options: {
        config: {
          providers: {
            // No `models` array at all: not a declaration this can read.
            opencode: { api: "openai-completions" },
            "opencode-go": {
              models: [
                // A row without an id is left alone rather than dropped.
                { name: "No id" },
                { id: "step-5-preview-free" },
              ],
            },
          },
        },
        id: "llm-pi-ai",
      },
    };
    const editor = {
      edit: vi.fn(
        async (
          _entry: unknown,
          change: (current: Record<string, unknown>) => Record<string, unknown>
        ) => {
          entry.options.config = change(
            entry.options.config as Record<string, unknown>
          ) as typeof entry.options.config;
        }
      ),
      entries: () => [entry],
    };

    const result = await new ModelPurgeService(ctxWith(editor)).purge();

    expect(result.removed).toEqual([
      { id: "step-5-preview-free", provider: "opencode-go" },
    ]);
    expect(entry.options.config.providers["opencode-go"].models).toEqual([
      { name: "No id" },
    ]);
  });

  it("refuses a context that is not an object", () => {
    expect(() => new ModelPurgeService(null)).toThrow(TypeError);
  });
});
