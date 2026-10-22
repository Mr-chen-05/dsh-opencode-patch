/**
 * Host-side catalog gap: what the vendor offers, minus what the profile declares
 * — and the one write that closes it.
 *
 * **Why a service and not a read-time join.** Joining the catalog into the
 * picker is the failure this repository already reversed twice: a list the plugin
 * is not the owner of must never be widened by the plugin, because Settings then
 * lists models the deployment never declared. The gap is the same information
 * with the ownership preserved — the user sees it, and only an explicit `declare`
 * writes it into the profile through `configEditor`.
 *
 * **Why the row is built from the catalog.** A declared model carries the fields
 * pi dispatches on (window, max tokens, modalities, thinking levels). Hand-typing
 * them is how a model ends up declared but unservable; taking them from the same
 * spec the adapter is served from means the entry cannot disagree with the model.
 *
 * @module dsh-opencode-patch/model-gap-service
 */

import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

import {
  GAP_NAMESPACE,
  type CatalogGapEntry,
  type CatalogGapPlane,
  type CatalogGapReport,
  type DeclareResult,
} from "./model-gap-contract.ts";
import {
  didCatalogRefreshSucceed,
  findModelSpecOn,
  getLiveGoCatalog,
  getLiveZenCatalog,
  refreshCatalog,
} from "./models-catalog.ts";
import { thinkingLevelMapFor } from "./pi-provider.ts";
import { isRecord } from "./utils/guards.ts";

/** A provider route the plugin knows how to read a plane from. */
const PLANES: readonly { route: string; plane: "go" | "zen" }[] = [
  { route: "opencode", plane: "zen" },
  { route: "opencode-go", plane: "go" },
];

/** The configEditor surface this module uses, narrowed from `unknown`. */
interface ConfigEditorFace {
  entries: () => readonly unknown[];
  edit: (
    entry: unknown,
    change: (current: Record<string, unknown>) => Record<string, unknown>
  ) => Promise<unknown>;
}

const asEditor = (value: unknown): ConfigEditorFace | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const { entries, edit } = value;
  if (typeof entries !== "function" || typeof edit !== "function") {
    return undefined;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the two methods were just checked; the cast only names their shape.
  return value as unknown as ConfigEditorFace;
};

/** The models a provider block declares, whatever shape the row uses. */
const modelsOf = (provider: unknown): readonly unknown[] | undefined => {
  if (!isRecord(provider)) {
    return undefined;
  }
  const { models } = provider;
  return Array.isArray(models) ? models : undefined;
};

/** One model row's id, when it is a row rather than a bare string. */
const idOf = (model: unknown): string | undefined => {
  if (typeof model === "string") {
    return model;
  }
  if (isRecord(model) && typeof model.id === "string") {
    return model.id;
  }
  return undefined;
};

/**
 * The profile row for one catalog model.
 *
 * PURE, and exported so a test can assert the shape without a config editor: this
 * is the object the adapter is later handed, and a field missing here is a model
 * that declares fine and serves wrong.
 *
 * `reasoningEfforts` drops the `null` entries of the thinking map — a `null` means
 * "this model has no such level", and writing it as an allowed level would offer
 * a control the model rejects.
 *
 * @param spec - the catalogued model, as the adapter is served it.
 * @returns the row to append to `providers[route].models`.
 */
export const declaredRowFor = (spec: {
  context_window: number;
  id: string;
  input_modalities: readonly string[];
  max_output_tokens: number;
  name: string;
  reasoning?: boolean;
  reasoning_options?: readonly { type: string; values?: readonly string[] }[];
}): Record<string, unknown> => {
  const levels = thinkingLevelMapFor({
    ...spec,
    reasoning_options: spec.reasoning_options?.map((option) => ({
      ...option,
      values: option.values === undefined ? undefined : [...option.values],
    })),
  } as never);
  const efforts =
    levels === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(levels).filter(([, value]) => value !== null)
        );
  return {
    id: spec.id,
    name: spec.name,
    contextWindow: spec.context_window,
    maxTokens: spec.max_output_tokens,
    input: [...spec.input_modalities],
    ...(efforts === undefined || Object.keys(efforts).length === 0
      ? {}
      : { reasoningEfforts: efforts }),
  };
};

/**
 * The ids each route declares, read off the config editor's entries.
 *
 * PURE, and exported so the awkward shapes are a test rather than a comment: an
 * entry that is not a record, an `options` that is not one, a `config` that is
 * not one, a provider block that is not one. Every one of those is a real
 * deployment shape (a row the settings UI has not filled in yet), and each must
 * read as "declares nothing" rather than throwing the whole gap away.
 *
 * @param editor - the `configEditor` service, or anything else.
 * @returns route → declared ids; a route absent from the map declares nothing.
 */
export const declaredRoutes = (
  editor: unknown
): ReadonlyMap<string, readonly string[]> => {
  const declared = new Map<string, readonly string[]>();
  const face = asEditor(editor);
  for (const entry of face?.entries() ?? []) {
    const options = isRecord(entry) ? entry.options : undefined;
    const raw = isRecord(options) ? options.config : undefined;
    const providers = isRecord(raw) ? raw.providers : undefined;
    if (!isRecord(providers)) {
      continue;
    }
    for (const { route } of PLANES) {
      const ids = (modelsOf(providers[route]) ?? [])
        .map((model) => idOf(model))
        .filter((id): id is string => id !== undefined);
      declared.set(route, ids);
    }
  }
  return declared;
};

/** The live catalog for one plane. */
const catalogFor = (plane: "go" | "zen") =>
  plane === "go" ? getLiveGoCatalog() : getLiveZenCatalog();

export class ModelGapService extends TypertRemoteService {
  constructor(ctx: unknown) {
    if (!isRecord(ctx)) {
      throw new TypeError("ModelGapService requires a Cordis context object");
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `TypertRemoteService` takes cordis `Context`, whose types ship only from the Harness installation; the guard above is the runtime check this cast stands in for.
    super(ctx as never, GAP_NAMESPACE);
  }

  /**
   * Read what the catalog offers that the profile does not declare.
   *
   * A forced refresh, for the same reason the purge does one: the shipped shim is
   * a snapshot, and "is there something newer?" is exactly the question a stale
   * snapshot cannot answer.
   */
  async gap(): Promise<CatalogGapReport> {
    await refreshCatalog(undefined, true);
    const catalogRead = didCatalogRefreshSucceed();
    const declaredByRoute = declaredRoutes(this.ctx.get?.("configEditor"));

    const planes: CatalogGapPlane[] = PLANES.map(({ route, plane }) => {
      const declared = declaredByRoute.get(route) ?? [];
      const declaredSet = new Set(declared);
      const missing: CatalogGapEntry[] = catalogFor(plane)
        .filter((spec) => !declaredSet.has(spec.id))
        .map((spec) => ({
          contextWindow: spec.context_window,
          free: spec.is_free === true,
          id: spec.id,
          maxTokens: spec.max_output_tokens,
          name: spec.name,
        }))
        // Free first, then by id: the question this row answers is usually "what
        // can I use without paying?", so the paid tail must not lead.
        .toSorted((a, b) => {
          if (a.free !== b.free) {
            return a.free ? -1 : 1;
          }
          return a.id.localeCompare(b.id);
        });
      return { declared, missing, route };
    });
    return { catalogRead, planes };
  }

  /**
   * Append the named catalog models to a route's declaration.
   *
   * Ids that are not in the catalog, and ids already declared, are dropped rather
   * than written: a declaration the adapter cannot serve is worse than an absent
   * one, because it appears in the picker and fails on the first turn.
   */
  async declare(query?: unknown): Promise<DeclareResult> {
    const route = isRecord(query) ? query.route : undefined;
    const ids = isRecord(query) && Array.isArray(query.ids) ? query.ids : [];
    const plane = PLANES.find((entry) => entry.route === route);
    if (plane === undefined) {
      throw new TypeError(
        `declare: "${String(route)}" is not a route this plugin declares`
      );
    }
    const editor = asEditor(this.ctx.get?.("configEditor"));
    if (editor === undefined) {
      throw new TypeError(
        "declare: this composition has no config editor, so the profile cannot be rewritten"
      );
    }
    const specs = ids
      .filter((id): id is string => typeof id === "string")
      .map((id) => findModelSpecOn(plane.plane, id))
      .filter((spec): spec is NonNullable<typeof spec> => spec !== undefined);

    const added: string[] = [];
    for (const entry of editor.entries()) {
      const options = isRecord(entry) ? entry.options : undefined;
      const raw = isRecord(options) ? options.config : undefined;
      if (!isRecord(isRecord(raw) ? raw.providers : undefined)) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- one entry owns the declaration; a second would be a different profile.
      await editor.edit(entry, (current) => {
        const next = isRecord(current.providers)
          ? { ...current.providers }
          : {};
        // A route block that is missing or malformed is CREATED here rather than
        // skipped: "declare this model on this route" is a complete instruction,
        // and refusing it because the block is absent would make the button do
        // nothing on exactly the profile that needs it most.
        const carried = next[plane.route];
        const block: Record<string, unknown> = isRecord(carried) ? carried : {};
        const existing = modelsOf(block) ?? [];
        const seen = new Set(
          existing
            .map((model) => idOf(model))
            .filter((id): id is string => id !== undefined)
        );
        const appended = specs
          .filter((spec) => !seen.has(spec.id))
          .map((spec) => declaredRowFor(spec));
        added.push(...appended.map((row) => String(row.id)));
        next[plane.route] = { ...block, models: [...existing, ...appended] };
        return { ...current, providers: next };
      });
      break;
    }
    return { added, route: plane.route };
  }
}

/**
 * Prototype key `remoteMethods()` reads Remote markers from — the same constant
 * `usage.ts`, `purge-service.ts` and `opencode-store-service.ts` spell out.
 */
const REMOTE_METHOD_DESCRIPTOR_KEY =
  "@deepseek-ai/dsh-typert-protocol/remote-methods";

/**
 * Declare `gap` and `declare` as Remote methods. See `usage.ts` for why the
 * decorator cannot be used in this build.
 */
Object.defineProperty(ModelGapService.prototype, REMOTE_METHOD_DESCRIPTOR_KEY, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([
      { method: "gap", invocation: { kind: "direct" } },
      { method: "declare", invocation: { kind: "direct" } },
    ]),
  }),
});
