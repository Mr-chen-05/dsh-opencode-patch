/**
 * `cordis-context.ts` — the runtime-checked view of the Cordis host context.
 *
 * The plugin cannot import `@deepseek-ai/cordis` (it ships with the harness, not
 * as a dependency), so every access here tolerates an unknown host shape and
 * degrades to `undefined`. These cases pin that tolerance: a guard that throws
 * or mis-narrows silently disables session affinity, parent-session headers or
 * credential resolution without any visible error.
 */

import assert from "node:assert/strict";

import { describe, expect, it, vi } from "vitest";

import {
  isLoaderHost,
  readCredentialsResolver,
  readCredentialsWriter,
  readEntryOptions,
  readSessionMetaResolver,
} from "../src/cordis-context.ts";

describe("cordis-context: readEntryOptions", () => {
  it("reads id and name from fiber.entry.options", () => {
    const ctx = { fiber: { entry: { options: { id: "dsh-opencode-patch" } } } };
    expect(readEntryOptions(ctx)).toEqual({
      id: "dsh-opencode-patch",
      name: undefined,
    });

    const both = {
      fiber: { entry: { options: { id: "legacy", name: "dsh-opencode" } } },
    };
    expect(readEntryOptions(both)).toEqual({
      id: "legacy",
      name: "dsh-opencode",
    });
  });

  it("returns undefined at every missing step", () => {
    expect(readEntryOptions(null)).toBeUndefined();
    expect(readEntryOptions("ctx")).toBeUndefined();
    expect(readEntryOptions({})).toBeUndefined();
    expect(readEntryOptions({ fiber: {} })).toBeUndefined();
    expect(readEntryOptions({ fiber: { entry: {} } })).toBeUndefined();
    expect(
      readEntryOptions({ fiber: { entry: { options: {} } } })
    ).toBeUndefined();
    // Non-string members are dropped, so an id-only row still reports itself.
    expect(
      readEntryOptions({ fiber: { entry: { options: { id: 42, name: "n" } } } })
    ).toEqual({ id: undefined, name: "n" });
  });
});

describe("cordis-context: isLoaderHost", () => {
  it("requires a callable loader.entries", () => {
    expect(isLoaderHost({ loader: { entries: () => [] } })).toBe(true);
    expect(isLoaderHost({ loader: { entries: 1 } })).toBe(false);
    expect(isLoaderHost({ loader: {} })).toBe(false);
    expect(isLoaderHost({})).toBe(false);
    expect(isLoaderHost(null)).toBe(false);
    expect(isLoaderHost(() => 1)).toBe(false);
  });
});

describe("cordis-context: readCredentialsResolver", () => {
  it("resolves a credential through ctx.get('credentials')", async () => {
    const ctx = {
      get: (name: string) =>
        name === "credentials"
          ? { resolve: async (ref: string) => ({ value: `key-for-${ref}` }) }
          : undefined,
    };
    const resolver = readCredentialsResolver(ctx);
    assert.ok(resolver, "expected a resolver");
    expect(await resolver("opencode-go")).toEqual({
      value: "key-for-opencode-go",
    });
  });

  it("reports a configured-but-valueless credential as an empty object", async () => {
    const ctx = {
      get: () => ({ resolve: async () => ({}) }),
    };
    const resolver = readCredentialsResolver(ctx);
    assert.ok(resolver);
    expect(await resolver("ref")).toEqual({});
  });

  it("returns undefined for unusable host shapes", () => {
    expect(readCredentialsResolver(null)).toBeUndefined();
    expect(readCredentialsResolver({})).toBeUndefined();
    expect(readCredentialsResolver({ get: 1 })).toBeUndefined();
    // get() itself throwing must not escape.
    expect(
      readCredentialsResolver({
        get: () => {
          throw new Error("no credentials service");
        },
      })
    ).toBeUndefined();
    // A host with no resolve() is not a resolver.
    expect(readCredentialsResolver({ get: () => ({}) })).toBeUndefined();
    expect(readCredentialsResolver({ get: () => null })).toBeUndefined();
  });

  it("degrades to undefined when the service rejects or answers oddly", async () => {
    const rejecting = readCredentialsResolver({
      get: () => ({
        resolve: async () => {
          throw new Error("vault down");
        },
      }),
    });
    assert.ok(rejecting);
    expect(await rejecting("ref")).toBeUndefined();

    const nonRecord = readCredentialsResolver({
      get: () => ({ resolve: async () => "plain-string" }),
    });
    assert.ok(nonRecord);
    expect(await nonRecord("ref")).toBeUndefined();

    const nonStringValue = readCredentialsResolver({
      get: () => ({ resolve: async () => ({ value: 7 }) }),
    });
    assert.ok(nonStringValue);
    expect(await nonStringValue("ref")).toEqual({});
  });
});

describe("cordis-context: readSessionMetaResolver", () => {
  const sessionsHost = (sessions: unknown) => ({ get: () => sessions });

  it("reads cwd and parentSession from the session header", () => {
    const resolver = readSessionMetaResolver(
      sessionsHost({
        get: () => ({
          header: { cwd: "/workspace/project", parentSession: "ses_parent" },
        }),
      })
    );
    assert.ok(resolver, "expected a resolver");
    expect(resolver("ses_child")).toEqual({
      cwd: "/workspace/project",
      parentSession: "ses_parent",
    });
  });

  it("falls back to ctx.sessions when ctx.get is absent", () => {
    const resolver = readSessionMetaResolver({
      sessions: { get: () => ({ header: { cwd: "/w" } }) },
    });
    assert.ok(resolver);
    expect(resolver("ses")).toEqual({ cwd: "/w", parentSession: undefined });
  });

  it("returns undefined for unusable host shapes", () => {
    expect(readSessionMetaResolver(null)).toBeUndefined();
    expect(readSessionMetaResolver({})).toBeUndefined();
    // get() throwing (a service not injected) must not escape.
    expect(
      readSessionMetaResolver({
        get: () => {
          throw new Error('cannot get property "sessions" without inject');
        },
      })
    ).toBeUndefined();
    expect(readSessionMetaResolver(sessionsHost(null))).toBeUndefined();
    expect(readSessionMetaResolver(sessionsHost({}))).toBeUndefined();
    expect(readSessionMetaResolver(sessionsHost({ get: 1 }))).toBeUndefined();
  });

  it("normalizes blank header fields and odd sessions to undefined", () => {
    const byId: Record<string, unknown> = {
      blank: { header: { cwd: "   ", parentSession: "" } },
      "no-header": {},
      other: "not-a-record",
      padded: { header: { cwd: "  /w/p  " } },
    };
    const resolver = readSessionMetaResolver(
      sessionsHost({
        get: (id: string) => {
          if (id === "throws") {
            throw new Error("gone");
          }
          return byId[id];
        },
      })
    );
    assert.ok(resolver);

    expect(resolver("blank")).toEqual({
      cwd: undefined,
      parentSession: undefined,
    });
    expect(resolver("padded")).toEqual({
      cwd: "/w/p",
      parentSession: undefined,
    });
    // A session with no header at all is unresolvable, not an empty meta.
    expect(resolver("no-header")).toBeUndefined();
    expect(resolver("other")).toBeUndefined();
    expect(resolver("throws")).toBeUndefined();
  });
});

describe("cordis-context: readCredentialsWriter", () => {
  /** A seam with all six methods, each recorded so a test can see which ran. */
  const seam = (overrides: Record<string, unknown> = {}) => {
    const calls: string[] = [];
    const records = new Map<string, unknown>();
    return {
      calls,
      credentials: {
        deleteRecord: (key: string) => {
          calls.push(`delete:${key}`);
          records.delete(key);
        },
        modifyRecord: async (
          key: string,
          mutate: (current?: unknown) => Promise<unknown>
        ) => {
          calls.push(`modify:${key}`);
          // The real seam awaits the mutation under its lock; a stub
          // that skipped the await would return before the write landed.
          const next = await mutate(records.get(key));
          if (next !== undefined) {
            records.set(key, next);
          }
          return next;
        },
        readRecord: (key: string) => {
          calls.push(`read:${key}`);
          return Promise.resolve(records.get(key));
        },
        resolve: vi.fn(),
        set: vi.fn(),
        unset: vi.fn(),
        ...overrides,
      },
      records,
    };
  };

  it("reads, writes and deletes a record through the seam", async () => {
    const { calls, credentials, records } = seam();
    const writer = readCredentialsWriter({ get: () => credentials });
    expect(writer).toBeDefined();

    await writer?.writeGrant("scope/id", { accessToken: "a" });
    expect(records.get("scope/id")).toEqual({
      kind: "grant",
      payload: { accessToken: "a" },
    });
    // And the record is read back as the seam stores it, not as it was written:
    // a record with no payload yields neither field.
    await expect(writer?.readRecord("scope/id")).resolves.toEqual({
      kind: "grant",
      payload: { accessToken: "a" },
    });
    await writer?.deleteRecord("scope/id");
    await expect(writer?.readRecord("scope/id")).resolves.toBeUndefined();
    expect(calls).toEqual([
      "modify:scope/id",
      "read:scope/id",
      "delete:scope/id",
      "read:scope/id",
    ]);
  });

  it("reports an absent record as undefined rather than an empty one", async () => {
    const { credentials } = seam();
    const writer = readCredentialsWriter({ get: () => credentials });
    await expect(writer?.readRecord("scope/missing")).resolves.toBeUndefined();
  });

  it("drops a record that carries no payload, so the reader cannot invent one", async () => {
    const { credentials } = seam({
      readRecord: () => Promise.resolve({ kind: "api_key" }),
    });
    expect(credentials.readRecord).toBeDefined();
    const writer = readCredentialsWriter({ get: () => credentials });
    // `kind` survives; `payload` was never there and must not become `null`
    // or an empty object — a reader would then have to guess whether the
    // grant had a payload.
    await expect(writer?.readRecord("scope/id")).resolves.toStrictEqual({
      kind: "api_key",
    });
  });

  it("is undefined when the seam lacks the record half", async () => {
    // A composition that mounts a credential service without `modifyRecord`
    // cannot keep a rotating refresh token atomically, so this must not
    // pretend otherwise.
    const partial = {
      deleteRecord: () => Promise.resolve(),
      readRecord: () => Promise.resolve(),
      resolve: () => Promise.resolve(),
      set: () => Promise.resolve(),
      unset: () => Promise.resolve(),
    };
    expect(readCredentialsWriter({ get: () => partial })).toBeUndefined();
    expect(readCredentialsWriter({})).toBeUndefined();
    expect(
      readCredentialsWriter({ get: () => "not a service" })
    ).toBeUndefined();
  });

  it("is undefined when asking for the seam throws", async () => {
    const ctx = {
      get: () => {
        throw new Error("no such service");
      },
    };
    expect(readCredentialsWriter(ctx)).toBeUndefined();
  });
});
