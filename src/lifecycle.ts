/**
 * Plugin lifecycle: the `apply()` entry point and its installers.
 *
 * `apply()` is a composition of small, independently readable installers, one
 * per side effect the plugin has on the host:
 *
 * | installer                | side effect                                   |
 * | ------------------------ | --------------------------------------------- |
 * | {@link logRenameNotice}  | one-time notice for legacy rows                |
 * | {@link installUsageService} | register the Go quota service + remotes     |
 * | {@link installFetchPatch}   | wrap `globalThis.fetch` (returns `false` if none) |
 * | {@link installStreamHook}   | capture turn state on `llm/stream`          |
 * | {@link installModelDiscovery} | publish the canonical catalog to the picker |
 *
 * Order is load-bearing and documented at the call site in {@link apply}.
 *
 * @module dsh-opencode-patch/lifecycle
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync } from "node:fs";

import {
  type PluginConfig,
  type ResolvedPluginConfig,
  resolveConfig,
} from "./config.ts";
import {
  type CordisContext,
  readCredentialPoolRotator,
  readCredentialsWriter,
  readEntryOptions,
} from "./cordis-context.ts";
import { recordDebug } from "./debug.ts";
import { patchFetch } from "./fetch-patch.ts";
import { resolveGoBaseURL } from "./go-discovery.ts";
import { isFetchFunction } from "./guards.ts";
import { LEGACY_NAME, LEGACY_PKG, name } from "./identity.ts";
import { LoginService } from "./login-service.ts";
import {
  type CatalogModelSpec,
  getLiveGoCatalog,
  getLiveZenCatalog,
  sanitizeModalities,
} from "./models-catalog.ts";
import {
  decorateModelDiscovery,
  hideResponsesRoute,
} from "./models-discovery.ts";
import { orgFor, setOrg } from "./org-cache.ts";
import { registerResponsesProvider } from "./responses-provider.ts";
import { isServableSdk } from "./responses-routes.ts";
import { createStreamHook } from "./stream-hook.ts";
import { createTokenStore } from "./token-store.ts";
import type { ActiveTurnState } from "./turn-store.ts";
import { GoUsageService } from "./usage.ts";

/**
 * One catalog row in the shape DSH's model-discovery surface expects.
 *
 * Models whose SDK no route serves are dropped: offering them would be offering
 * a model that cannot work, and the user has no way to tell that from the row.
 */
const toDiscovered = (specs: readonly CatalogModelSpec[]) =>
  specs
    .filter((m) => isServableSdk(m.provider_npm))
    .map((m) => ({
      contextWindow: m.context_window,
      id: m.id,
      inputModalities: sanitizeModalities(m.input_modalities),
      maxTokens: m.max_output_tokens,
      name: m.name,
    }));

/** Tell a row still configured under the pre-rename id/package to update. */
const logRenameNotice = (ctx: CordisContext): void => {
  const entryOptions = readEntryOptions(ctx);
  if (entryOptions?.name === LEGACY_PKG || entryOptions?.id === LEGACY_NAME) {
    ctx.logger?.info?.(
      '[dsh-opencode-patch] Notice: "@viztor/dsh-opencode" has been renamed to "dsh-opencode-patch". Please update your profile configuration.'
    );
  }
};

/**
 * Register the Go quota service and its Typert remote face.
 *
 * Runs before the fetch patch so a composition without `globalThis.fetch`
 * still gets a working meter.
 */
/**
 * Publish a service through `ctx.provide`, when `ctx.plugin` is not available.
 *
 * The fallback exists because a service the client cannot reach has no way to say
 * so from the host: the installers report through `ctx.logger`, and a host that
 * writes no log file turns every one of those into a silence. `provide` reaches
 * the same lookup under the same name, which is the half that matters.
 *
 * @param ctx - the host context.
 * @param name - the service name the client looks for.
 * @param Service - the service class.
 * @param options - its constructor options.
 */
const mountByProvide = (
  ctx: CordisContext,
  serviceName: string,
  Service: new (ctx: never, options: never) => unknown,
  options: unknown
): void => {
  const { provide } = ctx as {
    provide?: (key: string, value: unknown) => void;
  };
  if (typeof provide !== "function") {
    ctx.logger?.warn?.(
      `[dsh-opencode-patch] ${serviceName} did not mount: this composition has neither ctx.plugin nor ctx.provide`
    );
    return;
  }
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the constructors take cordis `Context`, whose types ship only from the Harness installation.
    provide.call(ctx, serviceName, new Service(ctx as never, options as never));
  } catch (error) {
    ctx.logger?.warn?.(
      `[dsh-opencode-patch] ${serviceName} did not mount`,
      error
    );
  }
};

const installUsageService = (
  ctx: CordisContext,
  config: ResolvedPluginConfig
): void => {
  // TEMPORARY diagnostic: the meter renders nothing when this service is
  // absent, and "absent" has two causes — the switch is off, or the composition
  // has no `plugin`. Say which. Remove once the meter renders.
  ctx.logger?.info?.(
    "[dsh-opencode-patch] usage service: enabled=%s plugin=%s",
    config.usageEnabled,
    typeof ctx.plugin
  );
  if (!config.usageEnabled) {
    ctx.logger?.info?.(
      "[dsh-opencode-patch] usage service NOT registered; the meter will render nothing"
    );
    return;
  }
  const usageOptions = {
    baseURL: () => resolveGoBaseURL(ctx, config.usageBaseURL),
    keySource: config.keySource,
  };
  if (typeof ctx.plugin !== "function") {
    // `ctx.plugin` is the documented way and the one that gets cordis's own
    // bookkeeping. A composition without it is not one to give up on, though:
    // `ctx.provide` publishes the same service under the same name, which is what
    // the client looks for - and a meter that cannot mount is otherwise a
    // silence with no way to tell it from a meter whose service answered
    // nothing. The pool rotator took this route for the same reason.
    mountByProvide(ctx, "opencodeGoUsage", GoUsageService, usageOptions);
    return;
  }
  // A throw here is not local: `apply` runs its installers in order, so an
  // unguarded throw takes every installer AFTER this one down with it - silently,
  // because nothing catches it either. Reported and contained instead, so a
  // meter that cannot mount is a meter that says so rather than one that also
  // takes the rest of the plugin with it.
  try {
    ctx.plugin(GoUsageService, usageOptions);
  } catch (error) {
    ctx.logger?.warn?.(
      "[dsh-opencode-patch] the usage service did not mount; the meter will render nothing",
      error
    );
  }
};

/**
 * Wrap `globalThis.fetch` so claimed OpenCode traffic carries session affinity
 * and the gateway headers, restoring both on dispose.
 *
 * @returns `false` when there is no fetch to wrap. The caller then stops: the
 * stream hook and discovery must not attach, or turns would run without the
 * session affinity this plugin exists to provide.
 */
const installFetchPatch = (
  ctx: CordisContext,
  config: ResolvedPluginConfig,
  als: AsyncLocalStorage<ActiveTurnState>
): boolean => {
  const originalFetch: unknown = globalThis.fetch;
  if (!isFetchFunction(originalFetch)) {
    ctx.logger?.warn?.(
      "[dsh-opencode-patch] globalThis.fetch is unavailable; cannot inject x-opencode-session"
    );
    return false;
  }

  // Rotation is driven by the credential failures this interceptor is the only
  // place to see — including the ones from routes the WRAPPER serves and from
  // the Go plane, neither of which passes through a route of ours. The pool
  // itself lives with the provider mount, so this asks it for a rotator and
  // reports what it saw.
  /**
   * The org each plane's credential belongs to, read once and kept.
   *
   * A session token is only half a credential — the gateway gates the free tier
   * on the org that arrived with it — so the request path needs this on every
   * call, and a store read per request would be a file read per request. The
   * cache is warmed at mount and refreshed when a credential failure suggests it
   * is stale; `undefined` is a real answer, because a plane whose credential is
   * a plain key has no org and must not carry a header for one.
   */
  // The cache is shared with the login service, which writes it when a login
  // completes: a grant can appear long after startup, and a value read once would
  // miss it.
  const warmOrg = async (plane: string): Promise<void> => {
    try {
      const store = createTokenStore({
        credentials: readCredentialsWriter(ctx),
        plane,
        scope: name,
      });
      const login = await store?.read();
      setOrg(plane, login?.orgId);
    } catch {
      // A store that cannot be read leaves the plane without an org rather than
      // failing a request: a key deployment is exactly this case, and it is the
      // default.
      setOrg(plane, undefined);
    }
  };
  const rotateAfterFailure = async (
    plane: string,
    status: number
  ): Promise<void> => {
    const rotate = readCredentialPoolRotator(ctx);
    if (rotate === undefined) {
      return;
    }
    await rotate(plane, status);
  };

  const patched = patchFetch(originalFetch, als, config, {
    onCredentialFailure: (plane, status) => {
      void rotateAfterFailure(plane, status);
    },
    // The org is part of the credential, not a setting: it comes from the stored
    // login for the plane the request is bound for, and a plane whose credential
    // is a plain key has none.
    resolveOrg: (plane) => orgFor(plane) ?? config.credentialOrg,
    // One JSONL line per request the interceptor touched, when the deployment
    // asked for debugging. It is the only way to see a request that was patched
    // wrongly: the gateway's answer for a malformed session id reads exactly
    // like its answer for a bad credential.
    ...(config.debug && config.debugFile !== undefined
      ? {
          debug: (entry: Record<string, unknown>) => {
            void recordDebug(ctx, config.debugFile ?? "", entry);
          },
        }
      : {}),
  });

  // Warm the org cache before the first request can need it. Best-effort and
  // deliberately not awaited: a store that cannot be read leaves a plane without
  // an org, which is the key deployment's normal state.
  for (const plane of ["opencode", "opencode-go"]) {
    void warmOrg(plane);
  }

  ctx.effect?.(() => {
    globalThis.fetch = patched;
    ctx.logger?.info?.(
      "[dsh-opencode-patch] active for providers [%s]",
      [...config.providers].join(", ")
    );
    // Decorate discovery in the same effect so disabling the plugin restores
    // both the gateway fetch behavior and the Host discovery method.
    const stopDiscoveryDecoration = decorateModelDiscovery(ctx, config);
    // Same reasoning for the listing patch: it replaces Host methods, so it must
    // be tied to this fiber. Called OUTSIDE an effect it would never be undone,
    // and every live reload would stack another wrapper. Installed before the
    // stream hook is used, because the redirect asks it whether the route is
    // really registered.
    const stopCatalogHiding = hideResponsesRoute(ctx);
    // Own the Responses route from here, so the user configures nothing: they
    // keep the `opencode` provider and key they already have. Best-effort — a
    // route declared in the profile still works if this cannot register.
    // The registration is async (it reads `llm-pi-ai` off the loader), so the
    // disposer cannot live in a local the effect body fills in later: an effect
    // that re-runs before the mount settles would find `undefined` here, release
    // nothing, and leave the previous mount's routes registered — and the mount
    // that then arrives would be an orphan owned by a disposed effect. So the
    // effect owns the WITHDRAWAL, not the mount: a mount that completes after
    // disposal is released on the spot, and one that completes before it is
    // released by the disposer below.
    let stopResponsesProvider: (() => void) | undefined;
    let released = false;
    const releaseResponsesProvider = (): void => {
      released = true;
      stopResponsesProvider?.();
      stopResponsesProvider = undefined;
    };
    void (async () => {
      // The resolved config rides in: the credential pool is opt-in through
      // it, and a mount without it can only serve the profile's own key.
      const stop = await registerResponsesProvider(ctx, config);
      if (released) {
        stop?.();
        return;
      }
      stopResponsesProvider = stop;
    })();
    return () => {
      releaseResponsesProvider();
      stopCatalogHiding?.();
      stopDiscoveryDecoration?.();
      if (globalThis.fetch === patched) {
        globalThis.fetch = originalFetch;
      }
    };
  }, "dsh-opencode-patch.fetch-patch");

  return true;
};

/** Capture turn state (session id, project, parent) on every streamed turn. */
const installStreamHook = (
  ctx: CordisContext,
  config: ResolvedPluginConfig,
  als: AsyncLocalStorage<ActiveTurnState>
): void => {
  ctx.on?.("llm/stream", createStreamHook(ctx, config, als), { prepend: true });
};

/**
 * Publish the canonical Go/Zen catalog to DSH's model discovery.
 *
 * Model discovery is part of the same "canonical catalog" feature as the
 * gateway listing enrichment, so both sit behind the one `enrichModels`
 * toggle: turning it off leaves DSH's own catalog and the raw gateway
 * listings untouched.
 */
const installModelDiscovery = (
  ctx: CordisContext,
  config: ResolvedPluginConfig
): void => {
  if (!config.enrichModels) {
    return;
  }
  try {
    const { llm } = ctx;
    if (typeof llm?.registerModelDiscovery !== "function") {
      return;
    }
    llm.registerModelDiscovery(name, () =>
      Promise.resolve(
        toDiscovered([...getLiveGoCatalog(), ...getLiveZenCatalog()])
      )
    );
    llm.registerModelDiscovery("opencode-go", () =>
      Promise.resolve(toDiscovered(getLiveGoCatalog()))
    );
    llm.registerModelDiscovery("opencode", () =>
      Promise.resolve(toDiscovered(getLiveZenCatalog()))
    );
  } catch {
    // Model discovery registration is non-fatal
  }
};

/**
 * Plugin entry: register the quota service, patch `fetch` for OpenCode
 * traffic, and capture turn state for configured providers.
 *
 * Order matters:
 * 1. the rename notice, so it is the first thing a legacy row logs;
 * 2. the quota service, before the fetch patch, so a composition without
 *    `globalThis.fetch` still gets a working meter;
 * 3. the fetch patch, which bails out (warning) when there is nothing to
 *    wrap — `on` must not be attached in that case, or turns would run
 *    without session affinity;
 * 4. the stream hook and model discovery, which only make sense once the
 *    request path is patched.
 *
 * @param ctx - the Cordis host context.
 * @param rawConfig - the row config, if any.
 */
/**
 * Mount the login service, so a settings card has something to call.
 *
 * Unlike the meter's service this has no switch: a login is an action the user
 * takes, not a behaviour the plugin runs, and mounting a remote that answers
 * "nothing is stored" until they take it is the whole of its default state. What
 * it needs is a composition with `plugin`, the same one the meter needs.
 *
 * @param ctx - the host context.
 */
const installLoginService = (ctx: CordisContext): void => {
  if (typeof ctx.plugin !== "function") {
    mountByProvide(ctx, "opencodeLogin", LoginService, {});
    return;
  }
  try {
    ctx.plugin(LoginService, {});
  } catch (error) {
    ctx.logger?.warn?.(
      "[dsh-opencode-patch] the login service did not mount",
      error
    );
  }
};

export const apply = (
  ctx: CordisContext,
  rawConfig: PluginConfig = {}
): void => {
  // TEMPORARY: the host terminal has shown none of this plugin's output, so a
  // file is the one channel that can be read back — and it answers whether the
  // host half runs at all. Remove once the meter renders.
  try {
    appendFileSync(
      "/tmp/dsh-opencode-patch.log",
      `[dsh-opencode-patch] apply() ran; providers=[${[...resolveConfig(rawConfig).providers].join(",")}]\n`
    );
  } catch {
    // A missing /tmp write must not stop the plugin.
  }
  const config = resolveConfig(rawConfig);
  const als = new AsyncLocalStorage<ActiveTurnState>();

  logRenameNotice(ctx);
  installUsageService(ctx, config);
  installLoginService(ctx);

  if (!installFetchPatch(ctx, config, als)) {
    return;
  }

  installStreamHook(ctx, config, als);
  installModelDiscovery(ctx, config);
};
