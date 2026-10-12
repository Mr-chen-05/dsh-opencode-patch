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

/**
 * A credential seam over two maps: references on one side, records on the
 * other, because the seam keeps them in different address spaces.
 *
 * The record half is here even though no pool case uses it — the accessor's
 * type requires all six, and a stub that quietly provided three would type-error
 * rather than test anything.
 */
const writerFor = () => {
  const refs = new Map<string, string>();
  const records = new Map<string, unknown>();
  const set = vi.fn(async (ref: string, value: string) => {
    refs.set(ref, value);
  });
  const unset = vi.fn(async (ref: string) => {
    refs.delete(ref);
  });
  return {
    credentials: {
      deleteRecord: async (key: string) => {
        records.delete(key);
      },
      readRecord: async (key: string) => {
        const payload = records.get(key);
        return payload === undefined ? undefined : { kind: "grant", payload };
      },
      resolve: async (ref: string) => {
        const value = refs.get(ref);
        return value === undefined ? undefined : { value };
      },
      set,
      unset,
      writeGrant: async (key: string, payload: unknown) => {
        records.set(key, payload);
      },
    },
    records,
    refs,
    set,
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
    await expect(pool?.next()).resolves.toEqual({
      kind: "key",
      value: "key-b",
    });
    await expect(pool?.next()).resolves.toEqual({
      kind: "key",
      value: "key-a",
    });
    await expect(pool?.next()).resolves.toEqual({
      kind: "key",
      value: "key-b",
    });
    // `current` reports without consuming the turn.
    await expect(pool?.current()).resolves.toBe("key-b");
    await expect(pool?.next()).resolves.toEqual({
      kind: "key",
      value: "key-a",
    });
  });

  it("publishes on EVERY rotation, not only when the pool is created", async () => {
    // The defect this guards: the pool selected entries without writing, and
    // the mount published once at startup. A route the wrapper serves resolves
    // the pool's reference per operation, so it kept reading the key that was
    // current at mount while this plugin's own routes had already rotated past
    // it — a rotation that reached exactly one of the two kinds of route.
    const { credentials, set } = writerFor();
    const refusals: string[] = [];
    const pool = createCredentialPool({
      config: { enabled: true, go: [], zen: ["A", "B"] },
      credentials,
      onPublishRefused: (reason) => {
        refusals.push(String(reason));
      },
      plane: "opencode",
      resolveRef: resolverFor({ A: "key-a", B: "key-b" }),
    });

    await pool?.next();
    expect(set).toHaveBeenCalledWith("OPENCODE_POOL_KEY", "key-b");
    await pool?.next();
    // The SECOND rotation publishes too — this is the line the mount-only
    // version failed.
    expect(set).toHaveBeenCalledWith("OPENCODE_POOL_KEY", "key-a");
    expect(set).toHaveBeenCalledTimes(2);
    expect(refusals).toEqual([]);
  });

  it("reports a refused publish without failing the rotation", async () => {
    // The caller asked for a key for a request it is making itself and already
    // has it; the publish exists for OTHER routes. Turning a refusal into an
    // error would fail a request that would have worked.
    const refusals: string[] = [];
    const pool = createCredentialPool({
      config: { enabled: true, go: [], zen: ["A"] },
      credentials: {
        deleteRecord: vi.fn(),
        readRecord: vi.fn(),
        resolve: vi.fn(),
        set: async () => {
          throw new Error("supplied read-only by the launching environment");
        },
        unset: vi.fn(),
        writeGrant: vi.fn(),
      },
      onPublishRefused: (reason) => {
        refusals.push(String(reason));
      },
      plane: "opencode",
      resolveRef: resolverFor({ A: "key-a" }),
    });

    const result = await pool?.next();
    // The key still comes back — the request it was for is served.
    expect(result).toEqual({ kind: "key", value: "key-a" });
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("supplied read-only");
  });

  it("rotates without a seam, and says the publish did not happen", async () => {
    const refusals: string[] = [];
    const pool = createCredentialPool({
      config: { enabled: true, go: [], zen: ["A"] },
      onPublishRefused: (reason) => {
        refusals.push(String(reason));
      },
      plane: "opencode",
      resolveRef: resolverFor({ A: "key-a" }),
    });
    await expect(pool?.next()).resolves.toEqual({
      kind: "key",
      value: "key-a",
    });
    // A pool with nothing to write through still rotates; it is simply
    // invisible outside this plugin, and says so.
    expect(refusals[0]).toContain("credentials service");
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
    await expect(zen?.next()).resolves.toEqual({
      kind: "key",
      value: "zen-key",
    });
    await expect(go?.next()).resolves.toEqual({ kind: "key", value: "go-key" });
    expect(zen?.reference).toBe("OPENCODE_POOL_KEY");
    expect(go?.reference).toBe("OPENCODE_GO_POOL_KEY");
    // And the references are the documented names, not derived from anything.
    expect(new Set(Object.values(POOL_REFERENCE))).toEqual(
      new Set(["OPENCODE_POOL_KEY", "OPENCODE_GO_POOL_KEY"])
    );
  });

  it("marks the entry in use, so a refused key does not come back around", async () => {
    // The wiring this guards was missing while every unit test passed: the pool
    // could mark an entry failed and nothing ever called it, so a key the
    // gateway refused stayed in rotation and was handed out again on the next
    // lap. The caller knows a request failed; the pool is the only one that
    // knows which entry was behind it.
    const pool = poolFor(
      { enabled: true, go: [], zen: ["A", "B", "C"] },
      {
        A: "key-a",
        B: "key-b",
        C: "key-c",
      }
    );
    await expect(pool?.next()).resolves.toEqual({
      kind: "key",
      value: "key-b",
    });
    // B was the one in use, so B is the one the failure belongs to.
    expect(pool?.markCurrentFailed()).toBe("B");
    // The healthy entries keep rotating and B never comes back: a full lap
    // returns to the keys that work, not to the one the gateway just refused.
    const seen: string[] = [];
    for (let turn = 0; turn < 5; turn += 1) {
      const result = await pool?.next();
      if (result?.kind === "key") {
        seen.push(result.value);
      }
    }
    expect(seen).toEqual(["key-c", "key-a", "key-c", "key-a", "key-c"]);
    expect(seen).not.toContain("key-b");
  });

  it("skips a failed entry and restores it when told", async () => {
    const pool = poolFor(
      { enabled: true, go: [], zen: ["A", "B"] },
      {
        A: "key-a",
        B: "key-b",
      }
    );
    await expect(pool?.next()).resolves.toEqual({
      kind: "key",
      value: "key-b",
    });
    pool?.markFailed("B");
    await expect(pool?.next()).resolves.toEqual({
      kind: "key",
      value: "key-a",
    });
    // Still only A, twice: the failed entry is out until it is put back.
    await expect(pool?.next()).resolves.toEqual({
      kind: "key",
      value: "key-a",
    });
    pool?.restore("B");
    await expect(pool?.next()).resolves.toEqual({
      kind: "key",
      value: "key-b",
    });
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
    await expect(pool?.next()).resolves.toEqual({
      kind: "key",
      value: "key-b",
    });
    // A blank stored value is the same absence as no value at all.
    const blank = poolFor({ enabled: true, go: [], zen: ["A"] }, { A: "" });
    await expect(blank?.next()).resolves.toEqual({ kind: "exhausted" });
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
    await expect(pool?.next()).resolves.toEqual({ kind: "exhausted" });
    await expect(pool?.current()).resolves.toBeUndefined();
  });
});

describe("credential-pool: publishing through the reference it owns", () => {
  it("writes the active key under the pool's own reference", async () => {
    const { credentials, refs, set } = writerFor();
    const pool = poolFor({ enabled: true, go: [], zen: ["A"] }, { A: "key-a" });

    await expect(publishPoolKey(pool, credentials)).resolves.toEqual({
      ok: true,
    });
    expect(set).toHaveBeenCalledWith("OPENCODE_POOL_KEY", "key-a");
    // And a route reading that reference sees the pool's key.
    await expect(credentials.resolve("OPENCODE_POOL_KEY")).resolves.toEqual({
      value: "key-a",
    });
    expect(refs.get("OPENCODE_POOL_KEY")).toBe("key-a");
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
      deleteRecord: vi.fn(),
      readRecord: vi.fn(),
      writeGrant: vi.fn(),
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
    await expect(pool?.next()).resolves.toEqual({
      kind: "key",
      value: "first",
    });
    values.A = "second";
    await expect(pool?.next()).resolves.toEqual({
      kind: "key",
      value: "second",
    });
  });
});
