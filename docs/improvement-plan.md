# Improvement plan

## Context

The result of an architecture audit of the tree at 1.4.1, and the order in which to act on it. It rests on:

- six audits: routing, catalog, credentials, config/UI, tests/CI/docs, and the stream path;
- an adversarial review of the plan itself;
- the host's own source and data (`deepseek-ai/deepseek-harness`, and the pi 1.1.0 catalog it pins). File references into the host are relative to that repository's `packages/`.

**Outcome:** a plugin that only uses host extension points the host supports; one source of truth per decision; a suite that pins behaviour before it moves; and the owner's product rules below.

**Each phase is one pull request**, and it updates this document: its row below moves to "merged", and its section is trimmed to what is left. A finding that does not survive its phase's first failing test is struck from here rather than forced.

## Status

| Phase | Title | State |
| :-- | :-- | :-- |
| P0 | suite hardening, 11 defect fixes, this plan | in review |
| P1a | `fix:` shipped breakage | planned |
| P1b | `chore:` hygiene | planned |
| P2 | `feat!:` the 2.0.0 major | planned |
| P-T1 | `test:` a harness that is the real host | planned |
| P-R1 | `refactor:` the plugin owns the plane routes | planned |
| P-R2 | `fix:` the endpoint family, measured | planned |
| P3 | `feat:` Settings complements pi's list | planned |
| P4 | `feat:` follow the user's configuration; on/off for gap models | planned |
| P-T2 | `test:` suite structure | planned |
| P-T3 | `ci:` CI and scripts | planned |
| P5 | `refactor:` installers | planned |
| P6 | `refactor:` one credential resolver | planned |
| P7 | `refactor:` one source per table | planned |
| P8 | `refactor:` settings table | planned |
| P9 | `refactor:` remote seam | planned |
| P10a | `refactor:` pure module moves | planned |
| P10b | `fix:` catalog state | planned |
| P11 | `refactor:` UI on the primitives | planned |
| P12 | `ci:` lint warnings gating | planned |

## Owner decisions

| # | Decision |
| :-- | :-- |
| D1 | A model whose reasoning is only on/off is offered as **Off / On**. Old saved Minimal/Xhigh/Max selections on such models **break, and the break is documented**. |
| D2 | **Delete `internalRoutes`** |
| D3 | **Composer = declared models only. Settings = the whole catalog to pick from.** |
| D4 | Delete `resolveRoutedKey`. It was exported in dde9d6e and nothing in `src/` has ever called it. |
| D5 | **Serve every mode on the user's own route ids, with no hidden routes.** `opencode` and `opencode-go` are the plugin's own registered provider (D13), serving every protocol per model (see "Routing"). |
| D6 | Shrink the public API in a major release (2.0.0) |
| D7 | Merge P0 first, then one PR per phase, each from `main` |
| D8 | **The plugin never writes the user's profile and never overrides the user's configuration at dispatch.** It complements what pi's provider list is missing and shows that in Settings when the user configures models. After that, dispatch follows the user's configuration. |
| D9 | Retire the deprecated `@viztor/dsh-opencode` wrapper in 2.0.0, after fixing its broken re-export in P1 |
| D10 | This document is the plan of record; each phase PR updates its status row |
| D11 | **The adapter patch exists to merge provider modes into the user's provider, nothing else.** Once the plugin's provider serves every mode per model (D13), the merge is native and the patch on a host-owned adapter is deleted. |
| D12 | **No upstream changes.** Everything is done inside the current host with the APIs it has. |
| D13 | **The plugin owns the `opencode`/`opencode-go` routes.** pi-ai is kept from claiming them through the config waterfall, and the plugin registers its own provider under the same ids (F11–F13, run S0). It never deletes another plugin's registration, which the host forbids. |
| D14 | **Target pi 1.1.0, the version the harness pins.** Design, tests and measurements assume it; a newer pi is tolerated, not required. |
| D15 | **Any model id saved on `opencode`/`opencode-go` is accepted and served**, including ids neither pi nor the live catalog knows. The plugin infers what it can, and the user's row decides the rest. |

## What the host supports (read from source)

- **Routes.**
  - `registerAdapter` is all-or-nothing against a `private adapters` map (`llm/src/index.ts:399-460`). Only a registration's owner moves its routes, through `handle.replace`.
  - `adapter-replacement.ts` deletes another plugin's entry, which is unsupported. Delete it.
- **Dispatch.**
  - The `llm/stream` waterfall allows a short-circuit (`index.ts:62-75`). `next()` takes no arguments, and loop requests are frozen.
  - Today's redirect, `llm.stream({ ...options, provider: hiddenRoute })` (`src/stream-hook.ts:251-266`), is supported but needs a registered hidden route. A route the plugin owns (F6, D13) keeps `adapterStream`'s validation, projection, replay filtering and failure normalization (`index.ts:1064-1150`) **without** one, so the redirect goes in P-R1.
- **Effort validation goes through the ADAPTER, not the public `resolveModelInfo`.**
  - The paths are `resolveCallConfig` → `resolveModelInfoFor` → `adapter.resolveModel`, `adapter.prepareCall`, and pi's private `modelOf` (`index.ts:769,894-905,964,1076`; `llm-pi-ai/src/adapter.ts:369-375`).
  - Today the adapter patch merges modes only for Go→Gemini, and through a hidden route (`models-discovery.ts:735-760`). Its catalog fill of context and levels for same-mode models (`:790-1010`) is not merging; under D8 the user's row, or pi's data where the user set nothing, answers both picker and dispatch.
- **Hiding.**
  - There is no visibility flag (`LlmProviderInfo = {id, name}`).
  - `listProviders()` is read by:
    - the composer (`session-controller/src/catalog.ts:24`) and `modelAvailable` (`:81`);
    - the Settings directory (`ui-settings-models/src/client/store.ts:233`);
    - the subagent tool (`tool-subagent/src/list-models.ts:20,50`);
    - ACP (`acp/acp/src/model-control.ts:158`);
    - the SDK server (`sdk/server/src/server.ts:423`);
    - the translator (`experimental/translator/src/deepseek.ts:69`).
  - With no hidden routes (P-R1), **no listing patch is needed**; today's exists only to hide them from these readers. (Instance patches do reach Remote calls, because the gateway resolves methods with `Reflect.get` at call time — `api/gateway/src/index.ts:841-843` — which the `discoverModels` wrapper relies on.)
- **Settings discovery is keyed by the pi-ai entry id** (`llm-pi-ai/src/index.ts:138,156`; `ProviderEditor.tsx:254`; `ModelListEditor.tsx:167,244`). The plugin's own `registerModelDiscovery` namespaces are never asked.
  - The host's normalization runs inside the original `discoverModels` (`index.ts:618-631`), so the wrapper must dedupe and whitelist the fields itself.
  - `LlmDiscoveredModel` carries only id, name, contextWindow, maxTokens and inputModalities, with no reasoning field.
- **D1 representation.** Effort ids must be pi levels (`adapter.ts:170-181`), and two vocabularies mean opposite things by `null`:
  - pi `thinkingLevelMap`: `{ minimal: null, low: null, medium: null, high: "high" }`, with **no `off` key**. `off: null` hides Off and suppresses the explicit disable (`openai-completions.js:674,690,712`; `anthropic-messages.js:917`).
  - profile `reasoningEfforts` dict: `{ off: null, high: "high" }`. Here null means "offered, send nothing" (`llm-pi-ai/src/catalog.ts:705-712`).
  - Picker: `{ efforts: [{ id: "off", name: "Off" }, { id: "high", name: "On" }] }`.
  - Offer Off only where the protocol can disable reasoning (`adapter.ts:184-196`).
  - Verify that `"high"` is what each protocol sends for "on" before relying on it. Today `"on"` goes out verbatim (`openai-completions.js:718`, `anthropic-messages.js:733-735`).

## Defects found in this audit, not yet fixed (all verified in code)

| Defect | Where |
| :-- | :-- |
| The deprecated wrapper re-exports a `default` that does not exist, an ESM link error. It is published every release. | `scripts/publish-scoped.ts:137`, `release.yml:124` |
| Settings shows pi's snapshot, not the catalog | `models-discovery.ts:142-198,532-539` |
| Mode merging is done only for Go→Gemini. For the other modes the picker shows catalog levels while dispatch validates against a different profile: toggle models show Minimal…Max with no Off, and Go `minimax-m3` + Xhigh/Max is refused on the internal Anthropic route. | `models-discovery.ts:607-616,735-760,1063-1203`; `pi-provider.ts:351-386`; `responses-provider.ts:111-150` |
| `isZenProvider("opencode-google")` is false | `utils/request-shape.ts:265-271` |
| `enrichModelsResponse` turns a 401/403/5xx into a 200 catalog. It must still fill the Go plane's 404. | `models-catalog.ts:800-804` |
| The warning token doesn't exist, so warnings render as caption text. The host's text token is `--dsw-alias-state-warn-label`. | `settings-card.tsx:159`, `settings-store-inspect.tsx:250` |
| The Settings spinner animates only if the meter is mounted | `settings-usage.tsx:248` → `usage-ui.ts:440` |
| The stream hook writes `debugFile` with `debug` off | `stream-hook.ts:327-340` vs `lifecycle.ts:361` |
| `settings-purge` reports `{ ok: false }` as "not a purge result" and casts instead of using the parser | `settings-purge.ts:47-55` |
| The stream hook's `prepared` handling is dead. The host never reads `options.prepared`. | `stream-hook.ts:44,200-203,258` |
| The partition test misses `debugFile` | `test/settings-page.test.tsx:1223` |
| `cordis.patch.yml`: phantom `showUsagePrice`, wrong `freeModelMarker: ''` text, incomplete field lists | `cordis.patch.yml:23,36,61` |
| `utils/retry.ts` uses `console` and global timers, against the purity gate | `utils/retry.ts:31,55` |
| `tool-fallback`: the Anthropic branch can't be reached, and the lookup is Go-first | `tool-fallback.ts:204,237-242` |
| Hard-coded catalog counts in tests, which the nightly refresh PR breaks by construction | `test/catalog.test.ts:94,200,208` |
| `.freebuff/project-id` is tracked | repo root |

## Routing: the problem, the measured facts, the design

**The problem, in the owner's words.** A provider defines one backend. Supporting every protocol and the newer catalog meant un-registering the original `opencode`/`opencode-go` provider and registering the plugin's own. Deleting another plugin's registration is unsupported, so the plugin mounted extra routes per protocol instead, merged their models back into the user's provider, and redirected dispatch. This section shows that the host **does** allow the original intent, through supported paths (F11–F13): keep pi-ai from claiming the two ids, and register the plugin's provider under them. A spike on the real host confirmed it (run S0).

**Facts from the host's own code and data.** F1–F5 and F10 are measured: the data files were counted and the resolver read. F6–F9 and F11–F13 are read from the code, and run S0 exercised F11–F13 end to end. P-T1's real-host harness pins them all, and a fact that fails there sends the design back to this section.

| # | Fact | Evidence |
| :-- | :-- | :-- |
| F1 | **One route already serves every mode, per model.** llm-pi-ai resolves `api` and `baseUrl` per model: `request.api ?? base?.api ?? routeApi` and `request.baseURL ?? base?.baseUrl ?? providerBaseUrl`, where `base` is pi's installed catalog entry. | `llm-pi-ai/src/catalog.ts:917-922` |
| F2 | **pi's installed `opencode` catalog spans four protocols, each with its own endpoint.** In pi 1.1.0, which the host pins and patches: Zen has 18 anthropic-messages (`/zen`) and 7 google, 28 completions and 30 responses (`/zen/v1`). Go has 5 anthropic (`/zen/go`) and 19 completions and 6 responses (`/zen/go/v1`), and **no google**. | `@earendil-works/pi-ai@1.1.0` `dist/providers/data/opencode*.json`; the harness's `pnpm-lock.yaml:13` |
| F3 | **A model pi's catalog does not know cannot get its own protocol.** A profile entry has no `api`/`baseURL` field (`PiAiModelProfile`); it takes the route's `api`, or `sharedCatalogApi`, which is undefined for a multi-protocol catalog. | `llm-pi-ai/src/catalog.ts:600-640,681-691,917-921` |
| F4 | **Such a model cannot be saved, listed or dispatched on a pi-ai route.** Writes are validated strictly (`assertServiceable`), so the save is rejected with "needs an api". Stored reads are deferred, so the id lands in `modelErrors`. `listModels` lists only resolved models, and `modelOf` throws `INVALID_CONFIG`. | `llm-pi-ai/src/config.ts:357-368,487`; `index.ts:171`; `adapter.ts:271-311` |
| F5 | **A route-level `api` or `baseURL` overrides every model**, collapsing the modes onto one protocol or endpoint. | `llm-pi-ai/src/catalog.ts:917,922` |
| F6 | **Dispatch reads the route's adapter.** `selectModel`, `prepareCall` and `llm.stream` all go through `registration.adapter.resolveModel`/`prepareCall`. The host requires only that the prepared model's `provider` equals the route id, and then dispatches through `adapterCall.stream`, with validation, projection, replay filtering and failure normalization intact. | `llm/src/index.ts:774-793,894-905,956-964,1064-1150` |
| F7 | **`registerAdapter` is all-or-nothing against a private map**, and only a registration's owner moves its routes (`handle.replace`). A route nobody holds is free to register. | `llm/src/index.ts:399-460` |
| F8 | **Config resolution is a public, synchronous waterfall.** Cordis runs `internal/config` listeners in order, each getting `(config, next)`; `prepend: true` puts a listener outside those registered before it. pi-ai's save check (`assertServiceable`) is one listener on it. | the harness's `vendor/cordis/src/events.ts:234-258`; `llm-pi-ai/src/index.ts:177-186` |
| F9 | **opencode's own client serves four protocols from one provider, per model.** It picks the SDK from `model.provider.npm` and the endpoint from `model.provider.api ?? provider.api`, both from the catalog. The plugin's catalog carries the same data (`catalog-data.ts` `OPENCODE_FAMILY_API`, a per-model SDK). | opencode's `packages/core/src/models-dev.ts:85-93` |
| F10 | **pi 1.1.0's `opencode-go` provider has no Google API.** Its api map is anthropic-messages, openai-completions and openai-responses only, each wrapped in `withOpenCodeSessionHeader`. pi exports each protocol separately (`api/*.lazy`: `anthropicMessagesApi`, `openAICompletionsApi`, `openAIResponsesApi`, `googleGenerativeAIApi`) plus `createProvider` (`models`), which is what `google-bridge.ts` `googleProviderFor` already composes from. | pi 1.1.0 `dist/providers/opencode-go.js`; its `package.json` `exports` |
| F11 | **pi-ai's routes are exactly the keys of its _resolved_ config.** It registers `[...profiles().keys()]`, and `profiles()` reads `config.providers.get()`, the value the fiber resolved. | `llm-pi-ai/src/index.ts:166-175,293-312` |
| F12 | **Every path to that resolved value goes through the `internal/config` waterfall, and the fiber keeps the waterfall's _return value_.** That covers the first load, `fiber.update`, the loader's volatile commit, and the config editor's validation. **The config editor writes the raw `next` to `cordis.patch.yml`, never the resolved value.** So an outermost listener that returns a copy without `providers.opencode`/`providers["opencode-go"]` keeps pi-ai from seeing or registering them, while the user's file keeps every entry. | the harness's `vendor/cordis/src/fiber.ts:641-643,736-752` and `vendor/loader/src/config/entry.ts:164-195`; `boot/config-editor/src/index.ts:101-123` |
| F13 | **The plugin can then register those ids through the public API.** With no pi-ai entry for them, `registerAdapter(["opencode", "opencode-go"], adapter)` passes the duplicate check. `PiAiAdapter` is a **public export** of `@deepseek-ai/dsh-llm-pi-ai`. pi-ai's Settings directory keeps listing both ids, because it lists every installed catalog provider regardless of profiles, with `settingsNs` = pi-ai and `settingsPath = ["providers", id]`. So Settings edits the same entries in the same file as today. | `llm/src/index.ts:399-460`; `llm-pi-ai/src/index.ts:77,128-150` |

**What the plugin has to add, and nothing else:**

- **G1:** any declared model the host's pi cannot resolve (D15): models newer than pi 1.1.0's catalog (8 Zen, 4 Go, including every Gemini model on Go, F10) **and** ids the catalog doesn't know at all;
- **G2:** the endpoint family. pi 1.1.0 stores the legacy bases; the plugin sends the per-protocol `inference` bases (or the legacy ones, per the `endpoint` setting);
- **G3:** a profile-level `api`/`baseURL` (F5) is the user's explicit choice and is honoured as such (D8), rather than silently collapsing the modes.

### The design: the plugin owns the plane routes (D13)

- **`host/route-claim.ts`.** One `internal/config` listener, `prepend: true`, active only for llm-pi-ai's fiber. It **mutates nothing**: it runs the same waterfall on a copy without the two plane providers, and returns that result.

  ```ts
  ctx.on(
    "internal/config",
    function (raw, next) {
      if (nested || !isPiAiFiber(this)) return next();
      const rest = withoutPlaneProviders(raw); // a fresh copy; undefined when none declared
      if (rest === undefined) return next();
      nested = true;
      try {
        return this.ctx.waterfall(this, "internal/config", rest, () => rest);
      } finally {
        nested = false;
      }
    },
    { prepend: true }
  );
  ```

  - pi-ai validates and serves everything else exactly as before. Its "needs an api" check never sees a plane entry, so **any model id saves** (D15), with no save gate and no error parsing.
  - The listener records the plane entries it set aside: they are the user's configuration for the plugin's provider (D8).
  - **Ordering:** pi-ai is usually active before the plugin mounts, so the plugin calls pi-ai's `fiber.restart()` (public) once, and pi-ai's config is resolved again through the listener. On dispose the listener goes with the plugin's fiber, the plugin releases its registration, and it restarts pi-ai once more, so pi-ai takes the routes back.
  - Mutating the config in place does **not** work. Cordis passes listeners a tracing proxy, so an in-place trim leaks into what the fiber keeps and into what the editor writes. A first prototype measured exactly that.

- **`host/plane-provider.ts`.** One `PiAiAdapter` (the public export), registered with `ctx.llm.registerAdapter(["opencode", "opencode-go"], adapter)`. Its profiles are rebuilt from the set-aside entries whenever they change.
  - **Its pi provider is a composite** (F10): `createProvider({ id: route, api: { every protocol: withOpenCodeSessionHeader(<protocol>Api()) }, models })`, loaded from the **host's** pi through the loader lookup `google-bridge.ts` already does.
  - **Every declared model**, known or not, comes from one pure function, `utils/plane-model.ts` `planeModelFor({ id, route, declared, piModel, spec, family })`, the way opencode's own client builds them (F9). Every field takes the first source that has it:

    | field | 1st | 2nd | 3rd | 4th |
    | :-- | :-- | :-- | :-- | :-- |
    | protocol (`api`) | the user's route-level `api` | the catalog spec's SDK | pi's built-in entry, then the id's family (`protocolFromModelId`, moved to `utils/protocols.ts`) | `openai-completions`, which both planes serve for every family |
    | `baseUrl` | the user's route-level `baseURL` | the `endpoint` family for that protocol: the per-protocol `inference` bases by default (what 1.4.1 already sends); pi 1.1.0's legacy bases when the setting says so |  |  |
    | name, context, max tokens, modalities, cost | the user's declared row | the catalog spec | pi's built-in entry | pi `Model` defaults |
    | reasoning levels | the user's `reasoningEfforts` | `utils/model-metadata.ts` `reasoningFor(spec)` (D1: toggle → Off/On) | pi's built-in entry | none |

  - An id with no catalog spec, no pi entry and no declared row still gets a model (completions, defaults), so it lists, validates and dispatches. The gateway decides whether it exists, as it would for opencode itself.
  - With no `models` list declared, the route serves the plane's whole servable catalog, as pi's catalog route does today.
  - The user's route-level `apiKeyEnv` and `headers` are honoured, and the key resolves through the plugin's credential resolver (P6).
- **Deleted:**
  - the llm-pi-ai child mount and its `llmFacade` Proxy;
  - every hidden route and its tables (`responses-routes.ts`, the hidden ids in `DEFAULT_PROVIDERS`);
  - the listing hide (`listProviders`, `listConfigurableProviders`, `listModels`);
  - the stream redirect and `isAvailable`;
  - the adapter patch on a host-owned adapter (`decoratePlaneAdapters`), because the route's adapter is now the plugin's own;
  - the Gemini bridge registration, which becomes ordinary models on the plugin's provider;
  - the Google history and replay translation, if replay stays on one provider label (verify by test);
  - `internalRoutes` (D2).
- **What remains private:** one seam, the `ResolvedPiAiProviderProfile` shape handed to the public `PiAiAdapter` (already used today, by the Gemini bridge). A contract test against the real `@deepseek-ai/dsh-llm-pi-ai` pins it, so a host upgrade that changes it fails CI rather than a user's turn.
- **What the user sees:** the same two providers in the composer and in Settings, under the same names. They now serve every protocol, every catalog model and any custom id, on the plugin's endpoints. Remove the plugin, and pi-ai serves them again from the same file.

### Measured on the real host

Runs A–D: published `@deepseek-ai/dsh` 0.2.1-rc.2 with the pi 1.4.0 it installs, offline, with an instrumented fetch. Run S0 swaps pi to **1.1.0 plus the harness's own patch** (D14). The prototypes are throwaway, and not in the repository.

| Run | Registered | Known models, 4 shapes × 2 planes | A model pi lacks | Saving a model pi lacks |
| :-- | :-- | :-- | :-- | :-- |
| A: plugin 1.4.1 as shipped | `opencode`, `opencode-go` + 6 hidden routes | served, through the hidden routes, on the plugin's per-shape endpoints | **not listed, `INVALID_CONFIG`, never sent** | **rejected** ("needs an api") |
| B: pi alone | `opencode`, `opencode-go` (pi-ai) | served, each in its own protocol, on pi's endpoints | same failure | **rejected** |
| C: pi + a delegating prototype (save gate, unregistered catalog adapter, adapter patch) | `opencode`, `opencode-go` (pi-ai) | served by pi | listed, validates, sent | accepted for catalog models; **a catalog-unknown id still rejected (run D)** |
| **S0: pi 1.1.0 + route claim + plugin provider** | `opencode`, `opencode-go` → **the plugin's adapter**; `deepseek`, `deepseek-official`, `deepseek-account` → pi-ai, unchanged; no hidden routes | all listed and validated, and each sent in its own protocol: `/inference/openai/v1/chat/completions` and `/responses`, `/inference/anthropic/v1/messages`, `/inference/google/v1beta/models/…:streamGenerateContent`, with the same paths under `/inference/go/` on Go, **Gemini on Go included** | Zen `gpt-5.3-codex-spark` → `/responses` (id family), with the user's `contextWindow` reaching `resolveModelInfo`; Go `minimax-m3.1-flash` → completions; Go `gemini-4-argon-contributor` → Google | **`not-a-real-model` accepted**: the file holds exactly the saved entry, then it is listed, validates and is sent as completions |

Two more S0 checks:

- **Handback.** With the listener removed, restarting pi-ai gives it both routes back. It then lists what pi 1.1.0 knows, and the file is untouched.
- **A Google failure code.** A 401 on a Google call surfaced as `PI_AI_ERROR` rather than `AUTH`, exactly as with pi alone (run B). That is pi's error mapping, not this design.

Left for P-R1's tests:

- the brief window at startup while pi-ai restarts (its other routes re-register with it);
- whether the gateway serves both endpoint families. That can't be measured from a sandbox that blocks `opencode.ai`, so P-R2 measures it in CI's live e2e job: a keyless request is enough, because 401 means the path exists and 404 means it doesn't.

**Fallback, only if P-T1's harness contradicts S0:** run C's shape. That means an unregistered catalog adapter per plane serving the gap models; an adapter patch on pi-ai's route adapter delegating them; and a non-mutating save gate that validates a copy without the unresolvable ids, then absorbs only pi-ai's "needs an api" refusal for those ids on those two routes.

## Target architecture

```
src/
  index.ts             apply, Config, inject, name + config types (D6)
  lifecycle.ts         apply(): installers only
  host/
    patch-method.ts    patch a host method: restore only if still current; delete when the original
                       was inherited; read "unpatched" from the prototype; re-wrap on llm/adapters-updated
    discovery.ts       discoverModels: pi's answer + the catalog's missing models (D3, D8)
    route-claim.ts     prepended internal/config listener: pi-ai resolves its config without the
                       two plane providers, so it never claims them; restarts pi-ai on mount/dispose
    plane-provider.ts  the plugin's PiAiAdapter, registered as opencode + opencode-go, built from
                       the user's entries with a composite pi provider and the plugin's endpoints
    remote.ts          installRemoteService, markRemote
  request/             fetch patch stages: claim → credential → headers → body (body parsed once)
  credentials.ts       gathers values; utils/credential-policy decides; CaptureStore per root
  utils/               pure: protocols, plane-model (one pi Model per declared id, F9 precedence),
                       model-metadata (reasoning, both vocabularies), credential-policy,
                       request-shape, session-id, google-replay, catalog-parse
  contracts/           defineRemote(namespace, methods) for usage, purge, store (client-safe)
  settings-table.ts    one field table → schema, resolver, types, card specs, copy, manifest
  ui/                  card, one ActionRow, meter, on the primitives
```

There are no hidden routes, no listing hide, no stream redirect, no child mount, no Gemini bridge registration, no patched host adapter and no `resolveModelInfo` override (D8). One private seam is left, the `ResolvedPiAiProviderProfile` shape handed to the public `PiAiAdapter`, and a contract test against the real host packages pins it.

## Phases

One PR each, from `main`, after P0 merges. The first commit of each phase is a test that fails on `main`.

1. **P1a `fix:` shipped breakage.**
   - Drop `export { default }` from the wrapper. The import test resolves `dsh-opencode-patch` from the dry-run scratch directory.
   - `isZenProvider`.
   - Status pass-through in `enrichModelsResponse`, keeping the Go 404 fill.
   - The warning colour uses `--dsw-alias-state-warn-label`.
   - Spinner keyframes in the settings styles.
   - One debug gate.
   - `settings-purge` uses `parsePurgeResult` and reads the envelope.
2. **P1b `chore:` hygiene.**
   - Delete `adapter-replacement.ts` and its test, which nothing imports. Extend `docs/engineering-notes.md`'s plane-route override section (≈`:535-549`) with why the approach is unsupported.
   - Delete the dead `prepared` code, and `.freebuff/`.
   - The partition test walks `Config.dict`, and a manifest test checks `cordis.patch.yml` against `Config.dict`.
   - `retry.ts` takes its timer and logger as parameters; the architecture test bans `console`/`setTimeout`/`setInterval` in `utils/` and walks recursively.
   - `tool-fallback` dead branches and plane lookup.
   - Replace `docs/improvement-plan.md` with this plan (D10).
3. **P2 `feat!:` the major.**
   - `index.ts` → `apply`, `Config`, `inject`, `name` and the config types.
   - All 30 importing test files (including e2e and mock) go through one `test/support/src.ts`, so later moves touch one file.
   - Delete `resolveRoutedKey` (D4) and `internalRoutes` (D2; breaking for anyone who set it to false). Retarget P0's bridge-disposer test to the "every route declared" exit (P-R1 later deletes the bridge, and the test with it).
   - Stop publishing `@viztor/dsh-opencode` (D9) and set its final deprecation message.
   - Document the D1 effort break here, so every breaking change ships in one 2.0.0. The `BREAKING CHANGE:` footer lists all of them.
4. **P-T1 `test:` a harness that is the real host.**
   - Pin the dev dependency `@earendil-works/pi-ai` to **1.1.0** (D14), with a test that fails if it drifts from the harness's lockfile pin.
   - Build `test/support/host.ts` on the **real** packages already in `node_modules`: a cordis `Context`, `@deepseek-ai/dsh-llm`'s `LlmRuntime` and `@deepseek-ai/dsh-llm-pi-ai`'s `apply`. It is pointed at the mock gateway (`test/mock/`) through `fetch`, with a profile builder for the deployment shapes that matter: no `models` list, a `models` list of known ids, gap ids in the config file, and a route-level `baseURL`/`api`.
   - **Characterization tests** that record today's behaviour across those shapes: for each model, the endpoint and protocol it reaches, and what the composer (`buildModelCatalog`'s logic), validation (`resolveCallConfig`) and Settings (`discoverModels`) report. They are the safety net for P-R1, and the measurement behind G1–G3.
   - **Contract tests** against the real packages, so an upgrade breaks CI, not a user. They pin:
     - the profile shape;
     - F11, that pi-ai's routes are the keys of its resolved config;
     - F12, that the waterfall's return value is what the fiber keeps, and that the editor writes the raw value.
   - Replay run S0 as tests on this harness. Its result confirms the design for P-R1, or sends it to the fallback.
   - Retire the ~60 ad-hoc contexts (21 with no-op `effect`), `createMockContext` and `HarnessSimulator`.
   - Add `host/patch-method.ts` (restore only if still current; delete when inherited; re-wrap on `llm/adapters-updated`), and `test/reload.test.ts` (apply A → apply B → dispose A → B intact → dispose B → originals) for the sites that remain.
5. **P-R1 `refactor:` the plugin owns the plane routes (D5, D13).** The core of the refactor; the steps are in "Routing".
   - `host/route-claim.ts`, `host/plane-provider.ts` and `utils/plane-model.ts`. Tests run against the real llm-pi-ai, llm and cordis:
     - after mount, `opencode`/`opencode-go` are the plugin's adapter, and every other pi-ai route is unchanged;
     - a known model, a pi-1.1.0 gap model and **a catalog-unknown id** each save through `configEditor.edit` (the file holds exactly what was saved), list, validate and dispatch (D15);
     - a broken entry on any other pi-ai provider is still rejected;
     - the listener never writes to the user's config object;
     - mount while pi-ai is active, dispose, and remount: the routes move to the plugin, back to pi-ai, and to the plugin again, with no `DUPLICATE_ADAPTER`.
   - Delete the hidden-route machinery: the child mount and its facade Proxy, `responses-routes.ts`, the listing hide, the stream redirect and `isAvailable`, `decoratePlaneAdapters`, the Gemini bridge registration, the hidden ids in `DEFAULT_PROVIDERS` and `cordis.patch.yml`, and the tests that pin them.
   - The Google replay translators go too, if the characterization tests show replay stays on one provider label.
   - **The P-T1 characterization tests must pass unchanged**, except the rows that recorded a defect, each named in the PR.
   - **New tests:**
     - every model on each plane, in each protocol, reaches its endpoint in the chosen family, **Go Gemini included** (F10);
     - `planeModelFor` table tests: each field's precedence (route-level override > declared row > catalog > pi > defaults; SDK > pi > id family > completions; both endpoint families);
     - a user's row (name, context, max tokens, modalities, efforts) wins end to end, in picker and dispatch.
   - Expected size: a net deletion of well over a thousand lines.
6. **P-R2 `fix:` the endpoint family, measured (G2).**
   - Measure, with the opt-in live e2e, which family the gateway serves for each protocol on each plane: the `inference` bases and pi 1.1.0's legacy ones (`/zen`, `/zen/v1`, `/zen/go`, `/zen/go/v1`).
   - Set the measured default, and pin it with tests.
7. **P3 `feat:` Settings complements pi's list (D3, D8).**
   - The `discoverModels` wrapper returns pi's answer plus the plane's **servable, non-deprecated** catalog models missing from it. It dedupes, and whitelists to `LlmDiscoveredModel`'s fields.
   - Gap rows save like any other (D15), and the composer then shows them, served by the plugin's provider.
   - The composer's `listModels` stays declared-only.
   - Delete `installModelDiscovery`/`toDiscovered` and P0's two discovery-reload tests.
   - Rewrite the "adds nothing" tests (`test/models-discovery.test.ts:207-210,307-319`) and the contradicting docs (`README.md:220`, `deep-dive.md:14,174-175`, `redirect-planes.md:102`). `deep-dive.md:14`'s "one wire protocol per route" premise is false for this host (F1).
8. **P4 `feat:` follow the user's configuration; on/off for gap models (D1, D8).**
   - Remove the catalog fill for models pi knows: the plane-route overrides in `decorateModelInfo`, and the same-mode fill inside the current adapter patch. The user's row, or pi, answers.
   - For models with no user row, `utils/model-metadata.ts` `reasoningFor(spec)` builds the plugin provider's levels in both vocabularies. A toggle model offers **Off/On**; old Minimal/Xhigh/Max selections break (documented in P2).
   - Delete the duplicate `ALL_THINKING_LEVELS` and the three capitalisation copies.
   - **Tests:** for every gap model on each plane, picker efforts = the levels dispatch accepts; for a known model, both equal pi's or the user's row; the "on" wire value is verified per protocol with an e2e probe.
9. **P-T2 `test:` suite structure.**
   - Move the 9 mock-booting unit files into `test/mock/`, de-duplicated against `request-shapes.mock.ts`, and the 3 offline e2e files into mock.
   - Delete the self-testing harness and mock-gateway tests.
   - Turn constants into invariants.
   - Split the 7 big test files.
   - One shared e2e environment helper; remove duplicated helpers, device-login mock routes and the hard-coded `ses_`.
   - Coverage tests for `session-id` and `opencode-store-contract`, plus per-file floors for `lifecycle`/`stream-hook`/`fetch-patch`.
10. **P-T3 `ci:` CI and scripts.**

- One unit run (`test:coverage`), with build before tests that read `lib/`, and type-check `test/**/*.tsx`.
- One composite setup action; the catalog fork `if:` and the pnpm comments.
- Paid e2e runs only on schedule or dispatch.
- `check.ts` keeps lib freshness (once), the consumer install (loading the client half too) and the size tripwire; its pure file checks move to vitest.
- The generators share helpers and one staleness rule; `verify-*` scripts exit non-zero; `capture-ui.sh` has no machine paths; `no-local-paths` covers every published file plus `.github/` and `*.sh`.

11. **P5 `refactor:` installers.** `installRemoteService(ctx, Service, contract, options)` replaces the three mount-once copies. Each reads the latest activation's settings and reports through `ctx.logger`. Update `scripts/check.ts:320-334`'s probe in the same PR.
12. **P6 `refactor:` one credential resolver.**
    - Parity test over the six deciders.
    - `utils/credential-policy.ts` + `credentials.ts`; the placeholder filter applied once.
    - The plugin provider's key resolution is the same resolver, store fallback included.
    - `CaptureStore` per root, evicting a key on 401.
    - No `process.env` in `fetch-patch`, `lifecycle` or the plugin provider.
13. **P7 `refactor:` one source per table.**
    - `utils/protocols.ts`: SDKs, one protocol map and one plane table (with the hidden routes gone after P-R1, the per-route tables go too), and one `planeForRoute` (four copies today).
    - One `formatUsd`.
    - One `specFor(route, id)`.
14. **P8 `refactor:` settings table.**
    - First, a snapshot test of the derived `Config`.
    - Then `settings-table.ts` drives the schema (schemastery `union`/`const`/`loose`, checking that `loose` and `volatile` compose), the resolver, the types, the card, the copy and the manifest.
    - Delete the 14 dead copy keys and `modelMarkers`; fix the zh `title`.
15. **P9 `refactor:` remote seam.**
    - `defineRemote` contracts, `markRemote`, `callRemote` (one unwrap, parsed by the contract).
    - Delete `isGoUsage` and the four hand-written unwraps; add the `opencodeGoUsage` constant.
    - The parity test reads the contracts.
16. **P10a `refactor:` pure module moves, no behaviour change.**
    - `models-discovery` → `host/*`.
    - What is left of `responses-provider` and `google-bridge` after P-R1 → `host/plane-provider.ts`, with the loader lookups moved into `cordis-context.ts`.
    - `go-discovery` → `credentials.ts`.
    - `usage-ui` → css/time/state/copy; `parseFailure` → the usage contract.
    - `fetch-patch` → `request/`.
17. **P10b `fix:` catalog state.**
    - The parse is pure and returns `deprecated`; refresh replaces the maps.
    - The refresh promise returns `{ ok, deprecated }` for the purge.
    - The shim carries deprecated ids, and the staleness check compares the whole output.
    - The purge makes one edit per entry and skips no-op entries.
18. **P11 `refactor:` UI on the primitives.**
    - `SegmentedControl`, `Button` with `icon`, `useDismissOnOutsidePointer`, one `ActionRow`.
    - Theme tokens only; inline styles moved to CSS.
    - Re-measure the bundle budget.
19. **P12 `ci:`** make lint warnings gating once `src/` is at zero.

## Order

```
P0 → P1a → P1b → P2 (2.0.0) → P-T1 → P-R1 → P-R2 → P3 → P4 → P-T2 → P-T3 → P5 → P6 → P7 → P8 → P9 → P10a → P10b → P11 → P12
```

- **P1a first:** shipped breakage.
- **P2 bundles every breaking change into one major:** D2, D4, D6, D9 and the D1 note.
- **P-T1 before any routing change:** the real-host harness records today's behaviour, which P-R1 must keep.
- **P-R1 is the refactor that matters:** it removes the workaround's moving parts, and everything after it is smaller because of it.
- **P10a only after P5–P9:** a move is safe once tests pin what moves.

## Verification (every phase)

Run on Node 26 (`.node-version`):

- `pnpm run check`: 0 errors, and no more warnings than before;
- `pnpm run test`, `test:shuffle` on 3+ seeds, and `test:mock`;
- `pnpm run build` + `node --experimental-strip-types scripts/check.ts`;
- `pnpm run test:coverage` at or above the ratchet.

Then on Node 24: `test:shuffle` + `test:mock`.

Before each commit, grep the diff and `lib/` for local paths.

Also:

- The phase's first test fails on `main`.
- For P-R1, P3 and P4, P-T1's real-host harness shows:
  - the composer is declared-only;
  - Settings is pi's list plus the missing catalog models;
  - a user-configured row's efforts and context reach both picker and dispatch unchanged;
  - a gap toggle model offers Off/On;
  - every model reaches its endpoint in its own protocol, on the user's route id, with no hidden route registered;
  - a model id the catalog has never heard of saves through Settings' `configEditor` path and dispatches;
  - all of it on pi 1.1.0.
- P4's e2e probe confirms the "on" wire value per protocol against the live gateway (opt-in job).
- Push, open the PR with a Conventional title, and watch CI to green before starting the next phase.
