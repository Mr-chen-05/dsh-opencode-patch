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
  const routes =
    registeredRoutes === undefined
      ? undefined
      : Reflect.apply(registeredRoutes.list, registeredRoutes.receiver, []);
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
  // Zen's free tier is NOT servable from here, and this is measured rather than
  // argued. With this machine's own session token, its active org and every
  // header captured from the real client, a free-tier Zen model still answers
  // `403 FreeTierError` on both endpoint families; the live e2e suite answers the
  // same way under CI. The gate is not in the request — it is a fingerprint or a
  // signature only the real client sends — so no credential this plugin can
  // assemble clears it.
  //
  // This reverses an earlier decision, and that decision's own comment is what
  // was wrong: it asserted the free tier "is served to a session token, which is
  // what the real client sends, and a deployment that has one can use these
  // models". The run that text describes was never made, and when it was made it
  // did not hold. Offering a model that cannot be served is not the lesser
  // failure — it is a refusal with nothing to act on, and it fills the picker
  // with ten rows that 403.
  //
  // The Go plane has NO free tier to gate, so its free models are served by the
  // subscription key exactly as its paid ones are, and stay offered.
  if (plane === "zen" && spec?.is_free === true) {
    return false;
  }
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
 * `listModels` is deliberately NOT patched. Every consumer of it in the Host
 * iterates `listProviders()` first — `buildModelCatalog`, `modelAvailable` and
 * `acp`'s model control all do — so once the registry omits the route, nothing
 * reaches its model list. Filtering it as well would be a third patch guarding
 * nothing.
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
    // Filtering `listModels` is not about hiding the internal routes — nothing
    // reaches it for those, because `listProviders` no longer names them. It is
    // about what a user CAN pick: the `opencode` route's own list may name a
    // model whose SDK no route serves, and selecting it would fail with nothing
    // in the row to say why.
    patched.listModels = async function listModels(
      this: unknown,
      provider: string
    ): Promise<unknown> {
      if (isInternalRoute(provider)) {
        return [];
      }
      const models = await Reflect.apply(originalListModels, this, [provider]);
      return Array.isArray(models)
        ? models.filter(
            (model) =>
              !isRecord(model) ||
              isServableModel(model.id, provider, config.hiddenModels)
          )
        : models;
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
const PI_THINKING_LEVELS: readonly string[] = [
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
 * Wrap the ADAPTERS behind the plane routes, so a model our catalog carries but
 * pi's installed catalog does not is still resolvable at dispatch.
 *
 * This is the seam the `modelOverrides` attempt missed. `buildModelCatalog` reads
 * the public `ctx.llm.resolveModelInfo`, which this plugin decorates, so the
 * picker shows the right context and levels for every catalogued model. But
 * `prepareCall` reads `registration.adapter.prepareCall` - the adapter itself -
 * and the plane routes' adapter resolves its models from pi's installed catalog.
 * `step-5-preview-free` has no `provider.npm`, so it stays on the route the user
 * selected, and pi ships no `step-5` entry on either plane: the adapter reports no
 * reasoning at all, and a saved effort then fails validation.
 *
 * A `modelOverrides` entry cannot fix this - it only DESCRIBES ids
 * `defaults.has(id)`, and `entries` comes from `defaults.values()`, so an id pi
 * has never heard of is rejected in strict validation and never served anyway.
 *
 * The registry keeps its adapters in a public `Map`, so the registration is
 * wrapped in place: nothing is re-registered, the user's profile is untouched, and
 * the route keeps the adapter it always had. Only MISSING answers are filled, so
 * an adapter that knows the model keeps its own result - which is what dispatch
 * honours.
 *
 * Only the adapters behind the plane ROUTES are wrapped - a foreign adapter in
 * the same registry (another provider's) is not this plugin's to replace - and
 * the original runs with the adapter as its receiver, because `resolveModel` and
 * `prepareCall` are class methods that read `this`.
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
        const record = isRecord(answered) ? answered : {};
        // The same pair the picker reads: `thinkingLevelMapFor` decides which
        // levels exist, `effortsFromLevelMap` renders them, so a level offered
        // here is a level the composer shows.
        const map = thinkingLevelMapFor(spec);
        const supports =
          map === undefined ? undefined : effortsFromLevelMap(map);
        return {
          ...record,
          ...(record.provider === undefined ? { provider } : {}),
          ...(record.id === undefined ? { id: model } : {}),
          ...(record.name === undefined ? { name: spec.name } : {}),
          ...(record.inputModalities === undefined
            ? { inputModalities: [...spec.input_modalities] }
            : {}),
          ...(record.context === undefined && spec.context_window > 0
            ? { context: { contextWindow: spec.context_window } }
            : {}),
          ...(record.defaultMaxTokens === undefined &&
          spec.max_output_tokens > 0
            ? { defaultMaxTokens: spec.max_output_tokens }
            : {}),
          ...(record.reasoning === undefined &&
          supports !== undefined &&
          supports.length > 0
            ? { reasoning: { efforts: supports } }
            : {}),
        };
      };
      adapter[method] = wrapped;
      restored.push(() => {
        adapter[method] = original;
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
 * Wrap the Host's `resolveModelInfo` so a plane route's model reports the/**
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
 * The plane routes are the user's own (`opencode`, `opencode-go`), declared in
 * their profile with no `models` list, so their adapter falls back to the
 * installed catalog — which knows nothing about these ids — and reports
 * `reasoning: false`. The INTERNAL routes this plugin mounts already carry the
 * right metadata through {@link reasoningEffortsFor}, and are passed through
 * untouched so the two never disagree.
 *
 * Only MISSING fields are filled. An adapter that reports its own `reasoning` or
 * `context` keeps it, because that is what dispatch will honour.
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
    const resolved: unknown = await Reflect.apply(original, llm, [
      provider,
      model,
      signal,
    ]);
    // Our own routes carry the real metadata already, and an answer that is not
    // a record has nothing to fill in.
    if (isInternalRoute(provider) || !isRecord(resolved)) {
      return resolved;
    }
    const spec = findModelSpecOn(catalogPlaneForRoute(provider), model);
    if (spec === undefined) {
      return resolved;
    }
    const out: Record<string, unknown> = { ...resolved };
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
    if (typeof spec.context_window === "number" && spec.context_window > 0) {
      out.context = { contextWindow: spec.context_window };
    }
    // The output cap is the same class of staleness, and a wrong one truncates
    // rather than merely mis-reports.
    if (
      typeof spec.max_output_tokens === "number" &&
      spec.max_output_tokens > 0
    ) {
      out.defaultMaxTokens = spec.max_output_tokens;
    }
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
