/**
 * Where a login's tokens live, and the two failure modes that shape it.
 *
 * @module dsh-opencode-patch/token-store.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CredentialsWriter } from "../src/cordis-context.ts";
import { createTokenStore } from "../src/token-store.ts";

/**
 * A seam over one map, recording the order of its calls so a test can assert
 * that a write went through `modifyRecord` rather than through a read and two
 * writes.
 */
const seamOver = (): {
  credentials: CredentialsWriter;
  calls: string[];
  records: Map<string, unknown>;
} => {
  const records = new Map<string, unknown>();
  const calls: string[] = [];
  const credentials: CredentialsWriter = {
    deleteRecord: vi.fn(async (key: string) => {
      calls.push("deleteRecord");
      records.delete(key);
    }),
    readRecord: vi.fn(async (key: string) => {
      calls.push("readRecord");
      const payload = records.get(key);
      return payload === undefined ? undefined : { kind: "grant", payload };
    }),
    resolve: vi.fn(),
    set: vi.fn(async () => {
      calls.push("set");
    }),
    unset: vi.fn(async () => {
      calls.push("unset");
    }),
    writeGrant: async (key: string, payload: unknown) => {
      calls.push("modifyRecord");
      records.set(key, payload);
    },
  };
  return { calls, credentials, records };
};

const NOW_MS = 1_800_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("token-store: absent when a token could not be kept", () => {
  it("is undefined with no credential seam to write through", () => {
    expect(
      createTokenStore({
        credentials: undefined,
        plane: "opencode",
        scope: "dsh-opencode-patch",
      })
    ).toBeUndefined();
  });

  it("is undefined for a key segment the seam would refuse", () => {
    // The seam brands `<scope>/<id>` as two lowercase hyphenated identifiers.
    // A key it would reject is worse than no store: the caller would believe a
    // token was kept when the write never landed.
    const { credentials } = seamOver();
    for (const bad of ["OpenCode", "open code", "open_code", "", "open.code"]) {
      expect(
        createTokenStore({
          credentials,
          plane: bad,
          scope: "dsh-opencode-patch",
        }),
        `plane "${bad}"`
      ).toBeUndefined();
      expect(
        createTokenStore({ credentials, plane: "opencode", scope: bad }),
        `scope "${bad}"`
      ).toBeUndefined();
    }
    // And the legal one is not.
    expect(
      createTokenStore({
        credentials,
        plane: "opencode-go",
        scope: "dsh-opencode-patch",
      })?.key
    ).toBe("dsh-opencode-patch/opencode-go");
  });

  it("scopes its key, so it can never name another plugin's record", () => {
    const { credentials, records } = seamOver();
    const store = createTokenStore({
      credentials,
      plane: "opencode",
      scope: "dsh-opencode-patch",
    });
    expect(store?.key).toBe("dsh-opencode-patch/opencode");
    // Another plugin's references and this plugin's records are different
    // address spaces: a write here lands under this plugin's scope alone.
    expect([...records.keys()]).toEqual([]);
    expect(store?.key.startsWith("llm-pi-ai/")).toBe(false);
  });
});

describe("token-store: a login that survives being read back", () => {
  it("writes the pair as one grant and reads it back whole", async () => {
    const { credentials, records } = seamOver();
    const store = createTokenStore({
      credentials,
      plane: "opencode",
      scope: "dsh-opencode-patch",
    });

    await store?.write({
      accessToken: "access-one",
      account: "acme",
      expiresInSeconds: 3600,
      refreshToken: "refresh-one",
    });

    // The payload is the seam's `grant` shape: a kind and an owner-defined
    // payload, never a concatenated string.
    const stored = records.get("dsh-opencode-patch/opencode") as {
      accessToken: string;
      refreshToken: string;
    };
    expect(stored.accessToken).toBe("access-one");
    expect(stored.refreshToken).toBe("refresh-one");

    const read = await store?.read();
    expect(read).toMatchObject({
      accessToken: "access-one",
      account: "acme",
      refreshToken: "refresh-one",
    });
    // Expiry survives as a REMAINING duration, so a reader does not have to
    // know when the write happened.
    expect(read?.expiresInSeconds).toBeGreaterThan(3500);
    expect(read?.expiresInSeconds).toBeLessThanOrEqual(3600);
  });

  it("writes through modifyRecord, which is the seam's only atomic path", async () => {
    // The Console rotates the refresh token with every grant. A write that was
    // a read followed by a write could lose the token another process obtained
    // in between; `modifyRecord` is one operation under the seam's lock.
    const { calls, credentials } = seamOver();
    const store = createTokenStore({
      credentials,
      plane: "opencode",
      scope: "dsh-opencode-patch",
    });
    await store?.write({
      accessToken: "a",
      expiresInSeconds: 60,
      refreshToken: "r",
    });
    expect(calls).toEqual(["modifyRecord"]);
    expect(calls).not.toContain("set");
  });

  it("replaces the whole pair rather than merging into what was there", async () => {
    const { credentials, records } = seamOver();
    const store = createTokenStore({
      credentials,
      plane: "opencode",
      scope: "dsh-opencode-patch",
    });
    await store?.write({
      accessToken: "access-one",
      expiresInSeconds: 60,
      refreshToken: "refresh-one",
    });
    await store?.write({
      accessToken: "access-two",
      expiresInSeconds: 60,
      refreshToken: "refresh-two",
    });
    const stored = records.get("dsh-opencode-patch/opencode") as {
      accessToken: string;
      refreshToken: string;
    };
    expect(stored.accessToken).toBe("access-two");
    expect(stored.refreshToken).toBe("refresh-two");
    // And the old refresh token is gone, which is the whole point: it is the
    // one the server has already rotated away.
    expect(JSON.stringify(stored)).not.toContain("refresh-one");
  });

  it("stores an expiry as an instant, so a token read after a restart is aged", async () => {
    const { credentials } = seamOver();
    const store = createTokenStore({
      credentials,
      plane: "opencode",
      scope: "dsh-opencode-patch",
    });
    await store?.write({
      accessToken: "a",
      expiresInSeconds: 120,
      refreshToken: "r",
    });
    // Time passes without a re-read.
    vi.setSystemTime(NOW_MS + 60_000);
    const seen = await store?.read();
    expect(seen?.expiresInSeconds).toBe(60);
    vi.setSystemTime(NOW_MS + 200_000);
    const expired = await store?.read();
    // Expired reads as zero, never as negative: a duration below zero would
    // invite arithmetic on it elsewhere.
    expect(expired?.expiresInSeconds).toBe(0);
    expect(expired?.accessToken).toBe("a");
  });

  it("clears a login, and clearing an absent one is a no-op", async () => {
    const { credentials, records } = seamOver();
    const store = createTokenStore({
      credentials,
      plane: "opencode",
      scope: "dsh-opencode-patch",
    });
    await store?.write({
      accessToken: "a",
      expiresInSeconds: 60,
      refreshToken: "r",
    });
    await store?.clear();
    expect(records.size).toBe(0);
    await expect(store?.read()).resolves.toBeUndefined();
    await expect(store?.clear()).resolves.toBeUndefined();
  });
});

describe("token-store: what it refuses to interpret", () => {
  it("reads nothing where no record is stored", async () => {
    const { credentials } = seamOver();
    const store = createTokenStore({
      credentials,
      plane: "opencode",
      scope: "dsh-opencode-patch",
    });
    await expect(store?.read()).resolves.toBeUndefined();
  });

  it("does not interpret a record of another kind", async () => {
    const { credentials, records } = seamOver();
    records.set("dsh-opencode-patch/opencode", { key: "sk-another-plugin" });
    const store = createTokenStore({
      credentials,
      plane: "opencode",
      scope: "dsh-opencode-patch",
    });
    // Someone else's payload under this key is not a login. Reading it as one
    // would be guessing at a shape this plugin never wrote.
    await expect(store?.read()).resolves.toBeUndefined();
  });

  it("does not interpret a grant payload that is not one of ours", async () => {
    const { credentials, records } = seamOver();
    records.set("dsh-opencode-patch/opencode", {
      token: "someone-elses-shape",
    });
    const store = createTokenStore({
      credentials,
      plane: "opencode",
      scope: "dsh-opencode-patch",
    });
    await expect(store?.read()).resolves.toBeUndefined();
  });

  it.each([undefined, null, "tomorrow", Number.NaN, Number.POSITIVE_INFINITY])(
    "treats an invalid stored expiry (%s) as stale",
    async (expiresAt) => {
      const { credentials, records } = seamOver();
      records.set("dsh-opencode-patch/opencode", {
        accessToken: "st_legacy",
        refreshToken: "rt_legacy",
        expiresAt,
      });
      const store = createTokenStore({
        credentials,
        plane: "opencode",
        scope: "dsh-opencode-patch",
      });
      await expect(store!.read()).resolves.toMatchObject({
        accessToken: "st_legacy",
        expiresInSeconds: 0,
      });
      await expect(store!.needsRefresh()).resolves.toEqual({ kind: "stale" });
    }
  );

  it("carries a login with no refresh token without inventing one", async () => {
    const { credentials } = seamOver();
    const store = createTokenStore({
      credentials,
      plane: "opencode",
      scope: "dsh-opencode-patch",
    });
    await store?.write({
      accessToken: "a",
      expiresInSeconds: 60,
      refreshToken: undefined,
    });
    const read = await store?.read();
    expect(read?.accessToken).toBe("a");
    expect(read?.refreshToken).toBeUndefined();
  });
});

describe("token-store: deciding whether a refresh is needed", () => {
  it("says a fresh token needs no refresh", async () => {
    const { credentials } = seamOver();
    const store = createTokenStore({
      credentials,
      plane: "opencode",
      scope: "dsh-opencode-patch",
    });
    await store?.write({
      accessToken: "a",
      expiresInSeconds: 3600,
      refreshToken: "r",
    });
    await expect(store?.needsRefresh()).resolves.toEqual({
      kind: "current",
      token: expect.objectContaining({ accessToken: "a" }),
    });
  });

  it("calls a token close to expiry stale, so a refresh can start in time", async () => {
    const { credentials } = seamOver();
    const store = createTokenStore({
      credentials,
      plane: "opencode",
      scope: "dsh-opencode-patch",
    });
    // Expires in 30s, which is inside a 60s window.
    await store?.write({
      accessToken: "a",
      expiresInSeconds: 30,
      refreshToken: "r",
    });
    // A discriminated `stale`, with no token attached: a token about to expire
    // is not a token to hand out, and one attached would invite its use.
    await expect(store?.needsRefresh(60_000)).resolves.toEqual({
      kind: "stale",
    });
  });

  it("calls an absent login stale, because there is nothing to refresh", async () => {
    const { credentials } = seamOver();
    const store = createTokenStore({
      credentials,
      plane: "opencode",
      scope: "dsh-opencode-patch",
    });
    await expect(store?.needsRefresh()).resolves.toEqual({ kind: "stale" });
  });

  it("keeps the two planes apart", async () => {
    const { credentials, records } = seamOver();
    const zen = createTokenStore({
      credentials,
      plane: "opencode",
      scope: "dsh-opencode-patch",
    });
    const go = createTokenStore({
      credentials,
      plane: "opencode-go",
      scope: "dsh-opencode-patch",
    });
    await zen?.write({ accessToken: "zen-a", expiresInSeconds: 60 });
    // The Go plane's store must not see the Zen login.
    await expect(go?.read()).resolves.toBeUndefined();
    expect([...records.keys()]).toEqual(["dsh-opencode-patch/opencode"]);
    await go?.write({ accessToken: "go-a", expiresInSeconds: 60 });
    await expect(zen?.read()).resolves.toMatchObject({ accessToken: "zen-a" });
    await expect(go?.read()).resolves.toMatchObject({ accessToken: "go-a" });
  });
});
