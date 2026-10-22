// @vitest-environment jsdom
/**
 * The card's two catalog-gap calls: reading the difference, and closing it.
 *
 * The shapes mirror `settings-purge.test.ts` — all three are Remote calls through
 * the same guard, so a difference between them would be a bug in one rather than
 * a decision.
 */
import { describe, expect, it, vi } from "vitest";

import { declareModels, messageOf, readGap } from "../src/settings-gap.ts";

const scopeWith = (calls: { gap?: unknown; declare?: unknown }): unknown => ({
  remote: { opencodeModelGap: calls },
});

const report = {
  catalogRead: true,
  planes: [
    {
      declared: ["mimo-v2.6-flash-free"],
      missing: [
        {
          contextWindow: 200_000,
          free: true,
          id: "glm-5.3-flash-free",
          maxTokens: 32_000,
          name: "GLM-5.3-Flash Free",
        },
      ],
      route: "opencode",
    },
  ],
};

describe("readGap", () => {
  it("passes the host's report through", async () => {
    await expect(
      readGap(scopeWith({ gap: async () => ({ ok: true, value: report }) }))
    ).resolves.toEqual({ kind: "read", report });
  });

  it("accepts a bare value, not only the envelope", async () => {
    await expect(
      readGap(scopeWith({ gap: async () => report }))
    ).resolves.toEqual({ kind: "read", report });
  });

  it("says so when the host mounted no gap service", async () => {
    await expect(readGap({ remote: {} })).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("carries the host's refusal as a message", async () => {
    await expect(
      readGap(scopeWith({ gap: () => Promise.reject(new Error("no catalog")) }))
    ).resolves.toEqual({ kind: "failed", message: "no catalog" });
  });

  it("rejects an answer that is not a gap report", async () => {
    await expect(
      readGap(
        scopeWith({ gap: async () => ({ ok: true, value: { nope: 1 } }) })
      )
    ).resolves.toEqual({
      kind: "failed",
      message: "the host answered something that is not a gap report",
    });
  });

  it("survives a remote whose guarded access THROWS", async () => {
    const throwing = new Proxy(
      {},
      {
        get: (_target, property) => {
          if (property === "opencodeModelGap") {
            throw new TypeError(
              'cannot get property "remote.opencodeModelGap" without inject'
            );
          }
        },
      }
    );
    await expect(readGap({ remote: throwing })).resolves.toEqual({
      kind: "unavailable",
    });
  });
});

describe("declareModels", () => {
  it("sends the route and the ids, and passes the answer through", async () => {
    const declare = vi.fn(async () => ({
      ok: true,
      value: { added: ["glm-5.3-flash-free"], route: "opencode" },
    }));
    await expect(
      declareModels(scopeWith({ declare }), "opencode", ["glm-5.3-flash-free"])
    ).resolves.toEqual({
      kind: "declared",
      result: { added: ["glm-5.3-flash-free"], route: "opencode" },
    });
    expect(declare).toHaveBeenCalledWith({
      ids: ["glm-5.3-flash-free"],
      route: "opencode",
    });
  });

  it("says so when the host mounted no gap service", async () => {
    await expect(
      declareModels({ remote: {} }, "opencode", ["x"])
    ).resolves.toEqual({ kind: "unavailable" });
  });

  it("carries the host's refusal as a message", async () => {
    await expect(
      declareModels(
        scopeWith({ declare: () => Promise.reject(new Error("no editor")) }),
        "opencode",
        ["x"]
      )
    ).resolves.toEqual({ kind: "failed", message: "no editor" });
  });

  it("rejects an answer that is not a declare result", async () => {
    await expect(
      declareModels(
        scopeWith({
          declare: async () => ({ ok: true, value: { route: "x" } }),
        }),
        "opencode",
        ["x"]
      )
    ).resolves.toEqual({
      kind: "failed",
      message: "the host answered something that is not a declare result",
    });
  });
});

describe("settings-gap: inputs that are not what the call expects", () => {
  it("treats a scope that is not an object as no remote at all", async () => {
    // `null` rather than `undefined`: the guard treats every non-object alike, and
    // a literal `undefined` argument reads as a slip.
    await expect(readGap(null)).resolves.toEqual({ kind: "unavailable" });
    await expect(declareModels(null, "opencode", ["x"])).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("turns a non-Error rejection reason into a message", () => {
    // A rejection reason is `unknown` — a host or transport that surfaces a
    // string must not crash the caller's error path.
    expect(messageOf("plain string")).toBe("plain string");
    expect(messageOf(new Error("real"))).toBe("real");
    expect(messageOf({ code: 500 })).toBe("[object Object]");
  });

  it("reads the namespace through the context when the scope exposes get", async () => {
    // The path that works for a namespace this bundle mounts itself: `ctx.get`
    // does not consult `inject`, so it reaches a service the scope never declared.
    const scope = {
      get: (name: string) =>
        name === "remote.opencodeModelGap"
          ? { gap: async () => report }
          : undefined,
    };
    await expect(readGap(scope)).resolves.toEqual({ kind: "read", report });
  });
});
