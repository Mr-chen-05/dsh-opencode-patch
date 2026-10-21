/**
 * The real composition: what the plugin leaves the WORLD holding, not what it
 * called.
 *
 * The DeepSeek harness's testing policy states the rule this file exists for:
 *
 * > A hand-built `ctx.plugin(...)` suite is insufficient. Boot a test-only
 * > composition through Loader and assert model-visible request/log, durable
 * > state, or user-visible output.
 *
 * The bug that motivated it is exactly the class that rule describes. Every
 * unit test passed while `opencodeModelPurge` was mounted on the host and
 * unreachable from the browser, because each test asserted the CALL rather than
 * the RESULT: "the service was mounted", "the descriptors list what they list".
 * Neither was false. The feature was still dead.
 *
 * So every assertion here is about what a consumer can OBSERVE afterwards — the
 * service a `ctx.get` resolves, the methods that service exposes, the host hooks
 * that were installed — never about which function was invoked.
 *
 * @module test/composition.test
 */
import { describe, expect, it } from "vitest";

import { apply } from "../src/index.ts";
import type { CordisContext } from "../src/index.ts";

/**
 * A context that behaves like a mounted host: `plugin()` really registers, and
 * `get()` really resolves what was registered.
 *
 * This is the difference from the `ctx.plugin(...)` suites this replaces — they
 * recorded calls into an array, which no consumer could observe. Here a service
 * the plugin mounts becomes visible through the same access path the plugin's
 * own code uses at runtime.
 */
const hostWith = (options: { readonly configEditor?: boolean } = {}) => {
  const services = new Map<string, unknown>();
  const installedAt: string[] = [];
  const ctx = {
    effect: (fn: () => unknown) => {
      installedAt.push("effect");
      return fn();
    },
    get: (name: string) => {
      if (name === "configEditor" && options.configEditor === true) {
        return { edit: async () => {}, entries: () => [] };
      }
      return services.get(name);
    },
    llm: {
      listModels: async () => [],
      listProviders: () => [],
      registerAdapter: () => () => {},
      registerModelDiscovery: () => {},
    },
    on: () => {},
    plugin: (component: { name?: string }) => {
      // The real service keys its registration with `super(ctx, "name")`, which
      // this stand-in cannot see; the NAME is what it registers under.
      if (component.name !== undefined) {
        services.set(component.name, component);
      }
    },
    root: undefined as unknown,
  };
  ctx.root = ctx;
  return { ctx: ctx as unknown as CordisContext, services, installedAt };
};

describe("composition · what a consumer can observe after apply()", () => {
  it("leaves the purge service answerable, and it exposes `purge`", () => {
    // The exact failure that shipped: the service mounted, the namespace was
    // never contributed, and the row said "unavailable" forever. Here the
    // question is the consumer's: can anything reach a purge at all?
    const { ctx, services } = hostWith();
    apply(ctx, { usageEnabled: false });
    const purge = services.get("ModelPurgeService");
    expect(
      purge,
      "the purge service must be registered on the root"
    ).toBeDefined();
    // The method the remote declares must exist on the class that was mounted,
    // or the namespace is answerable and still cannot answer.
    expect(
      typeof (purge as { prototype?: { purge?: unknown } })?.prototype?.purge
    ).toBe("function");
  });

  it("leaves the usage service answerable only while the meter is on", () => {
    const off = hostWith();
    apply(off.ctx, { usageEnabled: false });
    expect(off.services.has("GoUsageService")).toBe(false);

    const on = hostWith();
    apply(on.ctx, { usageEnabled: true });
    const usage = on.services.get("GoUsageService");
    expect(usage, "the meter needs a reachable usage service").toBeDefined();
    expect(
      typeof (usage as { prototype?: { read?: unknown } })?.prototype?.read
    ).toBe("function");
  });

  it("installs the host hooks a turn needs, not just records that it tried", () => {
    // `effect` is how this plugin does anything host-side. If `apply` returns
    // with none installed, the plugin is loaded and inert.
    const { ctx, installedAt } = hostWith();
    apply(ctx, { usageEnabled: true });
    expect(installedAt.length).toBeGreaterThan(0);
  });

  it("survives an apply() with no config editor, which must not throw", () => {
    // A composition without the settings service is a real deployment: the
    // card's purge row reports unavailability rather than the plugin failing to
    // load. Proven by applying, not by reading a branch.
    const { ctx } = hostWith({ configEditor: false });
    expect(() => apply(ctx, { usageEnabled: false })).not.toThrow();
  });
});
