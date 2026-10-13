/**
 * The reader, against databases this test builds rather than one that exists.
 *
 * Every case makes its own SQLite file with the schema the installation uses, so
 * the queries are exercised for real — `node:sqlite` is the same driver the plugin
 * uses — without depending on a machine that has OpenCode installed.
 *
 * The values here are fixtures. They are shaped like secrets because the reader's
 * job is to carry them, and they are not secrets because nothing in this repository
 * ever holds a real one.
 *
 * @module dsh-opencode-patch/opencode-store.test
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  readOpencodeAccount,
  readOpencodeCredentials,
} from "../src/opencode-store.ts";

const temporary: string[] = [];

/** A database at a fresh path, built by `create`. */
const database = (create: (db: DatabaseSync) => void): string => {
  const directory = mkdtempSync(nodePath.join(os.tmpdir(), "opencode-store-"));
  temporary.push(directory);
  const path = nodePath.join(directory, "opencode.db");
  const db = new DatabaseSync(path);
  create(db);
  db.close();
  return path;
};

/** The schema, as the installation ships it, trimmed to the columns read. */
const schema = (db: DatabaseSync): void => {
  db.exec(`
    CREATE TABLE credential (
      id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT,
      connector_id TEXT, method_id TEXT, active INTEGER,
      time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE account (
      id TEXT PRIMARY KEY, email TEXT, url TEXT, access_token TEXT,
      refresh_token TEXT, token_expiry INTEGER,
      time_created INTEGER, time_updated INTEGER
    );
  `);
};

const addCredential = (
  db: DatabaseSync,
  id: string,
  integrationId: string,
  value: string,
  active: number,
  label?: string
): void => {
  db.prepare(
    "INSERT INTO credential (id, integration_id, label, value, active) VALUES (?, ?, ?, ?, ?)"
  ).run(id, integrationId, label ?? integrationId, value, active);
};

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("opencode-store: credentials", () => {
  it("returns the active rows, keyed by integration", () => {
    const path = database((db) => {
      schema(db);
      addCredential(db, "a", "opencode", "oc_sk_fixture_zen", 1, "Zen");
      addCredential(db, "b", "opencode-go", "sk-fixture-go", 1, "Go");
    });
    const found = readOpencodeCredentials(path);
    expect(found).toHaveLength(2);
    const integrations = found?.map((entry) => entry.integrationId) ?? [];
    expect(integrations).toHaveLength(2);
    expect(integrations).toEqual(
      expect.arrayContaining(["opencode", "opencode-go"])
    );
    expect(
      found?.find((entry) => entry.integrationId === "opencode")?.label
    ).toBe("Zen");
  });

  it("leaves an inactive credential behind", () => {
    // A retired key is one the user already replaced; offering it would resurrect
    // the thing they retired.
    const path = database((db) => {
      schema(db);
      addCredential(db, "old", "opencode", "oc_sk_fixture_old", 0);
      addCredential(db, "new", "opencode", "oc_sk_fixture_new", 1);
    });
    const found = readOpencodeCredentials(path);
    expect(found).toHaveLength(1);
    expect(found?.[0]?.value).toBe("oc_sk_fixture_new");
  });

  it("skips a row with no integration or no value rather than inventing one", () => {
    const path = database((db) => {
      schema(db);
      db.prepare(
        "INSERT INTO credential (id, integration_id, label, value, active) VALUES (?, ?, ?, ?, ?)"
      ).run("c", "", "", "orphan", 1);
      addCredential(db, "d", "opencode", "oc_sk_fixture_ok", 1);
    });
    const found = readOpencodeCredentials(path);
    expect(found).toHaveLength(1);
    expect(found?.[0]?.value).toBe("oc_sk_fixture_ok");
  });

  it("answers undefined for an installation with none", () => {
    const path = database(schema);
    expect(readOpencodeCredentials(path)).toBeUndefined();
  });
});

describe("opencode-store: the account", () => {
  it("returns the stored login", () => {
    const path = database((db) => {
      schema(db);
      db.prepare(
        "INSERT INTO account (id, email, access_token, refresh_token, token_expiry) VALUES (?, ?, ?, ?, ?)"
      ).run("acct", "you@example.com", "fixture-access", "fixture-refresh", 1);
    });
    expect(readOpencodeAccount(path)).toEqual({
      accessToken: "fixture-access",
      email: "you@example.com",
      refreshToken: "fixture-refresh",
    });
  });

  it("treats a row with no access token as no login", () => {
    const path = database((db) => {
      schema(db);
      db.prepare(
        "INSERT INTO account (id, email, access_token, refresh_token) VALUES (?, ?, ?, ?)"
      ).run("acct", "you@example.com", "", "");
    });
    expect(readOpencodeAccount(path)).toBeUndefined();
  });

  it("carries a missing refresh token rather than dropping the login", () => {
    const path = database((db) => {
      schema(db);
      db.prepare(
        "INSERT INTO account (id, email, access_token) VALUES (?, ?, ?)"
      ).run("acct", "you@example.com", "fixture-access");
    });
    expect(readOpencodeAccount(path)).toEqual({
      accessToken: "fixture-access",
      email: "you@example.com",
      refreshToken: undefined,
    });
  });
});

describe("opencode-store: nothing throws", () => {
  it("answers undefined when the file is not there", () => {
    // The ordinary case on a machine without OpenCode: not an error, and not
    // something a user should ever see a message about.
    const missing = nodePath.join(
      os.tmpdir(),
      "opencode-store-absent",
      "opencode.db"
    );
    expect(readOpencodeCredentials(missing)).toBeUndefined();
    expect(readOpencodeAccount(missing)).toBeUndefined();
  });

  it("answers undefined for a file that is not a database", () => {
    const directory = mkdtempSync(
      nodePath.join(os.tmpdir(), "opencode-store-")
    );
    temporary.push(directory);
    const path = nodePath.join(directory, "opencode.db");
    writeFileSync(path, "not a database at all");
    expect(readOpencodeCredentials(path)).toBeUndefined();
    expect(readOpencodeAccount(path)).toBeUndefined();
  });

  it("answers undefined for a database from another version", () => {
    const path = database((db) => {
      db.exec("CREATE TABLE something_else (id TEXT PRIMARY KEY)");
    });
    expect(readOpencodeCredentials(path)).toBeUndefined();
    expect(readOpencodeAccount(path)).toBeUndefined();
  });

  it("answers undefined for :memory:, which is not a path to open", () => {
    expect(readOpencodeCredentials(":memory:")).toBeUndefined();
    expect(readOpencodeAccount(":memory:")).toBeUndefined();
  });
});
