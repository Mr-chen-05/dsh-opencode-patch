/**
 * Serve the gateway's non-default APIs from the plugin, so a model the user
 * already picked simply works.
 *
 * The problem this solves: OpenCode Zen is one route whose models do not all
 * speak one wire format. models.dev names a per-model SDK for exactly those that
 * differ — 30 bundled Zen models name `@ai-sdk/openai` (Responses API) and 17
 * name `@ai-sdk/anthropic` (Messages API), against a route declared as
 * `openai-completions`. DSH cannot express "this model speaks a different
 * format": `llm-pi-ai` carries one `api` per ROUTE, and `llm.registerAdapter`
 * refuses a route that already has an adapter. So the format has to live on a
 * route, and the model has to be dispatched to the route whose `api` names it.
 *
 * ## Why this mounts the host's own plugin instead of building an adapter
 *
 * `llm-pi-ai` is a plugin, not a library. Its package root exports the plugin
 * contract (`apply`/`inject`/`name`) plus what a configuration surface needs;
 * the pieces that turn a raw profile into a serviceable route are internal, and
 * its published `exports` map advertises `"./src/*"` while `files` ships only
 * `lib/` — so that path is dead in every installed copy. `apply` is the
 * supported entry and resolves all of it itself, which is why nothing here
 * reimplements a protocol or copies the host's resolver.
 *
 * ## The four collisions a second instance causes, and how each is handled
 *
 * | collision | why | handled by |
 * | --- | --- | --- |
 * | `DUPLICATE_FLOW` | `apply` registers one authorization flow per installed catalog provider | `isolate('authorization')`, so the `inject` never fires |
 * | `DUPLICATE_DIRECTORY` | `apply` declares the WHOLE catalog, not just the routes being added | the facade answers `registerConfigurableProviders` locally |
 * | `DUPLICATE_DISCOVERY` | discovery is keyed by settings namespace, and a nested entry inherits its parent's id | the facade answers `registerModelDiscovery` locally |
 * | `providers.get expected object` | the registry keys its runtime by `apply` identity, so the FIRST instance's schema validates the second mount | the mount is handed RAW config, never a pre-validated `Config` |
 *
 * The facade is a local view for the mounted instance only. It forwards
 * `registerAdapter` to the real service — so the child fiber still owns and
 * releases the registration — and suppresses the two publishing calls.
 *
 * @module dsh-opencode-patch/responses-provider
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { DEFAULT_USAGE_KEY_ENV, type ResolvedPluginConfig } from "./config.ts";
import type { CordisContext } from "./cordis-context.ts";
import { registerGoogleBridge } from "./google-bridge.ts";
import { isFunctionLike, isRecord } from "./guards.ts";
import {
  createLoginCredentialReader,
  type LoginCredentialReader,
} from "./login-credential.ts";
import {
  type CatalogModelSpec,
  getLiveGoCatalog,
  getLiveZenCatalog,
} from "./models-catalog.ts";
import { setOrg } from "./org-cache.ts";
import { baseForProtocol } from "./pi-provider.ts";
import {
  GOOGLE_INTERNAL_ROUTE,
  GOOGLE_SDK,
  PROTOCOL_FOR_SDK,
  ROUTE_FOR_PLANE_PROTOCOL,
  SELF_MOUNTED_ROUTES,
} from "./responses-routes.ts";

/** The host plugin whose `apply` this module mounts. */
const PI_AI_PACKAGE = "@deepseek-ai/dsh-llm-pi-ai";

/** The route whose profile the internal routes inherit their credential from. */
const SOURCE_ROUTE = "opencode";

/** Services hidden from the mounted instance; see the module header. */
const HIDDEN_SERVICES: readonly string[] = ["authorization", "settings"];

/** The credential the README tells a user to store. */
const DEFAULT_CREDENTIAL_REF = "OPENCODE_API_KEY";

/** The gateway's endpoint. */

/**
 * The sentinel that makes the stored credential resolvable at all: pi-ai's
 * `getClientApiKey` throws when a route names neither a key nor an
 * `authorization` header, before `fetch` — so the key the user already stored
 * never gets a chance to be resolved without it. The fetch patch swaps it for
 * the real one.
 */
const KEY_SENTINEL = "Bearer unused";

/** One model entry, in the shape `llm-pi-ai`'s config schema expects. */
interface ModelProfile {
  contextWindow: number;
  id: string;
  input: string[];
  maxTokens: number;
  name: string;
  reasoningEfforts?: Record<string, string | null> | false;
}

const ALL_THINKING_LEVELS: ReadonlySet<string> = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/**
 * Derive the `reasoningEfforts` dictionary that `dsh-llm-pi-ai` expects in
 * a model profile, from the model's catalog specification.
 *
 * `dsh-llm-pi-ai` in `resolveModelReasoning` checks `entry.reasoningEfforts`.
 * Without it, it falls back to pi's installed catalog entry — which has no
 * knowledge of OpenCode models, setting `reasoning: false` and leaving the
 * model with no thinking levels in the DSH composer.
 */
export const reasoningEffortsFor = (
  spec: CatalogModelSpec
): Record<string, string | null> | undefined => {
  if (spec.reasoning !== true) {
    return undefined;
  }
  const options = spec.reasoning_options ?? [];
  const effortOption = options.find(
    (option) => option.type === "effort" && (option.values?.length ?? 0) > 0
  );
  if (effortOption?.values !== undefined) {
    const efforts: Record<string, string | null> = { off: null };
    for (const v of effortOption.values) {
      if (v === "none" || v === "off") {
        efforts.off = null;
      } else if (ALL_THINKING_LEVELS.has(v)) {
        efforts[v] = v;
      }
    }
    const hasActive = Object.keys(efforts).some((k) => k !== "off");
    if (hasActive) {
      return efforts;
    }
  }
  if (options.some((option) => option.type === "toggle")) {
    return {
      off: null,
      low: "low",
      medium: "medium",
      high: "high",
    };
  }
  // Model declares reasoning: true without explicit reasoning_options (e.g. minimax-m2.5, minimax-m2.7, minimax-m3 on Zen)
  return {
    off: null,
    low: "low",
    medium: "medium",
    high: "high",
  };
};

/**
 * Read a value that may be an array or any iterable as an array.
 *
 * The loader's `entries()` is a generator, so it is not an array; a mock or a
 * future version may hand over either.
 *
 * @param value - the candidate.
 * @returns the items, or `[]` when the value is not iterable.
 */
const toArray = (value: unknown): unknown[] => {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === null || typeof value !== "object") {
    return [];
  }
  const iterator: unknown = Reflect.get(value, Symbol.iterator);
  if (typeof iterator !== "function") {
    return [];
  }
  const items: unknown[] = [];
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the Symbol.iterator check above is the runtime proof
  for (const item of value as Iterable<unknown>) {
    items.push(item);
  }
  return items;
};

/**
 * The loader service, off the context or through the service registry.
 *
 * `ctx.loader` is the accessor cordis installs for the service; `ctx.get` is the
 * untyped escape hatch, kept because a context that exposes only the latter is
 * still a context this plugin can work in.
 *
 * @param ctx - the host context.
 * @returns the loader, or `undefined` when the host serves none.
 */
const loaderOf = (ctx: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(ctx)) {
    return undefined;
  }
  const direct: unknown = ctx.loader;
  if (isRecord(direct) && isFunctionLike(direct.entries)) {
    return direct;
  }
  if (!isFunctionLike(ctx.get)) {
    return undefined;
  }
  let viaGet: unknown;
  try {
    viaGet = Reflect.apply(ctx.get, ctx, ["loader"]);
  } catch {
    return undefined;
  }
  return isRecord(viaGet) && isFunctionLike(viaGet.entries)
    ? viaGet
    : undefined;
};

/** Every entry the host's loader holds, or `[]` when there is no loader. */
const loaderEntries = (ctx: unknown): unknown[] => {
  const loader = loaderOf(ctx);
  if (loader === undefined) {
    return [];
  }
  const { entries } = loader;
  if (typeof entries !== "function") {
    return [];
  }
  try {
    return toArray(Reflect.apply(entries, loader, []));
  } catch {
    return [];
  }
};

/**
 * The plugin behind a loader entry that never kept the import result.
 *
 * One loader generation stores the raw module on the entry (`moduleNamespace`);
 * the other hands the import result straight to the registry and keeps only the
 * fiber, so the two pieces needed to mount it again are read off that fiber:
 * the registry's resolved callback on the fiber's runtime, and the
 * registry-normalized `inject`. `Inject.resolve` maps an already-normalized
 * `{ service: null }` onto itself, so the synthesized record mounts exactly as
 * the module namespace would.
 *
 * The `inject` is required, not cosmetic: it is what lets the plugin's first
 * `ctx.<service>` property access resolve at all, so an entry whose fiber
 * carries none is reported as unusable rather than mounted into a crash.
 *
 * @param entry - the loader entry whose `options.name` matched the package.
 * @returns the mountable record, or `undefined` when the fiber carries none.
 */
const pluginFromFiber = (
  entry: Record<string, unknown>
): Record<string, unknown> | undefined => {
  const { fiber } = entry;
  if (!isRecord(fiber)) {
    return undefined;
  }
  const { runtime } = fiber;
  if (!isRecord(runtime) || !isFunctionLike(runtime.callback)) {
    return undefined;
  }
  if (!isRecord(fiber.inject)) {
    return undefined;
  }
  return { apply: runtime.callback, inject: fiber.inject };
};

/**
 * The loader entry the composition loaded the host plugin under.
 *
 * @param ctx - host context carrying the loader.
 * @returns the entry, or `undefined` when no entry names the package.
 */
const piAiEntry = (ctx: unknown): Record<string, unknown> | undefined => {
  const entry = loaderEntries(ctx).find(
    (candidate) =>
      isRecord(candidate) &&
      isRecord(candidate.options) &&
      candidate.options.name === PI_AI_PACKAGE
  );
  return isRecord(entry) ? entry : undefined;
};

/**
 * The host's already-loaded `llm-pi-ai`, asked of the loader rather than guessed
 * from the filesystem.
 *
 * The loader imported the plugin in the first place, so its entry carries — or
 * carried — the raw import result. That is the only way to reach the plugin
 * which does not encode a package-manager layout — this repository deliberately
 * does not depend on `llm-pi-ai`, because doing so drags in roughly a thousand
 * lockfile lines and makes pnpm refuse the install over ignored build scripts.
 *
 * Two loader generations answer differently and both are in the wild, so both
 * shapes are read here: one keeps the raw module on the entry, and one keeps
 * only the fiber ({@link pluginFromFiber} reconstructs that). `unwrapExports`
 * is the loader's own normalization, so a default-export or CJS-interop shape
 * needs no second guess.
 *
 * @param ctx - host context carrying the loader.
 * @returns the plugin, or `undefined` when no entry carries a usable one.
 */
export const loadPiAi = (ctx: unknown): Record<string, unknown> | undefined => {
  const loader = loaderOf(ctx);
  const entry = piAiEntry(ctx);
  if (entry === undefined) {
    return undefined;
  }
  if (entry.moduleNamespace !== undefined) {
    const unwrapped =
      loader !== undefined && isFunctionLike(loader.unwrapExports)
        ? Reflect.apply(loader.unwrapExports, loader, [entry.moduleNamespace])
        : entry.moduleNamespace;
    return isRecord(unwrapped) && isFunctionLike(unwrapped.apply)
      ? unwrapped
      : undefined;
  }
  return pluginFromFiber(entry);
};

/**
 * The raw module namespace, for the one thing a fiber cannot carry.
 *
 * The Google bridge constructs the wrapper's own `PiAiAdapter`, and the class
 * lives on the module namespace — which one loader generation keeps on its
 * entry and the other drops entirely ({@link pluginFromFiber} reads the rest
 * off the fiber). The registry's runtime record does not keep it either: it
 * holds `{ name, callback, fibers, Config }` and nothing else.
 *
 * The module is still reachable, because it is the SAME module: the loader
 * resolved the entry's own name against the context's base URL, so resolving
 * that name from the same base reaches the same file, and Node's module cache
 * hands back the namespace the loader already executed. Nothing is imported
 * twice and nothing is guessed from a package-manager layout.
 *
 * @param ctx - host context carrying the loader and its base URL.
 * @returns the namespace, or `undefined` when no entry names the package or
 *   the module cannot be resolved from the base URL.
 */
export const loadPiAiModule = async (
  ctx: unknown
): Promise<Record<string, unknown> | undefined> => {
  if (piAiEntry(ctx) === undefined) {
    return undefined;
  }
  const base = isRecord(ctx) ? ctx.baseUrl : undefined;
  if (typeof base !== "string" || base.length === 0) {
    return undefined;
  }
  try {
    // The base URL is the directory the loader resolves bare specifiers
    // against, so the sibling file only anchors `createRequire` to that
    // directory; it is never read.
    const resolve = createRequire(new URL("noop.js", base));
    const namespace: unknown = await import(
      pathToFileURL(resolve.resolve(PI_AI_PACKAGE)).href
    );
    return isRecord(namespace) ? namespace : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The host record the GOOGLE BRIDGE needs: one carrying `PiAiAdapter`.
 *
 * {@link loadPiAi} answers the MOUNT's question — a callback and an inject —
 * and on the fiber-only loader generation that record carries no classes. The
 * bridge builds its adapter from the module's own class, so when the entry
 * kept no namespace the module is asked directly ({@link loadPiAiModule});
 * when even that fails the mount's record is handed back, and the bridge
 * stands down rather than inventing an adapter.
 *
 * @param ctx - host context carrying the loader.
 * @returns the best available host record, or `undefined` when there is none.
 */
export const loadPiAiAdapterHost = async (
  ctx: unknown
): Promise<Record<string, unknown> | undefined> => {
  const host = loadPiAi(ctx);
  if (isRecord(host) && isFunctionLike(host.PiAiAdapter)) {
    return host;
  }
  return (await loadPiAiModule(ctx)) ?? host;
};

/**
 * The credential reference the composition already resolves for `opencode`.
 *
 * A deployment that named its own environment variable must not be asked to
 * state it again here: pi-ai resolves the reference through the credentials
 * service, so the same reference is the same stored record, and a different one
 * would be a route that authenticates as nobody.
 *
 * @param ctx - host context carrying the loader.
 * @returns the declared reference, or the documented default.
 */
export const inheritedCredentialRef = (ctx: unknown): string => {
  for (const entry of loaderEntries(ctx)) {
    if (!isRecord(entry) || !isRecord(entry.options)) {
      continue;
    }
    // `options` is already known to be a record: the guard above rejected
    // everything else. The repeat was unreachable, and a branch no input can
    // take is a branch no test can cover.
    const { options } = entry;
    const { config } = options;
    if (!isRecord(config) || !isRecord(config.providers)) {
      continue;
    }
    const source = config.providers[SOURCE_ROUTE];
    if (!isRecord(source)) {
      continue;
    }
    const ref = source.apiKeyEnv;
    if (typeof ref === "string" && ref.length > 0) {
      return ref;
    }
  }
  return DEFAULT_CREDENTIAL_REF;
};

/**
 * Every model the gateway serves on the API one SDK names.
 *
 * The default catalog unions BOTH planes, which is the right answer to "what
 * does this gateway serve". It is the wrong answer for the routes this module
 * mounts: they carry Zen's `baseURL`, and the Go plane names models the Zen
 * endpoint does not serve, so offering one resolves to "model not found" against
 * the route's own endpoint. The mount therefore passes {@link getLiveZenCatalog}
 * explicitly.
 *
 * @param sdk - the models.dev `provider.npm` value the route serves.
 * @param catalog - the catalog to read; both planes by default.
 * @returns one profile per model, deduplicated.
 */
export const modelsForSdk = (
  sdk: string,
  catalog: readonly CatalogModelSpec[] = [
    ...getLiveZenCatalog(),
    ...getLiveGoCatalog(),
  ]
): ModelProfile[] => {
  const seen = new Set<string>();
  const profiles: ModelProfile[] = [];
  for (const spec of catalog) {
    if (spec.provider_npm !== sdk || seen.has(spec.id)) {
      continue;
    }
    seen.add(spec.id);
    const reasoningEfforts = reasoningEffortsFor(spec);
    profiles.push({
      contextWindow: spec.context_window,
      id: spec.id,
      input: [...spec.input_modalities],
      maxTokens: spec.max_output_tokens,
      name: spec.name,
      ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
    });
  }
  return profiles;
};

/**
 * The provider profile for one route, in the shape the config schema takes.
 *
 * The mounted plugin resolves it — defaults, serviceable models and all —
 * exactly as it would a profile the user wrote.
 *
 * @param protocol - the pi-ai protocol the route's `api` names.
 * @param models - the models to serve.
 * @param apiKeyEnv - the credential reference the composition already uses.
 * @returns the profile, keyed by nothing yet (the caller keys it).
 */
const providerProfile = (
  protocol: string,
  models: readonly ModelProfile[],
  apiKeyEnv: string,
  baseURL: string
) => ({
  api: protocol,
  apiKeyEnv,
  baseURL,
  headers: { authorization: KEY_SENTINEL },
  models: [...models],
});

/** Every SDK that names one protocol — a protocol may be named by more than one. */
const sdksForProtocol = (protocol: string): string[] =>
  Object.keys(PROTOCOL_FOR_SDK).filter(
    (sdk) => PROTOCOL_FOR_SDK[sdk] === protocol
  );

/**
 * The catalog and credential of one plane.
 *
 * A route carries ONE plane: its base URL, its catalog and its credential all
 * come from the same account. Mixing them resolves to "model not found" against
 * the route's own endpoint, which is why the mount reads all three here rather
 * than from a module constant.
 */
const planeSource = (plane: string, ctx: unknown) =>
  plane === "opencode-go"
    ? { apiKeyEnv: DEFAULT_USAGE_KEY_ENV, catalog: getLiveGoCatalog() }
    : { apiKeyEnv: inheritedCredentialRef(ctx), catalog: getLiveZenCatalog() };

/**
 * The route names the registry actually holds, read from its raw map.
 *
 * The map, not `listProviders()`: that method is Remote-decorated, and the
 * decorated view under-reports — measured, the map held `opencode-responses`
 * while `listProviders()` did not list it, which is what let a mount try to
 * register it a second time. A host that stops exposing the map falls back to
 * the decorated list, which is still better than assuming nothing is declared.
 *
 * @param llm - the `llm` service.
 * @returns the route names, or `undefined` when no raw map is readable.
 */
const adapterRoutes = (llm: unknown): Set<string> | undefined => {
  if (!isRecord(llm)) {
    return undefined;
  }
  const raw: unknown = llm.adapters;
  return raw instanceof Map ? new Set([...raw.keys()].map(String)) : undefined;
};

/** The routes the host already serves, so a declared one is never overridden. */
const declaredRoutes = (llm: CordisContext["llm"]): Set<string> => {
  const fromMap = adapterRoutes(llm);
  if (fromMap !== undefined) {
    return fromMap;
  }
  const listed = llm?.listProviders?.();
  return new Set(
    Array.isArray(listed)
      ? listed.flatMap((route) =>
          isRecord(route) && typeof route.id === "string" ? [route.id] : []
        )
      : []
  );
};

/** Withdraw one registration, whichever handle shape the registry returned. */
const releaseRegistration = (handle: unknown): void => {
  try {
    if (typeof handle === "function") {
      Reflect.apply(handle, undefined, []);
      return;
    }
    if (isRecord(handle) && typeof handle.dispose === "function") {
      Reflect.apply(handle.dispose, handle, []);
    }
  } catch {
    // A registration that cannot be withdrawn must not stop the unwind.
  }
};

/**
 * A handle-shaped no-op, for a forwarded registration reduced to nothing.
 *
 * The mounted wrapper stores whatever `registerAdapter` returns and may call
 * `replace` on it later, so the shape has to match a real handle; withdrawal
 * stays with the real handle's own disposer.
 */
const NOOP_HANDLE: (() => void) & { replace: () => void } = Object.assign(
  () => {
    // Nothing was registered, so there is nothing to withdraw.
  },
  {
    replace: (): void => {
      // Nothing was registered, so there is nothing to replace.
    },
  }
);

/**
 * A view of the real `llm` service for the mounted instance.
 *
 * `registerAdapter` is forwarded — bound to the real service, so the child fiber
 * owns what it registers — and every handle it returns is captured, which is
 * what lets {@link registerResponsesProvider}'s disposer withdraw the routes
 * deterministically rather than relying on the fiber's own unwind.
 *
 * The forward re-checks the routes against the raw adapter map first. The
 * registry's registration is all-or-nothing — one already-registered route
 * makes it throw before any of the others land — so a route something else
 * serves is dropped here and the rest of the mount survives. That map is the
 * same authority {@link declaredRoutes} reads, so the two views agree.
 *
 * The two publishing calls are answered locally, which is what keeps a second
 * instance from colliding with the host's own directory and discovery
 * registrations. Every other member passes through with the correct receiver.
 *
 * @param real - the real `llm` service.
 * @param captured - collects the handles `registerAdapter` returns.
 * @returns the facade, or `real` when it is not an object.
 */
const llmFacade = (real: unknown, captured: unknown[]): unknown => {
  if (typeof real !== "object" || real === null) {
    return real;
  }
  return new Proxy(real, {
    get: (source, prop) => {
      if (prop === "registerAdapter") {
        const register: unknown = Reflect.get(source, prop, source);
        if (typeof register !== "function") {
          return register;
        }
        return (routes: readonly string[], adapter: unknown) => {
          // Registration is all-or-nothing: one route that is already taken
          // would kill every route travelling with it. The taken ones are
          // dropped up front; a list that empties that way is "nothing new",
          // not a withdrawal.
          const listed = adapterRoutes(source) ?? new Set<string>();
          const owned = routes.filter((route) => !listed.has(route));
          if (owned.length === 0) {
            return NOOP_HANDLE;
          }
          const handle: unknown = Reflect.apply(register, source, [
            owned,
            adapter,
          ]);
          captured.push(handle);
          return handle;
        };
      }
      if (prop === "registerConfigurableProviders") {
        return () => ({
          dispose: () => {
            // Nothing was published, so there is nothing to withdraw.
          },
          replace: () => {
            // Nothing was published, so there is nothing to replace.
          },
        });
      }
      if (prop === "registerModelDiscovery") {
        return () => {
          // Nothing was published, so there is nothing to withdraw.
        };
      }
      const value: unknown = Reflect.get(source, prop, source);
      if (typeof value !== "function") {
        return value;
      }
      const bound = (...args: unknown[]): unknown =>
        Reflect.apply(value, source, args);
      return bound;
    },
  });
};

/**
 * The real `llm` service, read through the holder's own `get`.
 *
 * Read off `this` rather than captured, because the shadow is installed on a
 * parent scope and every context below it resolves the service through its own
 * isolation chain — a captured reference would pin the mount to whichever scope
 * happened to build the facade.
 *
 * @param holder - the context the getter was reached through.
 * @returns the service, or `undefined` when the holder cannot resolve it.
 */
const readLlmService = (holder: unknown): unknown => {
  if (!isRecord(holder)) {
    return undefined;
  }
  const { get } = holder;
  if (typeof get !== "function") {
    return undefined;
  }
  try {
    return Reflect.apply(get, holder, ["llm"]);
  } catch {
    return undefined;
  }
};

/**
 * The scope the host plugin is mounted in, or `undefined` when unsupported.
 *
 * Both isolated services are load-bearing. `authorization` is what keeps the
 * flows from colliding; `settings` is what keeps the mounted instance from
 * writing a settings section nobody asked for, which is the seam a check of
 * `authorization` alone would miss.
 *
 * @param ctx - the host context.
 * @param captured - collects the handles `registerAdapter` returns.
 * @returns the scope to mount into.
 */
const mountScope = (
  ctx: CordisContext,
  captured: unknown[]
): CordisContext | undefined => {
  let scope: CordisContext | undefined = ctx;
  for (const service of HIDDEN_SERVICES) {
    if (scope === undefined || typeof scope.isolate !== "function") {
      return undefined;
    }
    scope = scope.isolate(service);
  }
  if (scope === undefined || typeof scope.extend !== "function") {
    return undefined;
  }
  const shadow = {
    get llm(): unknown {
      return llmFacade(readLlmService(this), captured);
    },
  };
  return scope.extend(shadow);
};

/**
 * Mount the host's `llm-pi-ai` once, for every internal route this plugin owns.
 *
 * One mount, not one per route: `apply` declares the whole catalog on every
 * call, so a per-route mount is a collision no matter how few routes it carries.
 *
 * Never throws. A deployment where the host plugin is not loaded, or that
 * already declares these routes, keeps its previous behaviour — reported at
 * `info`, because both are expected states rather than faults.
 *
 * @param ctx - host context carrying the loader, the LLM registry and the
 *   services the mounted plugin needs.
 * @returns the disposer withdrawing the mount, or `undefined` when nothing was
 *   mounted.
 */
export const registerResponsesProvider = async (
  ctx: CordisContext,
  config?: ResolvedPluginConfig,
  loginCredential?: LoginCredentialReader
): Promise<(() => void) | undefined> => {
  const { llm } = ctx;
  if (llm === undefined || typeof llm.registerAdapter !== "function") {
    return undefined;
  }
  const declared = declaredRoutes(llm);
  // The bridge route first. It registers on the real service through this
  // plugin's own adapter, so it needs nothing from the wrapper's mount below:
  // a deployment that declares every protocol route in its profile still gets
  // the Gemini models, which were the one protocol a declared route could
  // never name. Its withdrawal joins the disposer this function returns, and
  // every early exit below hands it back rather than leaking it.
  const bridgeHandle = declared.has(GOOGLE_INTERNAL_ROUTE)
    ? undefined
    : registerGoogleBridge({
        apiKeyRef: inheritedCredentialRef(ctx),
        // The credential a login already stored, read the same way the org is.
        loginToken: loginTokenReader(
          ctx,
          config?.readOpencodeStore === true,
          loginCredential
        ),
        // And, last, the installation's own store - off unless the deployment
        // opted in, which is what `config` carries here.
        readOpencodeStore: config?.readOpencodeStore === true,
        // The same endpoint family the internal routes below are mounted with,
        // so a deployment cannot end up sending to two families at once.
        endpoint: config?.endpoint,
        ctx,
        host: await loadPiAiAdapterHost(ctx),
        // The bridge reads the RAW catalog, not the config-shaped profile:
        // its pi models carry this catalog's cost, so pi's own usage
        // accounting lands the right numbers without our meter's help.
        // `registerAdapter` is a prototype method of the real `llm` service —
        // handing the detached function over loses the service, and the
        // registration then reads `this.ctx` off the box it arrived in and dies
        // on the first boot that reaches this line at all. Bound to `llm`, the
        // call lands exactly where the documented `ctx.llm.registerAdapter(…)`
        // idiom puts it: on the service the plugin's context resolved.
        llm: {
          registerAdapter: llm.registerAdapter.bind(llm),
        },
        specs: planeSource("opencode", ctx).catalog.filter(
          (spec) => spec.provider_npm === GOOGLE_SDK
        ),
      });
  if (bridgeHandle !== undefined) {
    ctx.logger?.info?.(
      "[dsh-opencode-patch] bridged the Gemini models to %s (own adapter)",
      GOOGLE_INTERNAL_ROUTE
    );
  }
  const bridgeDispose =
    bridgeHandle === undefined
      ? undefined
      : () => {
          releaseRegistration(bridgeHandle);
        };
  // A deployment that already declares a route in its profile keeps it: the user
  // hand-picks the models it serves, and mounting over that would take the choice
  // away. Deferring is the point — this module exists so a deployment that
  // declares NOTHING still works, not to override one that does.
  const wanted = Object.entries(ROUTE_FOR_PLANE_PROTOCOL).flatMap(
    ([plane, entry]) =>
      Object.entries(entry.routes)
        // Self-mounted routes register through the plugin's own adapter, so
        // handing their models to the wrapper's mount would only earn its
        // protocol table's refusal.
        .filter(
          ([, route]) => !declared.has(route) && !SELF_MOUNTED_ROUTES.has(route)
        )
        .map(([protocol, route]) => ({
          plane,
          protocol,
          route,
          // Per protocol, NOT the plane's base. pi builds each protocol's
          // request differently: the OpenAI ones append `/chat/completions` or
          // `/responses` to a base that already carries `/v1`, while the
          // Anthropic one hands the base straight to the Anthropic SDK, which
          // appends `/v1/messages` itself. Mounting the Anthropic route on the
          // plane's base therefore asks for `/v1/v1/messages`, which the gateway
          // answers with 404 — measured, along with the base that works.
          // The plane's own base stays the fallback for a protocol this table
          // does not carry, so an unknown protocol degrades to today's
          // behaviour rather than to an undefined URL.
          baseURL:
            baseForProtocol(plane, protocol, config?.endpoint) ?? entry.baseURL,
        }))
  );
  if (wanted.length === 0) {
    ctx.logger?.info?.(
      "[dsh-opencode-patch] every internal route is already declared; leaving them alone"
    );
    return undefined;
  }
  const host = loadPiAi(ctx);
  if (host === undefined) {
    ctx.logger?.info?.(
      "[dsh-opencode-patch] no loaded llm-pi-ai in this composition; internal routes stay unregistered"
    );
    return undefined;
  }
  const providers: Record<string, unknown> = {};
  const mounted: string[] = [];
  for (const { plane, protocol, route, baseURL } of wanted) {
    // The base URL travels WITH the route, so there is no "unknown plane" case
    // to guard: a plane the table does not carry has no route to mount.
    const source = planeSource(plane, ctx);
    // No empty-catalog guard: each route reads its OWN plane's catalog, so a
    // route whose protocol that plane does not carry has no entry in the table
    // at all. The guard this replaces existed because every route used the Zen
    // catalog, which made every Go route empty.
    const models = sdksForProtocol(protocol).flatMap((sdk) =>
      modelsForSdk(sdk, source.catalog)
    );
    providers[route] = providerProfile(
      protocol,
      models,
      source.apiKeyEnv,
      baseURL
    );
    mounted.push(
      `${route} (${plane} · ${protocol}) with ${models.length} model(s)`
    );
  }
  if (mounted.length === 0) {
    ctx.logger?.info?.(
      "[dsh-opencode-patch] no model needs an internal route; nothing to mount"
    );
    return bridgeDispose;
  }
  const captured: unknown[] = [];
  const scope = mountScope(ctx, captured);
  if (scope === undefined || typeof scope.plugin !== "function") {
    ctx.logger?.info?.(
      "[dsh-opencode-patch] this host exposes no isolate/plugin scope; internal routes stay unregistered"
    );
    return bridgeDispose;
  }
  try {
    const fiber = scope.plugin(host, { providers });
    // Cordis's `Fiber` is not thenable; `await()` is what waits for the
    // lifecycle work and rethrows a startup error. A stand-in may hand over a
    // promise instead, so both shapes are settled here.
    const settle = fiber?.await;
    await Promise.resolve(
      typeof settle === "function" ? fiber?.await?.() : fiber
    );
    if (captured.length === 0) {
      ctx.logger?.info?.(
        "[dsh-opencode-patch] the mount registered no route; internal routes stay unregistered"
      );
      return bridgeDispose;
    }
    ctx.logger?.info?.("[dsh-opencode-patch] mounted %s", mounted.join("; "));

    return () => {
      bridgeDispose?.();
      for (const handle of captured) {
        releaseRegistration(handle);
      }
      captured.length = 0;
      void (async () => {
        try {
          await fiber?.dispose?.();
        } catch {
          // A disposal failure must not mask the plugin's own teardown.
        }
      })();
    };
  } catch (error) {
    ctx.logger?.info?.(
      "[dsh-opencode-patch] internal routes stay unregistered (%s); routes declared in the profile are unaffected",
      error instanceof Error ? error.message : String(error)
    );
    return bridgeDispose;
  }
};

/**
 * The bridge's token-only view of the shared login credential reader.
 *
 * @param ctx - the host context.
 * @param readOpencodeStore - the user's opt-in to the installation's account.
 * @param read - optionally the lifecycle's shared reader, including its sessions.
 * @returns a reader the bridge calls when a route named no reference.
 */
export const loginTokenReader =
  (
    ctx: unknown,
    readOpencodeStore = false,
    read: LoginCredentialReader = createLoginCredentialReader(
      ctx,
      readOpencodeStore
    )
  ): ((plane: string) => Promise<string | undefined>) =>
  async (plane) => {
    const credential = await read(plane);
    // Clear an old org too: it must never survive a change of credential owner.
    setOrg(plane, credential?.orgId);
    return credential?.accessToken;
  };
