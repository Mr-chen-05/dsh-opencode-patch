/**
 * The credential pool: several keys, one active at a time, rotation the
 * deployment opts into.
 *
 * **It is off unless a deployment says otherwise.** Every entry point here
 * returns `undefined` when the switch is off or the plane's list is empty, and
 * every caller treats `undefined` as "resolve exactly what the profile named,
 * the way this plugin has always done". Adding the plugin must not change a
 * deployment's credential, and that is the whole contract.
 *
 * **The pool never writes behind anyone's key.** Rotation writes a reference
 * the pool owns — `OPENCODE_POOL_KEY` or its Go sibling — which nothing
 * shadows. Writing a deployment's own reference is refused by the seam itself
 * while a read-only source shadows it, and would replace their credential in the
 * one case where it is not; so the pool does not try, and the reference name is
 * a constant rather than something derived from a profile.
 *
 * **Two consumers, one pool.** A route this plugin serves resolves the pool
 * itself, which is true round-robin: each call takes the next entry. A route the
 * wrapper serves cannot — its credential resolution is the wrapper's — so the
 * pool publishes its current entry through the owned reference, and the wrapper
 * reads that on its next operation.
 *
 * @module dsh-opencode-patch/credential-pool
 */

import type { CredentialPoolConfig } from "./config.ts";
import type { CredentialsWriter } from "./cordis-context.ts";
import type { Plane } from "./pi-provider.ts";

/** The reference each plane's pool publishes its active key through. */
export const POOL_REFERENCE: Readonly<Record<Plane, string>> = {
  "opencode-go": "OPENCODE_GO_POOL_KEY",
  opencode: "OPENCODE_POOL_KEY",
};

/** What a caller needs to resolve through a pool. */
export interface CredentialPool {
  /** The reference this plane's active key is published through. */
  readonly reference: string;
  /**
   * The next entry's key, advancing the pool.
   *
   * Round-robin among the entries that are not marked failed. Returns
   * `undefined` when every entry has failed or none resolves, so a caller falls
   * through to its own resolution rather than failing a request over a pool
   * that is merely exhausted.
   */
  readonly next: () => Promise<
    | { readonly kind: "key"; readonly value: string }
    | { readonly kind: "exhausted" }
  >;
  /** The current entry's key without advancing. */
  readonly current: () => Promise<string | undefined>;
  /** Mark one entry failed, so the next advance skips it. */
  readonly markFailed: (ref: string) => void;
  /**
   * Mark the entry in use failed.
   *
   * What a credential failure means: the key the gateway just refused is the one
   * this pool handed out, and leaving it in rotation would hand it out again on
   * the next lap. The caller knows a request failed; the pool is the only one
   * that knows which entry was behind it.
   *
   * @returns the ref that was marked, or undefined when none was in use.
   */
  readonly markCurrentFailed: () => string | undefined;
  /** Put a failed entry back in rotation. */
  readonly restore: (ref: string) => void;
  /** The refs this pool rotates over, in order. */
  readonly refs: readonly string[];
}

/** What {@link createCredentialPool} needs. */
export interface CredentialPoolInputs {
  readonly plane: Plane;
  readonly config: CredentialPoolConfig;
  /**
   * The seam, when this composition mounts one.
   *
   * Rotation WRITES the active key through it, which is the only mechanism a
   * route the WRAPPER serves can be reached by. A pool without a seam still
   * rotates; it is simply invisible outside this plugin.
   */
  readonly credentials?: CredentialsWriter;
  /** Resolve one reference's value; the environment is the fallback. */
  readonly resolveRef: (ref: string) => Promise<{ value?: string } | undefined>;
  /** Called when a rotation's publish is refused; defaults to nothing. */
  /** Called when a rotation's publish is refused; defaults to nothing. */
  readonly onPublishRefused?: (reason: string | undefined) => void;
}

/**
 * One plane's references, in order, with the blank ones dropped.
 *
 * Entries are trimmed, because a list typed or pasted by hand carries stray
 * spaces and a reference name is a POSIX identifier — and because a whitespace
 * entry must not become a pool of one entry that resolves nothing. The trimmed
 * name is what the seam is asked about, so trimming cannot silently miss.
 */
const refsFor = (
  plane: Plane,
  config: CredentialPoolConfig
): readonly string[] =>
  (plane === "opencode-go" ? config.go : config.zen)
    .filter((ref): ref is string => typeof ref === "string")
    .map((ref) => ref.trim())
    .filter((ref) => ref.length > 0);

/**
 * The pool for one plane, or `undefined` when there is nothing to serve.
 *
 * Undefined is the answer in three cases, and each is a decision rather than an
 * accident: the deployment left the switch off, the plane's list is empty, or
 * every configured entry is empty. In all of them this plugin resolves exactly
 * what the profile declared, which is the zero-configuration default.
 *
 * @param inputs - the plane, the deployment's configuration and the seam.
 * @returns the pool, or undefined when the deployment has not opted in.
 */
export const createCredentialPool = (
  inputs: CredentialPoolInputs
): CredentialPool | undefined => {
  const { config, plane, resolveRef } = inputs;
  if (!config.enabled) {
    return undefined;
  }
  const refs = refsFor(plane, config);
  if (refs.length === 0) {
    return undefined;
  }

  const failed = new Set<string>();
  let index = 0;

  /**
   * Every entry's current value, read once per selection.
   *
   * Reading all of them rather than stopping at the first usable one keeps the
   * choice synchronous, and re-reading on every selection is what lets the pool
   * notice that a value changed under it — a deployment rotates an environment
   * variable, a login refreshes. A pool holds a handful of entries, so the
   * reads are cheap; serialising them one at a time would buy nothing.
   */
  const valuesFor = (): Promise<(string | undefined)[]> =>
    Promise.all(
      refs.map(async (ref) => {
        const hit = await resolveRef(ref);
        const value = hit?.value;
        return typeof value === "string" && value.length > 0
          ? value
          : undefined;
      })
    );

  /** The first entry at or after `from` that is neither failed nor unresolved. */
  const pick = (
    from: number,
    values: readonly (string | undefined)[]
  ): number | undefined => {
    for (let step = 0; step < refs.length; step += 1) {
      const candidate = (from + step) % refs.length;
      const ref = refs[candidate];
      if (ref === undefined || failed.has(ref)) {
        continue;
      }
      if (values[candidate] !== undefined) {
        return candidate;
      }
    }
    return undefined;
  };

  const select = async (from: number): Promise<string | undefined> => {
    const values = await valuesFor();
    const found = pick(from, values);
    if (found === undefined) {
      return undefined;
    }
    index = found;
    return values[found];
  };

  const reference = POOL_REFERENCE[plane];
  return {
    current: () => select(index),
    markCurrentFailed: () => {
      const ref = refs[index];
      if (ref !== undefined) {
        failed.add(ref);
      }
      return ref;
    },
    markFailed: (ref: string) => {
      failed.add(ref);
    },
    /**
     * Advance the pool AND publish the new key.
     *
     * Publishing on every rotation — rather than once when the plugin mounts —
     * is what the design claims. A route the wrapper serves resolves the pool's
     * reference per operation, so a rotation reaches it only if the rotation
     * writes. A pool that selected without writing would rotate perfectly and
     * stay invisible to every route but this plugin's own.
     *
     * A refused publish does not fail the rotation: the caller asked for a key
     * for a request it is making itself and already holds it. The publish
     * exists for OTHER routes, so it is reported rather than turned into an
     * error on a request that would have worked.
     */
    next: async () => {
      const chosen = await select((index + 1) % refs.length);
      // An exhausted pool is a RESULT, not an absent value: a caller that
      // receives "exhausted" knows to fall through to its own credential, while
      // one receiving `undefined` has to guess whether that meant exhaustion or
      // a bug in the selection.
      if (chosen === undefined) {
        return { kind: "exhausted" };
      }
      const published = await publishKey(reference, chosen, inputs.credentials);
      if (!published.ok) {
        inputs.onPublishRefused?.(published.reason);
      }
      return { kind: "key", value: chosen };
    },
    reference,
    refs,
    restore: (ref: string) => {
      failed.delete(ref);
    },
  };
};

/**
 * Publish a pool's active key through the reference the pool owns.
 *
 * The write is where the refusal matters: the seam rejects it while a read-only
 * source shadows the reference, so a deployment that exports `OPENCODE_POOL_KEY`
 * itself keeps its own value and this reports the refusal instead of believing a
 * rotation landed.
 *
 * @param pool - the pool whose key should be published.
 * @param credentials - the seam, when the composition mounts one.
 * @returns whether the value is published, and why not when it is not.
 */
export const publishPoolKey = async (
  pool: CredentialPool,
  credentials?: CredentialsWriter
): Promise<{ ok: boolean; reason?: string }> => {
  const value = await pool.current();
  return value === undefined
    ? { ok: false, reason: "no pool entry resolves" }
    : publishKey(pool.reference, value, credentials);
};

/**
 * Write one value under one reference the pool owns.
 *
 * Shared by the mount-time publish and by rotation, so both take the same path
 * and a refusal reads the same whichever produced it.
 */
const publishKey = async (
  reference: string,
  value: string,
  credentials?: CredentialsWriter
): Promise<{ ok: boolean; reason?: string }> => {
  if (credentials === undefined) {
    return {
      ok: false,
      reason: "this composition mounts no credentials service",
    };
  }
  try {
    await credentials.set(reference, value);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `the seam refused the write: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
};
