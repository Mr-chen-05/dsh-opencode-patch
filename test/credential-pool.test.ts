/**
 * What the pool does, and — the part that matters more — what it does not do
 * unless a deployment says so.
 *
 * @module dsh-opencode-patch/credential-pool.test
 */

import { describe, expect, it, vi } from "vitest";

import type { CredentialPoolConfig } from "../src/config.ts";
import {
  type CredentialPool,
  createCredentialPool,
  POOL_REFERENCE,
  publishPoolKey,
} from "../src/credential-pool.ts";

const OFF: CredentialPoolConfig = { enabled: false, go: [], zen: [] };

/** A resolver over a fixed map, so a rotation is observable rather than inferred. */
const resolverFor = (values: Record<string, string>) =>
  vi.fn(async (ref: string) => {
    const value = values[ref];
    return value === undefined ? undefined : { value };
  });

const writerFor = () => {
  const store = new Map<string, string>();
  const set = vi.fn(async (ref: string, value: string) => {
    store.set(ref, value);
  });
  const unset = vi.fn(async (ref: string) => {
    store.delete(ref);
  });
  return {
    credentials: {
      resolve: async (ref: string) => {
        const value = store.get(ref);
        return value === undefined ? undefined : { value };
      },
      set,
      unset,
    },
    set,
    store,
    unset,
  };
};

/**
 * The pool for one plane, asserted present.
 *
 * The cases that exercise a pool's behaviour all configure one, so this
 * narrows once here instead of casting at every call — a pool that failed to
 * exist would fail on the first assertion about its keys anyway.
 */
const poolFor = (
  config: CredentialPoolConfig,
  values: Record<string, string>,
  plane: "opencode" | "opencode-go" = "opencode"
): CredentialPool => {
  const pool = createCredentialPool({
    config,
    plane,
    resolveRef: resolverFor(values),
  });
  if (pool === undefined) {
    throw new Error(`no pool for ${plane} with ${JSON.stringify(config)}`);
  }
  return pool;
};

/** The same call, for the cases whose subject IS the absence of a pool. */
const maybePool = (
  config: CredentialPoolConfig,
  values: Record<string, string>,
  plane: "opencode" | "opencode-go" = "opencode"
): CredentialPool | undefined =>
  createCredentialPool({ config, plane, resolveRef: resolverFor(values) });

describe("credential-pool: absent unless a deployment opted in", () => {
  it("is undefined with the switch off, however many entries are listed", async () => {
    // The contract, stated as a test: adding the plugin must not change a
    // deployment's credential. A pool nobody enabled is not a pool with an
    // empty list — it is no pool, so every caller keeps resolving what the
    // profile named.
    expect(
      maybePool({ ...OFF, zen: ["A", "B"] }, { A: "a", B: "b" })
    ).toBeUndefined();
    // What a deployment gets without configuring anything: off, and empty.
    expect(maybePool(OFF, { A: "a" })).toBeUndefined();
  });

  it("is undefined when the switch is on but the plane lists nothing", () => {
    expect(
      maybePool({ enabled: true, go: [], zen: [] }, { A: "a" })
    ).toBeUndefined();
    // And per plane: a Zen list does not populate the Go pool.
    expect(
      maybePool(
        { enabled: true, go: [], zen: ["A"] },
        { A: "a" },
        "opencode-go"
      )
    ).toBeUndefined();
  });

  it("treats blank entries as absent rather than as a pool of empty names", () => {
    expect(
      maybePool({ enabled: true, go: [], zen: ["", "  "] }, {})
    ).toBeUndefined();
  });
});

describe("credential-pool: rotation among the entries a plane declared", () => {
  it("advances round-robin, and stays put when asked for the current entry", async () => {
    const pool = poolFor(
      { enabled: true, go: [], zen: ["A", "B"] },
      {
        A: "key-a",
        B: "key-b",
      }
    );
    expect(pool?.refs).toEqual(["A", "B"]);
    await expect(pool?.next()).resolves.toBe("key-b");
    await expect(pool?.next()).resolves.toBe("key-a");
    await expect(pool?.next()).resolves.toBe("key-b");
    // `current` reports without consuming the turn.
    await expect(pool?.current()).resolves.toBe("key-b");
    await expect(pool?.next()).resolves.toBe("key-a");
  });

  it("keeps the planes apart: a Zen key never answers a Go request", async () => {
    const config: CredentialPoolConfig = {
      enabled: true,
      go: ["GO_ONE"],
      zen: ["ZEN_ONE"],
    };
    const values = { GO_ONE: "go-key", ZEN_ONE: "zen-key" };
    const zen = poolFor(config, values, "opencode");
    const go = poolFor(config, values, "opencode-go");
    await expect(zen?.next()).resolves.toBe("zen-key");
    await expect(go?.next()).resolves.toBe("go-key");
    expect(zen?.reference).toBe("OPENCODE_POOL_KEY");
    expect(go?.reference).toBe("OPENCODE_GO_POOL_KEY");
    // And the references are the documented names, not derived from anything.
    expect(new Set(Object.values(POOL_REFERENCE))).toEqual(
      new Set(["OPENCODE_POOL_KEY", "OPENCODE_GO_POOL_KEY"])
    );
  });

  it("skips a failed entry and restores it when told", async () => {
    const pool = poolFor(
      { enabled: true, go: [], zen: ["A", "B"] },
      {
        A: "key-a",
        B: "key-b",
      }
    );
    await expect(pool?.next()).resolves.toBe("key-b");
    pool?.markFailed("B");
    await expect(pool?.next()).resolves.toBe("key-a");
    // Still only A, twice: the failed entry is out until it is put back.
    await expect(pool?.next()).resolves.toBe("key-a");
    pool?.restore("B");
    await expect(pool?.next()).resolves.toBe("key-b");
  });

  it("skips an entry that resolves to nothing, without giving up", async () => {
    // A reference with no value is a stale configuration, not a pool failure:
    // the next entry still answers.
    const pool = poolFor(
      { enabled: true, go: [], zen: ["MISSING", "B"] },
      {
        B: "key-b",
      }
    );
    await expect(pool?.next()).resolves.toBe("key-b");
    // A blank stored value is the same absence as no value at all.
    const blank = poolFor({ enabled: true, go: [], zen: ["A"] }, { A: "" });
    await expect(blank?.next()).resolves.toBeUndefined();
  });

  it("falls through rather than erroring when every entry is spent", async () => {
    // The spec: an empty or fully-failed pool falls through, so a request is
    // never failed over a pool that is merely exhausted.
    const pool = poolFor(
      { enabled: true, go: [], zen: ["A", "B"] },
      {
        A: "key-a",
        B: "key-b",
      }
    );
    pool?.markFailed("A");
    pool?.markFailed("B");
    await expect(pool?.next()).resolves.toBeUndefined();
    await expect(pool?.current()).resolves.toBeUndefined();
  });
});

describe("credential-pool: publishing through the reference it owns", () => {
  it("writes the active key under the pool's own reference", async () => {
    const { credentials, set, store } = writerFor();
    const pool = poolFor({ enabled: true, go: [], zen: ["A"] }, { A: "key-a" });

    await expect(publishPoolKey(pool, credentials)).resolves.toEqual({
      ok: true,
    });
    expect(set).toHaveBeenCalledWith("OPENCODE_POOL_KEY", "key-a");
    // And a route reading that reference sees the pool's key.
    await expect(credentials.resolve("OPENCODE_POOL_KEY")).resolves.toEqual({
      value: "key-a",
    });
    expect(store.get("OPENCODE_POOL_KEY")).toBe("key-a");
  });

  it("never writes a reference the deployment declared", async () => {
    const { credentials, set } = writerFor();
    const pool = poolFor({ enabled: true, go: [], zen: ["A"] }, { A: "key-a" });

    await publishPoolKey(pool, credentials);
    // The only write that happened names the pool's own reference. This is the
    // line the whole design rests on: a deployment's OPENCODE_API_KEY is never
    // a write target.
    for (const [ref] of set.mock.calls) {
      expect(ref).toBe("OPENCODE_POOL_KEY");
      expect(ref).not.toBe("OPENCODE_API_KEY");
    }
  });

  it("reports the seam's refusal instead of believing a rotation landed", async () => {
    // The seam rejects a write a read-only source shadows. Pretending that
    // succeeded would leave a deployment believing their pool is rotating while
    // every request still reads their exported value.
    const refuse = vi.fn(async () => {
      throw new Error(
        '"OPENCODE_POOL_KEY" is supplied read-only by the launching environment, so set would be shadowed'
      );
    });
    const pool = poolFor({ enabled: true, go: [], zen: ["A"] }, { A: "key-a" });

    const result = await publishPoolKey(pool, {
      resolve: vi.fn(),
      set: refuse,
      unset: async () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("supplied read-only");
    expect(refuse).toHaveBeenCalledTimes(1);
  });

  it("says so when there is no seam to write through", async () => {
    const pool = poolFor({ enabled: true, go: [], zen: ["A"] }, { A: "key-a" });
    const result = await publishPoolKey(pool);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("credentials service");
  });

  it("reports an exhausted pool rather than publishing an empty value", async () => {
    // The seam refuses an empty value, and publishing one would unconfigure the
    // reference the wrapper's routes read.
    const { credentials, set } = writerFor();
    const pool = poolFor({ enabled: true, go: [], zen: ["MISSING"] }, {});
    const result = await publishPoolKey(pool, credentials);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no pool entry resolves");
    expect(set).not.toHaveBeenCalled();
  });
});

describe("credential-pool: a changed value is noticed on the next selection", () => {
  it("re-reads the entries, so a rotated environment variable takes effect", async () => {
    // Nothing here caches: each selection asks the seam again, which is what
    // makes the pool compatible with credentials that change under it.
    const values: Record<string, string> = { A: "first" };
    const pool = createCredentialPool({
      config: { enabled: true, go: [], zen: ["A"] },
      plane: "opencode",
      resolveRef: async (ref: string) => ({ value: values[ref] }),
    });
    await expect(pool?.next()).resolves.toBe("first");
    values.A = "second";
    await expect(pool?.next()).resolves.toBe("second");
  });
});
