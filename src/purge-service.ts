/**
 * Host-side "purge deprecated models": rewrites the deployment's own provider
 * declaration, deleting the model entries the live catalog has retired.
 *
 * **Why it edits the profile instead of filtering at read time.** A filter keeps
 * a second list of "what the user really means", and that list is invisible: the
 * configuration still declares the model, the log still reports it, and the only
 * way to learn why a row is missing is to find the filter. Deleting the entry
 * leaves one source of truth — the profile — and the model is gone from every
 * surface because it is no longer declared anywhere.
 *
 * The write goes through `configEditor`, the same service the settings UI uses:
 * it validates the next config, persists it atomically under the profile's file
 * lock, and lets the Loader reconcile the change. Nothing here writes YAML.
 *
 * @module dsh-opencode-patch/purge-service
 */

import {
  RemoteError,
  TypertRemoteService,
} from "@deepseek-ai/dsh-typert-protocol";

import {
  didCatalogRefreshSucceed,
  isDeprecatedModelOn,
  refreshCatalog,
} from "./models-catalog.ts";
import {
  PURGE_UNAVAILABLE,
  type PurgeResult,
  type PurgedModel,
} from "./purge-contract.ts";
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

export class ModelPurgeService extends TypertRemoteService {
  constructor(ctx: unknown) {
    if (!isRecord(ctx)) {
      throw new TypeError("ModelPurgeService requires a Cordis context object");
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `TypertRemoteService` takes cordis `Context`, whose types ship only from the Harness installation; the guard above is the runtime check.
    super(ctx as never, "opencodeModelPurge");
  }

  /**
   * Delete every declared model the live catalog marks `deprecated`.
   *
   * One network read first, forced: the shipped shim cannot answer this
   * question, because a retired model is dropped from the active catalog rather
   * than kept with a flag. `catalogRead` reports whether that read landed, so the
   * card can say "the catalog reports none" instead of implying it when the
   * refresh failed.
   */
  async purge(): Promise<PurgeResult> {
    const editor = asEditor(this.ctx.get?.("configEditor"));
    if (editor === undefined) {
      throw new RemoteError(
        PURGE_UNAVAILABLE,
        "This composition has no config editor, so the profile cannot be rewritten",
        { configured: false, retainPrevious: false, retryable: false }
      );
    }

    await refreshCatalog(undefined, true);
    // **Whether THIS attempt read the registry**, not whether one ever did.
    // `refreshCatalog` never rejects, and `isCatalogFresh()` answers "has this
    // process refreshed at all?" — true for hours after a failure. Reporting
    // that as `catalogRead` told the card "nothing is deprecated" for a read
    // that never happened.
    const catalogRead = didCatalogRefreshSucceed();

    const entries = editor.entries().filter((entry) => {
      const config = isRecord(entry) ? entry.options : undefined;
      const options = isRecord(config) ? config : undefined;
      const raw = isRecord(options?.config) ? options.config : undefined;
      const providers = isRecord(raw?.providers) ? raw.providers : undefined;
      return (
        providers !== undefined &&
        PLANES.some(({ route }) => isRecord(providers[route]))
      );
    });
    if (entries.length === 0) {
      throw new RemoteError(
        PURGE_UNAVAILABLE,
        "No profile entry declares an opencode provider, so there is nothing to purge",
        { configured: false, retainPrevious: false, retryable: false }
      );
    }

    const removed: PurgedModel[] = [];
    for (const entry of entries) {
      // Collected per entry, then appended. NOT a fix for anything: an `edit`
      // that throws propagates out of `purge()` before the return, so the report
      // can never describe a rejected edit either way (checked, so this comment
      // does not claim a failure mode that cannot occur). It is simply the
      // narrower scope — each entry's removals stay attributable to that entry,
      // which is what a partial-failure path would need if one is ever added.
      const entryRemoved: PurgedModel[] = [];
      await editor.edit(entry, (current) => {
        const providers = isRecord(current.providers)
          ? { ...current.providers }
          : {};
        for (const { route, plane } of PLANES) {
          const declared = modelsOf(providers[route]);
          if (declared === undefined) {
            continue;
          }
          const kept = declared.filter((model) => {
            const id = idOf(model);
            if (id === undefined || !isDeprecatedModelOn(plane, id)) {
              return true;
            }
            entryRemoved.push({ provider: route, id });
            return false;
          });
          if (kept.length !== declared.length) {
            providers[route] = {
              ...(providers[route] as object),
              models: kept,
            };
          }
        }
        return { ...current, providers };
      });
      removed.push(...entryRemoved);
    }

    return { removed, catalogRead };
  }
}

/**
 * Prototype key `remoteMethods()` reads Remote markers from — the same constant
 * `usage.ts` uses, spelled here rather than imported because the protocol
 * package does not re-export it.
 */
const REMOTE_METHOD_DESCRIPTOR_KEY =
  "@deepseek-ai/dsh-typert-protocol/remote-methods";

/**
 * Declare `purge` as a Remote method. See `usage.ts` for why the decorator
 * cannot be used in this build.
 */
Object.defineProperty(
  ModelPurgeService.prototype,
  REMOTE_METHOD_DESCRIPTOR_KEY,
  {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze([
        { method: "purge", invocation: { kind: "direct" } },
      ]),
    }),
  }
);
