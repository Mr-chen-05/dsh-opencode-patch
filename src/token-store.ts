/**
 * Where a Console login's tokens live.
 *
 * **A token pair is a GRANT, not a reference.** The credential seam has two
 * halves, and they answer two different questions. A reference (`set(ref,
 * value)`) answers "what is behind this environment-variable name" and holds one
 * string. A login produces a PAIR: an access token, a refresh token that the
 * server rotates on every grant, and an expiry. Storing that as one reference
 * value would mean concatenating it and parsing it back, and the seam's own
 * vocabulary for exactly this is the `grant` record: an owner-defined JSON
 * payload the seam stores and never interprets, under the owner's key.
 *
 * **Atomicity is the whole reason.** The seam's only record write path is
 * `modifyRecord`, a read-decide-replace under one lock, and the Console returns
 * a NEW refresh token with every access token. Write the access token without
 * replacing the refresh token and the next refresh presents a token the server
 * has already rotated away — the failure mode this module exists to prevent.
 *
 * **Keys are scoped, so this plugin cannot write behind another.** The record
 * key is `<scope>/<id>` with the scope being a registered plugin name; the pool's
 * references and this plugin's records therefore live in different address
 * spaces, and nothing here can name `llm-pi-ai/opencode`.
 *
 * @module dsh-opencode-patch/token-store
 */

import type { ConsoleTokens } from "./console-auth.ts";
import type { CredentialsWriter } from "./cordis-context.ts";

/** What this module writes, in the shape the seam stores verbatim. */
interface StoredGrant {
  readonly accessToken: string;
  readonly account: string | undefined;
  readonly expiresAt: number;
  readonly refreshToken: string | undefined;
}

/** The record as it comes back out, which may have been written by an older build. */
const isStoredGrant = (value: unknown): value is StoredGrant =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { accessToken?: unknown }).accessToken === "string";

/**
 * One plane's stored login.
 *
 * Reads are cheap and re-read the record every time: a refresh performed in
 * another process must be visible here, and a cached copy would hand out an
 * access token the server has already retired.
 */
export interface TokenStore {
  /** The record key this store owns. */
  readonly key: string;
  /**
   * The current tokens, or `undefined` while no login is stored.
   *
   * A record this plugin did not write is not interpreted: it is someone
   * else's payload, and reading it as a grant would be guessing.
   */
  readonly read: () => Promise<ConsoleTokens | undefined>;
  /**
   * Store a pair, replacing whatever was there in one operation.
   *
   * The expiry is stored as an absolute instant rather than a duration, so a
   * token that sat unread across a restart is expired on read rather than
   * treated as fresh.
   */
  readonly write: (tokens: ConsoleTokens) => Promise<void>;
  /** Remove the stored login, if any. Removing an absent record is a no-op. */
  readonly clear: () => Promise<void>;
  /**
   * Whether the stored login can still be used, and the tokens when it can.
   *
   * A discriminated result rather than a flag beside a value, because the two
   * facts are not independent: a token is present exactly when `stale` is
   * false, and a caller reading them separately has to re-derive that. `stale`
   * also covers having no login at all, which is the state a refresh cannot
   * fix.
   *
   * @param withinMs - treat a token expiring within this window as stale.
   * @returns `current` with a usable token, or `stale` when one must be
   * refreshed first.
   */
  readonly needsRefresh: (
    withinMs?: number
  ) => Promise<
    | { readonly kind: "current"; readonly token: ConsoleTokens }
    | { readonly kind: "stale" }
  >;
}

/** What {@link createTokenStore} needs. */
export interface TokenStoreInputs {
  /** The owner's plugin name, the scope half of the record key. */
  readonly scope: string;
  /** The plane's own id, the addressing half. */
  readonly plane: string;
  /** The credential seam; without it a login cannot be stored. */
  readonly credentials: CredentialsWriter | undefined;
}

const isPlainSegment = (value: string): boolean =>
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);

/**
 * The store for one plane's login, or `undefined` when tokens cannot be stored.
 *
 * Undefined is the answer when this composition mounts no credential seam, or
 * when either key segment is not a legal identifier — because a key the seam
 * would reject is worse than no store, since a caller would believe a token was
 * kept when it was not.
 *
 * @param inputs - the owner's scope, the plane, and the seam.
 * @returns the store, or undefined when a token cannot be stored here.
 */
export const createTokenStore = (
  inputs: TokenStoreInputs
): TokenStore | undefined => {
  const { credentials, plane, scope } = inputs;
  if (credentials === undefined) {
    return undefined;
  }
  // The seam brands this pair through its own helper; the grammar check here is
  // the same one that helper enforces, and failing it early is what keeps a
  // rejected key from looking like a working store.
  if (!isPlainSegment(scope) || !isPlainSegment(plane)) {
    return undefined;
  }
  const key = `${scope}/${plane}`;

  const read = async (): Promise<ConsoleTokens | undefined> => {
    const record = await credentials.readRecord(key);
    if (record === undefined || record.kind !== "grant") {
      return undefined;
    }
    // `readRecord` already answers this shape — the accessor narrows it — so
    // reading the payload needs no assertion of its own.
    const { payload } = record;
    if (!isStoredGrant(payload)) {
      return undefined;
    }
    return {
      accessToken: payload.accessToken,
      account: payload.account,
      // A grant with no expiry is treated as expired rather than as never
      // expiring: an access token the seam cannot date is one this module must
      // refresh rather than hand out.
      expiresInSeconds: Math.max(
        0,
        Math.floor((payload.expiresAt - Date.now()) / 1000)
      ),
      refreshToken: payload.refreshToken,
    };
  };

  const write = async (tokens: ConsoleTokens): Promise<void> => {
    const payload: StoredGrant = {
      accessToken: tokens.accessToken,
      account: tokens.account,
      expiresAt: Date.now() + tokens.expiresInSeconds * 1000,
      refreshToken: tokens.refreshToken,
    };
    await credentials.writeGrant(key, payload);
  };

  return {
    clear: () => credentials.deleteRecord(key),
    key,
    needsRefresh: async (withinMs = 60_000) => {
      const current = await read();
      if (current === undefined) {
        return { kind: "stale" };
      }
      // Expiry arrives as a REMAINING duration, so it has to be compared
      // against a remaining window rather than against an instant.
      const remainingMs = current.expiresInSeconds * 1000;
      return remainingMs <= withinMs
        ? { kind: "stale" }
        : { kind: "current", token: current };
    },
    read,
    write,
  };
};
