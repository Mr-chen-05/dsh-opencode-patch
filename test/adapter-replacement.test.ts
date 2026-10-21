/**
 * `replaceRouteAdapters` — taking a provider route over from the adapter that
 * currently serves it.
 *
 * The duplicate check in `dsh-llm` reads the registry map, so releasing the entry
 * first makes the route registrable through the ordinary API. These cases pin the
 * three things that must hold for that swap to be safe: the original is restored on
 * disposal, a failed build leaves it untouched, and a refusal does not strand the
 * provider.
 */
import { describe, expect, it, vi } from "vitest";

import { replaceRouteAdapters } from "../src/adapter-replacement.ts";
import type { CordisContext } from "../src/index.ts";

interface FakeLlm {
  adapters: Map<string, { adapter: Record<string, unknown> }>;
  registerAdapter: (
    providers: readonly string[],
    adapter: unknown
  ) => (() => void) | undefined;
}

/** A registry with one built-in route, and the events a swap would cause. */
const registryWith = (route: string) => {
  const original = { adapter: { name: "builtin" } as Record<string, unknown> };
  const adapters = new Map([[route, original]]);
  const events: string[] = [];
  const llm: FakeLlm = {
    adapters,
    registerAdapter: (providers, adapter) => {
      for (const provider of providers) {
        if (adapters.has(provider)) {
          throw new Error("DUPLICATE_ADAPTER");
        }
      }
      for (const provider of providers) {
        adapters.set(provider, { adapter: adapter as Record<string, unknown> });
      }
      events.push(`registered:${providers.join(",")}`);
      return () => {
        for (const provider of providers) {
          adapters.delete(provider);
        }
        events.push(`disposed:${providers.join(",")}`);
      };
    },
  };
  return { adapters, events, llm, original };
};

describe("replaceRouteAdapters", () => {
  it("releases the route, registers ours, and restores the original after", () => {
    const { adapters, events, llm, original } = registryWith("opencode");
    const ctx = { llm, logger: { warn: () => {} } } as unknown as CordisContext;
    const ours = { name: "ours" };

    const stop = replaceRouteAdapters(ctx, ["opencode"], () => ours);

    expect(stop).toBeTypeOf("function");
    expect(adapters.get("opencode")?.adapter).toBe(ours);
    expect(events).toEqual(["registered:opencode"]);

    stop?.();
    expect(adapters.get("opencode")).toBe(original);
    expect(events).toEqual(["registered:opencode", "disposed:opencode"]);
  });

  it("does nothing when the route is not registered", () => {
    // A composition without the provider has no route to take over, and inventing
    // one would give the user a provider the deployment never declared.
    const { adapters, events, llm } = registryWith("somewhere-else");
    const ctx = { llm, logger: { warn: () => {} } } as unknown as CordisContext;
    expect(
      replaceRouteAdapters(ctx, ["opencode"], () => ({ name: "ours" }))
    ).toBeUndefined();
    expect(adapters.has("opencode")).toBe(false);
    expect(events).toEqual([]);
  });

  it("leaves the route with its own adapter when the build fails", () => {
    const { adapters, llm, original } = registryWith("opencode");
    const warn = vi.fn();
    const ctx = { llm, logger: { warn } } as unknown as CordisContext;
    const stop = replaceRouteAdapters(ctx, ["opencode"], () => {
      throw new Error("no pi-ai here");
    });
    expect(stop).toBeUndefined();
    expect(adapters.get("opencode")).toBe(original);
    expect(warn).toHaveBeenCalled();
  });

  it("restores the original when the host refuses the registration", () => {
    const { adapters, llm, original } = registryWith("opencode");
    // A refusal AFTER the release: the provider would otherwise be left unserved.
    llm.registerAdapter = () => {
      throw new Error("refused");
    };
    const warn = vi.fn();
    const ctx = { llm, logger: { warn } } as unknown as CordisContext;
    expect(
      replaceRouteAdapters(ctx, ["opencode"], () => ({ name: "ours" }))
    ).toBeUndefined();
    expect(adapters.get("opencode")).toBe(original);
    expect(warn).toHaveBeenCalled();
  });
});

describe("replaceRouteAdapters: the shapes it declines", () => {
  const ctxWith = (llm: unknown) =>
    ({ llm, logger: { warn: vi.fn() } }) as unknown as CordisContext;

  it("declines a registry without a usable map or registerAdapter", () => {
    // Both are read structurally off the service, so a composition that exposes
    // one and not the other must answer "cannot take over" rather than throwing
    // halfway through a swap.
    expect(
      replaceRouteAdapters(ctxWith({}), ["opencode"], () => ({}))
    ).toBeUndefined();
    expect(
      replaceRouteAdapters(
        ctxWith({ adapters: {}, registerAdapter: () => {} }),
        ["opencode"],
        () => ({})
      )
    ).toBeUndefined();
    expect(
      replaceRouteAdapters(
        ctxWith({ adapters: new Map(), registerAdapter: "nope" }),
        ["opencode"],
        () => ({})
      )
    ).toBeUndefined();
    // A context with no `llm` at all is the same answer.
    expect(
      replaceRouteAdapters({} as CordisContext, ["opencode"], () => ({}))
    ).toBeUndefined();
  });

  it("declines when any route of the group is unserved", () => {
    // All-or-nothing: replacing half a protocol group would leave the other
    // half on the host's adapter, and the two would disagree about the route.
    const { llm } = registryWith("opencode");
    expect(
      replaceRouteAdapters(ctxWith(llm), ["opencode", "opencode-go"], () => ({
        name: "ours",
      }))
    ).toBeUndefined();
  });

  it("declines an empty route list", () => {
    const { llm } = registryWith("opencode");
    expect(replaceRouteAdapters(ctxWith(llm), [], () => ({}))).toBeUndefined();
  });

  it("gives the routes back when the host returns no disposer", () => {
    // `registerAdapter` answers a callable or nothing. A composition that
    // answers nothing still has to be reversible, or the route is stranded on
    // our adapter with no way back.
    const original = {
      adapter: { name: "builtin" } as Record<string, unknown>,
    };
    const adapters = new Map([["opencode", original]]);
    const llm = {
      adapters,
      registerAdapter: (providers: readonly string[], adapter: unknown) => {
        for (const provider of providers) {
          adapters.set(provider, {
            adapter: adapter as Record<string, unknown>,
          });
        }
        // Falls off the end: one of the two shapes the host answers with is no
        // disposer at all, and a composition that answers that still has to be
        // reversible.
      },
    };
    const dispose = replaceRouteAdapters(ctxWith(llm), ["opencode"], () => ({
      name: "ours",
    }));
    expect(dispose).toBeDefined();
    // Ours is in place...
    expect(adapters.get("opencode")?.adapter.name).toBe("ours");
    dispose?.();
    // ...and the original is back even though the host gave us no disposer.
    expect(adapters.get("opencode")).toBe(original);
  });

  it("restores the original even if its own disposer throws", () => {
    // Disposal runs inside a `finally`, so a throwing disposer cannot leave the
    // route without its adapter.
    const original = {
      adapter: { name: "builtin" } as Record<string, unknown>,
    };
    const adapters = new Map([["opencode", original]]);
    const llm = {
      adapters,
      registerAdapter: (providers: readonly string[], adapter: unknown) => {
        for (const provider of providers) {
          adapters.set(provider, {
            adapter: adapter as Record<string, unknown>,
          });
        }
        return () => {
          throw new Error("dispose exploded");
        };
      },
    };
    const dispose = replaceRouteAdapters(ctxWith(llm), ["opencode"], () => ({
      name: "ours",
    }));
    expect(() => dispose?.()).toThrow("dispose exploded");
    expect(adapters.get("opencode")).toBe(original);
  });
});
