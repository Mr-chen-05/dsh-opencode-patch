/**
 * A login credential for a request: its token and org travel together.
 *
 * Shared by the fetch patch and the Google bridge, without making either know
 * how a grant is stored. Sessions live for the reader's lifetime so concurrent
 * callers share refreshes, but each operation re-reads the grant. The optional
 * installation account stays read-only and is consulted only after DSH grants.
 *
 * @module dsh-opencode-patch/login-credential
 */

import { ConsoleAuthClient } from "./console-auth.ts";
import { readCredentialsWriter } from "./cordis-context.ts";
import { resolveOpencodeStoreAccount } from "./go-discovery.ts";
import { name } from "./identity.ts";
import { createLoginSession, type LoginSession } from "./login-session.ts";
import { createTokenStore } from "./token-store.ts";

/** The parts of a login needed by a model request, never by the client seam. */
export interface LoginCredential {
  readonly accessToken: string;
  readonly orgId?: string;
}

/** A lazy, per-operation lookup, returning no credential when no login exists. */
export type LoginCredentialReader = (
  plane: string
) => Promise<LoginCredential | undefined>;

/**
 * Build one reader per plugin lifetime, shared by all request paths.
 *
 * @param ctx - the host context providing the credential seam.
 * @param readOpencodeStore - the user's opt-in to the installation's store.
 * @param client - the Console client; the lifecycle uses the unpatched fetch.
 * @returns a reader that tries the requested plane, the other plane, then the
 * opt-in installation account. Unknown planes never consult credentials.
 */
export const createLoginCredentialReader = (
  ctx: unknown,
  readOpencodeStore = false,
  client = new ConsoleAuthClient({})
): LoginCredentialReader => {
  const sessions = new Map<string, LoginSession>();
  const sessionFor = (plane: string): LoginSession | undefined => {
    const cached = sessions.get(plane);
    if (cached !== undefined) {
      return cached;
    }
    // Resolve lazily: the service or a login may appear after plugin startup.
    const session = createLoginSession({
      client,
      store: createTokenStore({
        credentials: readCredentialsWriter(ctx),
        plane,
        scope: name,
      }),
    });
    if (session !== undefined) {
      sessions.set(plane, session);
    }
    return session;
  };
  const grantFor = async (
    plane: string
  ): Promise<LoginCredential | undefined> => {
    const result = await sessionFor(plane)?.token();
    if (result?.kind === "failed" && result.failure.reason !== "no login") {
      // Absence permits fallback; an existing owner's revoked grant does not.
      // Never include the Console's error body or any token in this message.
      throw new Error(
        `MISSING_CREDENTIAL: ${plane} login refresh refused; sign in again`
      );
    }
    return result?.kind === "ok"
      ? { accessToken: result.token.accessToken, orgId: result.token.orgId }
      : undefined;
  };
  return async (plane) => {
    const known = plane === "opencode" || plane === "opencode-go";
    const other = plane === "opencode-go" ? "opencode" : "opencode-go";
    return known
      ? ((await grantFor(plane)) ??
          (await grantFor(other)) ??
          resolveOpencodeStoreAccount(readOpencodeStore))
      : undefined;
  };
};
