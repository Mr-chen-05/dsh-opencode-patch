// @vitest-environment jsdom
/**
 * The card's purge call: three outcomes, each named, because "nothing happened"
 * has three different causes and the operator has to be told which.
 */
import { describe, expect, it, vi } from "vitest";

import { purgeDeprecatedModels } from "../src/settings-purge.ts";

const scopeWith = (purge: unknown): unknown => ({
  remote: { opencodeModelPurge: { purge } },
});

describe("purgeDeprecatedModels", () => {
  it("passes the host's answer through", async () => {
    const purge = vi.fn(async () => ({
      ok: true,
      value: {
        catalogRead: true,
        removed: [{ id: "fledge-alpha-free", provider: "opencode" }],
      },
    }));
    const outcome = await purgeDeprecatedModels(scopeWith(purge));
    expect(outcome).toEqual({
      kind: "purged",
      result: {
        catalogRead: true,
        removed: [{ id: "fledge-alpha-free", provider: "opencode" }],
      },
    });
  });

  it("says so when the host mounted no purge service", async () => {
    await expect(purgeDeprecatedModels({ remote: {} })).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("carries the host's refusal as a message, not as a silent undefined", async () => {
    const purge = vi.fn(() => Promise.reject(new Error("no config editor")));
    const outcome = await purgeDeprecatedModels(scopeWith(purge));
    expect(outcome).toEqual({ kind: "failed", message: "no config editor" });
  });

  it("rejects an answer that is not a purge result", async () => {
    const outcome = await purgeDeprecatedModels(
      scopeWith(() => Promise.resolve({ ok: true, value: { weird: true } }))
    );
    expect(outcome).toMatchObject({ kind: "failed" });
  });
});
