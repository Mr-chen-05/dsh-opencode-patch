/**
 * Take a provider route over from the adapter that currently serves it.
 *
 * `llm.registerAdapter` refuses a route that already has an adapter
 * (`DUPLICATE_ADAPTER`, `dsh-llm/lib/index.js:273`), which is why this plugin used
 * to mount EXTRA routes for the protocols its models speak and redirect calls to
 * them. That works, but it costs the thing a user notices: the extra routes are
 * providers, so they must be hidden from every listing, and the models have to be
 * merged back into the route the user actually configured.
 *
 * The registry itself is the way out, and it needs no unsupported internals: the
 * duplicate check reads `adapters`, so REMOVING the current entry first makes the
 * route registrable through the ordinary API. Our registration then carries a
 * disposer and fires `llm/adapters-updated`, exactly like one the host made.
 *
 * @module adapter-replacement
 */

import type { CordisContext } from "./cordis-context.ts";

/** A registration as the registry stores it: the adapter, plus its route. */
interface RouteRegistration {
  readonly adapter: Record<string, unknown>;
}

/** The part of the registry this module reads and writes. */
interface Registry {
  readonly adapters?: Map<string, RouteRegistration>;
  readonly registerAdapter?: (
    providers: readonly string[],
    adapter: unknown
  ) => unknown;
}

/**
 * Replace the adapter behind `routes` with one this plugin builds.
 *
 * The swap is two steps and the order matters: release the current entry, then
 * register. A failure at either step restores what was there, so a composition
 * that cannot take the route over is left exactly as it was rather than with the
 * provider missing.
 *
 * @param ctx - the host context, for the registry and the logging.
 * @param routes - the provider routes to take over.
 * @param build - builds the adapter that will serve them.
 * @returns a disposer that gives the routes back, or `undefined` when the
 *   composition cannot be taken over.
 */
export const replaceRouteAdapters = (
  ctx: CordisContext,
  routes: readonly string[],
  build: () => Record<string, unknown>
): (() => void) | undefined => {
  // The registry is read structurally: `adapters` is a field on the service, not
  // part of its declared interface.
  const { adapters, registerAdapter } = (ctx.llm ?? {}) as unknown as Registry;
  if (!(adapters instanceof Map) || typeof registerAdapter !== "function") {
    return undefined;
  }
  // Both halves are required: an adapter with no routes is refused by the host,
  // and this module has nothing to say about a route nobody serves.
  const present = routes.filter((route) => adapters.has(route));
  if (present.length === 0 || present.length !== routes.length) {
    return undefined;
  }

  // What was there, kept so the swap is reversible. Held by value: the registry
  // entry is replaced, and the host's own effect still believes it holds it.
  const previous = new Map<string, RouteRegistration>();
  for (const route of present) {
    const registration = adapters.get(route);
    if (registration === undefined) {
      return undefined;
    }
    previous.set(route, registration);
  }

  const restore = (): void => {
    for (const [route, registration] of previous) {
      adapters.set(route, registration);
    }
  };

  let adapter: Record<string, unknown>;
  try {
    adapter = build();
  } catch (error) {
    ctx.logger?.warn?.(
      "[dsh-opencode-patch] could not build the replacement adapter; leaving the route with its own",
      error
    );
    return undefined;
  }

  // Released only now, so a build failure never leaves the provider unserved.
  for (const route of present) {
    adapters.delete(route);
  }

  let dispose: (() => void) | undefined;
  try {
    const handle: unknown = registerAdapter(present, adapter);
    dispose = typeof handle === "function" ? (handle as () => void) : undefined;
  } catch (error) {
    restore();
    ctx.logger?.warn?.(
      "[dsh-opencode-patch] the replacement adapter was refused; the route keeps its own",
      error
    );
    return undefined;
  }

  return () => {
    try {
      dispose?.();
    } finally {
      restore();
    }
  };
};
