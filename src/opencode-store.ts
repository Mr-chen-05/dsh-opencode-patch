/**
 * Reading the credentials an OpenCode installation already holds.
 *
 * This is the opt-in half of the credential story: a user who has signed in to
 * OpenCode should not have to sign in again here. It is off by default and a
 * credential declared in DSH always wins — reading another tool's store is
 * something a user turns on, not something that happens to them.
 *
 * Two rules shape everything below.
 *
 * - **Nothing throws.** A missing file, an unreadable file, a database from a
 *   different version and a table that is not there are all the ordinary case, and
 *   every one of them answers `undefined`. A reader that fails loudly on a machine
 *   without OpenCode installed would be a bug in the plugin.
 * - **A value never leaves this module's return value.** No logging, no error
 *   message carrying a token, no shape that reaches the client bundle. The caller
 *   decides what to do with a secret; this module only finds it.
 *
 * `node:sqlite` is a host-only built-in, which is what keeps this module on the host
 * side of the bundle rule rather than in the client.
 *
 * @module dsh-opencode-patch/opencode-store
 */

import { DatabaseSync } from "node:sqlite";

/** A credential as the installation stores it, minus everything unused. */
export interface OpencodeCredential {
  /** The provider the credential is for, as `integration_id` carries it. */
  readonly integrationId: string;
  /** The credential's own name, for a report that names what it found. */
  readonly label: string;
  /** The secret. Never logged, never returned to the client bundle. */
  readonly value: string;
}

/** A stored login, which is the alternative to running the device flow again. */
export interface OpencodeAccount {
  /** The account's email, which is not a secret. */
  readonly email: string;
  /** The access token. Never logged. */
  readonly accessToken: string;
  /** The refresh token, when the installation stored one. */
  readonly refreshToken: string | undefined;
}

/** A text column, or `undefined` when the row holds something else. */
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/** The rows a query returned, or `undefined` when anything at all went wrong. */
const rows = (
  path: string,
  sql: string
): readonly Record<string, unknown>[] | undefined => {
  let database: DatabaseSync | undefined;
  try {
    // Read-only, so a reader can never write to another tool's store even if the
    // query below were wrong.
    database = new DatabaseSync(path, { readOnly: true });
    return database.prepare(sql).all();
  } catch {
    // A missing file, a locked file, a different schema version: all ordinary, and
    // all indistinguishable from each other in a way that does not matter here.
    return undefined;
  } finally {
    try {
      database?.close();
    } catch {
      // Closing a connection that already failed is not worth reporting.
    }
  }
};

/**
 * The active credentials the installation holds, or `undefined` when it holds none
 * this module can read.
 *
 * Only active rows are returned: an inactive credential is one the user has already
 * replaced, and offering it would resurrect a key they retired.
 *
 * @param databasePath - the path {@link opencodeDatabasePath} resolved, or `:memory:`.
 * @returns the credentials, or `undefined`.
 */
export const readOpencodeCredentials = (
  databasePath: string
): readonly OpencodeCredential[] | undefined => {
  if (databasePath === ":memory:") {
    return undefined;
  }
  const found = rows(
    databasePath,
    "SELECT integration_id AS integrationId, label, value FROM credential WHERE active = 1"
  );
  if (found === undefined) {
    return undefined;
  }
  const credentials = found.flatMap((row) => {
    const integrationId = text(row.integrationId);
    const value = text(row.value);
    if (integrationId === undefined || value === undefined) {
      return [];
    }
    return [{ integrationId, label: text(row.label) ?? integrationId, value }];
  });
  return credentials.length === 0 ? undefined : credentials;
};

/**
 * The stored login, or `undefined` when there is not one.
 *
 * The installation holds at most one account, and a row without an access token is
 * not a login, so the first usable row wins.
 *
 * @param databasePath - the path {@link opencodeDatabasePath} resolved, or `:memory:`.
 * @returns the account, or `undefined`.
 */
export const readOpencodeAccount = (
  databasePath: string
): OpencodeAccount | undefined => {
  if (databasePath === ":memory:") {
    return undefined;
  }
  const found = rows(
    databasePath,
    "SELECT email, access_token AS accessToken, refresh_token AS refreshToken FROM account"
  );
  if (found === undefined) {
    return undefined;
  }
  for (const row of found) {
    const accessToken = text(row.accessToken);
    if (accessToken !== undefined) {
      return {
        accessToken,
        email: text(row.email) ?? "",
        refreshToken: text(row.refreshToken),
      };
    }
  }
  return undefined;
};
