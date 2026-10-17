/**
 * Provider-aware decoration for DSH model discovery.
 *
 * The settings surface asks the adapter that owns a route—`llm-pi-ai` for
 * `opencode` and `opencode-go`—for candidates. When that adapter already
 * knows the route, it answers from its installed catalog without calling the
 * gateway, so response enrichment never runs. Decorating its returned
 * candidates is therefore the only in-plugin way to add a catalog model the
 * installed catalog omits, or to remove a model OpenCode CLI retired, from a
 * “fetch available models” answer.
 *
 * The decorator only rewrites results for an explicitly claimed OpenCode
 * provider route. Nothing is stored: as with the underlying discovery call,
 * the answer remains candidate metadata for the surface to adopt.
 *
 * @module dsh-opencode-patch/models-discovery
 */

import type { ResolvedPluginConfig } from "./config.ts";
import type { CordisContext } from "./cordis-context.ts";
import { isRecord } from "./guards.ts";
import {
  getLiveGoCatalog,
  catalogPlaneForRoute,
  findModelSpecOn,
  getLiveZenCatalog,
  isDeprecatedModelOn,
  isRetiredModel,
  sanitizeModalities,
  type CatalogModelSpec,
  type CatalogProvider,
} from "./models-catalog.ts";
import { thinkingLevelMapFor } from "./pi-provider.ts";
import {
  internalRouteFor,
  isInternalRoute,
  isServableSdk,
  PLANES,
  protocolFromModelId,
  UNSERVED_PLANE_SDKS,
} from "./responses-routes.ts";

export interface DiscoveryCandidate {
  contextWindow?: number;
  id: string;
  inputModalities?: string[];
  maxTokens?: number;
  name?: string;
}

/** Whether a discovery result has the shape this decorator can preserve. */
const isDiscoveryCandidate = (value: unknown): value is DiscoveryCandidate => {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.id !== "string" || value.id.length === 0) {
    return false;
  }
  const { contextWindow, inputModalities, maxTokens, name } = value;
  if (name !== undefined && (typeof name !== "string" || name.length === 0)) {
    return false;
  }
  if (contextWindow !== undefined && typeof contextWindow !== "number") {
    return false;
  }
  if (maxTokens !== undefined && typeof maxTokens !== "number") {
    return false;
  }
  if (
    inputModalities !== undefined &&
    (!Array.isArray(inputModalities) ||
      inputModalities.some((modality) => typeof modality !== "string"))
  ) {
    return false;
  }
  return true;
};

/**
 * Decide which canonical catalog, if any, may supplement one discovery answer.
 *
 * Exact claimed route IDs win. A configured custom route or an unstored draft
 * falls back to the gateway URL only when the request names an OpenCode
 * gateway; anything else is left to its owning adapter.
 */
export const resolveDiscoveryProvider = (
  request: unknown,
  config: Pick<ResolvedPluginConfig, "gatewayUrls" | "providers">
): CatalogProvider | undefined => {
  const provider =
    isRecord(request) &&
    typeof request.provider === "string" &&
    request.provider.length > 0 &&
    config.providers.has(request.provider)
      ? request.provider
      : undefined;
  const baseURL =
    isRecord(request) && typeof request.baseURL === "string"
      ? request.baseURL
      : undefined;
  const normalizedBaseURL = baseURL?.toLowerCase() ?? "";
  const isGateway = config.gatewayUrls.some(
    (marker) =>
      marker.length > 0 && normalizedBaseURL.includes(marker.toLowerCase())
  );

  if (provider === "opencode-go") {
    return "go";
  }
  if (provider === "opencode") {
    return "zen";
  }
  if (!isGateway || baseURL === undefined) {
    return undefined;
  }
  return normalizedBaseURL.includes("/zen/go") ||
    normalizedBaseURL.includes("/go/v1")
    ? "go"
    : "zen";
};

/**
 * Merge canonical entries into an adapter’s discovery answer while honoring
 * provider-scoped retirements.
 *
 * The adapter’s own rows keep their capacities and order. Canonical rows are
 * appended only when the adapter did not already report that ID.
 */
export const mergeDiscoveredModels = (
  discovered: unknown,
  provider: CatalogProvider,
  catalog: readonly CatalogModelSpec[]
): DiscoveryCandidate[] => {
  const seen = new Set<string>();
  const merged: DiscoveryCandidate[] = [];

  if (Array.isArray(discovered)) {
    for (const candidate of discovered) {
      if (!isDiscoveryCandidate(candidate) || seen.has(candidate.id)) {
        continue;
      }
      if (isRetiredModel(provider, candidate.id)) {
        continue;
      }
      // Retired by the REGISTRY, not by our own list. The adapter's installed
      // snapshot is older than the live catalog and still lists ids the vendor
      // has retired; merging it unchanged is a picker led by models that no
      // longer answer. Our catalog drops them during parse, so without this the
      // merge is what puts them back.
      if (isDeprecatedModelOn(provider, candidate.id)) {
        continue;
      }
      seen.add(candidate.id);
      const spec = findModelSpecOn(provider, candidate.id);
      merged.push({
        ...candidate,
        contextWindow: candidate.contextWindow ?? spec?.context_window,
        inputModalities: sanitizeModalities(
          candidate.inputModalities ?? spec?.input_modalities
        ),
        maxTokens: candidate.maxTokens ?? spec?.max_output_tokens,
      });
    }
  }

  for (const spec of catalog) {
    if (seen.has(spec.id) || isRetiredModel(provider, spec.id)) {
      continue;
    }
    seen.add(spec.id);
    merged.push({
      contextWindow: spec.context_window,
      id: spec.id,
      inputModalities: sanitizeModalities(spec.input_modalities),
      maxTokens: spec.max_output_tokens,
      name: spec.name,
    });
  }

  return merged;
};

/**
 * The Host's UNFILTERED provider listing, captured when the hiding patch is
 * installed. The re-dispatch must consult this one: the patched listing
 * deliberately omits the route, so checking the patched method would make the
 * redirect never fire.
 */
/**
 * Kept WITH its receiver. A method read off the service and called detached
 * runs with `this === undefined`, and the LLM registry reads its own state
 * through `this` — so the detached call surfaces as
 * "Cannot read properties of undefined (reading 'adapters')", which names the
 * registry's internals rather than the call that broke the receiver.
 */
let registeredRoutes: { list: () => unknown; receiver: unknown } | undefined;

/**
 * Whether a route the plugin owns is really registered on the Host.
 *
 * The redirect must consult the UNFILTERED registry: the patched listing
 * deliberately omits every internal route, so asking it would always answer "no"
 * and the re-dispatch would never fire.
 *
 * @param routeId - the internal route to test for.
 * @returns true when the unfiltered registry still carries the route.
 */
export const isRouteRegistered = (routeId: string): boolean => {
  if (registeredRoutes === undefined) {
    return false;
  }
  const { receiver } = registeredRoutes;
  if (
    isRecord(receiver) &&
    "adapters" in receiver &&
    receiver.adapters instanceof Map &&
    receiver.adapters.has(routeId)
  ) {
    return true;
  }
  const routes = Reflect.apply(
    registeredRoutes.list,
    registeredRoutes.receiver,
    []
  );
  return (
    Array.isArray(routes) &&
    routes.some((route) => isRecord(route) && route.id === routeId)
  );
};

/** Drop every internal route from a Host listing, leaving other entries alone. */
const withoutRoute = (value: unknown, key: "id" | "provider"): unknown =>
  Array.isArray(value)
    ? value.filter((entry) => !(isRecord(entry) && isInternalRoute(entry[key])))
    : value;

/**
 * Whether a model can be served, judged by the SDK the PLANE IN HAND declares.
 *
 * The plane matters: `qwen3.8-max`, `minimax-m2.7` and `minimax-m3` are
 * `@ai-sdk/anthropic` on Go and the default (completions) on Zen, so a Go-first
 * lookup filters a Zen listing by a Go fact. Same seam as the redirect's — see
 * `findModelSpecOn`.
 */
/**
 * Whether a model may be offered on a route.
 *
 * Exported for its own test: it is the one place I1's second clause lives, and the
 * interesting case is a model no catalog describes.
 */
/**
 * Whether an id names an OpenCode free-tier model.
 *
 * @param id - the model id.
 * @returns whether it is a free-tier id.
 */

export const isServableModel = (
  id: unknown,
  route: string,
  hidden: readonly string[] = []
): boolean => {
  if (typeof id !== "string") {
    return true;
  }
  // A named exclusion outranks every rule below it, including retention: it is
  // the deployment's own word about a model, and the retention list is this
  // file's. A deployment that withholds an id the catalog retains, or the other
  // way round, gets the deployment's answer.
  if (hidden.includes(id)) {
    return false;
  }
  // A free-tier id is OFFERED. It was excluded here for several rounds, on
  // measurements that sent an API key, the account token, the token with its org,
  // every client header, both endpoints and no credential at all - each answering
  // `403 FreeTierError`. What none of those runs had was a deployment that was
  // signed in: the free tier is served to a session token, which is what the real
  // client sends, and a deployment that has one can use these models. The
  // exclusion hid models a signed-in user can run, which is a worse failure than
  // offering one that refuses.
  //
  // The refusal is not silent when it happens: `stream-hook.ts` reports a model
  // this plugin cannot serve, once per pair, and that report is what a reader
  // should be given instead of an empty picker.
  const plane = catalogPlaneForRoute(route);
  const spec = findModelSpecOn(plane, id);
  const sdk = spec?.provider_npm;
  if (sdk !== undefined) {
    if (UNSERVED_PLANE_SDKS.has(`${route} + ${sdk}`)) {
      return false;
    }
    return isServableSdk(sdk);
  }
  // A model the catalog does not describe: `undefined` is the completions default,
  // which is right for a model that omits its SDK and wrong for one nobody has
  // described. So the id is asked, and a family whose protocol this plane has no
  // route for is not offered - I1's second clause, which until now held only for
  // models the catalog carries. `internalRouteFor` answers exactly this: a route
  // when one exists, and `undefined` when the model stays where it is.
  return (
    protocolFromModelId(id) === undefined ||
    internalRouteFor(route, id) !== undefined
  );
};

/**
 * Keep the internal routes out of every listing a user sees.
 *
 * Three surfaces enumerate providers, and the route has to be absent from all
 * of them or it shows up as a provider the user is invited to configure:
 *
 * - `buildModelCatalog` (the model picker) turns every registered route into a
 *   group and drops the groups whose model list is empty, so reporting no models
 *   removes it there.
 * - `joinProviderDirectory` (Settings → Models) maps `listConfigurableProviders`
 *   and then pushes a row for **every remaining registered provider** — so
 *   filtering only the configurable directory would not hide it.
 *
 * **`listModels` IS patched, and the note that used to sit here saying it was
 * not is why the picker lost most of the catalog.** The old text read:
 *
 *   "`listModels` is deliberately NOT patched. Every consumer of it in the Host
 *    iterates `listProviders()` first … so once the registry omits the route,
 *    nothing reaches its model list."
 *
 * The premise is true and the conclusion does not follow. Hiding the internal
 * routes is exactly why their models must be JOINED into the parent route's list:
 * `buildModelCatalog` is `listProviders()` × `listModels(id)`, each internal route
 * carries only its own protocol's models, and hiding it therefore makes those
 * models unreachable rather than merely unlisted. Measured: 27 models in the
 * picker before the join, 88 after.
 *
 * The patch now does two things: it empties an internal route's own list (nothing
 * reaches it, but a third patch guarding nothing is cheaper than a surprise), and
 * it merges each plane root's list with its plane's catalog. Both are below.
 *
 * Nothing in dispatch reads these: the adapter registry resolves a route
 * internally, and the `llm/stream` hook uses {@link isResponsesRouteRegistered}
 * — which reads the ORIGINAL listing, captured here — to decide whether the
 * redirect has somewhere to go.
 *
 * @param ctx - host context carrying the LLM registry.
 * @param config - the resolved config, for the ids a deployment withholds.
 * @returns the disposer restoring the original methods, or `undefined` when
 *   there is nothing to patch.
 */
export const hideResponsesRoute = (
  ctx: CordisContext,
  config: ResolvedPluginConfig
): (() => void) | undefined => {
  const { llm } = ctx;
  if (llm === undefined) {
    return undefined;
  }
  const {
    listConfigurableProviders: originalListConfigurableProviders,
    listModels: originalListModels,
    listProviders: originalListProviders,
  } = llm;
  if (
    typeof originalListProviders !== "function" &&
    typeof originalListConfigurableProviders !== "function" &&
    typeof originalListModels !== "function"
  ) {
    return undefined;
  }
  if (typeof originalListProviders === "function") {
    registeredRoutes = { list: originalListProviders, receiver: llm };
  }

  const patched: Record<string, unknown> = {};
  if (typeof originalListProviders === "function") {
    patched.listProviders = function listProviders(this: unknown): unknown {
      return withoutRoute(Reflect.apply(originalListProviders, this, []), "id");
    };
  }
  if (typeof originalListConfigurableProviders === "function") {
    patched.listConfigurableProviders = function listConfigurableProviders(
      this: unknown
    ): unknown {
      return withoutRoute(
        Reflect.apply(originalListConfigurableProviders, this, []),
        "provider"
      );
    };
  }
  if (typeof originalListModels === "function") {
    // **This is the JOIN, and without it most of the catalog is unreachable from
    // the picker.** `buildModelCatalog` (the composer's model list) is
    // `listProviders()` × `listModels(id)`. The internal protocol routes are
    // hidden from `listProviders`, and each of them carries ONLY its own
    // protocol's models — `opencode-responses` holds the `@ai-sdk/openai` rows,
    // `opencode-anthropic` the Anthropic ones, `opencode-google` the Google ones
    // (`registerResponsesProvider` builds each with `sdksForProtocol` +
    // `modelsForSdk`). So enumerating `opencode` returned the completions bucket
    // alone and every Responses / Messages / Google model — perfectly servable,
    // redirectable by `internalRouteFor` — simply never appeared. That is the
    // "they didn't join" failure: not filtered, not deprecated, just absent.
    //
    // So the parent route's list is merged with its plane's catalog, which is the
    // union across protocols. `mergeDiscoveredModels` keeps the adapter's own
    // rows (and their extra fields) and appends the rows it lacks, which is the
    // same merge the "fetch available models" path already did.
    //
    // Only the two plane routes are joined. A deployment's own relay is not ours
    // to populate: its catalog is the one it declares.
    const planeRoots = new Set(["opencode", "opencode-go"]);
    patched.listModels = async function listModels(
      this: unknown,
      provider: string
    ): Promise<unknown> {
      if (isInternalRoute(provider)) {
        return [];
      }
      const models = await Reflect.apply(originalListModels, this, [provider]);
      if (!Array.isArray(models)) {
        return models;
      }
      const listed = planeRoots.has(provider)
        ? mergeDiscoveredModels(
            models,
            catalogPlaneForRoute(provider),
            catalogPlaneForRoute(provider) === "go"
              ? getLiveGoCatalog()
              : getLiveZenCatalog()
          )
        : models;
      return listed.filter(
        (model) =>
          !isRecord(model) ||
          isServableModel(model.id, provider, config.hiddenModels)
      );
    };
  }

  const installed: string[] = [];
  const restoreFrom: Record<string, unknown> = {
    listConfigurableProviders: originalListConfigurableProviders,
    listModels: originalListModels,
    listProviders: originalListProviders,
  };
  try {
    for (const [key, value] of Object.entries(patched)) {
      Reflect.set(llm, key, value);
      installed.push(key);
    }
  } catch {
    for (const key of installed) {
      Reflect.set(llm, key, restoreFrom[key]);
    }
    return undefined;
  }
  return () => {
    for (const key of installed) {
      if (Reflect.get(llm, key) === patched[key]) {
        Reflect.set(llm, key, restoreFrom[key]);
      }
    }
  };
};

/**
 * Wrap the Host’s model-discovery method so “fetch available models” answers
 * for claimed OpenCode routes include the canonical catalog’s missing rows
 * and omit its provider-scoped retired rows.
 *
 * The original method keeps ownership of errors, cancellation, and every
 * unclaimed route. The returned disposer restores it.
 */
export const decorateModelDiscovery = (
  ctx: CordisContext,
  config: ResolvedPluginConfig
): (() => void) | undefined => {
  if (!config.enrichModels) {
    return undefined;
  }
  const { llm } = ctx;
  if (llm === undefined || typeof llm.discoverModels !== "function") {
    return undefined;
  }
  const discover = llm.discoverModels;
  const decorated = async (
    settingsNs: string,
    request?: unknown,
    signal?: AbortSignal
  ): Promise<unknown> => {
    const discovered = await Reflect.apply(discover, llm, [
      settingsNs,
      request,
      signal,
    ]);
    const provider = resolveDiscoveryProvider(request, config);
    if (provider === undefined) {
      return discovered;
    }
    return mergeDiscoveredModels(
      discovered,
      provider,
      provider === "go" ? getLiveGoCatalog() : getLiveZenCatalog()
    );
  };

  try {
    llm.discoverModels = decorated;
  } catch {
    // A non-extensible Host service must not prevent request patching.
    return undefined;
  }
  return () => {
    if (llm.discoverModels === decorated) {
      llm.discoverModels = discover;
    }
  };
};

/** Every pi thinking level, in escalation order, `off` first. */
export const PI_THINKING_LEVELS: readonly string[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * The reasoning efforts DSH renders for one model, read off the SAME
 * thinking-level map the routes dispatch on.
 *
 * One rule, so a level the composer offers is a level the model answers: a
 * level the map pins to `null` is not offered, and every other level is. The
 * wire spelling is NOT carried — an adapter's effort `id` is the pi level, and
 * `resolveReasoningLevel` matches it by that name before the adapter translates
 * it, so re-spelling it here would make the composer offer an effort the
 * resolver refuses.
 *
 * @param map - the model's `thinkingLevelMap`.
 * @returns the efforts, in escalation order.
 */
const effortsFromLevelMap = (
  map: Partial<Record<string, string | null>>
): { id: string; name: string }[] =>
  PI_THINKING_LEVELS.filter((level) => map[level] !== null).map((level) => ({
    id: level,
    name:
      level === "off"
        ? "Off"
        : `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
  }));

/**
 * Resolve the effective context window for a model by taking into account:
 * 1. The canonical capability from the catalog (`canonicalWindow`).
 * 2. Any explicit context limit requested by the user, session, or host (`requestedWindow`).
 * 3. Any optional deployment ceiling configured by the user (`maxCeiling`).
 *
 * It safely clamps so that:
 * - A requested context cannot exceed the model's physical context limit.
 * - A configured ceiling clamps any higher context window down to that ceiling.
 * - Missing or invalid requests cleanly fall back to canonical specs.
 *
 * @param canonicalWindow - The physical context limit declared by the model catalog.
 * @param requestedWindow - Optional requested or configured context window.
 * @param maxCeiling - Optional deployment-level context ceiling.
 * @returns The effective context window limit in tokens.
 */
export const resolveEffectiveContextWindow = (
  canonicalWindow: number,
  requestedWindow?: unknown,
  maxCeiling?: unknown
): number => {
  let effective = canonicalWindow;
  if (
    typeof requestedWindow === "number" &&
    Number.isFinite(requestedWindow) &&
    requestedWindow > 0
  ) {
    effective = Math.min(requestedWindow, canonicalWindow);
  }
  if (
    typeof maxCeiling === "number" &&
    Number.isFinite(maxCeiling) &&
    maxCeiling > 0
  ) {
    effective = Math.min(effective, maxCeiling);
  }
  return effective;
};

/**
 * Wrap the ADAPTERS behind the plane routes, so a model our catalog carries but
 * pi's installed catalog does not is resolvable at dispatch, and takes every
 * thinking level the composer offers.
 *
 * This is the seam the `modelOverrides` attempt missed, and the method that
 * matters is `modelOf`. The picker reads the public `ctx.llm.resolveModelInfo`,
 * which this plugin decorates, so the composer renders OUR catalog's context and
 * levels for every catalogued model. Dispatch (`streamWithSnapshot`) resolves
 * the model through the adapter's `modelOf` and validates the saved effort with
 * `getSupportedThinkingLevels`; `modelInfo` - and so `resolveModel` and
 * `prepareCall` - read the same method, which is why filling the picker's answer
 * was never enough. For an id pi's installed catalog does not carry -
 * `glm-5.3-flash-free` on Zen, `cat-jam-free` on both planes, both declared in
 * the deployment's profile - with no `reasoningEfforts` of its own on the row,
 * that model materializes as `reasoning: false` with no level map: the only
 * level it takes is `off`, so every level the picker offered came back
 * UNSUPPORTED_REASONING_EFFORT.
 *
 * A `modelOverrides` entry cannot fix this - it only DESCRIBES ids
 * `defaults.has(id)`, and `entries` comes from `defaults.values()`, so an id pi
 * has never heard of is rejected in strict validation and never served anyway.
 *
 * The registry keeps its adapters in a public `Map`, so the registration is
 * wrapped in place: nothing is re-registered, the user's profile is untouched, and
 * the route keeps the adapter it always had. `resolveModel` and `prepareCall` fill
 * only what the adapter left BLANK, so an adapter that knows the model keeps its
 * own answer. `modelOf` is the other shape - what comes out of it has to ACCEPT
 * the levels the composer offers, or a saved effort cannot be dispatched - so it
 * fills the levels the model REFUSES and leaves every level it already takes
 * alone: nothing is removed, and a level that dispatches today dispatches the
 * same way afterwards.
 *
 * Only the adapters behind the plane ROUTES are wrapped - a foreign adapter in
 * the same registry (another provider's) is not this plugin's to replace - and
 * the original runs with the adapter as its receiver, because all three are
 * class methods that read `this`.
 *
 * @param llm - the Host's LLM service.
 * @param config - the resolved config, for the ids a deployment withholds.
 * @returns the disposer restoring the original methods, or `undefined`.
 */
export const decoratePlaneAdapters = (
  llm: CordisContext["llm"],
  config: ResolvedPluginConfig
): (() => void) | undefined => {
  // The registry's own map. Reached structurally rather than through a typed
  // handle because the service exposes it as a field, not a method.
  const registry = (llm ?? {}) as {
    adapters?: Map<string, { adapter: Record<string, unknown> }>;
  };
  const { adapters } = registry;
  if (!(adapters instanceof Map)) {
    return undefined;
  }
  const restored: (() => void)[] = [];
  for (const [route, registration] of adapters) {
    const adapter = registration?.adapter;
    if (adapter === undefined || adapter === null) {
      continue;
    }
    // Only the adapters behind THIS plugin's plane routes: the fill exists for
    // the routes a deployment declares without a `models` list, whose adapter
    // falls back to pi's installed catalog. Another provider's adapter is not
    // this plugin's to replace.
    if (!(route in PLANES)) {
      continue;
    }
    // The plane comes from the ROUTE, so a Go model is filled from the Go
    // catalog and a Zen one from Zen's - the same rule `findModelSpecOn` applies.
    const plane = catalogPlaneForRoute(route);
    for (const method of ["resolveModel", "prepareCall"] as const) {
      const original = adapter[method];
      if (typeof original !== "function") {
        continue;
      }
      const wrapped = async (
        provider: string,
        model: string,
        signal?: AbortSignal
      ): Promise<unknown> => {
        // The original with the adapter as its receiver: both methods are class
        // methods that read `this` (pi-ai's open with `this.current()`), and a
        // detached call fails the provider's whole catalog load.
        const answered: unknown = await Reflect.apply(original, adapter, [
          provider,
          model,
          signal,
        ]);
        if (config.hiddenModels.includes(model)) {
          return answered;
        }
        const spec = findModelSpecOn(plane, model);
        if (spec === undefined) {
          return answered;
        }
        // Only what the adapter left BLANK. An adapter that answers keeps its
        // answer, because that is what dispatch will honour.
        const override = config.modelOverrides[model];
        const record = isRecord(answered) ? answered : {};
        const existingContext = isRecord(record.context) ? record.context : {};
        const requestedWindow =
          override?.contextWindow ??
          (typeof existingContext.contextWindow === "number"
            ? existingContext.contextWindow
            : undefined);
        const effectiveWindow =
          spec.context_window > 0
            ? resolveEffectiveContextWindow(
                spec.context_window,
                requestedWindow,
                config.maxContextWindow
              )
            : undefined;
        const modelName =
          override?.name ??
          (typeof record.name === "string" ? record.name : spec.name);
        const { defaultMaxTokens: recordMaxTokens } = record;
        let inputModalities: ("text" | "image")[] = sanitizeModalities(
          spec.input_modalities
        );
        if (override?.inputModalities !== undefined) {
          inputModalities = [...override.inputModalities];
        } else if (Array.isArray(record.inputModalities)) {
          inputModalities = sanitizeModalities(record.inputModalities);
        }

        let defaultMaxTokens: number | undefined;
        if (override?.maxTokens !== undefined) {
          defaultMaxTokens = override.maxTokens;
        } else if (typeof recordMaxTokens === "number") {
          defaultMaxTokens = recordMaxTokens;
        } else if (spec.max_output_tokens > 0) {
          defaultMaxTokens = spec.max_output_tokens;
        }

        // The same pair the picker reads: `thinkingLevelMapFor` decides which
        // levels exist, `effortsFromLevelMap` renders them, so a level offered
        // here is a level the composer shows.
        let supports: { id: string; name: string }[] | undefined;
        if (override?.reasoningEfforts !== undefined) {
          supports = override.reasoningEfforts.map((id) => ({
            id,
            name:
              id === "off"
                ? "Off"
                : `${id.charAt(0).toUpperCase()}${id.slice(1)}`,
          }));
        } else if (record.reasoning === undefined) {
          const map = thinkingLevelMapFor(spec);
          if (map !== undefined) {
            supports = effortsFromLevelMap(map);
          }
        }

        const outRecord: Record<string, unknown> = {
          ...record,
          inputModalities,
          name: modelName,
        };
        if (record.provider === undefined) {
          outRecord.provider = provider;
        }
        if (record.id === undefined) {
          outRecord.id = model;
        }
        if (effectiveWindow !== undefined) {
          outRecord.context = {
            ...existingContext,
            contextWindow: effectiveWindow,
          };
        }
        if (defaultMaxTokens !== undefined) {
          outRecord.defaultMaxTokens = defaultMaxTokens;
        }
        if (supports !== undefined && supports.length > 0) {
          outRecord.reasoning = { efforts: supports };
        }
        return outRecord;
      };
      adapter[method] = wrapped;
      restored.push(() => {
        adapter[method] = original;
      });
    }

    // The half dispatch validates against, and the reason a filled picker was
    // still not enough. `streamWithSnapshot` resolves the model through
    // `modelOf` and then reads the level map off it; `getSupportedThinkingLevels`
    // refuses a level whose entry is `null` and refuses `xhigh`/`max` unless the
    // entry exists at all - so a level is filled exactly when the model does not
    // already take it, and a level the adapter (or the deployment's own row)
    // declares keeps its wire spelling.
    //
    // The map is the one the composer already renders: `thinkingLevelMapFor` is
    // the same derivation `decorateModelInfo` uses to build the picker's Effort
    // row, so the two read one source rather than two that have to agree.
    const originalModelOf = adapter.modelOf;
    if (typeof originalModelOf === "function") {
      const wrappedModelOf = (
        snapshot: unknown,
        provider: string,
        model: string
      ): unknown => {
        const answered: unknown = Reflect.apply(originalModelOf, adapter, [
          snapshot,
          provider,
          model,
        ]);
        if (config.hiddenModels.includes(model) || !isRecord(answered)) {
          return answered;
        }
        const spec = findModelSpecOn(plane, model);
        if (spec === undefined) {
          return answered;
        }
        const override = config.modelOverrides[model];
        const levels =
          override?.reasoningEfforts === undefined
            ? thinkingLevelMapFor(spec)
            : Object.fromEntries(
                override.reasoningEfforts.map((id) => [id, id] as const)
              );
        // No opinion: the catalog does not call the model a reasoning one, and
        // the deployment named no level for it either.
        if (levels === undefined || Object.keys(levels).length === 0) {
          return answered;
        }
        const declared = isRecord(answered.thinkingLevelMap)
          ? answered.thinkingLevelMap
          : {};
        // pi's acceptance rule, which is what `resolveReasoningLevel` throws
        // against (`getSupportedThinkingLevels`): a model that reasons takes a
        // level whose entry is not `null`, and `xhigh`/`max` need an entry to
        // exist at all - an absent entry there is not a level, while for the
        // base levels it means the level's own name on the wire.
        const taken = (level: string): boolean => {
          if (answered.reasoning !== true) {
            return false;
          }
          const entry = declared[level];
          if (entry === null) {
            return false;
          }
          return level === "xhigh" || level === "max"
            ? entry !== undefined
            : true;
        };
        const merged: Record<string, unknown> = { ...declared };
        let filled = false;
        for (const [level, wire] of Object.entries(levels)) {
          // A level the model already takes keeps the adapter's own answer: one
          // that spells the level itself keeps that spelling, and one that leaves
          // it out keeps the level's name on the wire. Only what it REFUSES is
          // filled, so the levels that work today keep working byte for byte.
          if (wire === null || taken(level)) {
            continue;
          }
          merged[level] = wire;
          filled = true;
        }
        // Nothing to add - and so nothing to say about `reasoning` either, since
        // every level is only "taken" for a model that already reasons: hand back
        // the adapter's own object rather than an equal copy of it.
        if (!filled) {
          return answered;
        }
        return { ...answered, reasoning: true, thinkingLevelMap: merged };
      };
      adapter.modelOf = wrappedModelOf;
      restored.push(() => {
        adapter.modelOf = originalModelOf;
      });
    }
  }
  if (restored.length === 0) {
    return undefined;
  }
  return () => {
    for (const undo of restored.toReversed()) {
      undo();
    }
  };
};

/**
 * Wrap the Host's `resolveModelInfo` so a plane route's model reports the
 * thinking level the catalog declares and the context window it names.
 *
 * This is the seam the model picker actually reads. `buildModelCatalog`
 * (`dsh-api-session-controller`) calls `ctx.llm.resolveModelInfo` per model and
 * renders an Effort row only from what comes back — so a plane route whose
 * adapter reports no `reasoning` shows no Effort row at all, which is the exact
 * symptom this exists for: `MiniMax-M3` and `MiniMax-M2.7` declare
 * `reasoning: true` in the catalog and still offered no thinking level.
 *
 * A plane route is a profile's own (`opencode`, `opencode-go`), and its adapter
 * materializes each declared row OVER the installed catalog's entry for the same
 * id: a row that declares no `reasoningEfforts` reports what that snapshot says
 * of the id — `reasoning: false`, with no level map, for every id it does not
 * carry — beside the row's own window and output cap.
 *
 * The fields our catalog carries are therefore AUTHORITATIVE here rather than
 * advisory: filling only what the adapter left blank let a stale snapshot report
 * itself on every surface that showed it, measured as 272k for `gpt-5.4` where
 * the vendor and our shim both say 1.05M. Only a model the catalog cannot
 * describe is passed through untouched, which is what keeps an id that only the
 * installed catalog knows — and a `reasoningEfforts` the row declares beside it
 * — reporting its own truth. A `modelOverrides` entry decides the fields it
 * names, its window being a request clamped by `maxContextWindow`. The INTERNAL
 * routes this plugin mounts already carry the right metadata through
 * {@link reasoningEffortsFor}, and are passed through so the two never disagree.
 *
 * That authority has a cost dispatch still pays: the requested level is
 * validated against the ADAPTER's object, not this one, so a level offered here
 * and refused there fails the turn — {@link decoratePlaneAdapters} fills that
 * object from the same catalog derivation so the two cannot disagree.
 *
 * @param ctx - host context carrying the LLM registry.
 * @param config - the resolved plugin config.
 * @returns the disposer restoring the original method, or `undefined`.
 */
export const decorateModelInfo = (
  ctx: CordisContext,
  config: ResolvedPluginConfig
): (() => void) | undefined => {
  if (!config.enrichModels) {
    return undefined;
  }
  const { llm } = ctx;
  if (llm === undefined || typeof llm.resolveModelInfo !== "function") {
    return undefined;
  }
  const original = llm.resolveModelInfo;
  const decorated = async (
    provider: string,
    model: string,
    signal?: AbortSignal
  ): Promise<unknown> => {
    let resolved: unknown;
    try {
      resolved = await Reflect.apply(original, llm, [provider, model, signal]);
    } catch (error) {
      // **One throw removes the WHOLE provider group from the picker.** The Host
      // builds a group with `Promise.all` over `listModels`, and a rejection
      // there is caught per PROVIDER, not per model — so the user loses every
      // model on that route, not one row.
      //
      // That became reachable when `listModels` started publishing the catalog on
      // the parent route: the route's own adapter never carried the Responses,
      // Messages or Google models, so `resolveModelInfo` may refuse an id it does
      // not know. Our catalog does know it, so answer from there rather than
      // letting one unknown id take the group down.
      //
      // A model the catalog cannot describe either is rethrown: inventing an
      // answer for an id nobody knows would hide a real problem.
      const spec = findModelSpecOn(catalogPlaneForRoute(provider), model);
      if (isInternalRoute(provider) || spec === undefined) {
        throw error;
      }
      resolved = {};
    }
    // Our own routes carry the real metadata already.
    if (isInternalRoute(provider)) {
      return resolved;
    }
    const spec = findModelSpecOn(catalogPlaneForRoute(provider), model);
    if (spec === undefined) {
      return resolved;
    }
    // A NON-RECORD answer is the same hazard as a throw, one step quieter: the
    // Host reads `resolved.reasoning` immediately after this returns, so
    // `undefined` becomes `TypeError: Cannot read properties of undefined` inside
    // the group's `Promise.all` — and the whole provider group goes with it. When
    // the catalog knows the model, the answer is built from the catalog instead of
    // passed through.
    const out: Record<string, unknown> = isRecord(resolved)
      ? { ...resolved }
      : {};
    // Our catalog is the FRESHER VINTAGE of the same data, and the divergence is
    // measured rather than assumed. pi ships an installed `opencode` catalog the
    // plane routes fall back to, and it is a different snapshot of models.dev:
    // it says 272k for `gpt-5.4` and 200k for `claude-sonnet-4-5` where the
    // vendor and our shim both say 1.05M and 1M, and it carries no
    // `thinkingLevelMap` for the `budget_tokens` Claude models where models.dev
    // declares a token minimum.
    //
    // Filling only what the adapter left BLANK let every one of those stale
    // values survive, which is what the surfaces then reported — so the fields
    // our catalog carries are authoritative here rather than advisory.
    const override = config.modelOverrides[model];
    const existingContext = isRecord(out.context) ? out.context : {};
    const requestedWindow = override?.contextWindow;

    if (typeof spec.context_window === "number" && spec.context_window > 0) {
      const effectiveWindow = resolveEffectiveContextWindow(
        spec.context_window,
        requestedWindow,
        config.maxContextWindow
      );
      out.context = {
        ...existingContext,
        contextWindow: effectiveWindow,
      };
    }
    // The output cap is the same class of staleness, and a wrong one truncates
    // rather than merely mis-reports.
    if (override?.maxTokens !== undefined) {
      out.defaultMaxTokens = override.maxTokens;
    } else if (
      typeof spec.max_output_tokens === "number" &&
      spec.max_output_tokens > 0
    ) {
      out.defaultMaxTokens = spec.max_output_tokens;
    }
    if (override?.name !== undefined) {
      out.name = override.name;
    }
    if (override?.inputModalities !== undefined) {
      out.inputModalities = [...override.inputModalities];
    }
    if (override?.reasoningEfforts === undefined) {
      const map = thinkingLevelMapFor(spec);
      const efforts = map === undefined ? [] : effortsFromLevelMap(map);
      if (efforts.length > 0) {
        out.reasoning = { efforts };
      } else {
        // The model takes no thinking level. Leaving the adapter's `reasoning`
        // here would offer a control the model refuses — and for a model our
        // catalog marks non-reasoning, that is exactly the stale shape.
        delete out.reasoning;
      }
    } else {
      out.reasoning = {
        efforts: override.reasoningEfforts.map((id) => ({
          id,
          name:
            id === "off"
              ? "Off"
              : `${id.charAt(0).toUpperCase()}${id.slice(1)}`,
        })),
      };
    }
    return out;
  };

  try {
    llm.resolveModelInfo = decorated;
  } catch {
    return undefined;
  }
  return () => {
    if (llm.resolveModelInfo === decorated) {
      llm.resolveModelInfo = original;
    }
  };
};
