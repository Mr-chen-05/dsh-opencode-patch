/**
 * Creating a login, and the one thing it must not forget.
 *
 * @module dsh-opencode-patch/login-flow.test
 */

import { describe, expect, it, vi } from "vitest";

import { ConsoleAuthClient } from "../src/console-auth.ts";
import type { CredentialsWriter } from "../src/cordis-context.ts";
import { beginLogin, orgForLogin, summarizeLogin } from "../src/login-flow.ts";
import { createTokenStore } from "../src/token-store.ts";

const CODE_RESPONSE = {
  device_code: "dc_measured",
  expires_in: 600,
  interval: 0,
  user_code: "HQFZ-NQPQ",
  verification_uri: "/console/device",
  verification_uri_complete: "/console/device?user_code=HQFZ-NQPQ",
};

const TOKEN_RESPONSE = {
  access_token: "st_measured",
  expires_in: 3600,
  refresh_token: "rt_measured",
  token_type: "Bearer",
};

/** The account and org reads, in the shapes the source shows. */
const ACCOUNT_RESPONSE = { email: "someone@example.com", id: "acc_measured" };
const ORGS_RESPONSE = [
  { id: "wrk_first", name: "First" },
  { id: "wrk_second", name: "Second" },
];

/** A Console that answers the whole login, recording every request. */
const consoleAnswering = (
  overrides: Record<string, unknown> = {}
): { client: ConsoleAuthClient; paths: string[] } => {
  const paths: string[] = [];
  const answers: Record<string, unknown> = {
    "/api/orgs": ORGS_RESPONSE,
    "/api/user": ACCOUNT_RESPONSE,
    "/auth/device/code": CODE_RESPONSE,
    "/auth/device/token": TOKEN_RESPONSE,
    ...overrides,
  };
  const fetchImpl = vi.fn(async (input: unknown) => {
    const url = String(input);
    const path = Object.keys(answers).find((key) => url.endsWith(key));
    paths.push(path ?? url);
    if (path === undefined) {
      return Response.json({ error: "unexpected_path" }, { status: 404 });
    }
    return Response.json(answers[path]);
  });
  return {
    client: new ConsoleAuthClient({
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    }),
    paths,
  };
};

const storeOver = (): {
  credentials: CredentialsWriter;
  records: Map<string, unknown>;
} => {
  const records = new Map<string, unknown>();
  return {
    credentials: {
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
    },
    records,
  };
};

const storeFor = (credentials: CredentialsWriter) =>
  createTokenStore({
    credentials,
    plane: "opencode",
    scope: "dsh-opencode-patch",
  });

describe("login-flow: absent when a login cannot be kept", () => {
  it("is undefined with no store to write into", async () => {
    const { client } = consoleAnswering();
    // A flow that could not keep its result would leave the user approved and
    // unauthenticated, which is worse than not starting one.
    await expect(
      beginLogin({ client, store: undefined })
    ).resolves.toBeUndefined();
  });
});

describe("login-flow: what a login learns before it stores anything", () => {
  it("answers a pending poll after one request, without starting a wait", async () => {
    const { client, paths } = consoleAnswering({
      "/auth/device/token": {
        error: "authorization_pending",
        error_description: "still waiting",
      },
    });
    const { credentials } = storeOver();
    const attempt = await beginLogin({ client, store: storeFor(credentials) });
    await expect(attempt?.poll()).resolves.toEqual({ kind: "pending" });
    expect(paths).toEqual(["/auth/device/code", "/auth/device/token"]);
  });

  it("reads the account and the orgs with the token it just obtained", async () => {
    const { client, paths } = consoleAnswering();
    const { credentials, records } = storeOver();
    const attempt = await beginLogin({ client, store: storeFor(credentials) });
    expect(attempt).toBeDefined();

    const result = await attempt?.complete({ deadlineMs: 60_000 });

    expect(result?.kind).toBe("signed-in");
    // The reads happen AFTER the token, because the token is what authorizes
    // them — and this is the only moment the account is knowable at all.
    expect(paths).toEqual([
      "/auth/device/code",
      "/auth/device/token",
      "/api/user",
      "/api/orgs",
    ]);

    const stored = records.get("dsh-opencode-patch/opencode") as {
      accessToken: string;
      orgId: string;
      orgs: { id: string }[];
      owner: { email: string; id: string };
      refreshToken: string;
    };
    expect(stored.accessToken).toBe("st_measured");
    expect(stored.refreshToken).toBe("rt_measured");
    expect(stored.owner).toEqual({
      email: "someone@example.com",
      id: "acc_measured",
    });
    expect(stored.orgId).toBe("wrk_first");
    expect(stored.orgs.map((org) => org.id)).toEqual([
      "wrk_first",
      "wrk_second",
    ]);
  });

  it("reads the stored login back with its owner intact", async () => {
    const { client } = consoleAnswering();
    const { credentials } = storeOver();
    const store = storeFor(credentials);
    const attempt = await beginLogin({ client, store });
    await attempt?.complete({ deadlineMs: 60_000 });

    const login = await store?.read();
    expect(login?.owner?.email).toBe("someone@example.com");
    expect(login?.orgId).toBe("wrk_first");
    expect(orgForLogin(login)).toBe("wrk_first");
  });

  it("stores NOTHING when the owner cannot be read", async () => {
    // The failure this guards is the one that looks like success: a token stored
    // without its org is a credential that authenticates and cannot reach the
    // free tier, which is exactly the wall this work exists to remove.
    const { client } = consoleAnswering({
      "/api/user": { error: "unauthorized" },
    });
    const { credentials, records } = storeOver();
    const attempt = await beginLogin({ client, store: storeFor(credentials) });

    const result = await attempt?.complete({ deadlineMs: 60_000 });

    expect(result?.kind).toBe("failed");
    if (result?.kind === "failed") {
      expect(result.detail).toContain("not its account");
    }
    expect(records.size).toBe(0);
  });

  it("stores nothing when the approval never comes", async () => {
    const { client } = consoleAnswering({
      "/auth/device/token": {
        error: "access_denied",
        error_description: "declined",
      },
    });
    const { credentials, records } = storeOver();
    const attempt = await beginLogin({ client, store: storeFor(credentials) });
    const result = await attempt?.complete({ deadlineMs: 60_000 });
    expect(result?.kind).toBe("failed");
    expect(records.size).toBe(0);
  });

  it("keeps the org the Console listed first, which is what the client activates", async () => {
    const { client } = consoleAnswering({
      "/api/orgs": [{ id: "wrk_only", name: "Only" }],
    });
    const { credentials } = storeOver();
    const attempt = await beginLogin({ client, store: storeFor(credentials) });
    const result = await attempt?.complete({ deadlineMs: 60_000 });
    expect(result?.kind).toBe("signed-in");
    if (result?.kind === "signed-in") {
      expect(result.login.orgId).toBe("wrk_only");
    }
  });

  it("carries no org when the account has none", async () => {
    const { client } = consoleAnswering({ "/api/orgs": [] });
    const { credentials } = storeOver();
    const attempt = await beginLogin({ client, store: storeFor(credentials) });
    const result = await attempt?.complete({ deadlineMs: 60_000 });
    expect(result?.kind).toBe("signed-in");
    if (result?.kind === "signed-in") {
      expect(result.login.orgId).toBeUndefined();
      expect(result.login.orgs).toEqual([]);
    }
  });
});

describe("login-flow: what a settings surface may see", () => {
  it("summarizes a login without handing over the credential it exists to keep", async () => {
    const { client } = consoleAnswering();
    const { credentials } = storeOver();
    const attempt = await beginLogin({ client, store: storeFor(credentials) });
    const result = await attempt?.complete({ deadlineMs: 60_000 });
    const summary = summarizeLogin(
      result?.kind === "signed-in" ? result.login : undefined
    );
    // Email and org: what a surface shows. The access token rides along only
    // because this value is the login itself; a surface that wants to RENDER
    // reads the email and the org and nothing else.
    expect(summary?.email).toBe("someone@example.com");
    expect(summary?.orgId).toBe("wrk_first");
    expect(summary?.orgs).toHaveLength(2);
    expect(summarizeLogin()).toBeUndefined();
  });
});
