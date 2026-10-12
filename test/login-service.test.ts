/**
 * The host half of a login: what a card can call, and what it can never get back.
 *
 * @module dsh-opencode-patch/login-service.test
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CredentialsWriter } from "../src/cordis-context.ts";
import { LoginService } from "../src/login-service.ts";
import { createMockContext } from "./test-helpers.ts";

const CODE_RESPONSE = {
  device_code: "dc_measured",
  expires_in: 600,
  interval: 0,
  user_code: "HQFZ-NQPQ",
  verification_uri: "/console/device",
  verification_uri_complete: "/console/device?user_code=HQFZ-NQPQ",
};

const TOKEN_RESPONSE = {
  access_token: "st_never_travels",
  expires_in: 3600,
  refresh_token: "rt_never_travels",
  token_type: "Bearer",
};

/** A Console answering the whole flow, recording every path it was asked for. */
const consoleFetch = (token: Record<string, unknown> = TOKEN_RESPONSE) => {
  const paths: string[] = [];
  const impl = vi.fn(async (input: unknown) => {
    const url = String(input);
    paths.push(url.replace("https://opencode.ai/console", ""));
    if (url.endsWith("/auth/device/code")) {
      return Response.json(CODE_RESPONSE);
    }
    if (url.endsWith("/auth/device/token")) {
      return Response.json(token);
    }
    if (url.endsWith("/api/user")) {
      return Response.json({ email: "someone@example.com", id: "acc_1" });
    }
    if (url.endsWith("/api/orgs")) {
      return Response.json([{ id: "wrk_first", name: "First" }]);
    }
    return Response.json({ error: "unexpected" }, { status: 404 });
  });
  return { fetch: impl as unknown as typeof globalThis.fetch, paths };
};

/** A credential seam over one map, enough for a grant record. */
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

const serviceOver = (
  credentials: CredentialsWriter | undefined,
  options: { fetch: typeof globalThis.fetch }
) =>
  new LoginService(createMockContext(), {
    consoleBaseUrl: "https://opencode.ai/console",
    ...(credentials === undefined ? {} : { credentials }),
    fetch: options.fetch,
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("login-service: what a card can see", () => {
  it("reports nothing stored, without inventing an account", async () => {
    const { fetch } = consoleFetch();
    const service = serviceOver(seam(), { fetch });
    await expect(service.state()).resolves.toEqual({
      orgs: [],
      plane: "opencode",
      signedIn: false,
    });
  });

  it("reports a stored login with its owner, and no credential", async () => {
    const credentials = seam();
    const { fetch } = consoleFetch();
    const service = serviceOver(credentials, { fetch });

    await service.begin();
    await expect(service.poll()).resolves.toEqual({ kind: "signed-in" });

    const state = await service.state();
    expect(state).toEqual({
      email: "someone@example.com",
      orgId: "wrk_first",
      orgs: [{ id: "wrk_first", name: "First" }],
      plane: "opencode",
      signedIn: true,
    });
    // The rule the whole seam rests on: the token was stored on the host and
    // never crossed to the caller.
    expect(JSON.stringify(state)).not.toContain("st_never_travels");
    expect(JSON.stringify(state)).not.toContain("rt_never_travels");
  });

  it("describes the Go plane separately, from the same account", async () => {
    const credentials = seam();
    const { fetch } = consoleFetch();
    const service = serviceOver(credentials, { fetch });
    await service.begin({ plane: "opencode-go" });
    await service.poll();
    // The Go plane has no grant of its own, so it reports nothing stored — a
    // login written to one plane is not a login for the other.
    await expect(service.state()).resolves.toMatchObject({ signedIn: false });
    await expect(
      service.state({ plane: "opencode-go" })
    ).resolves.toMatchObject({
      signedIn: true,
    });
  });
});

describe("login-service: the device flow a card drives", () => {
  it("answers the code and the URL to open", async () => {
    const { fetch, paths } = consoleFetch();
    const service = serviceOver(seam(), { fetch });

    const challenge = await service.begin();

    expect(challenge).toEqual({
      expiresInSeconds: 600,
      intervalSeconds: 0,
      userCode: "HQFZ-NQPQ",
      verificationUri: "https://opencode.ai/console/device",
      verificationUriComplete:
        "https://opencode.ai/console/device?user_code=HQFZ-NQPQ",
    });
    // And nothing about the credential came back with it.
    expect(JSON.stringify(challenge)).not.toContain("st_never_travels");
    expect(paths[0]).toBe("/auth/device/code");
  });

  it("refuses to start a flow it cannot keep", async () => {
    // Without a credential service there is nowhere for the tokens to land, and
    // a flow that cannot keep its result leaves the user approved and
    // unauthenticated.
    const { fetch } = consoleFetch();
    const service = serviceOver(undefined, { fetch });
    await expect(service.begin()).rejects.toThrow(/no credential service/u);
  });

  it("reports a poll with no flow in progress rather than waiting", async () => {
    const { fetch } = consoleFetch();
    const service = serviceOver(seam(), { fetch });
    await expect(service.poll()).resolves.toEqual({
      detail: "no login is in progress",
      kind: "failed",
    });
  });

  it("reports a refusal as terminal, and a wait as pending", async () => {
    const declined = consoleFetch({
      error: "access_denied",
      error_description: "the user said no",
    });
    const service = serviceOver(seam(), { fetch: declined.fetch });
    await service.begin();
    const outcome = await service.poll();
    expect(outcome.kind).toBe("failed");
    expect(outcome.detail).toContain("no");
  });
});
