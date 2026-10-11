/**
 * The device flows, against the responses the Console was MEASURED returning.
 *
 * The shapes below are not invented: the code endpoint answered `200` with a
 * `device_code`, a `user_code`, a relative `verification_uri`, an `interval` of
 * 5 and an `expires_in` of 600; the token endpoint answered `400` with
 * `authorization_pending` for a real unapproved code and `invalid_grant` for
 * one it did not know. A stub that answered something else would be testing the
 * stub.
 *
 * @module dsh-opencode-patch/console-auth.test
 */

import { describe, expect, it, vi } from "vitest";

import {
  awaitAuthorization,
  CONSOLE_BASE_URL,
  ConsoleAuthClient,
  DEVICE_CODE_GRANT,
  OPENCODE_CLI_CLIENT_ID,
  absoluteVerificationUri,
} from "../src/console-auth.ts";

/** The real code-endpoint answer, verbatim in shape. */
const MEASURED_CODE_RESPONSE = {
  device_code: "mCK07oVjx6ix29measuredDeviceCodeValue",
  expires_in: 600,
  interval: 5,
  user_code: "HQFZ-NQPQ",
  verification_uri: "/console/device",
  verification_uri_complete:
    "/console/device?user_code=HQFZ-NQPQ&client_id=opencode-cli",
};

/** The real pending answer, verbatim in shape. */
const MEASURED_PENDING_RESPONSE = {
  _tag: "DeviceTokenError",
  error: "authorization_pending",
  error_description: "The authorization request is still pending",
};

/** The real refusal answer, verbatim in shape. */
const MEASURED_INVALID_RESPONSE = {
  _tag: "DeviceTokenError",
  error: "invalid_grant",
  error_description: "The device code is invalid",
};

interface Call {
  readonly body: Record<string, unknown>;
  readonly url: string;
}

/** A fetch that answers the given bodies in order, recording every call. */
const stubFetch = (
  answers: readonly (Record<string, unknown> | Error)[]
): { fetch: typeof globalThis.fetch; calls: Call[] } => {
  const calls: Call[] = [];
  let at = 0;
  const fetchImpl = vi.fn(async (input: unknown, init?: { body?: unknown }) => {
    calls.push({
      body: JSON.parse(
        typeof init?.body === "string" ? init.body : "{}"
      ) as Record<string, unknown>,
      url: String(input),
    });
    const answer = answers[Math.min(at, answers.length - 1)];
    at += 1;
    if (answer instanceof Error) {
      throw answer;
    }
    return Response.json(answer);
  });
  return { calls, fetch: fetchImpl as unknown as typeof globalThis.fetch };
};

describe("console-auth: the verification URL a human can actually open", () => {
  it("resolves the Console's relative answer against the Console", () => {
    // Measured: the endpoint answers `/console/device`, not a URL. Opening that
    // verbatim opens nothing, which is the detail a login screen gets wrong.
    expect(absoluteVerificationUri("/console/device")).toBe(
      "https://opencode.ai/console/device"
    );
    expect(absoluteVerificationUri("/console/device?user_code=HQFZ-NQPQ")).toBe(
      "https://opencode.ai/console/device?user_code=HQFZ-NQPQ"
    );
  });

  it("leaves an absolute answer alone rather than second-guessing it", () => {
    expect(absoluteVerificationUri("https://console.example/device")).toBe(
      "https://console.example/device"
    );
  });

  it("handles a relative answer for a Console that is not opencode.ai", () => {
    expect(
      absoluteVerificationUri("/console/device", "https://proxy.test/console")
    ).toBe("https://proxy.test/console/device");
  });
});

describe("console-auth: starting a device authorization", () => {
  it("reads the measured answer and turns its URI into something openable", async () => {
    const { calls, fetch } = stubFetch([MEASURED_CODE_RESPONSE]);
    const client = new ConsoleAuthClient({ fetch });

    const pending = await client.start();

    // The request is the one OpenCode's own CLI makes.
    expect(calls[0]?.url).toBe(`${CONSOLE_BASE_URL}/auth/device/code`);
    expect(calls[0]?.body).toEqual({ client_id: OPENCODE_CLI_CLIENT_ID });
    // And the answer is usable without the caller knowing it was relative.
    expect(pending.authorization.userCode).toBe("HQFZ-NQPQ");
    expect(pending.authorization.verificationUri).toBe(
      "https://opencode.ai/console/device"
    );
    expect(pending.authorization.verificationUriComplete).toBe(
      "https://opencode.ai/console/device?user_code=HQFZ-NQPQ&client_id=opencode-cli"
    );
    expect(pending.authorization.intervalSeconds).toBe(5);
    expect(pending.authorization.expiresInSeconds).toBe(600);
  });

  it("refuses a response with no code rather than polling for one", async () => {
    // A Console that moved, or a client id with no entitlement, answers with an
    // error. Starting must fail here, not poll for a device_code that is not
    // coming.
    const { fetch } = stubFetch([
      { error: "invalid_client", error_description: "unknown client" },
    ]);
    const client = new ConsoleAuthClient({ fetch });
    await expect(client.start()).rejects.toThrow(/unknown client/u);
  });

  it("surfaces a transport failure as a failure, not as a pending code", async () => {
    const { fetch } = stubFetch([new Error("network down")]);
    const client = new ConsoleAuthClient({ fetch });
    await expect(client.start()).rejects.toThrow(/network down/u);
  });
});

describe("console-auth: polling the way the Console answers", () => {
  it("reads a pending poll as pending, and sends the device grant", async () => {
    const { calls, fetch } = stubFetch([
      MEASURED_CODE_RESPONSE,
      MEASURED_PENDING_RESPONSE,
    ]);
    const client = new ConsoleAuthClient({ fetch });
    const pending = await client.start();

    await expect(pending.poll()).resolves.toEqual({ kind: "pending" });
    expect(calls[1]?.url).toBe(`${CONSOLE_BASE_URL}/auth/device/token`);
    expect(calls[1]?.body).toEqual({
      client_id: OPENCODE_CLI_CLIENT_ID,
      device_code: MEASURED_CODE_RESPONSE.device_code,
      grant_type: DEVICE_CODE_GRANT,
    });
  });

  it("treats a code the Console does not know as a failure, not a wait", async () => {
    const { fetch } = stubFetch([
      MEASURED_CODE_RESPONSE,
      MEASURED_INVALID_RESPONSE,
    ]);
    const client = new ConsoleAuthClient({ fetch });
    const pending = await client.start();

    await expect(pending.poll()).resolves.toEqual({
      detail: "The device code is invalid",
      kind: "failed",
    });
  });

  it("distinguishes a refusal and an expiry from a wait", async () => {
    const denied = stubFetch([
      MEASURED_CODE_RESPONSE,
      { error: "access_denied", error_description: "the user said no" },
    ]);
    const deniedClient = new ConsoleAuthClient({ fetch: denied.fetch });
    const deniedPending = await deniedClient.start();
    await expect(deniedPending.poll()).resolves.toEqual({
      detail: "the user said no",
      kind: "denied",
    });

    const expired = stubFetch([
      MEASURED_CODE_RESPONSE,
      { error: "expired_token", error_description: "the code expired" },
    ]);
    const expiredClient = new ConsoleAuthClient({ fetch: expired.fetch });
    const expiredPending = await expiredClient.start();
    await expect(expiredPending.poll()).resolves.toEqual({
      detail: "the code expired",
      kind: "expired",
    });
  });

  it("reads slow_down as its own outcome, so the wait can back off", async () => {
    const { fetch } = stubFetch([
      MEASURED_CODE_RESPONSE,
      { error: "slow_down", error_description: "poll less often" },
    ]);
    const slowClient = new ConsoleAuthClient({ fetch });
    const slowPending = await slowClient.start();
    await expect(slowPending.poll()).resolves.toEqual({ kind: "slow_down" });
  });
});

describe("console-auth: waiting for a human", () => {
  it("keeps polling through pending answers and returns the tokens", async () => {
    const { calls, fetch } = stubFetch([
      { ...MEASURED_CODE_RESPONSE, interval: 0 },
      MEASURED_PENDING_RESPONSE,
      MEASURED_PENDING_RESPONSE,
      {
        access_token: "access-value",
        expires_in: 3600,
        refresh_token: "refresh-value",
      },
    ]);
    const client = new ConsoleAuthClient({ fetch });
    const pending = await client.start();

    const result = await awaitAuthorization(pending, { deadlineMs: 60_000 });

    expect(result).toEqual({
      granted: {
        accessToken: "access-value",
        account: undefined,
        expiresInSeconds: 3600,
        refreshToken: "refresh-value",
      },
    });
    expect(calls).toHaveLength(4);
  });

  it("stops at the deadline instead of waiting forever", async () => {
    const { fetch } = stubFetch([
      { ...MEASURED_CODE_RESPONSE, interval: 0 },
      MEASURED_PENDING_RESPONSE,
    ]);
    const client = new ConsoleAuthClient({ fetch });
    const pending = await client.start();

    // The deadline is behind us: the first poll already answers past the
    // window, so this returns without waiting.
    const result = await awaitAuthorization(pending, { deadlineMs: -1 });
    expect(result).toEqual({
      error: { detail: expect.any(String), kind: "expired" },
    });
  });

  it("reports a refusal rather than retrying it", async () => {
    const { fetch } = stubFetch([
      { ...MEASURED_CODE_RESPONSE, interval: 0 },
      { error: "access_denied", error_description: "declined" },
    ]);
    const client = new ConsoleAuthClient({ fetch });
    const result = await awaitAuthorization(await client.start(), {
      deadlineMs: 60_000,
    });
    expect(result).toEqual({ error: { detail: "declined", kind: "denied" } });
  });

  it("reports each wait, so a login screen can show progress", async () => {
    const { fetch } = stubFetch([
      { ...MEASURED_CODE_RESPONSE, interval: 0 },
      MEASURED_PENDING_RESPONSE,
      { access_token: "a", expires_in: 1 },
    ]);
    // A recorder rather than a spy: the callback's return value is ignored, and
    // what matters is which waits it reported.
    const waits: number[] = [];
    const pending = await new ConsoleAuthClient({ fetch }).start();
    await awaitAuthorization(pending, {
      deadlineMs: 60_000,
      onWait: (seconds) => {
        waits.push(seconds);
      },
    });
    expect(waits.length).toBeGreaterThan(0);
  });
});

describe("console-auth: the refresh grant rotates both halves", () => {
  it("asks with the refresh grant and returns the NEW pair", async () => {
    const { calls, fetch } = stubFetch([
      {
        access_token: "access-two",
        expires_in: 3600,
        refresh_token: "refresh-two",
      },
    ]);
    const client = new ConsoleAuthClient({ fetch });

    const tokens = await client.refresh("refresh-one");

    expect(calls[0]?.url).toBe(`${CONSOLE_BASE_URL}/auth/device/token`);
    expect(calls[0]?.body).toEqual({
      client_id: OPENCODE_CLI_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: "refresh-one",
    });
    // The whole point: the refresh token is NEW, so storing only the access
    // token would present a token the server has already rotated away.
    expect(tokens.refreshToken).toBe("refresh-two");
    expect(tokens.accessToken).toBe("access-two");
  });

  it("names what the Console said when the grant is refused", async () => {
    const { fetch } = stubFetch([
      { error: "invalid_grant", error_description: "refresh token revoked" },
    ]);
    const client = new ConsoleAuthClient({ fetch });
    await expect(client.refresh("stale")).rejects.toThrow(
      /refresh token revoked/u
    );
  });

  it("carries the account when the Console names one", async () => {
    const { fetch } = stubFetch([
      { access_token: "a", account: "acme", expires_in: 60 },
    ]);
    await expect(
      new ConsoleAuthClient({ fetch }).refresh("r")
    ).resolves.toMatchObject({ account: "acme" });
  });
});
