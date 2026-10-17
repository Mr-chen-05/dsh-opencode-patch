/**
 * Reading a plugin's own namespace off a Cordis remote, safely.
 *
 * **Why this exists and why it is not inline.** Cordis guards property access on
 * a remote by NAME: a namespace this bundle has not declared in `inject` THROWS
 * `cannot get property "remote.<ns>" without inject` rather than answering
 * `undefined`, and an optional chain cannot catch a throw. So
 * `scope.remote.opencodeGoUsage` takes the whole slot entry down — and it takes
 * it down in a way indistinguishable from a host that mounts no service at all.
 *
 * This was fixed once, in the usage meter's injector, and the same unguarded read
 * survived in the settings card. A guard that has to be remembered is a guard
 * that gets missed; it lives here once, and both call sites read through it.
 *
 * Declaring the names in `inject` is NOT the fix. A name there is a HARD gate
 * that holds the whole plugin until it exists, which is what took the meter out
 * once with "web boot: 1 entry did not activate".
 *
 * @module dsh-opencode-patch/settings-remote
 */

/** One call on a remote namespace, as the seam exposes it. */
export type RemoteCall = (query?: unknown) => Promise<unknown>;

/** The reachable calls of one namespace, or `undefined` when it is not. */
export type RemoteNamespace = Record<string, RemoteCall | undefined>;

/**
 * Whether a value is an object, narrowed without an assertion.
 *
 * `isRecord` from `guards.ts` does exactly this and is already the house
 * predicate; it is re-used rather than restated so the narrowing is a guard the
 * compiler follows instead of a cast it only tolerates.
 */
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * The namespace's calls, or `undefined` when the namespace is not reachable.
 *
 * Three ways it is not reachable, all answering `undefined`: there is no remote,
 * the remote has no such namespace, and the access THROWS because the bundle
 * never declared the name.
 *
 * @param remote - the host's remote face.
 * @param namespace - the namespace to read.
 * @returns the namespace's calls, or `undefined`.
 */
export const remoteNamespace = (
  remote: unknown,
  namespace: string
): RemoteNamespace | undefined => {
  try {
    if (!isObject(remote)) {
      return undefined;
    }
    const face: unknown = remote[namespace];
    if (!isObject(face)) {
      return undefined;
    }
    // The one cast, and it is a widening of a value already known to be a plain
    // object: the seam's own shape, whose members are checked at the call site
    // by `isRemoteCall`. Narrowing each key here would validate the whole
    // namespace to read one function off it.
    return face as RemoteNamespace;
  } catch {
    // The guarded-access throw. Ordinary, and exactly what this is for.
    return undefined;
  }
};

/** Whether a value is one of the seam's call shapes. */
export const isRemoteCall = (value: unknown): value is RemoteCall =>
  typeof value === "function";
