import { afterEach, describe, expect, it, vi } from "vitest";

import { ConsoleAuthClient } from "../src/console-auth.ts";
import { name } from "../src/identity.ts";
import { createLoginCredentialReader } from "../src/login-credential.ts";
import { createTokenStore } from "../src/token-store.ts";
import { createCredentialsSeam, createOpencodeStore } from "./test-helpers.ts";

const storeFor = (
  credentials: ReturnType<typeof createCredentialsSeam>["credentials"],
  plane = "opencode"
) => {
  const store = createTokenStore({ credentials, plane, scope: name });
  if (store === undefined) {
    throw new Error("fixture store was not created");
  }
  return store;
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("shared login credential reader", () => {
  it("rejects unknown planes without consulting the seam", async () => {
    const get = vi.fn();
    await expect(
      createLoginCredentialReader({ get })("")
    ).resolves.toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });

  it("sees a service and login that appear after the reader was built", async () => {
    const { credentials } = createCredentialsSeam();
    let available = false;
    const read = createLoginCredentialReader({
      get: () => (available ? credentials : undefined),
    });
    await expect(read("opencode")).resolves.toBeUndefined();
    available = true;
    const store = storeFor(credentials);
    await store.write({
      accessToken: "st_fixture",
      expiresInSeconds: 3600,
      orgId: "org_fixture",
    });
    await expect(read("opencode-go")).resolves.toMatchObject({
      accessToken: "st_fixture",
      orgId: "org_fixture",
    });
    await store.clear();
    await expect(read("opencode-go")).resolves.toBeUndefined();
  });

  it("prefers the requested plane's grant and only then the other plane", async () => {
    const { credentials, ctx } = createCredentialsSeam();
    const zen = storeFor(credentials);
    const go = storeFor(credentials, "opencode-go");
    await zen.write({
      accessToken: "st_zen",
      expiresInSeconds: 3600,
      orgId: "org_zen",
    });
    await go.write({
      accessToken: "st_go",
      expiresInSeconds: 3600,
      orgId: "org_go",
    });
    const read = createLoginCredentialReader(ctx);
    await expect(read("opencode-go")).resolves.toMatchObject({
      accessToken: "st_go",
      orgId: "org_go",
    });
    await expect(read("opencode")).resolves.toMatchObject({
      accessToken: "st_zen",
      orgId: "org_zen",
    });
    await go.clear();
    await expect(read("opencode-go")).resolves.toMatchObject({
      accessToken: "st_zen",
      orgId: "org_zen",
    });
  });

  it("reads the installation account only when opted in and never ahead of a DSH grant", async () => {
    const fixture = createOpencodeStore([], {
      accessToken: "st_installation",
      orgId: "org_installation",
      tokenExpiry: 0,
    });
    vi.stubEnv("XDG_DATA_HOME", fixture.root);
    const { credentials, ctx, records } = createCredentialsSeam();
    try {
      await expect(
        createLoginCredentialReader(ctx)("opencode-go")
      ).resolves.toBeUndefined();
      const read = createLoginCredentialReader(ctx, true);
      await expect(read("opencode-go")).resolves.toMatchObject({
        accessToken: "st_installation",
        orgId: "org_installation",
      });
      expect(records.size).toBe(0);
      await storeFor(credentials).write({
        accessToken: "st_dsh",
        expiresInSeconds: 3600,
        orgId: "org_dsh",
      });
      await expect(read("opencode-go")).resolves.toMatchObject({
        accessToken: "st_dsh",
        orgId: "org_dsh",
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("fails closed on a refused refresh rather than selecting another owner", async () => {
    const { credentials, ctx } = createCredentialsSeam();
    await storeFor(credentials).write({
      accessToken: "st_expired",
      refreshToken: "rt_revoked",
      expiresInSeconds: 0,
    });
    await storeFor(credentials, "opencode-go").write({
      accessToken: "st_other_owner",
      expiresInSeconds: 3600,
    });
    const fixture = createOpencodeStore([], {
      accessToken: "st_installation_owner",
    });
    vi.stubEnv("XDG_DATA_HOME", fixture.root);
    const refresh = vi.fn(async () =>
      Response.json(
        { error: "invalid_grant", error_description: "private_fixture_detail" },
        { status: 400 }
      )
    );
    try {
      const read = createLoginCredentialReader(
        ctx,
        true,
        new ConsoleAuthClient({ fetch: refresh })
      );
      await expect(read("opencode")).rejects.toThrow(
        /MISSING_CREDENTIAL.*refresh/
      );
      await expect(read("opencode")).rejects.not.toThrow(
        /private_fixture_detail|rt_revoked|st_expired/
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("shares a refresh across both planes and preserves the grant's owner and org", async () => {
    const { credentials, ctx } = createCredentialsSeam();
    const store = storeFor(credentials);
    const metadata = {
      orgId: "org_owner",
      orgs: [{ id: "org_owner", name: "Fixture" }],
      owner: { id: "user_fixture", email: "you@example.com" },
    };
    await store.write({
      accessToken: "st_old",
      refreshToken: "rt_old",
      expiresInSeconds: 10,
      ...metadata,
    });
    const refresh = vi.fn(async () =>
      Response.json({
        access_token: "st_new",
        refresh_token: "rt_new",
        expires_in: 3600,
      })
    );
    const read = createLoginCredentialReader(
      ctx,
      false,
      new ConsoleAuthClient({ fetch: refresh })
    );
    const results = await Promise.all([
      read("opencode"),
      read("opencode-go"),
      read("opencode"),
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result).toMatchObject({
        accessToken: "st_new",
        orgId: "org_owner",
      });
    }
    await expect(store.read()).resolves.toMatchObject({
      accessToken: "st_new",
      refreshToken: "rt_new",
      ...metadata,
    });
    await expect(read("opencode-go")).resolves.toMatchObject({
      accessToken: "st_new",
      orgId: "org_owner",
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
