/**
 * Creating a login: the device flow, and everything it must learn before it can
 * store anything.
 *
 * **A token stored without its owner is a token that can only reach half of what
 * it is entitled to.** The gateway gates the free tier on an account and an org,
 * so a login that keeps only the token pair can serve paid models and nothing
 * else. The client this plugin interoperates with does not make that mistake: it
 * reads `/api/user` and `/api/orgs` BEFORE it persists anything, and writes the
 * account, the email and the active org in the same call as the tokens.
 *
 * So this module does the same, and the order is the point:
 *
 * 1. ask for a code a human can approve, and show it;
 * 2. wait for the approval;
 * 3. read the account and its organizations with the token just obtained;
 * 4. write ONE record: the pair, the account, the orgs, and the active org.
 *
 * **Step 3 is not optional and not deferred.** It is the only moment the account
 * is knowable, because it is the only moment the token exists and is fresh. A
 * caller that skipped it would have to invent the owner later, and the org is
 * what the free tier checks.
 *
 * **The active org is the first one**, matching the client, which activates the
 * first and leaves a choice among several as a TODO of its own. A deployment with
 * more than one org changes it by writing the record, not by re-running a login.
 *
 * @module dsh-opencode-patch/login-flow
 */

import {
  awaitAuthorization,
  type ConsoleAccount,
  type ConsoleAuthClient,
  type ConsoleOrg,
  type ConsoleTokens,
  type PendingAuthorization,
  type PollOutcome,
} from "./console-auth.ts";
import type { StoredLogin, TokenStore } from "./token-store.ts";

/** A login waiting on a human, and what happens once they approve. */
export type LoginAttemptResult =
  | { readonly kind: "pending" }
  | { readonly kind: "slow_down" }
  | { readonly kind: "signed-in"; readonly login: StoredLogin }
  | { readonly detail: string; readonly kind: "failed" };

export interface LoginAttempt {
  /** The code, the URL to open, and the poll the wait runs on. */
  readonly authorization: PendingAuthorization["authorization"];
  /** Poll once; a pending answer returns immediately without another request. */
  readonly poll: (signal?: AbortSignal) => Promise<LoginAttemptResult>;
  /**
   * Wait for the approval and store what the login learned.
   *
   * @param options - how long to wait, and where to report each wait.
   * @returns the stored login, or why there is none.
   */
  readonly complete: (options?: {
    readonly deadlineMs?: number;
    readonly onWait?: (seconds: number) => void;
    readonly signal?: AbortSignal;
  }) => Promise<
    | { readonly kind: "signed-in"; readonly login: StoredLogin }
    | { readonly detail: string; readonly kind: "failed" }
  >;
}

const pollFailure = (
  failure: Extract<PollOutcome, { kind: "denied" | "expired" | "failed" }>
): { readonly detail: string; readonly kind: "failed" } => ({
  detail: failure.detail,
  kind: "failed",
});

const storeGrantedLogin = async (
  client: ConsoleAuthClient,
  store: TokenStore,
  tokens: ConsoleTokens,
  signal?: AbortSignal
): Promise<
  | { readonly kind: "signed-in"; readonly login: StoredLogin }
  | { readonly detail: string; readonly kind: "failed" }
> => {
  let owner: ConsoleAccount;
  let orgs: readonly ConsoleOrg[];
  try {
    [owner, orgs] = await Promise.all([
      client.account(tokens.accessToken, signal),
      client.orgs(tokens.accessToken, signal),
    ]);
  } catch (error) {
    if (signal?.aborted) {
      return { detail: "login was cancelled", kind: "failed" };
    }
    return {
      detail: `the Console issued a token but not its account: ${
        error instanceof Error ? error.message : String(error)
      }`,
      kind: "failed",
    };
  }

  if (signal?.aborted) {
    return { detail: "login was cancelled", kind: "failed" };
  }
  const login: StoredLogin = {
    ...tokens,
    orgId: orgs[0]?.id,
    orgs,
    owner,
  };
  await store.write(login);
  return { kind: "signed-in", login };
};

const finalizeAwait = (
  client: ConsoleAuthClient,
  store: TokenStore,
  outcome: Awaited<ReturnType<typeof awaitAuthorization>>
): Promise<
  | { readonly kind: "signed-in"; readonly login: StoredLogin }
  | { readonly detail: string; readonly kind: "failed" }
> => {
  if ("error" in outcome) {
    const failure = outcome.error;
    if (
      failure.kind === "denied" ||
      failure.kind === "expired" ||
      failure.kind === "failed"
    ) {
      return Promise.resolve(pollFailure(failure));
    }
    return Promise.resolve({
      detail: `the approval did not arrive (${failure.kind})`,
      kind: "failed",
    });
  }
  return storeGrantedLogin(client, store, outcome.granted);
};

/** What {@link beginLogin} needs. */
export interface LoginFlowInputs {
  readonly client: ConsoleAuthClient;
  /** Where the login is written; without one there is nowhere to keep it. */
  readonly store: TokenStore | undefined;
}

/**
 * Start a login and hand back the code a human approves.
 *
 * @param inputs - the Console client and the store to write into.
 * @returns the attempt, or `undefined` when no login can be kept — a store is
 * the only place a token pair and its owner belong, and a flow that could not
 * keep one would leave the user approved and unauthenticated.
 * @throws {Error} when the Console does not issue a code.
 */
export const beginLogin = async (
  inputs: LoginFlowInputs
): Promise<LoginAttempt | undefined> => {
  const { client, store } = inputs;
  if (store === undefined) {
    return undefined;
  }
  const pending = await client.start();

  return {
    authorization: pending.authorization,
    poll: async (signal) => {
      const outcome = await pending.poll(signal);
      if (outcome.kind === "pending" || outcome.kind === "slow_down") {
        return { kind: outcome.kind };
      }
      if (outcome.kind !== "granted") {
        return pollFailure(outcome);
      }
      return storeGrantedLogin(client, store, outcome.tokens, signal);
    },
    complete: async (options = {}) => {
      const { signal, ...authorizationOptions } = options;
      if (signal?.aborted) {
        return { detail: "login was cancelled", kind: "failed" };
      }
      const cancellable: PendingAuthorization = {
        authorization: pending.authorization,
        poll: (pollSignal) => pending.poll(signal ?? pollSignal),
      };
      const result = await awaitAuthorization(
        cancellable,
        authorizationOptions
      );
      if (signal?.aborted) {
        return { detail: "login was cancelled", kind: "failed" };
      }
      return finalizeAwait(client, store, result);
    },
  };
};

/**
 * The org a stored login must carry on a request.
 *
 * One function rather than a field read at each call site, so the rule lives in
 * one place: the stored org is the one the login activated, and a record without
 * one — written before this existed, or by a hand-edited store — simply carries
 * no org, which the gateway answers as a key would be answered.
 *
 * @param login - a stored login.
 * @returns the org id, or undefined when the login never learned one.
 */
export const orgForLogin = (
  login: StoredLogin | undefined
): string | undefined => login?.orgId;

/** The tokens and owner as one value, for a caller that wants both. */
export interface LoginSummary {
  readonly email: string | undefined;
  readonly orgId: string | undefined;
  readonly orgs: readonly ConsoleOrg[];
  readonly tokens: ConsoleTokens;
}

/**
 * What a settings surface needs to show about a stored login, without a token.
 *
 * Deliberately excludes the access token: a surface that lists who is signed in
 * has no reason to hold the credential, and a value it never receives is one it
 * cannot leak.
 *
 * @param login - a stored login, or nothing.
 * @returns the summary, or undefined when nothing is stored.
 */
export const summarizeLogin = (
  login?: StoredLogin
): LoginSummary | undefined =>
  login === undefined
    ? undefined
    : {
        email: login.owner?.email,
        orgId: login.orgId,
        orgs: login.orgs ?? [],
        tokens: {
          accessToken: login.accessToken,
          ...(login.account === undefined ? {} : { account: login.account }),
          expiresInSeconds: login.expiresInSeconds,
          ...(login.refreshToken === undefined
            ? {}
            : { refreshToken: login.refreshToken }),
        },
      };
