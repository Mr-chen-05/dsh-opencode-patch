/**
 * Authoritative OpenCode Go & Zen model catalog and gateway model list enrichment.
 *
 * The raw OpenCode Go `/models` gateway endpoint frequently returns an incomplete
 * or truncated list of model IDs without display names, context windows, max
 * tokens, or input modalities.
 *
 * This module maintains the canonical catalog (sourced from `models.dev/api.json`)
 * and intercepts `GET .../models` gateway responses to ensure that all 33+ models
 * are present, fully described, and available for DSH model discovery.
 *
 * @module dsh-opencode-patch/models-catalog
 */

import {
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  RETIRED_ZEN_MODEL_IDS,
  type CatalogModelSpec,
  type ReasoningOptionSpec,
} from "./catalog-data.ts";
import { DEFAULT_GATEWAY_URLS } from "./config.ts";
import { isRecord } from "./guards.ts";
import type { ModelCostRate } from "./session-cost.ts";

// The catalog data is part of this module's public surface (and of the
// package's, via `index.ts`), so re-export it rather than making callers
// reach into `catalog-data.ts` directly.
export {
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  RETIRED_ZEN_MODEL_IDS,
  type CatalogModelSpec,
} from "./catalog-data.ts";

export type CatalogProvider = "go" | "zen";

/** Whether OpenCode CLI no longer offers this model ID on this provider. */
export const isRetiredModel = (
  provider: CatalogProvider,
  id: string
): boolean => provider === "zen" && RETIRED_ZEN_MODEL_IDS.has(id);

/** Canonical OpenCode model registry URL. */
export const MODELS_OPENCODE_URL = "https://models.opencode.ai/api.json";

/** Public OpenCode model registry mirror URL. */
export const MODELS_DEV_URL = "https://models.dev/api.json";

/**
 * Modalities supported by DeepSeek Harness model configuration schemas.
 * DSH strictly accepts ("text" | "image")[], rejecting "video", "audio", "pdf".
 */
export const DSH_SUPPORTED_MODALITIES = new Set(["text", "image"]);

/**
 * Sanitize an input modalities list to match the DSH schema ("text" | "image").
 * Drops "video", "audio", "pdf", and defaults to ["text"] if empty.
 */
export const sanitizeModalities = (
  modalities: unknown
): ("text" | "image")[] => {
  if (!Array.isArray(modalities)) {
    return ["text"];
  }
  const filtered = modalities.filter(
    (m): m is "text" | "image" =>
      typeof m === "string" && DSH_SUPPORTED_MODALITIES.has(m)
  );
  return filtered.length > 0 ? filtered : ["text"];
};

/** TTL for cached models before triggering a background revalidation (60 minutes). */
export const CATALOG_REVALIDATION_TTL_MS = 60 * 60 * 1000;

/**
 * What an enriched row falls back to when neither the live row nor the catalog
 * describes the model. Matches the shim's own defaults, so a model that reaches
 * the picker before either source knows it is still fully described.
 */
/**
 * Model ids kept in the catalog even though `models.dev` marks them deprecated.
 *
 * The registry's `deprecated` flag is a statement about the vendor's catalogue,
 * not about the gateway. They disagree in measured cases, and the disagreement is
 * invisible from here: `step-5-preview-free` has carried the flag on both planes
 * while still answering requests, which is how the session this was written in
 * was running on it. Retaining an id keeps a model that works; dropping it on the
 * flag alone removes one.
 *
 * The rule is "until it stops answering", not "until the flag clears" - a probe
 * is the only thing that can tell those apart, and `docs/credentials.md` records
 * the measurement that put the first entry here. A pin with no date is a pin
 * nobody can age out, so each carries one.
 */
const RETAINED_MODEL_IDS: ReadonlySet<string> = new Set([
  // Measured 2026-10-17 by POSTing one token to `/zen/v1/chat/completions` per
  // id and reading the answer: `400 "Model is unavailable"` means gone, and
  // `401`/`403` means the model is there and only the credential is missing.
  // That is the "until it stops ANSWERING" probe this comment has always asked
  // for, and it overturned every previous entry:
  //
  //   exo-free                        403  -> retained
  //   cat-jam-free                    403  -> retained
  //   muse-spark-1.2-contributor-free 403  -> retained
  //   step-5-preview-free             400  -> REMOVED, it no longer answers
  //
  // The `deprecated` flag is not a substitute for this: 36 of the 43 deprecated
  // zen ids answered `400` and are genuinely gone, 4 answered `410 Gone`, and 3
  // still answer — so the flag is right most of the time and wrong exactly where
  // it costs a working model.
  "cat-jam-free",
  "exo-free",
  "muse-spark-1.2-contributor-free",
]);

const FALLBACK_CONTEXT_WINDOW = 1_000_000;

/** @see FALLBACK_CONTEXT_WINDOW */
const FALLBACK_MAX_OUTPUT_TOKENS = 131_072;

/**
 * Timeout for models.dev revalidation requests.
 *
 * 8s was measured against the endpoint when it answered in ~200ms, and the
 * vendor has since slowed to 7-12s for the same payload. The budget was tighter
 * than the thing it budgets, so the freshness job - and every runtime revalidation
 * - failed with a `TimeoutError` rather than with a content mismatch. Two CI runs
 * on `catalog freshness` were this, not vendor churn.
 *
 * 30s is comfortably past the observed worst case while still bounded, because a
 * revalidation that hangs is worse than one that fails: the shim ships with the
 * bundled catalog, and the SWR refresh keeps serving it, so a slow answer costs
 * a wait and a dead one costs a retry.
 */
export const MODELS_DEV_TIMEOUT_MS = 30_000;

let activeGoCatalog = new Map<string, CatalogModelSpec>(
  OPENCODE_GO_CATALOG.filter((m) => !isRetiredModel("go", m.id)).map((m) => [
    m.id,
    m,
  ])
);
let activeZenCatalog = new Map<string, CatalogModelSpec>(
  OPENCODE_ZEN_CATALOG.filter((m) => !isRetiredModel("zen", m.id)).map((m) => [
    m.id,
    m,
  ])
);
/**
 * Ids the most recent parse saw as `status: "deprecated"`, per plane.
 *
 * Kept beside the active maps because the ADAPTER's own discovery needs it:
 * `mergeDiscoveredModels` merges adapter rows before catalog rows, and pi's
 * installed snapshot still carries ids the live catalog has retired. Dropping
 * them from our catalog alone is not enough — the merge puts them back.
 */
const deprecatedGoIds = new Set<string>();
const deprecatedZenIds = new Set<string>();

let lastRefreshedAt = 0;
let refreshPromise:
  | Promise<{
      go: readonly CatalogModelSpec[];
      zen: readonly CatalogModelSpec[];
    }>
  | undefined;

export interface ParsedCatalogs {
  /**
   * The endpoint each plane's provider declares, read from the catalog itself
   * rather than assumed. `models.dev` puts it on the provider entry as `api`, and
   * the client consumes exactly this field
   * (`packages/core/src/models-dev.ts:107`, `settings: { baseURL: item.api }`).
   */
  api: { go: string; zen: string };
  /**
   * The endpoint each WIRE FAMILY declares, per plane, keyed by the SDK package
   * the catalog names for it (`""` for the provider default).
   *
   * The provider-level `api` above is not the whole story: the vendor serves
   * anthropic and google at their own paths, and declares that per model. Read
   * from the same data rather than restated in code, so a vendor move is a shim
   * regeneration and not a source change.
   */
  familyApi: { go: FamilyApi; zen: FamilyApi };
  go: CatalogModelSpec[];
  zen: CatalogModelSpec[];
}

/** One plane's endpoint per SDK package (`""` = the provider's own default). */
export type FamilyApi = Readonly<Record<string, string>>;

/** The endpoint a provider entry declares, or `""` when it declares none. */
const providerApiFor = (entry: unknown): string =>
  isRecord(entry) && typeof entry.api === "string" ? entry.api : "";

/**
 * Each wire family's endpoint, keyed by the SDK package that names it.
 *
 * A model's own `provider.api` wins; otherwise it inherits the provider's. The
 * first value seen for a package is kept — the vendor declares one endpoint per
 * family, and a second value would mean the assumption is wrong rather than that
 * the first should be replaced.
 *
 * @param entry - one provider entry from the catalog.
 * @returns the family map, empty when the entry carries no models.
 */
const familyApiFor = (entry: unknown): FamilyApi => {
  const out: Record<string, string> = {};
  if (!isRecord(entry) || !isRecord(entry.models)) {
    return out;
  }
  const providerApi = providerApiFor(entry);
  for (const rawModel of Object.values(entry.models)) {
    if (!isRecord(rawModel)) {
      continue;
    }
    const provider = isRecord(rawModel.provider) ? rawModel.provider : {};
    const npm = typeof provider.npm === "string" ? provider.npm : "";
    const api = typeof provider.api === "string" ? provider.api : providerApi;
    if (api.length > 0 && out[npm] === undefined) {
      out[npm] = api;
    }
  }
  return out;
};

/**
 * The thinking options a model declares, with unknown shapes dropped.
 *
 * A `type` is required because the options are discriminated by it; `values` and
 * `min` are optional and only carried when they are the right kind. An entry
 * that is not an object, or has no string `type`, is skipped rather than
 * repaired.
 *
 * @param raw - `models.dev`'s `reasoning_options`.
 * @returns the options, or `undefined` when there are none to carry.
 */
const sanitizeReasoningOptions = (
  raw: unknown
): ReasoningOptionSpec[] | undefined => {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const out: ReasoningOptionSpec[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.type !== "string") {
      continue;
    }
    const values = Array.isArray(entry.values)
      ? entry.values.filter((v): v is string => typeof v === "string")
      : undefined;
    const min = typeof entry.min === "number" ? entry.min : undefined;
    out.push({
      ...(min === undefined ? {} : { min }),
      type: entry.type,
      ...(values === undefined ? {} : { values }),
    });
  }
  return out.length === 0 ? undefined : out;
};

const extractSpecs = (
  modelsObj: Record<string, unknown>,
  defaultContext = 1_000_000,
  deprecated?: Set<string>
): CatalogModelSpec[] => {
  const results: CatalogModelSpec[] = [];
  for (const [id, rawModel] of Object.entries(modelsObj)) {
    if (!isRecord(rawModel)) {
      continue;
    }
    // The bundled shim ships active models only, and a refresh must agree with
    // it: merging a deprecated entry here would put a row the gateway no longer
    // serves back into the model picker on the next successful revalidation.
    //
    // EXCEPT the retained ones. `models.dev` marks a model deprecated well
    // before the gateway stops serving it, and the two sources disagree in
    // measured cases: `step-5-preview-free` has been `deprecated` in the
    // registry while still answering on both planes - the session this was
    // written in ran on it. Dropping it on the registry's word alone removes a
    // working model, which is the same failure as offering a broken one, and
    // there is no way to tell the two apart from here.
    //
    // A retained id is kept until it stops ANSWERING, not until a registry flag
    // says so, and each one carries the date it was pinned so a reader can see
    // how long the disagreement has stood.
    if (rawModel.status === "deprecated" && !RETAINED_MODEL_IDS.has(id)) {
      // Recorded, not merely dropped. A model the registry has retired must not
      // come back through the ADAPTER's own discovery: `mergeDiscoveredModels`
      // merges adapter rows first, and pi's installed snapshot still lists ids
      // the live catalog has retired (measured: 5 of them, and 6 live-active
      // ids it lacks). Without this set the merge re-adds every one, which is a
      // picker led by models the vendor has retired.
      deprecated?.add(id);
      continue;
    }
    const name =
      typeof rawModel.name === "string" && rawModel.name.length > 0
        ? rawModel.name
        : id;
    const limit = isRecord(rawModel.limit) ? rawModel.limit : undefined;
    const context_window =
      typeof limit?.context === "number" && limit.context > 0
        ? limit.context
        : defaultContext;
    const max_output_tokens =
      typeof limit?.output === "number" && limit.output > 0
        ? limit.output
        : 131_072;
    const modalities = isRecord(rawModel.modalities)
      ? rawModel.modalities
      : undefined;
    const input_modalities = sanitizeModalities(modalities?.input);
    const costRaw = isRecord(rawModel.cost) ? rawModel.cost : undefined;
    let cost: ModelCostRate | undefined;
    if (costRaw !== undefined) {
      const input = typeof costRaw.input === "number" ? costRaw.input : 0;
      const output = typeof costRaw.output === "number" ? costRaw.output : 0;
      const cache_read =
        typeof costRaw.cache_read === "number" ? costRaw.cache_read : undefined;
      const cache_write =
        typeof costRaw.cache_write === "number"
          ? costRaw.cache_write
          : undefined;
      cost = {
        input,
        output,
        ...(cache_read === undefined ? {} : { cache_read }),
        ...(cache_write === undefined ? {} : { cache_write }),
      };
    }
    const is_free =
      id.includes("free") || (cost?.input === 0 && cost?.output === 0);
    // The thinking level: whether the model takes one, and which kinds it takes.
    // Read here rather than derived, because the three shapes differ - effort
    // with values, a token budget with a minimum, and a plain toggle - and a
    // picker that guessed would offer a setting the model refuses.
    const reasoning =
      typeof rawModel.reasoning === "boolean" ? rawModel.reasoning : undefined;
    const reasoning_options = sanitizeReasoningOptions(
      rawModel.reasoning_options
    );
    // models.dev sets `provider.npm` only as an override of the provider's
    // default SDK, so its PRESENCE is the signal: a model naming `@ai-sdk/openai`
    // is served on the Responses API, one naming nothing uses the default.
    const provider = isRecord(rawModel.provider)
      ? rawModel.provider
      : undefined;
    const provider_npm =
      typeof provider?.npm === "string" && provider.npm.length > 0
        ? provider.npm
        : undefined;

    results.push({
      context_window,
      ...(cost === undefined ? {} : { cost }),
      id,
      input_modalities:
        input_modalities.length > 0 ? input_modalities : ["text"],
      ...(is_free ? { is_free: true } : {}),
      max_output_tokens,
      name,
      ...(provider_npm === undefined ? {} : { provider_npm }),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(reasoning_options === undefined ? {} : { reasoning_options }),
    });
  }
  return results;
};

/** Which of the two catalogs a model id should be read from. */
export type CatalogPlane = "go" | "zen";

/**
 * The plane a route's models come from.
 *
 * `opencode-go` is the subscription plane; everything else this plugin knows
 * about (`opencode`, and the internal routes derived from it) is Zen.
 */
export const catalogPlaneForRoute = (route: unknown): CatalogPlane =>
  route === "opencode-go" ? "go" : "zen";

/**
 * The spec a given PLANE declares for a model.
 *
 * **The two planes declare different SDKs for the same model id**, which is why
 * this exists at all. models.dev's `opencode-go` names `@ai-sdk/anthropic` for
 * `qwen3.8-max`, `minimax-m2.7` and `minimax-m3`, while its `opencode` names
 * nothing — the default, i.e. completions. A single Go-first lookup therefore
 * answers a ZEN question with GO data, and for those three models that is a
 * mis-route rather than a detail.
 *
 * Measured 2026-10-06 against the live Zen gateway: `qwen3.8-max` and
 * `minimax-m3` answer `200` on `/chat/completions` and
 * `400 ModelProtocolUnsupported` on `/messages` — and `/messages` is exactly
 * where the Go-first read sent them. Both were reachable and failing.
 */
export const findModelSpecOn = (
  plane: CatalogPlane,
  modelId: string
): CatalogModelSpec | undefined =>
  plane === "go" ? activeGoCatalog.get(modelId) : activeZenCatalog.get(modelId);

/**
 * Look up model specifications and pricing rates by model ID, preferring the Go
 * plane.
 *
 * Correct for "does either plane know this model" — pricing and limits, which
 * agree across the planes for every shared id. **Not** correct for routing: see
 * {@link findModelSpecOn}. Anywhere the answer decides which ENDPOINT serves a
 * model, the plane has to come from the route in play.
 */
export const findModelSpec = (modelId: string): CatalogModelSpec | undefined =>
  activeGoCatalog.get(modelId) ?? activeZenCatalog.get(modelId);

/**
 * Safely parse raw models.dev JSON data for both opencode-go and opencode providers.
 *
 * @param data - raw parsed JSON from `https://models.dev/api.json`
 * @returns extracted model specifications for both Go and Zen
 */
export const parseModelsDevCatalog = (data: unknown): ParsedCatalogs => {
  if (!isRecord(data)) {
    return {
      api: { go: "", zen: "" },
      familyApi: { go: {}, zen: {} },
      go: [],
      zen: [],
    };
  }
  const goObj =
    isRecord(data["opencode-go"]) && isRecord(data["opencode-go"].models)
      ? data["opencode-go"].models
      : {};
  const zenObj =
    isRecord(data.opencode) && isRecord(data.opencode.models)
      ? data.opencode.models
      : {};

  deprecatedGoIds.clear();
  deprecatedZenIds.clear();
  return {
    api: {
      go: providerApiFor(data["opencode-go"]),
      zen: providerApiFor(data.opencode),
    },
    familyApi: {
      go: familyApiFor(data["opencode-go"]),
      zen: familyApiFor(data.opencode),
    },
    go: extractSpecs(goObj, 1_000_000, deprecatedGoIds),
    zen: extractSpecs(zenObj, 1_000_000, deprecatedZenIds),
  };
};

/**
 * Whether the most recent catalog parse saw `id` as retired on `plane`.
 *
 * The complement of {@link findModelSpecOn}: a model can be absent from the
 * catalog because it is NEW or because it is RETIRED, and the two want opposite
 * treatment in a merge. This is what tells them apart.
 *
 * @param plane - `zen` or `go`.
 * @param id - the model id to test.
 * @returns whether the registry has retired it.
 */
export const isDeprecatedModelOn = (plane: "go" | "zen", id: string): boolean =>
  (plane === "go" ? deprecatedGoIds : deprecatedZenIds).has(id);

/**
 * Fetch and merge the latest live model specifications from `models.dev`.
 *
 * Never throws: on network failure, timeout, or invalid reply, gracefully falls
 * back to the current active catalog. Concurrent calls coalesce into one in-flight promise.
 *
 * @param fetchFn - fetch implementation to use (defaults to globalThis.fetch)
 * @param force - bypass TTL cache and force immediate refresh
 */
export const refreshCatalog = (
  fetchFn: typeof fetch = globalThis.fetch,
  force = false
): Promise<{
  go: readonly CatalogModelSpec[];
  zen: readonly CatalogModelSpec[];
}> => {
  const now = Date.now();
  if (
    !force &&
    lastRefreshedAt > 0 &&
    now - lastRefreshedAt < CATALOG_REVALIDATION_TTL_MS
  ) {
    return Promise.resolve({
      go: [...activeGoCatalog.values()],
      zen: [...activeZenCatalog.values()],
    });
  }
  if (!force && refreshPromise !== undefined) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      const response = await fetchFn(MODELS_OPENCODE_URL, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(MODELS_DEV_TIMEOUT_MS),
      });
      if (response.ok) {
        const json: unknown = await response.json();
        const parsed = parseModelsDevCatalog(json);
        if (parsed.go.length > 0) {
          const nextGo = new Map(activeGoCatalog);
          for (const model of parsed.go) {
            nextGo.set(model.id, model);
          }
          activeGoCatalog = nextGo;
        }
        if (parsed.zen.length > 0) {
          const nextZen = new Map(activeZenCatalog);
          for (const model of parsed.zen) {
            nextZen.set(model.id, model);
          }
          for (const retiredId of RETIRED_ZEN_MODEL_IDS) {
            nextZen.delete(retiredId);
          }
          activeZenCatalog = nextZen;
        }
        if (parsed.go.length > 0 || parsed.zen.length > 0) {
          lastRefreshedAt = Date.now();
        }
      }
    } catch {
      // Revalidation failure retains active catalogs and allows later retry
    } finally {
      refreshPromise = undefined;
    }
    return {
      go: [...activeGoCatalog.values()],
      zen: [...activeZenCatalog.values()],
    };
  })();

  return refreshPromise;
};

const triggerBackgroundRefresh = async (
  fetchFn: typeof fetch
): Promise<void> => {
  try {
    await refreshCatalog(fetchFn);
  } catch {
    // Background revalidation failure silently retains active catalogs
  }
};

/**
 * Serve one catalog map immediately (non-blocking), kicking off a background
 * SWR revalidation when it is stale.
 *
 * Both providers share a single freshness clock: `lastRefreshedAt` is only
 * advanced by a refresh that returned something for at least one provider, so
 * an offline start keeps retrying on every read until the first success.
 *
 * @param catalog - the active map to snapshot.
 * @param fetchFn - fetch implementation used for the background refresh.
 */
const readLiveCatalog = (
  catalog: ReadonlyMap<string, CatalogModelSpec>,
  fetchFn: typeof fetch
): readonly CatalogModelSpec[] => {
  const now = Date.now();
  if (
    lastRefreshedAt === 0 ||
    now - lastRefreshedAt >= CATALOG_REVALIDATION_TTL_MS
  ) {
    void triggerBackgroundRefresh(fetchFn);
  }
  return [...catalog.values()];
};

/**
 * Return the current Go catalog immediately, triggering SWR revalidation if stale.
 *
 * @param fetchFn - fetch implementation to use for background refresh
 */
export const getLiveGoCatalog = (
  fetchFn: typeof fetch = globalThis.fetch
): readonly CatalogModelSpec[] => readLiveCatalog(activeGoCatalog, fetchFn);

/**
 * Return the current Zen catalog immediately, triggering SWR revalidation if stale.
 *
 * @param fetchFn - fetch implementation to use for background refresh
 */
export const getLiveZenCatalog = (
  fetchFn: typeof fetch = globalThis.fetch
): readonly CatalogModelSpec[] => readLiveCatalog(activeZenCatalog, fetchFn);

/** Legacy alias for getLiveGoCatalog. */
export const getLiveCatalog = getLiveGoCatalog;

/**
 * Check whether a request URL is interrogating the models directory.
 *
 * The gateway marker is a PARAMETER, not a constant. It used to be hardcoded to
 * `opencode.ai/zen` while `isOpenCodeRequest` already took `gatewayUrls` — so a
 * relay or mirror that matched every other OpenCode rule got the headers and the
 * session id but no catalog enrichment, and the only symptom was a shorter model
 * list. Same shape as that predicate: match any configured marker, defaulting to
 * the stock one.
 *
 * @param url - the request URL
 * @param gatewayUrls - configured gateway markers; defaults to the stock one
 */
export const isModelsListingUrl = (
  url: string,
  gatewayUrls: readonly string[] = DEFAULT_GATEWAY_URLS
): boolean => {
  const onGateway = gatewayUrls.some(
    (marker) => marker.length > 0 && url.includes(marker)
  );
  if (!onGateway) {
    return false;
  }
  return url.endsWith("/models") || url.includes("/models?");
};

/**
 * Whether that listing is on the GO plane.
 *
 * The plane is a property of the PATH, never of the host: a custom gateway's Go
 * route is still `/go/v1`, so this reads the same way for a relay as for
 * opencode.ai — which is exactly why the marker above had to be lifted out.
 */
export const isGoModelsListingUrl = (
  url: string,
  gatewayUrls?: readonly string[]
): boolean =>
  isModelsListingUrl(url, gatewayUrls) &&
  (url.includes("/zen/go") || url.includes("/go/v1"));

/**
 * Merge and enrich a gateway `/models` response with the complete OpenCode Go or Zen catalog.
 *
 * @param url - the request URL
 * @param response - the upstream fetch Response
 * @param fetchFn - optional fetch implementation for SWR background refresh
 * @returns an enriched Response with all models and complete metadata
 */
export const enrichModelsResponse = async (
  url: string,
  response: Response,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<Response> => {
  let existingData: Record<string, unknown>[] = [];
  try {
    const raw: unknown = await response.clone().json();
    if (isRecord(raw) && Array.isArray(raw.data)) {
      existingData = raw.data.filter(isRecord);
    }
  } catch {
    // If the upstream returned non-JSON, generate the full catalog response.
  }

  const isGo = isGoModelsListingUrl(url);
  const catalog = isGo ? getLiveGoCatalog(fetchFn) : getLiveZenCatalog(fetchFn);
  const catalogById = new Map(catalog.map((m) => [m.id, m]));
  const merged = new Map<string, Record<string, unknown>>();

  // **This is the CATALOG surface, so it is the one place that seeds.**
  // `discoverModels` in `dsh-llm-pi-ai` returns its installed catalog for a
  // provider it ships and only fetches an endpoint for one it does not — so a
  // `/models` answer is "what this endpoint offers", the list a user browses, not
  // the list a picker shows. Widening is right here and wrong anywhere that
  // decides what a deployment may pick.
  //
  // The seed also covers the ordinary case of a gateway answering with a subset:
  // the vendor's own listing is narrower than its catalog.
  for (const spec of catalog) {
    const input_modalities = sanitizeModalities(spec.input_modalities);
    merged.set(spec.id, {
      context_window: spec.context_window,
      created: 1_727_740_800,
      id: spec.id,
      input: input_modalities,
      input_modalities,
      inputModalities: input_modalities,
      max_output_tokens: spec.max_output_tokens,
      name: spec.name,
      object: "model",
      owned_by: "opencode",
    });
  }
  for (const item of existingData) {
    const id = typeof item.id === "string" ? item.id : "";
    if (id.length === 0 || isRetiredModel(isGo ? "go" : "zen", id)) {
      continue;
    }
    const spec = catalogById.get(id);
    const rawModalities =
      item.input_modalities ??
      item.inputModalities ??
      item.input ??
      spec?.input_modalities;
    const input_modalities = sanitizeModalities(rawModalities);
    const enriched = {
      ...item,
      // A live row the catalog does not describe must still be fully described.
      // The gateway adds models before models.dev — or the bundled shim — knows
      // them, and DSH needs a number to size the context meter; a row carrying
      // `undefined` here reaches the picker as a model with no limits at all.
      context_window:
        item.context_window ??
        item.contextWindow ??
        spec?.context_window ??
        FALLBACK_CONTEXT_WINDOW,
      id,
      input: input_modalities,
      input_modalities,
      inputModalities: input_modalities,
      max_output_tokens:
        item.max_output_tokens ??
        item.maxTokens ??
        spec?.max_output_tokens ??
        FALLBACK_MAX_OUTPUT_TOKENS,
      name: item.name ?? item.displayName ?? spec?.name ?? id,
      object: "model",
      owned_by: item.owned_by ?? "opencode",
    };
    merged.set(id, enriched);
  }

  const enrichedPayload = {
    data: [...merged.values()],
    object: "list",
  };

  const bodyStr = JSON.stringify(enrichedPayload);
  const newHeaders = new Headers(response.headers);
  newHeaders.set("content-type", "application/json; charset=utf-8");
  newHeaders.set("content-length", Buffer.byteLength(bodyStr).toString());

  return new Response(bodyStr, {
    headers: newHeaders,
    status: 200,
    statusText: "OK",
  });
};
