/**
 * A login in use: read the stored grant, refresh it when it is about to expire,
 * and hand out a token that is good for the call about to be made.
 *
 * **Refresh is proactive, not reactive.** Waiting for a 401 means one failed
 * request per login per hour, and the failure is the user seeing an error
 * instead of a prompt. A token that will expire inside the window is refreshed
 * before it is handed out, so the request it authenticates is the one that
 * succeeds.
 *
 * **One refresh at a time, per store.** A refresh is a network round trip, and
 * every concurrent call would otherwise start its own — each rotating the
 * refresh token, so all but one would present a token the server had already
 * replaced. The in-flight promise is shared, which is the in-process half of the
 * seam's atomic pair write. This excludes concurrent refreshes in this session,
 * not in independent readers or processes; an atomic write alone cannot lock
 * the network exchange or stop a late refresh from racing a new login.
 *
 * **Nothing here invents a token.** A store with nothing in it, a grant with no
 * refresh token, and a refresh the Console refuses all end the same way — this
 * module reports the failure instead of returning a token it does not have,
 * because a credential that looks present and is not bills someone else's
 * account.
 *
 * @module dsh-opencode-patch/login-session
 */

import type { ConsoleAuthClient } from "./console-auth.ts";
import type { StoredLogin, TokenStore } from "./token-store.ts";

/** Why a session has no usable token, when it does not. */
export type SessionFailure =
  /** No login is stored for this plane. */
  | { readonly reason: "no login" }
  /** A login is stored but the Console refused to refresh it. */
  | { readonly detail: string; readonly reason: "refresh refused" };

/** One plane's login in use. */
export interface LoginSession {
  /**
   * An access token good for the next call.
   *
   * Refreshes first when the stored token is inside the window, so the caller
   * never has to handle an expired one.
   */
  readonly token: () => Promise<
    | { readonly kind: "ok"; readonly token: StoredLogin }
    | { readonly failure: SessionFailure; readonly kind: "failed" }
  >;
  /** Drop the stored login and any in-flight refresh. */
  readonly signOut: () => Promise<void>;
  /** Whether a token is stored at all, without reading its value. */
  readonly signedIn: () => Promise<boolean>;
}

/** What {@link createLoginSession} needs. */
export interface LoginSessionInputs {
  readonly store: TokenStore | undefined;
  readonly client: ConsoleAuthClient;
  /** Treat a token expiring within this window as needing a refresh. */
  readonly withinMs?: number;
}

/**
 * The session for one plane, or `undefined` when a login cannot be kept.
 *
 * Undefined follows the store: with no seam there is nowhere to read a login
 * from and nowhere to write a refreshed one, so a caller that cannot store a
 * token cannot use one either.
 *
 * @param inputs - the store, the Console client, and the refresh window.
 * @returns the session, or undefined when no login can be kept.
 */
export const createLoginSession = (
  inputs: LoginSessionInputs
): LoginSession | undefined => {
  const { client, store, withinMs = 120_000 } = inputs;
  if (store === undefined) {
    return undefined;
  }
  let inFlight:
    | Promise<
        | { readonly kind: "ok"; readonly token: StoredLogin }
        | { readonly failure: SessionFailure; readonly kind: "failed" }
      >
    | undefined;

  const refreshStored = async (current: StoredLogin) => {
    const { refreshToken } = current;
    if (refreshToken === undefined) {
      // A grant with no refresh token is usable until it expires and useless
      // afterwards; saying so is better than silently handing out an expiring
      // one as if it were current.
      return {
        failure: {
          detail: "the stored grant carries no refresh token",
          reason: "refresh refused",
        },
        kind: "failed",
      } as const;
    }
    try {
      const tokens = await client.refresh(refreshToken);
      // The pair is written together, so the refresh token that goes with this
      // access token is the one stored beside it.
      const login: StoredLogin = {
        ...current,
        ...tokens,
        account: tokens.account ?? current.account,
      };
      await store.write(login);
      return { kind: "ok", token: login } as const;
    } catch (error) {
      return {
        failure: {
          detail: error instanceof Error ? error.message : String(error),
          reason: "refresh refused",
        },
        kind: "failed",
      } as const;
    }
  };

  const resolve = async () => {
    // One snapshot per operation: reading again after a stale check can see a
    // different owner's login and refresh a grant that is already fresh.
    const current = await store.read();
    if (current === undefined) {
      return { failure: { reason: "no login" }, kind: "failed" } as const;
    }
    return current.expiresInSeconds * 1000 > withinMs
      ? ({ kind: "ok", token: current } as const)
      : refreshStored(current);
  };

  return {
    // The shared promise is what makes one refresh per store per window: a
    // second caller arriving mid-refresh gets the first one's result rather
    // than rotating the token a second time.
    token: async () => {
      // One refresh per window: a second caller arriving mid-refresh gets the
      // first one's result rather than rotating the token a second time.
      inFlight ??= resolve();
      const running = inFlight;
      try {
        return await running;
      } finally {
        if (inFlight === running) {
          inFlight = undefined;
        }
      }
    },
    signOut: async () => {
      inFlight = undefined;
      await store.clear();
    },
    signedIn: async () => (await store.read()) !== undefined,
  };
};
