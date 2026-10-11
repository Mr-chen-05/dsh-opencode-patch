/**
 * Structural view of the Cordis host context.
 *
 * The host plugin cannot import `@deepseek-ai/cordis` types: that package
 * ships with the Harness installation, not as a dependency of this package.
 * So the context surface the plugin actually touches is declared here as
 * minimal interfaces, and every narrow step is a runtime-checked predicate
 * (never an `as` cast) — mock contexts in tests and future Cordis versions
 * both fail loudly instead of silently mis-shaping.
 *
 * @module dsh-opencode-patch/cordis-context
 */

import { readString } from "./config-values.ts";
import { isFunctionLike, isRecord } from "./guards.ts";

/**
 * The disposer `llm.registerAdapter` returns.
 *
 * It is a **callable**, not an object with a `dispose` method, and it carries an
 * atomic route swap: `replace(providers)` re-points the same adapter at a new
 * route set. A stand-in handed to a plugin that expects the real contract has to
 * answer both, or the plugin's own re-registration path throws on a missing
 * method rather than on the conflict it should be reporting.
 */
export type AdapterRegistrationLike = (() => void) & {
  replace?: (providers: readonly string[]) => void;
};

/**
 * The directory counterpart of {@link AdapterRegistrationLike}: withdraws every
 * configurable provider a registration holds, and swaps them atomically.
 */
export type DirectoryRegistrationLike = (() => void) & {
  replace?: (entries: readonly unknown[]) => void;
};

/** Logging + lifecycle capabilities `apply()` uses. */
export interface CordisContext {
  effect?: (fn: () => unknown, name?: string) => void;
  /**
   * A child context with extra metadata on top of this scope, prototypally
   * inheriting every property. Own properties of the metadata shadow the
   * inherited ones, which is how a service can be shadowed for one subtree
   * without the parent being mutated.
   */
  extend?: (meta?: Record<string, unknown>) => CordisContext;
  get?: (name: string) => unknown;
  inject?: (deps: string[], cb: (scope: unknown) => void) => void;
  /**
   * The loader's entry list. Every configured entry the host loaded keeps its
   * raw import result there, which is how the plugin reaches a package it is
   * deliberately not a dependency of.
   */
  loader?: LoaderService;
  llm?: {
    /**
     * Offer to interrogate provider endpoints on behalf of one settings
     * namespace. Uniqueness is by namespace, so a second registration under the
     * same one is a conflict rather than a replacement.
     */
    registerModelDiscovery?: (
      ns: string,
      discover: (request?: unknown, signal?: AbortSignal) => Promise<unknown>
    ) => (() => void) | undefined;
    /** Declare routes a plugin can activate through configuration. */
    registerConfigurableProviders?: (
      entries: readonly unknown[]
    ) => DirectoryRegistrationLike | undefined;
    discoverModels?: (
      settingsNs: string,
      request?: unknown,
      signal?: AbortSignal
    ) => Promise<unknown>;
    /**
     * Re-dispatch a generation. Used to hand a call to the route whose `api`
     * already names the format it needs, instead of translating the protocol.
     */
    stream?: (options: unknown) => unknown;
    /** Registered provider routes, for checking a target exists before using it. */
    listProviders?: () => unknown;
    /** Routes offered in Settings → Models. */
    listConfigurableProviders?: () => unknown;
    /**
     * Register an adapter for routes the plugin owns. Used to serve the
     * gateway's Responses plane without the user declaring anything.
     */
    registerAdapter?: (
      providers: readonly string[],
      adapter: unknown
    ) => AdapterRegistrationLike | undefined;
    /**
     * The models one route advertises. The browser catalog turns each route into
     * a group and DROPS groups with no models, so this is how an internal route
     * stays out of the picker.
     */
    listModels?: (provider: string) => Promise<unknown>;
  };
  /**
   * A child context whose reads and writes of `name` resolve in a new scope.
   * Used to hide the authorization seam from a mounted `llm-pi-ai` instance, so
   * it registers no auth flows and cannot collide with the host's own.
   */
  isolate?: (name: string) => CordisContext;
  logger?: {
    info?: (msg: string, ...args: unknown[]) => void;
    warn?: (msg: string, ...args: unknown[]) => void;
  };
  on?: (
    event: string,
    callback: (
      options: unknown,
      next: () => unknown,
      ...rest: unknown[]
    ) => unknown,
    options?: { prepend?: boolean }
  ) => void;
  /**
   * Start a plugin in this context and return its fiber. A plugin is a function
   * or an object with an `apply` method — which is exactly what `llm-pi-ai`
   * exports, so this is how the plugin mounts it.
   */
  plugin?: (plugin: unknown, config?: unknown) => PluginFiber | undefined;
}

/**
 * The fiber `ctx.plugin` starts a plugin in.
 *
 * **Not thenable.** Cordis's `Fiber` has no `then`, so `await fiber` resolves
 * immediately with the fiber itself and swallows nothing: `await()` is the
 * method that waits for the lifecycle work and rethrows a startup or
 * config-validation error. Without calling it, a mount that failed validation
 * looks exactly like one that succeeded.
 */
export interface PluginFiber {
  /** Wait for current lifecycle work, rethrowing a startup error if any. */
  await?: () => Promise<unknown>;
  /** Dispose and unload; resolves once the unwind is complete. */
  dispose?: () => Promise<unknown>;
}

/** One loaded cordis entry's identifying options. */
export interface EntryOptions {
  id?: string;
  name?: string;
}

/** Credentials-service lookup, as the plugin consumes it. */
export type CredentialsResolver = (
  ref: string
) => Promise<{ value?: string } | undefined>;

/**
 * The plugin's own cordis entry options (`fiber.entry.options`), when the
 * context carries them. Used only to detect a legacy row id/name and log the
 * rename notice.
 *
 * @param ctx - the plugin context, mock or real.
 */
export const readEntryOptions = (ctx: unknown): EntryOptions | undefined => {
  if (!isRecord(ctx)) {
    return undefined;
  }
  const fiber: unknown = ctx.fiber;
  if (!isRecord(fiber)) {
    return undefined;
  }
  const entry: unknown = fiber.entry;
  if (!isRecord(entry)) {
    return undefined;
  }
  const options: unknown = entry.options;
  if (!isRecord(options)) {
    return undefined;
  }
  const id = typeof options.id === "string" ? options.id : undefined;
  const name = typeof options.name === "string" ? options.name : undefined;
  if (id === undefined && name === undefined) {
    return undefined;
  }
  return { id, name };
};

/**
 * Resolve a credential reference through `ctx.get("credentials")`, or
 * `undefined` when the Host serves no credentials service.
 *
 * Errors thrown by the service degrade to `undefined`: a broken credentials
 * service must not fail a plugin whose env fallback still works.
 *
 * @param ctx - the plugin context, mock or real.
 */
/** The write side of the credential seam, as far as this plugin needs it. */
export interface CredentialsWriter {
  /** Resolve one reference, or undefined while unconfigured. */
  readonly resolve: (ref: string) => Promise<{ value?: string } | undefined>;
  /** Durably store one value; rejects while a read-only source shadows it. */
  readonly set: (ref: string, value: string) => Promise<void>;
  /** Remove one reference; removing an absent one is a no-op. */
  readonly unset: (ref: string) => Promise<void>;
  /** The stored record under one key, with its value, or undefined. */
  readonly readRecord: (
    key: string
  ) => Promise<{ kind?: string; payload?: unknown } | undefined>;
  /**
   * Store one grant payload atomically.
   *
   * The seam's `modifyRecord` is the only write path for a record, and this
   * hands it a mutation that replaces the payload outright — which is what a
   * rotating refresh token needs: the write must not be able to lose a token
   * another process obtained in between a read and a write.
   */
  readonly writeGrant: (key: string, payload: unknown) => Promise<void>;
  /** Remove one record; removing an absent one is a no-op. */
  readonly deleteRecord: (key: string) => Promise<void>;
}

/**
 * The credential service itself, when this composition mounts one.
 *
 * Separate from {@link readCredentialsResolver} because writing is a different
 * question from reading: the seam refuses a write that a read-only source would
 * shadow, and a caller that cannot tell a refusal from a success would believe a
 * rotation landed when it did not.
 *
 * @param ctx - the host context.
 * @returns the service's resolve, set and unset, or undefined when absent.
 */
export const readCredentialsWriter = (
  ctx: unknown
): CredentialsWriter | undefined => {
  if (!isRecord(ctx) || !isFunctionLike(ctx.get)) {
    return undefined;
  }
  const { get } = ctx;
  let host: unknown;
  try {
    host = Reflect.apply(get, ctx, ["credentials"]);
  } catch {
    return undefined;
  }
  if (
    !isRecord(host) ||
    !isFunctionLike(host.resolve) ||
    !isFunctionLike(host.set) ||
    !isFunctionLike(host.unset) ||
    !isFunctionLike(host.readRecord) ||
    !isFunctionLike(host.modifyRecord) ||
    !isFunctionLike(host.deleteRecord)
  ) {
    return undefined;
  }
  const { deleteRecord, modifyRecord, readRecord, resolve, set, unset } = host;
  return {
    resolve: async (ref: string): Promise<{ value?: string } | undefined> => {
      const hit: unknown = await Reflect.apply(resolve, host, [ref]);
      if (!isRecord(hit)) {
        return undefined;
      }
      const { value } = hit;
      return typeof value === "string" ? { value } : undefined;
    },
    set: async (ref: string, value: string): Promise<void> => {
      await Reflect.apply(set, host, [ref, value]);
    },
    unset: async (ref: string): Promise<void> => {
      await Reflect.apply(unset, host, [ref]);
    },
    readRecord: async (
      key: string
    ): Promise<{ kind?: string; payload?: unknown } | undefined> => {
      const record: unknown = await Reflect.apply(readRecord, host, [key]);
      if (!isRecord(record)) {
        return undefined;
      }
      const { kind, payload } = record;
      return {
        ...(typeof kind === "string" ? { kind } : {}),
        ...(payload === undefined ? {} : { payload }),
      };
    },
    writeGrant: async (key: string, payload: unknown): Promise<void> => {
      // One mutation, under the seam's own lock: the payload is replaced whole,
      // so an access token and the refresh token that goes with it can never
      // land as two writes a reader could interleave with.
      await Reflect.apply(modifyRecord, host, [
        key,
        () => Promise.resolve({ kind: "grant", payload }),
      ]);
    },
    deleteRecord: async (key: string): Promise<void> => {
      await Reflect.apply(deleteRecord, host, [key]);
    },
  };
};

/**
 * The pool rotator this composition's provider mount registered, if any.
 *
 * A handoff between two installers that must not know about each other: the
 * provider mount owns the pools, and the fetch interceptor sees the credential
 * failures a rotation should answer. Registering a rotator rather than sharing a
 * pool keeps rotation in one place — and means an uninstalled provider mount
 * simply has none, so a credential failure rotates nothing instead of throwing.
 *
 * @param ctx - the host context.
 * @returns the registered rotator, or undefined when there is none.
 */
export const readCredentialPoolRotator = (
  ctx: unknown
): ((plane: string, status: number) => Promise<void>) | undefined => {
  if (!isRecord(ctx)) {
    return undefined;
  }
  const candidate = ctx.credentialPoolRotator;
  if (!isFunctionLike(candidate)) {
    return undefined;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- isFunctionLike proves it is callable; the parameter list is this module's own contract and the provider mount is the only writer of the slot
  return candidate as (plane: string, status: number) => Promise<void>;
};

export const readCredentialsResolver = (
  ctx: unknown
): CredentialsResolver | undefined => {
  if (!isRecord(ctx) || !isFunctionLike(ctx.get)) {
    return undefined;
  }
  const { get } = ctx;
  let host: unknown;
  try {
    host = Reflect.apply(get, ctx, ["credentials"]);
  } catch {
    return undefined;
  }
  if (!isRecord(host) || !isFunctionLike(host.resolve)) {
    return undefined;
  }
  const { resolve } = host;
  return async (ref: string): Promise<{ value?: string } | undefined> => {
    let hit: unknown;
    try {
      hit = await Reflect.apply(resolve, host, [ref]);
    } catch {
      return undefined;
    }
    if (!isRecord(hit)) {
      return undefined;
    }
    const value: unknown = hit.value;
    return typeof value === "string" ? { value } : {};
  };
};

/**
 * Structural claim satisfied by any context exposing the loader's entry list.
 *
 * `unwrapExports` is what turns an entry's RAW import result into the plugin
 * object the registry would have applied — the same normalization the loader
 * itself performs, so a default-export or CJS-interop shape needs no second
 * guess here.
 */
export interface LoaderHost {
  loader: {
    entries: () => Iterable<unknown>;
    unwrapExports?: (exports: unknown) => unknown;
  };
}

/** The loader surface, as the plugin reads it off its own context. */
export type LoaderService = LoaderHost["loader"];

/**
 * True when `ctx` exposes the loader's entry list. Iteration itself is the
 * caller's trust boundary, exactly as it was before this predicate existed.
 *
 * @param ctx - the plugin context, mock or real.
 */
export const isLoaderHost = (ctx: unknown): ctx is LoaderHost => {
  if (!isRecord(ctx)) {
    return false;
  }
  const loader: unknown = ctx.loader;
  if (!isRecord(loader)) {
    return false;
  }
  const entries: unknown = loader.entries;
  return typeof entries === "function";
};

/** Session metadata resolved from the host SessionRegistry. */
export interface SessionMeta {
  cwd?: string;
  parentSession?: string;
  /**
   * The session's creation time in milliseconds.
   *
   * It sits on the RECORD, not in its `header` (the Host validates
   * `record.createdAt`), and it is what lets a derived OpenCode session id
   * carry a REAL creation time rather than hash bits — the vendor parses that
   * field back out of the id.
   */
  createdAt?: number;
}

export type SessionMetaResolver = (
  sessionId: string
) => SessionMeta | undefined;

/**
 * Read the session metadata lookup function from `ctx.get("sessions")` or `ctx.sessions`,
 * returning `undefined` when the Host serves no session service.
 */
export const readSessionMetaResolver = (
  ctx: unknown
): SessionMetaResolver | undefined => {
  if (!isRecord(ctx)) {
    return undefined;
  }
  let sessions: unknown;
  if (isFunctionLike(ctx.get)) {
    try {
      sessions = Reflect.apply(ctx.get, ctx, ["sessions"]);
    } catch {
      return undefined;
    }
  } else {
    try {
      sessions = Reflect.get(ctx, "sessions");
    } catch {
      return undefined;
    }
  }
  if (!isRecord(sessions) || !isFunctionLike(sessions.get)) {
    return undefined;
  }
  const { get } = sessions;
  return (sessionId: string): SessionMeta | undefined => {
    try {
      const session: unknown = Reflect.apply(get, sessions, [sessionId]);
      if (!isRecord(session)) {
        return undefined;
      }
      const header: unknown = session.header;
      if (!isRecord(header)) {
        return undefined;
      }
      // Blank fields are absent, not values: a whitespace-only cwd would
      // otherwise become the `x-opencode-project` header. `readString` is the
      // same rule the config readers use, so "absent or blank means default"
      // holds in one place.
      const parentSession = readString(header.parentSession);
      const cwd = readString(header.cwd);
      // A creation time is a non-negative safe integer or it is absent; a
      // malformed one must not become a timestamp in the id.
      const createdAt: number | undefined =
        typeof session.createdAt === "number" &&
        Number.isSafeInteger(session.createdAt) &&
        session.createdAt >= 0
          ? session.createdAt
          : undefined;
      return { createdAt, cwd, parentSession };
    } catch {
      return undefined;
    }
  };
};
