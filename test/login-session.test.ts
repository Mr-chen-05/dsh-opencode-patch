/**
 * A login in use: when it refreshes, when it does not, and what it says when it
 * cannot.
 *
 * @module dsh-opencode-patch/login-session.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConsoleAuthClient } from "../src/console-auth.ts";
import type { CredentialsWriter } from "../src/cordis-context.ts";
import { createLoginSession } from "../src/login-session.ts";
import { createTokenStore } from "../src/token-store.ts";

const NOW_MS = 1_800_000_000_000;

const seam = (): CredentialsWriter => {
  const records = new Map<string, unknown>();
  return {
    deleteRecord: async (key: string) => {
      records.delete(key);
    },
    readRecord: async (key: string) => {
      const payload = records.get(key);
      return payload === undefined ? undefined : { kind: "grant", payload };
    },
    resolve: vi.fn(),
    set: vi.fn(),
    unset: vi.fn(),
    writeGrant: async (key: string, payload: unknown) => {
      records.set(key, payload);
    },
  };
};

/** A Console whose refresh grant answers `token`, counting every call. */
const clientAnswering = (
  token: { accessToken: string; refreshToken: string } | Error
): { client: ConsoleAuthClient; refreshes: () => number } => {
  let calls = 0;
  const fetchImpl = vi.fn(async () => {
    calls += 1;
    if (token instanceof Error) {
      return Response.json(
        { error: "invalid_grant", error_description: token.message },
        { status: 400 }
      );
    }
    return Response.json({
      access_token: token.accessToken,
      expires_in: 3600,
      refresh_token: token.refreshToken,
    });
  });
  return {
    client: new ConsoleAuthClient({
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    }),
    refreshes: () => calls,
  };
};

const sessionOver = (
  client: ConsoleAuthClient,
  withinMs?: number
): ReturnType<typeof createLoginSession> => {
  const store = createTokenStore({
    credentials: seam(),
    plane: "opencode",
    scope: "dsh-opencode-patch",
  });
  return createLoginSession(
    withinMs === undefined ? { client, store } : { client, store, withinMs }
  );
};

/**
 * Write a login into a store, asserting one exists.
 *
 * `createTokenStore` answers `undefined` when a seam or a key would not take a
 * grant, so a case that got `undefined` must fail here rather than silently
 * testing nothing.
 */
const writeStored = async (
  store: ReturnType<typeof createTokenStore>,
  tokens: {
    accessToken: string;
    expiresInSeconds: number;
    refreshToken?: string;
  }
) => {
  if (store === undefined) {
    throw new Error("no token store: the seam or the key was refused");
  }
  await store.write(tokens);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("login-session: absent when a login cannot be kept", () => {
  it("is undefined with no store, and no token is invented", () => {
    const { client } = clientAnswering({ accessToken: "a", refreshToken: "r" });
    expect(createLoginSession({ client, store: undefined })).toBeUndefined();
  });
});

describe("login-session: a stored login in use", () => {
  it("uses one grant snapshot per token resolution", async () => {
    const credentials = seam();
    const readRecord = vi.spyOn(credentials, "readRecord");
    const store = createTokenStore({
      credentials,
      plane: "opencode",
      scope: "dsh-opencode-patch",
    });
    const { client } = clientAnswering({
      accessToken: "access-new",
      refreshToken: "refresh-new",
    });
    await store!.write({
      accessToken: "access-old",
      refreshToken: "refresh-old",
      expiresInSeconds: 10,
      account: "fixture-account",
    });
    const result = await createLoginSession({ client, store })!.token();
    expect(readRecord).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      kind: "ok",
      token: { accessToken: "access-new", account: "fixture-account" },
    });
    await expect(store!.read()).resolves.toMatchObject({
      account: "fixture-account",
    });
  });

  it("hands out a stored token without refreshing it", async () => {
    const { client, refreshes } = clientAnswering({
      accessToken: "access-two",
      refreshToken: "refresh-two",
    });
    const store = createTokenStore({
      credentials: seam(),
      plane: "opencode",
      scope: "dsh-opencode-patch",
    });
    const session = createLoginSession({ client, store });
    await writeStored(store, {
      accessToken: "access-one",
      expiresInSeconds: 3600,
      refreshToken: "refresh-one",
    });

    const result = await session?.token();
    // A token with an hour left needs no refresh, so no network call happens —
    // the request this authenticates is the one that has to succeed.
    expect(result?.kind).toBe("ok");
    expect(refreshes()).toBe(0);
  });

  it("refreshes before handing out a token that is about to expire", async () => {
    const { client, refreshes } = clientAnswering({
      accessToken: "access-two",
      refreshToken: "refresh-two",
    });
    const store = createTokenStore({
      credentials: seam(),
      plane: "opencode",
      scope: "dsh-opencode-patch",
    });
    const session = createLoginSession({ client, store, withinMs: 120_000 });
    await writeStored(store, {
      accessToken: "access-one",
      expiresInSeconds: 30,
      refreshToken: "refresh-one",
    });

    const result = await session?.token();
    expect(result?.kind).toBe("ok");
    expect(refreshes()).toBe(1);
    if (result?.kind === "ok") {
      expect(result.token.accessToken).toBe("access-two");
    }
    // And the rotated pair is what is stored, so the NEXT call reads the new
    // refresh token rather than the one the server replaced.
    const stored = await store?.read();
    expect(stored).toMatchObject({
      accessToken: "access-two",
      refreshToken: "refresh-two",
    });
  });

  it("does not refresh again while the new token is fresh", async () => {
    const { client, refreshes } = clientAnswering({
      accessToken: "access-two",
      refreshToken: "refresh-two",
    });
    const store = createTokenStore({
      credentials: seam(),
      plane: "opencode",
      scope: "dsh-opencode-patch",
    });
    const session = createLoginSession({ client, store });
    await writeStored(store, {
      accessToken: "access-one",
      expiresInSeconds: 10,
      refreshToken: "refresh-one",
    });

    await session?.token();
    const second = await session?.token();
    expect(second?.kind).toBe("ok");
    // One refresh, then the token it obtained — a second call must not rotate
    // again while the first result is still good.
    expect(refreshes()).toBe(1);
  });
});

describe("login-session: one refresh at a time", () => {
  it("shares one refresh between concurrent callers", async () => {
    // Two calls in the same window must not each rotate the refresh token: the
    // second would present one the server has already replaced, and would throw
    // the caller away from a perfectly good login.
    const { client, refreshes } = clientAnswering({
      accessToken: "access-two",
      refreshToken: "refresh-two",
    });
    const store = createTokenStore({
      credentials: seam(),
      plane: "opencode",
      scope: "dsh-opencode-patch",
    });
    const session = createLoginSession({ client, store });
    await writeStored(store, {
      accessToken: "access-one",
      expiresInSeconds: 10,
      refreshToken: "refresh-one",
    });

    const [first, second] = await Promise.all([
      session?.token(),
      session?.token(),
    ]);
    expect(refreshes()).toBe(1);
    expect(first?.kind).toBe("ok");
    expect(second?.kind).toBe("ok");
    // Both callers see the same rotated pair, not two different ones.
    if (first?.kind === "ok" && second?.kind === "ok") {
      expect(first.token.accessToken).toBe("access-two");
      expect(second.token.accessToken).toBe("access-two");
    }
  });

  it("allows a later refresh once the previous one has settled", async () => {
    const { client, refreshes } = clientAnswering({
      accessToken: "access-two",
      refreshToken: "refresh-two",
    });
    const store = createTokenStore({
      credentials: seam(),
      plane: "opencode",
      scope: "dsh-opencode-patch",
    });
    const session = createLoginSession({ client, store });
    await writeStored(store, {
      accessToken: "access-one",
      expiresInSeconds: 10,
      refreshToken: "refresh-one",
    });
    await session?.token();
    // Time passes and the freshly stored token nears expiry again.
    vi.setSystemTime(NOW_MS + 3_600_000);
    await session?.token();
    // The in-flight promise is cleared on settle, so the second window can
    // refresh rather than replaying the first result forever.
    expect(refreshes()).toBe(2);
  });
});

describe("login-session: what it says when it cannot help", () => {
  it("reports no login rather than an invented token", async () => {
    const { client, refreshes } = clientAnswering({
      accessToken: "a",
      refreshToken: "r",
    });
    const session = sessionOver(client);
    const result = await session?.token();
    expect(result).toEqual({ failure: { reason: "no login" }, kind: "failed" });
    // Nothing was called: there is no refresh token to present.
    expect(refreshes()).toBe(0);
  });

  it("reports a refusal by name, and keeps the stored login", async () => {
    const { client } = clientAnswering(new Error("refresh token revoked"));
    const store = createTokenStore({
      credentials: seam(),
      plane: "opencode",
      scope: "dsh-opencode-patch",
    });
    const session = createLoginSession({ client, store });
    await writeStored(store, {
      accessToken: "access-one",
      expiresInSeconds: 10,
      refreshToken: "refresh-one",
    });

    const result = await session?.token();
    expect(result?.kind).toBe("failed");
    if (result?.kind === "failed") {
      expect(result.failure).toMatchObject({ reason: "refresh refused" });
      expect(JSON.stringify(result.failure)).toContain("refresh token revoked");
    }
    // A refused refresh does not erase the login: the stored pair is what the
    // user can re-authorize from, and dropping it would lose the refresh token.
    await expect(store?.read()).resolves.toMatchObject({
      accessToken: "access-one",
    });
  });

  it("reports a grant with no refresh token, instead of handing out a stale one", async () => {
    const { client, refreshes } = clientAnswering({
      accessToken: "a",
      refreshToken: "r",
    });
    const store = createTokenStore({
      credentials: seam(),
      plane: "opencode",
      scope: "dsh-opencode-patch",
    });
    const session = createLoginSession({ client, store, withinMs: 120_000 });
    await writeStored(store, {
      accessToken: "access-one",
      expiresInSeconds: 10,
    });

    const result = await session?.token();
    expect(result?.kind).toBe("failed");
    if (result?.kind === "failed") {
      expect(JSON.stringify(result.failure)).toContain("no refresh token");
    }
    expect(refreshes()).toBe(0);
  });

  it("says who is signed in without handing over the token", async () => {
    const { client } = clientAnswering({ accessToken: "a", refreshToken: "r" });
    const store = createTokenStore({
      credentials: seam(),
      plane: "opencode",
      scope: "dsh-opencode-patch",
    });
    const session = createLoginSession({ client, store });
    await expect(session?.signedIn()).resolves.toBe(false);
    await writeStored(store, { accessToken: "a", expiresInSeconds: 60 });
    await expect(session?.signedIn()).resolves.toBe(true);
  });

  it("drops the stored login on sign-out, and can be signed in again", async () => {
    const { client } = clientAnswering({ accessToken: "a", refreshToken: "r" });
    const store = createTokenStore({
      credentials: seam(),
      plane: "opencode",
      scope: "dsh-opencode-patch",
    });
    const session = createLoginSession({ client, store });
    await writeStored(store, { accessToken: "a", expiresInSeconds: 60 });

    await session?.signOut();
    await expect(session?.signedIn()).resolves.toBe(false);
    await expect(session?.token()).resolves.toEqual({
      failure: { reason: "no login" },
      kind: "failed",
    });
  });
});
