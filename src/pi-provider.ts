/**
 * Build pi-ai providers for the gateway's two planes, from our own catalog.
 *
 * The plugin mounts its routes through `dsh-llm-pi-ai`, which builds a
 * hand-declared route from a three-entry protocol table. That table is why
 * `@ai-sdk/google` could not be served: `google-generative-ai` is implemented
 * by pi-ai but is not one of the three names a route may declare. This module
 * builds the provider directly instead, so every protocol pi implements is
 * reachable and the routing decision moves to each model's `api` field.
 *
 * Two measured facts shape it, neither derivable from the protocol name:
 *
 * - **The base URL is per protocol, not per plane.** The Anthropic SDK appends
 *   its own `/v1/messages`, so its base is one level shorter than the others.
 *   Read off pi's own `opencode` provider, which records it per model.
 * - **The session header must be set on the request.** pi ships its own, but it
 *   defers when the header is already present, so wrapping each `api` here puts
 *   ours on every protocol and leaves pi's a no-op.
 *
 * pi-ai is injected rather than imported: the plugin must not bundle a second
 * copy of it, and the caller is the only place that knows how to reach the one
 * the host already loaded.
 *
 * @module dsh-opencode-patch/pi-provider
 */

import type { CatalogModelSpec } from "./catalog-data.ts";
import { OPENCODE_PLANE_API } from "./catalog-data.ts";
import {
  ANTHROPIC_SDK,
  GOOGLE_SDK,
  RESPONSES_SDK,
} from "./responses-routes.ts";

/** The gateway plane a provider serves. */
export type Plane = "opencode" | "opencode-go";

/**
 * The base URL each protocol uses on each plane.
 *
 * Read from pi-ai's own `opencode` and `opencode-go` providers rather than
 * inferred: the Anthropic entry is deliberately one level shorter because that
 * SDK appends `/v1/messages` itself.
 */
/**
 * The endpoint each protocol's requests go to, per plane.
 *
 * The base comes from the catalog - the field the client itself consumes
 * (`models-dev.ts:107` lifts the provider's `api` into `settings.baseURL`), and
 * which the shim now carries as `OPENCODE_PLANE_API`. It was hard-coded here
 * instead, and when the vendor moved `models.dev`'s provider entry to
 * `…/inference/v1` the constant was left on `…/zen/v1`: a deployment would have
 * kept using the older endpoint while its own catalog named the newer one.
 *
 * The Anthropic path differs from the others by design (`/messages` not `/chat/
 * completions`), so only the suffix changes, and the suffix is per protocol
 * rather than per model.
 */
const PLANE_BASE: Readonly<Record<Plane, string>> = {
  opencode: OPENCODE_PLANE_API.zen,
  "opencode-go": OPENCODE_PLANE_API.go,
};

/**
 * The protocol's path on the plane's base, or `null` when it is the base itself.
 *
 * The catalog's `api` is the base INCLUDING the version segment - `…/zen/v1`,
 * `…/inference/v1` - so the versioned protocols are the base with nothing added,
 * and the Anthropic endpoint (`/messages`) is the base without that segment.
 * Appending `/v1` to the new value produces `…/inference/v1/v1`, which is how
 * this was found.
 */
const PROTOCOL_SUFFIX: Readonly<Record<string, string | null>> = {
  "anthropic-messages": null,
  "google-generative-ai": "",
  "openai-completions": "",
  "openai-responses": "",
};

export const BASE_FOR_PROTOCOL: Readonly<
  Record<Plane, Readonly<Record<string, string>>>
> = {
  opencode: withPlaneBase("opencode"),
  "opencode-go": withPlaneBase("opencode-go"),
};

/** Every protocol on one plane, sharing the plane's base. */
function withPlaneBase(plane: Plane): Readonly<Record<string, string>> {
  const base = PLANE_BASE[plane];
  const out: Record<string, string> = {};
  for (const [protocol, suffix] of Object.entries(PROTOCOL_SUFFIX)) {
    out[protocol] =
      suffix === null ? base.replace(/\/v1$/, "") : `${base}${suffix}`;
  }
  return out;
}

/**
 * The protocol each SDK names, for a provider built here.
 *
 * Deliberately NOT `PROTOCOL_FOR_SDK`: that table is the wrapper's, and it
 * lists only the protocols a hand-declared route may name. Building the
 * provider ourselves lifts that limit, so this table carries every protocol pi
 * implements that the gateway is measured to serve - which is four, and one
 * more than a route could ever name.
 *
 * `@ai-sdk/mistral` is absent on purpose. pi implements
 * `mistral-conversations`, but driving it at the gateway produces a request
 * whose URL this harness could not even observe, and the account has no
 * entitlement to test it against. It stays unserved until that is measured,
 * rather than being wired on the strength of a protocol existing.
 */
export const GATEWAY_PROTOCOL_FOR_SDK: Readonly<Record<string, string>> = {
  [RESPONSES_SDK]: "openai-responses",
  [ANTHROPIC_SDK]: "anthropic-messages",
  [GOOGLE_SDK]: "google-generative-ai",
};

/** The protocol a model speaks, or undefined when its SDK has no mapping. */
export const protocolFor = (spec: CatalogModelSpec): string | undefined =>
  spec.provider_npm === undefined
    ? "openai-completions"
    : GATEWAY_PROTOCOL_FOR_SDK[spec.provider_npm];

/** Whether a string names a plane this table carries. */
const isPlane = (value: string): value is Plane =>
  value === "opencode" || value === "opencode-go";

/**
 * The base URL one protocol of one plane is served from.
 *
 * The table is keyed by {@link Plane} so a missing plane is a type error where
 * the table is written. Callers walk a route table whose key is a plain string,
 * so they come through here: a plane the table does not carry has no base, and
 * saying so is better than indexing past the end of a record.
 *
 * @param plane - the gateway plane.
 * @param protocol - the protocol the request speaks.
 * @returns the base URL, or undefined when the table does not carry that plane.
 */
export const baseForProtocol = (
  plane: string,
  protocol: string
): string | undefined =>
  isPlane(plane) ? BASE_FOR_PROTOCOL[plane]?.[protocol] : undefined;

/**
 * The pi model object for one catalogued model.
 *
 * pi reads `api` to pick a protocol implementation and `baseUrl` to know where
 * to send it, so both have to be right per model. The cost field is pi's own
 * vocabulary: camelCase where the catalog is snake_case, and its rates are per
 * million tokens, which is what the catalog already carries.
 *
 * **The installed catalog entry is the floor, never the whole object.** Building
 * these models field by field drops everything pi knows that this module does
 * not model — the compatibility switches a Claude or Grok request needs, the
 * `reasoning` flag, the `thinkingLevelMap` that maps a thinking level onto the
 * wire's own spelling, the `inputLimits` that bound an image. The wrapper's own
 * model materialization spreads the catalog entry for the same reason, and says
 * so: enumerating would silently drop every field the package does not model.
 *
 * So the entry is spread first and only then overlaid, which also makes the
 * precedence deliberate: our catalog is fresher than the installed one for the
 * fields we set, and the installed one is the only source for the fields we do
 * not know about.
 *
 * @param plane - the gateway plane this model is served on.
 * @param spec - the catalogued model.
 * @param protocol - the protocol it speaks, from {@link protocolFor}.
 * @param base - pi's installed catalog entry for this id, when it has one.
 * @returns the model object pi's provider dispatches on.
 */
/**
 * The thinking levels a model accepts, as pi's map.
 *
 * pi's `ThinkingLevelMap` is `Partial<Record<ModelThinkingLevel, string | null>>`
 * — each of pi's levels mapped onto the spelling the model's own wire uses, with
 * `null` marking a level it does not take. The catalog says which levels a model
 * has and says nothing about the wire's spelling, so the mapping is the identity
 * where the two agree, and every level the catalog does not list is `null` rather
 * than absent: absent means "use the provider default", which would offer a level
 * the model refuses.
 *
 * Only the shapes the catalog actually uses are handled — `effort` with a value
 * list, and `toggle` for on/off. `budget_tokens` carries a minimum rather than a
 * list of levels, so it contributes no map: pi's token-budget field is a separate
 * mechanism and guessing one here would be worse than offering none.
 *
 * @param spec - the catalogued model.
 * @returns the map, or `undefined` when the model declares no levels.
 */
export const thinkingLevelMapFor = (
  spec: CatalogModelSpec
): Partial<Record<string, string | null>> | undefined => {
  const options = spec.reasoning_options ?? [];
  const levels = options.find(
    (option) => option.type === "effort" && (option.values?.length ?? 0) > 0
  )?.values;
  if (levels !== undefined) {
    // `off` is part of the map too, and `null` there means the model has no
    // off switch - which is what the installed catalog says for these models.
    const map: Record<string, string | null> = { off: null };
    for (const level of ALL_THINKING_LEVELS) {
      map[level] = levels.includes(level) ? level : null;
    }
    return map;
  }
  if (options.some((option) => option.type === "toggle")) {
    // On or off: every level is the same "on", and `off` is the model's own.
    const map: Record<string, string | null> = { off: null };
    for (const level of ALL_THINKING_LEVELS) {
      map[level] = "on";
    }
    return map;
  }
  return undefined;
};

/** pi's levels, in its own order, so the map is complete rather than partial. */
const ALL_THINKING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const piModelFor = (
  plane: Plane,
  spec: CatalogModelSpec,
  protocol: string,
  base?: object
) => ({
  ...base,
  api: protocol,
  baseUrl: BASE_FOR_PROTOCOL[plane]?.[protocol],
  contextWindow: spec.context_window,
  cost: {
    cacheRead: spec.cost?.cache_read ?? 0,
    cacheWrite: spec.cost?.cache_write ?? 0,
    input: spec.cost?.input ?? 0,
    output: spec.cost?.output ?? 0,
  },
  id: spec.id,
  input: spec.input_modalities,
  maxTokens: spec.max_output_tokens,
  name: spec.name,
  provider: plane,
  // Explicit, because the spread above is only a floor: pi's installed catalog
  // need not carry these models at all, and when it does not, `reasoning` and
  // `thinkingLevelMap` were simply absent - which is the thinking level the
  // picker could not offer for any model.
  // Required by pi's Model, not optional: a model that declares no reasoning
  // takes none, and `false` is what that means. Omitting it left an object the
  // package's own type says cannot exist.
  reasoning: spec.reasoning === true,
  ...(thinkingLevelMapFor(spec) === undefined
    ? {}
    : { thinkingLevelMap: thinkingLevelMapFor(spec) }),
});
