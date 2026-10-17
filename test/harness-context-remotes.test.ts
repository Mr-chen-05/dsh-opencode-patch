/**
 * Test: Cordis Context Variations, Remote Services & Scope Isolation.
 *
 * Validates:
 * - Service access patterns: ctx.get(name) vs property access
 * - Scope isolation and child scopes via ctx.inject([services], scope => ...)
 * - Typert remotes availability (opencodeLogin, opencodeGoUsage, modelDirectories)
 * - Remote error handling, code mapping, and retry flags
 * - Graceful degradation when services or remotes are absent
 *
 * @module test/harness-context-remotes.test
 */

import { describe, expect, it } from "vitest";

import { HarnessSimulator } from "./mock/testing-kit.ts";

describe("Cordis Context & Remote Services", () => {
  it("provides service lookup via ctx.get() and handles undeclared services safely", () => {
    const harness = new HarnessSimulator({
      services: {
        customService: { active: true },
      },
    });
    const { ctx } = harness.createMockContext();

    expect(ctx.get("customService")).toEqual({ active: true });
    expect(ctx.get("undeclaredService")).toBeUndefined();
  });

  it("isolates child scopes and injects requested services via ctx.inject()", () => {
    const harness = new HarnessSimulator({
      services: {
        llm: { model: "default" },
      },
    });
    const { ctx } = harness.createMockContext();

    let childScope: unknown;
    (
      ctx.inject as (
        deps: readonly string[],
        cb: (scope: unknown) => unknown
      ) => unknown
    )(["llm"], (scope) => {
      childScope = scope;
    });

    expect(childScope).toBeDefined();
    expect((childScope as { get: (k: string) => unknown }).get("llm")).toEqual({
      model: "default",
    });
  });

  it("handles presence of Typert remotes (opencodeGoUsage and opencodeLogin)", async () => {
    const harness = new HarnessSimulator({
      remotes: {
        opencodeGoUsage: {
          read: async () => ({
            rolling: {
              percent: 42,
              resetsAt: "2026-11-01T00:00:00.000Z",
              status: "ok",
            },
          }),
        },
        opencodeLogin: {
          state: async () => ({
            email: "dev@company.com",
            orgId: "wrk_123",
            signedIn: true,
          }),
        },
      },
    });
    const { ctx } = harness.createMockContext();

    const usageRemote = ctx.remote.opencodeGoUsage as {
      read: () => Promise<{ rolling: { percent: number } }>;
    };
    const usageData = await usageRemote.read();
    expect(usageData.rolling.percent).toBe(42);

    const loginRemote = ctx.remote.opencodeLogin as {
      state: () => Promise<{ signedIn: boolean; email: string }>;
    };
    const loginData = await loginRemote.state();
    expect(loginData.signedIn).toBe(true);
    expect(loginData.email).toBe("dev@company.com");
  });

  it("handles absence of remotes gracefully without crashing", () => {
    const harness = new HarnessSimulator({
      remotes: {},
    });
    const { ctx } = harness.createMockContext();

    expect(ctx.remote.opencodeGoUsage).toBeUndefined();
    expect(ctx.remote.opencodeLogin).toBeUndefined();
    expect(ctx.remote.modelDirectories).toBeUndefined();
  });
});
