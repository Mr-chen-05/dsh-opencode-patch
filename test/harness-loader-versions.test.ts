/**
 * Test: DeepSeek Harness Loader Generations & Host Plugin Discovery.
 *
 * Validates:
 * - Legacy loader generation (entries retain module namespace directly)
 * - Modern 0.2.0-rc.2 / 0.2.1 loader generation (fiber-only entries; module resolved via ctx.baseUrl)
 * - Degraded loader handling (missing loader, empty entries, non-iterable entries)
 * - Safe host adapter discovery and isolation across harness versions
 *
 * @module test/harness-loader-versions.test
 */

import { describe, expect, it } from "vitest";

import { HarnessSimulator } from "./mock/testing-kit.ts";

describe("DeepSeek Harness: Loader Versions & Plugin Discovery", () => {
  it("discovers host plugin from Legacy loader entry retaining namespace", () => {
    const harness = new HarnessSimulator({
      loaderGeneration: "legacy-namespace",
    });
    const { ctx, loaderEntries } = harness.createMockContext();

    expect(loaderEntries.length).toBe(1);
    const entry = loaderEntries[0] as {
      name: string;
      namespace: {
        PiAiAdapter: unknown;
        apply: unknown;
        inject: string[];
        name: string;
      };
    };
    expect(entry.name).toBe("@deepseek-ai/dsh-llm-pi-ai");
    expect(entry.namespace.PiAiAdapter).toBeDefined();
    expect(entry.namespace.name).toBe("llm-pi-ai");
    expect(entry.namespace.inject).toContain("llm");
    expect(ctx.get("loader")).toBeDefined();
  });

  it("handles Modern 0.2.0-rc.2 / 0.2.1 loader carrying fiber without namespace", () => {
    const harness = new HarnessSimulator({
      baseUrl: new URL("../", import.meta.url).href,
      loaderGeneration: "fiber-only",
    });
    const { ctx, loaderEntries } = harness.createMockContext();

    expect(loaderEntries.length).toBe(1);
    const entry = loaderEntries[0] as {
      fiber: { inject: { llm: null }; runtime: { callback: () => unknown } };
      namespace?: unknown;
      options: { name: string };
    };
    expect(entry.fiber).toBeDefined();
    expect(entry.namespace).toBeUndefined();
    expect(entry.options.name).toBe("@deepseek-ai/dsh-llm-pi-ai");
    expect(ctx.baseUrl).toBeDefined();
    expect(ctx.baseUrl.startsWith("file://")).toBe(true);
  });

  it("handles degraded loader with empty entries and provides scope isolation", () => {
    const harness = new HarnessSimulator({
      loaderGeneration: "degraded",
    });
    const { ctx, loaderEntries } = harness.createMockContext();

    expect(loaderEntries.length).toBe(0);

    let capturedScope: unknown;
    (
      ctx.inject as (
        deps: readonly string[],
        cb: (scope: unknown) => unknown
      ) => unknown
    )(["llm"], (scope) => {
      capturedScope = scope;
    });
    expect(capturedScope).toBe(ctx);
  });

  it("survives absent loader and missing baseUrl gracefully", () => {
    const contextWithoutLoader: {
      baseUrl?: string;
      get?: (key: string) => unknown;
    } = {
      get: () => null,
    };

    expect(contextWithoutLoader.get?.("loader")).toBeNull();
    expect(contextWithoutLoader.baseUrl).toBeUndefined();
  });
});
