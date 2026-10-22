// @vitest-environment jsdom
/**
 * The card's inspection call: four outcomes, each named, because "nothing
 * happened" has four different causes and the reader has to be told which.
 *
 * The shape mirrors `settings-purge.test.ts` on purpose — both are Remote calls
 * the card makes through the same guard, so a difference between them would be a
 * bug in one of them rather than a decision.
 */
import { describe, expect, it, vi } from "vitest";

import { inspectStore } from "../src/settings-store.ts";

const scopeWith = (inspect: unknown): unknown => ({
  remote: { opencodeStore: { inspect } },
});

describe("inspectStore", () => {
  it("passes the host's answer through", async () => {
    const inspection = {
      account: { email: "someone@example.com", type: "oauth" },
      found: true,
      path: "~/.local/share/opencode/opencode.db",
    };
    const inspect = vi.fn(async () => ({ ok: true, value: inspection }));
    await expect(inspectStore(scopeWith(inspect))).resolves.toEqual({
      kind: "inspected",
      inspection,
    });
  });

  it("accepts a bare value, not only the envelope", async () => {
    const inspection = { found: false, message: "not_found" };
    await expect(
      inspectStore(scopeWith(async () => inspection))
    ).resolves.toEqual({ kind: "inspected", inspection });
  });

  it("says so when the host mounted no store service", async () => {
    await expect(inspectStore({ remote: {} })).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("survives a scope that is not an object at all", async () => {
    // `null` rather than `undefined`: the guard treats every non-object
    // the same, and a literal `undefined` argument reads as a slip.
    await expect(inspectStore(null)).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("carries the host's refusal as a message, not as a silent undefined", async () => {
    const inspect = vi.fn(() => Promise.reject(new Error("no sqlite")));
    await expect(inspectStore(scopeWith(inspect))).resolves.toEqual({
      kind: "failed",
      message: "no sqlite",
    });
  });

  it("rejects an answer that is not an inspection", async () => {
    // A shape check, not a wish: the card renders rows off this value, and a
    // half-built answer would print `undefined` beside a label.
    await expect(
      inspectStore(scopeWith(async () => ({ ok: true, value: { path: "x" } })))
    ).resolves.toEqual({
      kind: "failed",
      message: "host returned an invalid inspection shape",
    });
    await expect(inspectStore(scopeWith(async () => 42))).resolves.toEqual({
      kind: "failed",
      message: "host returned an invalid inspection shape",
    });
  });

  it("survives a remote whose guarded access THROWS", async () => {
    // `scope.remote.opencodeStore` is a cordis GUARDED PROPERTY: for a namespace
    // this bundle never declared in `inject` it throws, and a throw out of a
    // render takes the whole settings card down. The shared guard in
    // `settings-remote.ts` is what turns that into "no service".
    const throwing = new Proxy(
      {},
      {
        get: (_target, property) => {
          if (property === "opencodeStore") {
            throw new TypeError(
              'cannot get property "remote.opencodeStore" without inject'
            );
          }
        },
      }
    );
    await expect(inspectStore({ remote: throwing })).resolves.toEqual({
      kind: "unavailable",
    });
  });
});
