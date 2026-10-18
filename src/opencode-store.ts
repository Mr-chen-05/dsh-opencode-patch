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

import { isRecord } from "./guards.ts";

/** A credential as the installation stores it, minus everything unused. */
export interface OpencodeCredential {
  /** The provider the credential is for, as `integration_id` carries it. */
  readonly integrationId: string;
  /** The credential's own name, for a report that names what it found. */
  readonly label: string;
  /** The secret. Never logged, never returned to the client bundle. */
  readonly value: string;
}

/**
 * The bearer token a credential row actually carries.
 *
 * Measured against a real installation: EVERY row's `value` is a JSON document
 * rather than a bare key, and the shape varies by integration. `cf-coding`,
 * `google`, `nvidia`, `opencode` and the two Cloudflare ones carry
 * `{ type, key, metadata? }`; the exception is `xai`, which carries
 * `{ type, methodID, refresh, access, expires }` and is an OAuth grant.
 *
 * So the raw column is not a credential. Handing it to a Bearer header puts a JSON
 * document where a key belongs, and the gateway answers `Invalid credential` or,
 * on the free tier, a refusal that reads as though the model itself were unusable -
 * which is exactly the wrong conclusion to draw from it. The whole document is also
 * how a secret ends up in a log.
 *
 * @param value - the raw `value` column.
 * @returns the key, the OAuth access token, or `undefined` for an unknown shape.
 */
const credentialToken = (value: string): string | undefined => {
  if (!value.trimStart().startsWith("{")) {
    // A bare key, which is what the JSON shapes wrap. Kept because a deployment may
    // legitimately hold one.
    return value;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  // Only the fields OpenCode itself declares: `key` for an API key, `access` for an
  // OAuth grant. Anything else answers `undefined` rather than being guessed at,
  // because a wrong token and no token are equally useless but only one is honest.
  for (const field of ["key", "access"]) {
    const candidate = parsed[field];
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
};

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
    // `active = 1` alone is wrong on a real installation. Measured: every row in
    // the live database has `active IS NULL`, because they are legacy rows written
    // before the flag existed, and OpenCode's own rule is that legacy rows carry no
    // flag and the NEWEST one is selected. So the explicit flag wins when any row
    // sets it, and otherwise the legacy rows are read newest-first rather than
    // being dropped - which is the difference between this reader working and
    // answering nothing on a machine that does have credentials.
    `SELECT integration_id AS integrationId, label, value FROM credential
     WHERE active = 1
        OR (active IS NULL AND NOT EXISTS (SELECT 1 FROM credential WHERE active = 1))
     ORDER BY time_updated DESC`
  );
  if (found === undefined) {
    return undefined;
  }
  const credentials = found.flatMap((row) => {
    const integrationId = text(row.integrationId);
    const token = credentialToken(text(row.value) ?? "");
    if (integrationId === undefined || token === undefined) {
      return [];
    }
    return [
      { integrationId, label: text(row.label) ?? integrationId, value: token },
    ];
  });
  return credentials.length === 0 ? undefined : credentials;
};
