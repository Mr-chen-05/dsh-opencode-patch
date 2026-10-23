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
| P-R1 | `refactor:` one route, delegated gaps | planned |
| P-R2 | `fix:` endpoint drift and collapsed modes | planned |
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
| U1 | upstream: per-entry `api`/`baseURL` in llm-pi-ai | to propose |

## Owner decisions

| # | Decision |
| :-- | :-- |
| D1 | A model whose reasoning is only on/off is offered as **Off / On**. Old saved Minimal/Xhigh/Max selections on such models **break, and the break is documented**. |
| D2 | **Delete `internalRoutes`** |
| D3 | **Composer = declared models only. Settings = the whole catalog to pick from.** |
| D4 | Delete `resolveRoutedKey`. It was exported in dde9d6e and nothing in `src/` has ever called it. |
| D5 | **Serve every mode on the user's own route, with no hidden routes.** The host already does this per model for every model pi's catalog knows. The plugin fills only the gaps (see "Routing"), through one unregistered adapter per plane that the user's route delegates gap models to. |
| D6 | Shrink the public API in a major release (2.0.0) |
| D7 | Merge P0 first, then one PR per phase, each from `main` |
| D8 | **The plugin never writes the user's profile and never overrides the user's configuration at dispatch.** It complements what pi's provider list is missing and shows that in Settings when the user configures models. After that, dispatch follows the user's configuration. |
| D9 | Retire the deprecated `@viztor/dsh-opencode` wrapper in 2.0.0, after fixing its broken re-export in P1 |
| D10 | This document is the plan of record; each phase PR updates its status row |
| D11 | **The adapter patch exists to merge provider modes into the user's provider, nothing else.** It stays (`merge-modes`) and covers every gap model; anything in it that is not merging goes. |

## What the host supports (read from source)

- **Routes.**
  - `registerAdapter` is all-or-nothing against a `private adapters` map (`llm/src/index.ts:399-460`). Only a registration's owner moves its routes, through `handle.replace`.
  - `adapter-replacement.ts` deletes another plugin's entry, which is unsupported. Delete it.
- **Dispatch.**
  - The `llm/stream` waterfall allows a short-circuit (`index.ts:62-75`). `next()` takes no arguments, and loop requests are frozen.
  - Today's redirect, `llm.stream({ ...options, provider: hiddenRoute })` (`src/stream-hook.ts:251-266`), is supported but needs a registered hidden route. Delegating at the adapter (F6, F7) keeps `adapterStream`'s validation, projection, replay filtering and failure normalization (`index.ts:1064-1150`) **without** one, so the redirect goes in P-R1.
- **Effort validation goes through the ADAPTER, not the public `resolveModelInfo`.**
  - The paths are `resolveCallConfig` → `resolveModelInfoFor` → `adapter.resolveModel`, `adapter.prepareCall`, and pi's private `modelOf` (`index.ts:769,894-905,964,1076`; `llm-pi-ai/src/adapter.ts:369-375`).
  - **The adapter patch exists to merge provider modes, nothing else (D11).** A declared model that pi cannot serve on the route (a gap, see "Routing") must resolve and dispatch as part of the user's own `opencode`/`opencode-go` provider. The route's adapter therefore hands `listModels`/`resolveModel`/`prepareCall` for that model to the plugin's catalog adapter. Today it does this only for Go→Gemini, and through a hidden route (`models-discovery.ts:735-760`).
  - Its catalog fill of context and levels for same-mode models (`:790-1010`) is not merging. Under D8 it goes: for a same-mode model, the picker and dispatch both follow the user's row, or pi's data where the user set nothing.
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

**The problem, in the owner's words.** A provider defines one backend. Supporting new models meant un-registering the original provider and registering a new one, which the host does not support; so the plugin mounted extra routes per protocol and merged their models back into the user's provider.

**Facts from the host's own code and data.** F1–F5 are measured: the data files were counted and the resolver read. F6–F7 are read from the code. P-T1's real-host harness proves them end to end before P-R1 relies on them, and a fact that fails there sends the design back to this section.

| # | Fact | Evidence |
| :-- | :-- | :-- |
| F1 | **One route already serves every mode, per model.** llm-pi-ai resolves `api` and `baseUrl` per model: `request.api ?? base?.api ?? routeApi` and `request.baseURL ?? base?.baseUrl ?? providerBaseUrl`, where `base` is pi's installed catalog entry. | `llm-pi-ai/src/catalog.ts:917-922`; the same in the 0.2.1-alpha.5 build this repo uses (`lib/index.js:689`) |
| F2 | **pi's installed `opencode` catalog spans four protocols, each with its own endpoint.** In pi 1.1.0, which the host pins and patches: Zen has 18 anthropic-messages (`/zen`) and 7 google, 28 completions and 30 responses (`/zen/v1`). Go has 5 anthropic (`/zen/go`) and 19 completions and 6 responses (`/zen/go/v1`), and **no google**. | `@earendil-works/pi-ai@1.1.0` `dist/providers/data/opencode*.json`; harness `pnpm-lock.yaml:13` |
| F3 | **A model pi's catalog does not know cannot get its own protocol.** A profile entry has no `api`/`baseURL` field (`PiAiModelProfile`); it takes the route's `api`, or `sharedCatalogApi`, which is undefined for a multi-protocol catalog. | `catalog.ts:600-640,681-691,917-921` |
| F4 | **Such a model cannot be saved, listed or dispatched on the user's route.** Writes are validated strictly (`assertServiceable`), so the save is rejected with "needs an api". Stored reads are deferred, so the id lands in `modelErrors`. `listModels` lists only resolved models, and `modelOf` throws `INVALID_CONFIG`. | `config.ts:357-368,487`; `index.ts:171`; `adapter.ts:271-311` |
| F5 | **A route-level `api` or `baseURL` overrides every model**, collapsing the modes onto one protocol or endpoint. | `catalog.ts:917,922` |
| F6 | **Dispatch reads the route's adapter.** `selectModel`, `prepareCall` and `llm.stream` all go through `registration.adapter.resolveModel`/`prepareCall`. The host requires only that the prepared model's `provider` equals the route id, and then dispatches through `adapterCall.stream`, with validation, projection, replay filtering and failure normalization intact. | `llm/src/index.ts:774-793,894-905,956-964,1064-1150` |
| F7 | **An adapter that is never registered can share the route's id.** The host checks duplicates only in its registry, so a plugin-owned `PiAiAdapter` whose profile is keyed `opencode`/`opencode-go` can answer for that route when the route's own adapter delegates to it. The Gemini bridge already builds such an adapter by hand. | `llm/src/index.ts:399-460`; `src/google-bridge.ts:541-600` |

**So the plugin has exactly three gaps to fill, and nothing else:**

- **G1:** models newer than pi's catalog on a plane, which includes every Gemini model on Go (F2);
- **G2:** endpoint drift, where pi's stored bases are retired or are the wrong family for the deployment's `endpoint`;
- **G3:** a profile-level `api`/`baseURL` that collapses the modes (F5).

Stale metadata for models pi knows is **not** a gap: under D8 the user's row, or pi, decides.

**The design ("one route, delegated gaps"):**

- **`host/catalog-adapter.ts`.** One `PiAiAdapter` per plane, built from the host's own llm-pi-ai class, as the bridge does today. Its profile is keyed by the user's route id and holds only the gap models, as pi `Model`s with their own `api` and `baseUrl` (from the catalog, family-aware). The user's row values come first (D8). It is **never registered**.
- **`host/merge-modes.ts`, the adapter patch (D11).** On the user's plane route adapter only:
  - `listModels` appends the declared gap ids;
  - `resolveModel` and `prepareCall` hand a gap model, with the same arguments, to the catalog adapter;
  - everything else is the user's route answering as it always does.
  - Picker, validation and dispatch therefore read one answer, through the host's own path (F6).
- **Deleted:**
  - the llm-pi-ai child mount and its `llmFacade` Proxy;
  - every hidden route and its tables (`responses-routes.ts`, the hidden ids in `DEFAULT_PROVIDERS`);
  - the listing hide (`listProviders`, `listConfigurableProviders`, `listModels`);
  - the stream redirect and `isAvailable`;
  - the Gemini bridge registration, which becomes ordinary G1 models;
  - the Google history and replay translation, if the delegated path keeps replay on one provider label (verify by test);
  - `internalRoutes` (D2).
- **What remains private:** one seam, the registry's adapter map, to wrap the user's route adapter, plus the hand-built profile shape. Both are pinned by contract tests against the real `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-llm-pi-ai` packages (already in `node_modules`), so a host upgrade that changes either fails CI rather than a user's turn.

**The limit no plugin can remove (F4).** A user cannot **save** a gap model through Settings, because pi-ai rejects the write. Today such models work only when declared in the deployment's config file, which is read in deferred mode. D3's "whole catalog in Settings" is therefore fully deliverable only with upstream change U1.

**Upstream changes to deepseek-harness, in order of value:**

- **U1:** a `models` entry, and `modelOverrides`, accept their own `api` and `baseURL`. In `resolveEntry`, `entry.api ?? request.api ?? base?.api ?? routeApi`, and the same for `baseURL`. `LlmDiscoveredModel` gains `api` (and `reasoning`), so a Settings adoption writes it. **With U1, pi serves every declared model natively, and `catalog-adapter`, `merge-modes` and the registry seam are deleted.** The plugin's routing layer becomes zero code, and what remains is the Settings complement.
- **U2:** a `resolveProfiles` export, so the catalog adapter's profile is built by llm-pi-ai rather than by hand (only needed until U1).
- Withdrawn: `registerAdapter(…, { listed: false })`. Without hidden routes nothing needs hiding.

## Target architecture

```
src/
  index.ts             apply, Config, inject, name + config types (D6)
  lifecycle.ts         apply(): installers only
  host/
    patch-method.ts    patch a host method: restore only if still current; delete when the original
                       was inherited; read "unpatched" from the prototype; re-wrap on llm/adapters-updated
    discovery.ts       discoverModels: pi's answer + the catalog's missing models (D3, D8)
    catalog-adapter.ts one unregistered PiAiAdapter per plane, keyed by the user's route id,
                       holding only the gap models (G1-G3) with their own api and baseUrl
    merge-modes.ts     the adapter patch on the user's route: gap models are listed, resolved
                       and prepared by the catalog adapter; nothing else is touched (D11)
    remote.ts          installRemoteService, markRemote
  request/             fetch patch stages: claim → credential → headers → body (body parsed once)
  credentials.ts       gathers values; utils/credential-policy decides; CaptureStore per root
  utils/               pure: protocols, model-metadata (reasoning, both vocabularies), credential-policy,
                       request-shape, session-id, google-replay, catalog-parse
  contracts/           defineRemote(namespace, methods) for usage, purge, store (client-safe)
  settings-table.ts    one field table → schema, resolver, types, card specs, copy, manifest
  ui/                  card, one ActionRow, meter, on the primitives
```

There are no hidden routes, no listing hide, no stream redirect, no child mount, no Gemini bridge registration, and no `resolveModelInfo` override (D8). One private seam is left, the registry's adapter map that `merge-modes` reaches, and it is pinned by a contract test against the real host packages and deleted by U1.

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
   - Build `test/support/host.ts` on the **real** packages already in `node_modules`: a cordis `Context`, `@deepseek-ai/dsh-llm`'s `LlmRuntime` and `@deepseek-ai/dsh-llm-pi-ai`'s `apply`. It is pointed at the mock gateway (`test/mock/`) through `fetch`, with a profile builder for the deployment shapes that matter: no `models` list, a `models` list of known ids, gap ids in the config file, and a route-level `baseURL`/`api`.
   - **Characterization tests** that record today's behaviour across those shapes: for each model, the endpoint and protocol it reaches, and what the composer (`buildModelCatalog`'s logic), validation (`resolveCallConfig`) and Settings (`discoverModels`) report. They are the safety net for P-R1, and the measurement behind G1–G3.
   - **Contract tests** that pin the two private seams (the registry adapter map, and the hand-built llm-pi-ai profile shape) against the real packages, so an upgrade breaks CI, not a user.
   - Retire the ~60 ad-hoc contexts (21 with no-op `effect`), `createMockContext` and `HarnessSimulator`.
   - Add `host/patch-method.ts` (restore only if still current; delete when inherited; re-wrap on `llm/adapters-updated`), and `test/reload.test.ts` (apply A → apply B → dispose A → B intact → dispose B → originals) for the sites that remain.
5. **P-R1 `refactor:` one route, delegated gaps (D5, D11).** The core of the refactor; the steps are in "Routing".
   - `host/catalog-adapter.ts`: one unregistered `PiAiAdapter` per plane, keyed by the user's route id, built from the gap models.
   - `host/merge-modes.ts`: the user's route adapter lists, resolves and prepares gap models through it.
   - Delete the hidden-route machinery: the child mount and its facade Proxy, `responses-routes.ts`, the listing hide, the stream redirect and `isAvailable`, the Gemini bridge registration, the hidden ids in `DEFAULT_PROVIDERS` and `cordis.patch.yml`, and the tests that pin them.
   - The Google replay translators go too, if the characterization tests show replay stays on one provider label.
   - **The P-T1 characterization tests must pass unchanged**, except the rows that recorded a defect, each named in the PR.
   - **New tests:**
     - a gap model on each plane, in each protocol, reaches its endpoint;
     - a known model is answered by pi alone;
     - a user's row for a gap model (name, context, max tokens, modalities, efforts) wins over the catalog.
   - Expected size: a net deletion of well over a thousand lines.
6. **P-R2 `fix:` endpoint drift and collapsed modes (G2, G3).**
   - Measure first, with P-T1's harness and the opt-in e2e: which of pi 1.1.0's bases (`/zen`, `/zen/v1`, `/zen/go`, `/zen/go/v1`) are retired or wrong for the deployment's `endpoint` family, and what a route-level `baseURL`/`api` does to known models.
   - The delegation rule becomes "gap model, or a known model whose resolved endpoint or protocol is wrong". The catalog adapter serves it with the right base.
   - If nothing is wrong, this phase only adds the tests that say so.
7. **P3 `feat:` Settings complements pi's list (D3, D8).**
   - The `discoverModels` wrapper returns pi's answer plus the plane's **servable, non-deprecated** catalog models missing from it. It dedupes, and whitelists to `LlmDiscoveredModel`'s fields.
   - **F4 limits this:** pi-ai rejects saving a gap model, so until U1 these rows are offered with that caveat in their name/description, or held back behind U1. This needs an owner decision.
   - The composer's `listModels` stays declared-only.
   - Delete `installModelDiscovery`/`toDiscovered` and P0's two discovery-reload tests.
   - Rewrite the "adds nothing" tests (`test/models-discovery.test.ts:207-210,307-319`) and the contradicting docs (`README.md:220`, `deep-dive.md:14,174-175`, `redirect-planes.md:102`). `deep-dive.md:14`'s "one wire protocol per route" premise is false for this host (F1).
8. **P4 `feat:` follow the user's configuration; on/off for gap models (D1, D8).**
   - Remove the catalog fill for models pi knows: the plane-route overrides in `decorateModelInfo`, and the same-mode fill inside the current adapter patch. The user's row, or pi, answers.
   - For gap models, `utils/model-metadata.ts` `reasoningFor(spec)` builds the catalog adapter's levels in both vocabularies. A toggle model offers **Off/On**; old Minimal/Xhigh/Max selections break (documented in P2).
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
    - The catalog adapter's key resolution is the same resolver, store fallback included.
    - `CaptureStore` per root, evicting a key on 401.
    - No `process.env` in `fetch-patch`, `lifecycle` or the catalog adapter.
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
    - What is left of `responses-provider` and `google-bridge` after P-R1 → `host/catalog-adapter.ts`, with the loader lookups moved into `cordis-context.ts`.
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

**Upstream asks (deepseek-harness):** U1 and U2 are described in "Routing". U1 deletes `catalog-adapter`, `merge-modes` and the last private seam.

## Order

```
P0 → P1a → P1b → P2 (2.0.0) → P-T1 → P-R1 → P-R2 → P3 → P4 → P-T2 → P-T3 → P5 → P6 → P7 → P8 → P9 → P10a → P10b → P11 → P12
                                              (U1 proposed upstream in parallel; when it lands, a phase deletes catalog-adapter + merge-modes)
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
  - every gap model reaches its endpoint in its own protocol, on the user's route, with no hidden route registered.
- P4's e2e probe confirms the "on" wire value per protocol against the live gateway (opt-in job).
- Push, open the PR with a Conventional title, and watch CI to green before starting the next phase.
