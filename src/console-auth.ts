/**
 * The Console device flows, as measured.
 *
 * OpenCode signs in two ways against the same Console, and both are device
 * flows: the client asks for a code, a human approves it in a browser, and the
 * client polls for the token. What differs is what the grant unlocks — the
 * account path reads the user and the organizations, the provider path stores
 * the credential for the models endpoint — so one client serves both and the
 * caller says which it wanted.
 *
 * **Everything here was measured against the Console before it was written.**
 * The code endpoint answers `200` with a `device_code`, a `user_code`, an
 * `interval`, an `expires_in`, and a `verification_uri` that is a RELATIVE path
 * rather than a URL — which is the detail that would break a login screen that
 * opened it verbatim. The token endpoint answers `400` with
 * `authorization_pending` while nobody has approved, `400` with
 * `invalid_grant` for a code it does not know, and the token itself on success.
 * Every error body carries `error` and `error_description` under a `_tag`, and
 * the loop branches on `error` rather than on the status.
 *
 * **A rotating refresh token.** The Console returns a NEW refresh token with
 * every access token, so storing one without replacing it loses the next
 * refresh. {@link ConsoleAuthClient.complete} returns the pair together and the
 * caller writes both in one operation, because the seam's `modifyRecord` is
 * exactly the read-decide-replace this needs.
 *
 * **Nothing here writes anything.** The client holds no state beyond one
 * in-flight authorization, and the caller decides where a token goes — which is
 * the credentials store, never the CLI's `auth.json`.
 *
 * @module dsh-opencode-patch/console-auth
 */

/** The Console every flow in this module talks to. */
export const CONSOLE_BASE_URL = "https://opencode.ai/console";

/**
 * The client id OpenCode's own CLI presents.
 *
 * Measured, not chosen: the code endpoint issued a device code for exactly this
 * value, and a flow started with anything else has no entitlement to be
 * assumed.
 */
export const OPENCODE_CLI_CLIENT_ID = "opencode-cli";

/** The device-grant type the token endpoint expects, spelled as OAuth requires. */
export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** What the code endpoint answered. */
export interface DeviceAuthorization {
  /** The code the client polls with. A secret until it is redeemed. */
  readonly deviceCode: string;
  /** The short code the human types. */
  readonly userCode: string;
  /** Absolute URL to open, resolved from the Console's relative answer. */
  readonly verificationUri: string;
  /** The same URL with the code pre-filled, when the endpoint supplies it. */
  readonly verificationUriComplete: string | undefined;
  /** Seconds the client should wait between polls. */
  readonly intervalSeconds: number;
  /** Seconds until the code stops being redeemable. */
  readonly expiresInSeconds: number;
}

/** The pair the refresh grant rotates, and the only thing worth storing. */
export interface ConsoleTokens {
  readonly accessToken: string;
  readonly refreshToken: string | undefined;
  /** Seconds until the access token expires. */
  readonly expiresInSeconds: number;
  /** The account this grant belongs to, when the endpoint says. */
  readonly account: string | undefined;
}

/** Why a poll did not produce a token yet, or ever will. */
export type PollOutcome =
  | { readonly kind: "pending" }
  | { readonly kind: "slow_down" }
  | { readonly kind: "denied"; readonly detail: string }
  | { readonly kind: "expired"; readonly detail: string }
  | { readonly kind: "failed"; readonly detail: string }
  | { readonly kind: "granted"; readonly tokens: ConsoleTokens };

/** What the client needs to do its work. */
export interface ConsoleAuthOptions {
  /** Defaults to {@link CONSOLE_BASE_URL}. */
  readonly baseUrl?: string;
  /** The fetch it uses; the default is the ambient one. */
  readonly fetch?: typeof globalThis.fetch;
  /** Client id override, for a deployment with its own registration. */
  readonly clientId?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (
  record: Record<string, unknown>,
  key: string
): string | undefined => {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const readNumber = (
  record: Record<string, unknown>,
  key: string
): number | undefined =>
  typeof record[key] === "number" ? record[key] : undefined;

/**
 * What the Console said went wrong, as a string.
 *
 * Every failure message in this module ends with this, so an unknown or oddly
 * typed `error` must never reach a template literal as `[object Object]` — the
 * one thing a login failure cannot be.
 */
const errorDetail = (record: Record<string, unknown>): string =>
  readString(record, "error_description") ??
  readString(record, "error") ??
  "unknown reason";

/**
 * Turn the Console's relative verification path into something openable.
 *
 * The endpoint answers `/console/device`, not a URL, so a client that opens the
 * answer verbatim opens nothing. A value that is already absolute is left alone,
 * because an endpoint that starts answering absolutely should not be second
 * guessed into a wrong URL.
 */
export const absoluteVerificationUri = (
  value: string,
  baseUrl: string = CONSOLE_BASE_URL
): string => {
  if (/^https?:\/\//u.test(value)) {
    return value;
  }
  const origin = baseUrl.replace(/\/console\/?$/u, "");
  return `${origin}${value.startsWith("/") ? value : `/${value}`}`;
};

/** One authorization in flight, and the polling that finishes it. */
export interface PendingAuthorization {
  readonly authorization: DeviceAuthorization;
  /**
   * Poll once. `granted` carries the tokens; every other outcome says whether
   * to keep waiting, and `pending` is the answer a human has not approved yet.
   */
  readonly poll: () => Promise<PollOutcome>;
}

/**
 * The device-flow client.
 *
 * Both logins are one of these: `start` twice on the same Console is two
 * independent authorizations, because each `start` asks the Console for a fresh
 * code.
 */
export class ConsoleAuthClient {
  readonly #baseUrl: string;
  readonly #clientId: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: ConsoleAuthOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? CONSOLE_BASE_URL).replace(/\/$/u, "");
    this.#clientId = options.clientId ?? OPENCODE_CLI_CLIENT_ID;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /** The reference to the identity this client presents. */
  get clientId(): string {
    return this.#clientId;
  }

  /**
   * One POST to the Console, answered as the plain record it is.
   *
   * The envelope is returned as read rather than as a narrowed type: every
   * caller branches on `error` / `error_description` and reads a handful of
   * token fields, and a type asserting those fields exist would say more than
   * any of them know before they have looked.
   */
  async #post(
    path: string,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = {
        error: "unreadable_response",
        error_description: text.slice(0, 200),
      };
    }
    return isRecord(parsed) ? parsed : { error: "unreadable_response" };
  }

  /**
   * Ask the Console for a code a human can approve.
   *
   * @returns the authorization, and a `poll` bound to its code.
   * @throws {Error} when the Console does not issue a code — an unapproved
   * client id, a Console that moved, or a body that is not what this module
   * was written against.
   */
  async start(): Promise<PendingAuthorization> {
    const raw = await this.#post("/auth/device/code", {
      client_id: this.#clientId,
    });
    const deviceCode = readString(raw, "device_code");
    const userCode = readString(raw, "user_code");
    if (deviceCode === undefined || userCode === undefined) {
      throw new Error(
        `the Console issued no device code for client ${this.#clientId}: ${errorDetail(
          raw
        )}`
      );
    }
    const verification = readString(raw, "verification_uri_complete");
    const authorization: DeviceAuthorization = {
      deviceCode,
      expiresInSeconds: readNumber(raw, "expires_in") ?? 600,
      intervalSeconds: readNumber(raw, "interval") ?? 5,
      // The Console answers a path; a URL is what a human can open.
      userCode,
      verificationUri: absoluteVerificationUri(
        readString(raw, "verification_uri") ?? "/console/device",
        this.#baseUrl
      ),
      verificationUriComplete:
        verification === undefined
          ? undefined
          : absoluteVerificationUri(verification, this.#baseUrl),
    };

    return {
      authorization,
      poll: () => this.#poll(authorization.deviceCode),
    };
  }

  async #poll(deviceCode: string): Promise<PollOutcome> {
    const raw = await this.#post("/auth/device/token", {
      client_id: this.#clientId,
      device_code: deviceCode,
      grant_type: DEVICE_CODE_GRANT,
    });
    const record = raw;
    const accessToken = readString(record, "access_token");
    if (accessToken !== undefined) {
      return {
        kind: "granted",
        tokens: {
          accessToken,
          account: readString(record, "account") ?? readString(record, "org"),
          expiresInSeconds: readNumber(record, "expires_in") ?? 0,
          refreshToken: readString(record, "refresh_token"),
        },
      };
    }
    switch (raw.error) {
      case "authorization_pending": {
        return { kind: "pending" };
      }
      case "slow_down": {
        return { kind: "slow_down" };
      }
      case "access_denied": {
        return {
          detail: readString(raw, "error_description") ?? "access denied",
          kind: "denied",
        };
      }
      case "expired_token": {
        return {
          detail: readString(raw, "error_description") ?? "expired",
          kind: "expired",
        };
      }
      default: {
        return {
          detail: errorDetail(raw),
          kind: "failed",
        };
      }
    }
  }

  /**
   * Exchange a refresh token for a new pair.
   *
   * The Console answers with a NEW refresh token, so the caller must replace both
   * halves together — storing only the access token means the next refresh
   * presents a token the server has already rotated away.
   *
   * @param refreshToken - the stored refresh token.
   * @returns the new pair.
   * @throws {Error} when the grant is refused, naming what the Console said.
   */
  async refresh(refreshToken: string): Promise<ConsoleTokens> {
    const raw = await this.#post("/auth/device/token", {
      client_id: this.#clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    const accessToken = readString(raw, "access_token");
    if (accessToken === undefined) {
      throw new Error(
        `the Console refused the refresh grant: ${errorDetail(raw)}`
      );
    }
    const record = raw;
    return {
      accessToken,
      account: readString(record, "account") ?? readString(record, "org"),
      expiresInSeconds: readNumber(record, "expires_in") ?? 0,
      refreshToken: readString(record, "refresh_token"),
    };
  }
}

/**
 * Poll until the authorization resolves, the deadline passes, or the Console
 * says it never will.
 *
 * The wait between attempts is the endpoint's own `interval`, and `slow_down`
 * doubles it — which is what that error means, and honouring it is the
 * difference between a patient client and a rate-limited one.
 *
 * @param pending - the authorization to finish.
 * @param options - how long to keep trying, and where to report waits.
 * @returns the tokens, or the reason there are none.
 */
export const awaitAuthorization = async (
  pending: PendingAuthorization,
  options: {
    readonly deadlineMs?: number;
    readonly onWait?: (seconds: number) => void;
  } = {}
): Promise<{ granted: ConsoleTokens } | { error: PollOutcome }> => {
  const deadline = Date.now() + (options.deadlineMs ?? 600_000);
  const first = await pending.poll();
  return afterPoll(
    pending,
    first,
    deadline,
    options.onWait,
    pending.authorization.intervalSeconds
  );
};

/**
 * One poll, then either the outcome or another wait.
 *
 * Written as recursion rather than a loop because the wait is the point: a poll
 * cannot start until the previous one's wait has elapsed, so there is nothing
 * here to parallelise, and a loop would read as though there were.
 *
 * @param pending - the authorization still in flight.
 * @param outcome - what the poll just answered.
 * @param deadline - when to stop waiting.
 * @param onWait - where a wait is reported.
 * @param waitSeconds - the delay before the next attempt.
 * @returns the tokens, or the reason there are none.
 */
const afterPoll = async (
  pending: PendingAuthorization,
  outcome: PollOutcome,
  deadline: number,
  onWait: ((seconds: number) => void) | undefined,
  waitSeconds: number
): Promise<{ granted: ConsoleTokens } | { error: PollOutcome }> => {
  if (outcome.kind !== "pending" && outcome.kind !== "slow_down") {
    return outcome.kind === "granted"
      ? { granted: outcome.tokens }
      : { error: outcome };
  }
  // `slow_down` means the interval is too short; honouring that is the
  // difference between a patient client and a rate-limited one.
  const wait = outcome.kind === "slow_down" ? waitSeconds * 2 : waitSeconds;
  if (Date.now() + wait * 1000 > deadline) {
    return {
      error: {
        detail: "not approved within the authorization's window",
        kind: "expired",
      },
    };
  }
  onWait?.(wait);
  await new Promise((resolve) => {
    setTimeout(resolve, wait * 1000);
  });
  const next = await pending.poll();
  return afterPoll(pending, next, deadline, onWait, wait);
};
