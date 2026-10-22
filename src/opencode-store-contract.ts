/**
 * Contract for inspecting a local OpenCode installation's credentials.
 *
 * Pure data types, no I/O, no context, safely imported by host and client.
 *
 * @module dsh-opencode-patch/opencode-store-contract
 */

export const STORE_NAMESPACE = "opencodeStore";

/** Sanitized summary of an account found in the local OpenCode installation. */
export interface OpencodeStoreAccount {
  readonly accountId?: string;
  readonly email?: string;
  readonly expired?: boolean;
  readonly expiresAt?: string;
  readonly label?: string;
  readonly orgName?: string;
  /**
   * Whether the store also holds a refresh token.
   *
   * It changes what an expired access token MEANS: a session that can refresh is
   * renewed the next time the CLI uses it, so reporting it as a failure would be
   * a false alarm on the ordinary state of a working installation.
   */
  readonly refreshable?: boolean;
  readonly type: "oauth" | "key" | "unknown";
}

/** Result of inspecting the local OpenCode installation. */
export interface OpencodeStoreInspection {
  readonly account?: OpencodeStoreAccount;
  readonly found: boolean;
  readonly message?: string;
  readonly path?: string;
}
