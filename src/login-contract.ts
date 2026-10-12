/**
 * What a settings surface may know about a login, and how it asks.
 *
 * **The token never crosses this seam.** A surface that lists who is signed in
 * has no reason to hold the credential, and a value it never receives is one it
 * cannot log, render or leak. So the state carries an email, an org and the
 * orgs, and nothing else — the same rule the usage meter follows, where the host
 * holds the key and the client only renders.
 *
 * **The device flow is three calls, because a human is in the middle of it.**
 * `begin` answers the code and the URL to open; the surface shows them; `poll`
 * asks whether the human has approved yet; `state` answers what is stored. A
 * single call that waited for approval would hold a request open for as long as
 * a person takes to find their phone, and would have nothing to show while they
 * looked.
 *
 * **A state read is cheap and always current.** The host re-reads the stored
 * grant per call, so a surface can poll `state` and see a login appear the
 * moment another window completes one.
 *
 * @module dsh-opencode-patch/login-contract
 */

import type {
  RemoteResult,
  TypertRemoteContribution,
} from "@deepseek-ai/dsh-typert-protocol";

import { isRecord } from "./guards.ts";

/** One organization, as a surface shows it. */
export interface LoginOrgView {
  readonly id: string;
  readonly name: string;
}

/**
 * What is stored for a plane, without the credential.
 *
 * `signedIn` is separate from the email because a grant can exist without an
 * owner — a token written before the owner was read — and a surface has to be
 * able to say "signed in, owner unknown" rather than either lying or showing
 * nothing.
 */
export interface LoginState {
  /** The account's email, when the stored grant carries one. */
  readonly email?: string;
  /** The org a request would carry, `wrk_…`, when the grant has one. */
  readonly orgId?: string;
  /** Every org the login may act within. */
  readonly orgs: readonly LoginOrgView[];
  /** Whether any grant is stored for this plane at all. */
  readonly signedIn: boolean;
  /** The plane this state describes. */
  readonly plane: string;
}

/** What a surface must send to start a login. */
export interface LoginBeginQuery {
  /** The plane to sign in to; the account is the same for both. */
  readonly plane?: string;
}

/** The code a human approves, and where they approve it. */
export interface LoginChallenge {
  /** The short code the human types, when the Console issues one. */
  readonly userCode: string;
  /** Absolute URL to open, resolved from the Console's relative answer. */
  readonly verificationUri: string;
  /** The same URL with the code pre-filled, when the Console supplies it. */
  readonly verificationUriComplete?: string;
  /** Seconds until the code stops being redeemable. */
  readonly expiresInSeconds: number;
  /** Seconds the surface should wait between polls. */
  readonly intervalSeconds: number;
}

/** Why a poll has not produced a login yet, or never will. */
export interface LoginPollResult {
  /** `pending` while a human has not approved; `failed` when they will not. */
  readonly kind: "pending" | "failed" | "signed-in";
  /** What went wrong, for the failure case. */
  readonly detail?: string;
}

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

const parseOrg = (value: unknown): LoginOrgView => {
  if (!isRecord(value)) {
    throw new TypeError("Invalid login org: expected an object");
  }
  const id = readString(value, "id");
  const name = readString(value, "name");
  if (id === undefined || name === undefined) {
    throw new TypeError("Invalid login org: missing id or name");
  }
  return { id, name };
};

/**
 * Validate a login state.
 *
 * Strict about what it cannot invent: a state without a plane is not a state, and
 * a state claiming to be signed in without an org list is one whose owner was
 * never read. The optional fields are optional because a grant written before
 * the owner was read is a real thing to render, not a malformed answer.
 *
 * @param value - the value from the wire.
 * @returns the state.
 * @throws {TypeError} when the shape is not one this seam can describe.
 */
export const parseLoginState = (value: unknown): LoginState => {
  if (!isRecord(value)) {
    throw new TypeError("Invalid login state: expected an object");
  }
  const plane = readString(value, "plane");
  if (plane === undefined) {
    throw new TypeError("Invalid login state: missing plane");
  }
  const rawOrgs = value.orgs;
  if (!Array.isArray(rawOrgs)) {
    throw new TypeError("Invalid login state: missing org list");
  }
  return {
    ...(readString(value, "email") === undefined
      ? {}
      : { email: readString(value, "email") }),
    ...(readString(value, "orgId") === undefined
      ? {}
      : { orgId: readString(value, "orgId") }),
    orgs: rawOrgs.map(parseOrg),
    plane,
    signedIn: value.signedIn === true,
  };
};

/**
 * Validate the query that starts a login.
 *
 * @param value - the value from the wire, which may be absent entirely.
 * @returns the query, with an absent plane left for the host to default.
 */
export const parseLoginBeginQuery = (value?: unknown): LoginBeginQuery => {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw new TypeError("Invalid login query: expected an object");
  }
  const plane = readString(value, "plane");
  return plane === undefined ? {} : { plane };
};

/**
 * Validate the challenge a surface shows.
 *
 * @param value - the value from the wire.
 * @returns the challenge.
 * @throws {TypeError} when a field a surface must render is absent.
 */
export const parseLoginChallenge = (value: unknown): LoginChallenge => {
  if (!isRecord(value)) {
    throw new TypeError("Invalid login challenge: expected an object");
  }
  const userCode = readString(value, "userCode");
  const verificationUri = readString(value, "verificationUri");
  const expiresInSeconds = readNumber(value, "expiresInSeconds");
  const intervalSeconds = readNumber(value, "intervalSeconds");
  if (
    userCode === undefined ||
    verificationUri === undefined ||
    expiresInSeconds === undefined ||
    intervalSeconds === undefined
  ) {
    throw new TypeError("Invalid login challenge: missing a field to render");
  }
  return {
    expiresInSeconds,
    intervalSeconds,
    userCode,
    verificationUri,
    ...(readString(value, "verificationUriComplete") === undefined
      ? {}
      : {
          verificationUriComplete: readString(value, "verificationUriComplete"),
        }),
  };
};

/**
 * Validate one poll's answer.
 *
 * @param value - the value from the wire.
 * @returns the outcome.
 * @throws {TypeError} when the kind is not one of the three.
 */
export const parseLoginPoll = (value: unknown): LoginPollResult => {
  if (!isRecord(value)) {
    throw new TypeError("Invalid login poll: expected an object");
  }
  const kind = readString(value, "kind");
  if (kind !== "pending" && kind !== "failed" && kind !== "signed-in") {
    throw new TypeError(`Invalid login poll kind: ${String(value.kind)}`);
  }
  return {
    detail: readString(value, "detail"),
    kind,
  };
};

const stateCodec = {
  create: () => ({ parse: parseLoginState }),
  mode: "strict" as const,
  schema: { parse: parseLoginState },
  typeSymbol: "dsh-opencode-patch#LoginState",
};

const beginQueryCodec = {
  create: () => ({ parse: parseLoginBeginQuery }),
  mode: "strict" as const,
  schema: { parse: parseLoginBeginQuery },
  typeSymbol: "dsh-opencode-patch#LoginBeginQuery",
};

const challengeCodec = {
  create: () => ({ parse: parseLoginChallenge }),
  mode: "strict" as const,
  schema: { parse: parseLoginChallenge },
  typeSymbol: "dsh-opencode-patch#LoginChallenge",
};

const pollCodec = {
  create: () => ({ parse: parseLoginPoll }),
  mode: "strict" as const,
  schema: { parse: parseLoginPoll },
  typeSymbol: "dsh-opencode-patch#LoginPollResult",
};

declare module "@deepseek-ai/dsh-typert-protocol" {
  interface TypertRemoteNamespaceMap {
    opencodeLogin: {
      /** Start a device flow and answer the code a human approves. */
      begin: (query?: LoginBeginQuery) => Promise<RemoteResult<LoginChallenge>>;
      /** Ask whether the human has approved yet. */
      poll: () => Promise<RemoteResult<LoginPollResult>>;
      /** What is stored now, without the credential. */
      state: (query?: LoginBeginQuery) => Promise<RemoteResult<LoginState>>;
    };
  }
}

/**
 * The remote a settings surface mounts.
 *
 * Three methods rather than one, because the middle of a device flow is a person:
 * `begin` gives the surface something to show, `poll` lets it ask again, and
 * `state` answers what is stored without ever handing over the token.
 */
export const loginRemote: TypertRemoteContribution = {
  descriptors: [
    {
      id: "dsh-opencode-patch#opencodeLogin/begin",
      invocation: { kind: "direct" },
      method: "begin",
      namespace: "opencodeLogin",
      parameters: [
        {
          acceptsUndefined: true,
          codec: beginQueryCodec,
          name: "query",
          source: "json",
          wire: "query",
        },
      ],
      result: challengeCodec,
      service: "opencodeLogin",
    },
    {
      id: "dsh-opencode-patch#opencodeLogin/poll",
      invocation: { kind: "direct" },
      method: "poll",
      namespace: "opencodeLogin",
      parameters: [],
      result: pollCodec,
      service: "opencodeLogin",
    },
    {
      id: "dsh-opencode-patch#opencodeLogin/state",
      invocation: { kind: "direct" },
      method: "state",
      namespace: "opencodeLogin",
      parameters: [
        {
          acceptsUndefined: true,
          codec: beginQueryCodec,
          name: "query",
          source: "json",
          wire: "query",
        },
      ],
      result: stateCodec,
      service: "opencodeLogin",
    },
  ],
  package: "dsh-opencode-patch",
};
