# Improvement plan

## Context

The result of an architecture audit of the tree at 1.4.1, and the order in which to act on it. It rests on:

- six audits: routing, catalog, credentials, config/UI, tests/CI/docs, and the stream path;
- an adversarial review of the plan itself;
- the host's own source (`deepseek-ai/deepseek-harness`): `packages/llm/llm`, `llm-pi-ai`, `api/session-controller`, `api/gateway`, and `client/ui-settings-models`. File references into the host are relative to that repository's `packages/`.

**Outcome:** a plugin that only uses host extension points the host supports; one source of truth per decision; a suite that pins behaviour before it moves; and the owner's product rules below.

**Each phase is one pull request**, and it updates this document: its row in the status table moves to "merged", and its section is trimmed to what is left. A finding that does not survive its phase's first failing test is struck from here rather than forced.

## Status

| Phase | Title | State |
| :-- | :-- | :-- |
| P0 | suite hardening, 11 defect fixes, this plan | in review |
| P1a | `fix:` shipped breakage | planned |
| P1b | `chore:` hygiene | planned |
| P2 | `feat!:` the 2.0.0 major | planned |
| P-T1 | `refactor:` fake host and patch lifecycle | planned |
| P3 | `feat:` Settings offers the catalog | planned |
| P4 | `feat:` follow the user's configuration; on/off on internal routes | planned |
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
| D5 | Keep the per-protocol hidden routes, done the way the host supports |
| D6 | Shrink the public API in a major release (2.0.0) |
| D7 | Merge P0 first, then one PR per phase, each from `main` |
| D8 | **The plugin never writes the user's profile and never overrides the user's configuration at dispatch.** It complements what pi's provider list is missing and shows that in Settings when the user configures models. After that, dispatch follows the user's configuration. |
| D9 | Retire the deprecated `@viztor/dsh-opencode` wrapper in 2.0.0, after fixing its broken re-export in P1 |
| D10 | This document is the plan of record; each phase PR updates its status row |
| D11 | **The adapter patch exists to merge provider modes into the user's provider, nothing else.** It stays, and is generalized to every mode; anything in it that is not merging goes. |

## What the host supports (read from source)

- **Routes.**
  - `registerAdapter` is all-or-nothing against a `private adapters` map (`llm/src/index.ts:399-460`). Only a registration's owner moves its routes, through `handle.replace`.
  - `adapter-replacement.ts` deletes another plugin's entry, which is unsupported. Delete it.
- **Dispatch.**
  - The `llm/stream` waterfall allows a short-circuit (`index.ts:62-75`). `next()` takes no arguments, and loop requests are frozen.
  - The redirect `llm.stream({ ...options, provider: hiddenRoute })` (`src/stream-hook.ts:251-266`) is the supported shape. It keeps `adapterStream`'s validation, projection, replay filtering and failure normalization (`index.ts:1064-1150`).
- **Effort validation goes through the ADAPTER, not the public `resolveModelInfo`.**
  - The paths are `resolveCallConfig` → `resolveModelInfoFor` → `adapter.resolveModel`, `adapter.prepareCall`, and pi's private `modelOf` (`index.ts:769,894-905,964,1076`; `llm-pi-ai/src/adapter.ts:369-375`).
  - **The adapter patch exists to merge provider modes, nothing else.** A declared model whose mode (Responses, Anthropic, Google) differs from the route's must resolve and dispatch as part of the user's own `opencode`/`opencode-go` provider. The plane route's adapter therefore answers `resolveModel`/`prepareCall`/`modelOf` for that model from the hidden route's adapter. Today that is done only for Go→Gemini (`models-discovery.ts:735-760`).
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
  - One listing patch stays. Instance patches reach Remote calls, because the gateway resolves methods with `Reflect.get` at call time (`api/gateway/src/index.ts:841-843`).
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

## Target architecture

```
src/
  index.ts             apply, Config, inject, name + config types (D6)
  lifecycle.ts         apply(): installers only
  host/
    patch-method.ts    patch a host method: restore only if still current; delete when the original
                       was inherited; read "unpatched" from the prototype; re-wrap on llm/adapters-updated
    listing.ts         the ONE listing patch: hide internal routes (every listProviders reader)
    discovery.ts       discoverModels: pi's answer + the catalog's missing models (D3, D8)
    merge-modes.ts     the adapter patch: a declared model in another mode answers from that
                       mode's hidden-route adapter, so the modes merge into one provider (D11)
    internal-routes.ts the hidden routes + Gemini bridge: one installer, one disposer
    remote.ts          installRemoteService, markRemote
  request/             fetch patch stages: claim → credential → headers → body (body parsed once)
  credentials.ts       gathers values; utils/credential-policy decides; CaptureStore per root
  utils/               pure: protocols, model-metadata (reasoning, both vocabularies), credential-policy,
                       request-shape, session-id, google-replay, catalog-parse
  contracts/           defineRemote(namespace, methods) for usage, purge, store (client-safe)
  settings-table.ts    one field table → schema, resolver, types, card specs, copy, manifest
  ui/                  card, one ActionRow, meter, on the primitives
```

`host/merge-modes.ts` is the adapter patch, and it **merges provider modes and nothing else**. For a declared model in another mode, the plane route's adapter (and the public `resolveModelInfo` the picker reads) answers from that mode's hidden-route adapter, so the picker and dispatch see one provider. Same-mode models are not touched (D8).

Two private seams remain, documented and feature-detected, each with an upstream ask that deletes it: the listing patch, and the adapter map that `merge-modes` reaches.

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
   - Delete `resolveRoutedKey` (D4) and `internalRoutes` (D2; breaking for anyone who set it to false). Retarget P0's bridge-disposer test to the "every route declared" exit.
   - Stop publishing `@viztor/dsh-opencode` (D9) and set its final deprecation message.
   - Document the D1 effort break here, so every breaking change ships in one 2.0.0. The `BREAKING CHANGE:` footer lists all of them.
4. **P-T1 `refactor:` fake host and patch lifecycle.**
   - `test/support/fake-cordis.ts` on the real `Context` (one import path), plus `fakeLlm()` and `fakeLogger()`. Retire the ~60 ad-hoc contexts (21 with no-op `effect`), `createMockContext` and `HarnessSimulator`.
   - `test/reload.test.ts` (apply A → apply B → dispose A → B intact → dispose B → originals) fails today.
   - `host/patch-method.ts` applied to every patch site, which makes it pass. It reads `listProviders` "unpatched" from the prototype, so the private `llm.adapters` reads in `stream-hook.ts:238-249` and `responses-provider.ts` go. The adapter patch keeps its read: merging modes needs the adapter map until upstream offers a seam. It re-wraps on `llm/adapters-updated`.
5. **P3 `feat:` Settings offers the catalog (D3, D8).**
   - The `discoverModels` wrapper returns pi's answer plus the plane's **servable, non-deprecated** catalog models that are missing from it. It dedupes, and whitelists to `LlmDiscoveredModel`'s fields.
   - The composer's `listModels` stays declared-only.
   - Delete `installModelDiscovery`/`toDiscovered` and P0's two discovery-reload tests; the mount facade keeps answering the child's `registerModelDiscovery` (`responses-provider.ts:649`).
   - Rewrite the "adds nothing" tests (`test/models-discovery.test.ts:207-210,307-319`) and the contradicting docs (`README.md:220`, `deep-dive.md:174-175`, `redirect-planes.md:102`).
6. **P4 `feat:` merge every provider mode; follow the user's configuration (D1, D5, D8).**
   - **Keep the adapter patch and narrow it to its purpose: merging modes.** Generalize the Go→Gemini case (`models-discovery.ts:735-760`) to every mode on both planes. For a declared model whose catalog SDK maps to another protocol (`internalRouteFor`), the plane adapter's `resolveModel`, `prepareCall` and `modelOf`, and the public `resolveModelInfo`, answer from that mode's hidden-route adapter, re-labelled with the user's provider. So the picker's levels and dispatch's validation come from the same adapter.
   - **Remove what is not merging:** the catalog fill of context, name, modalities and levels for same-mode models (`:790-1010`) and the matching overrides in `decorateModelInfo`. Same-mode models follow the user's row, or pi's data where the user set nothing.
   - **Hidden-route profiles follow the user, complemented by the catalog.** Each declared model's profile on its hidden route takes the user's row settings first (name, context, max tokens, modalities, `reasoningEfforts`) and the catalog only where the user set nothing.
   - **D1 on the hidden routes.** `utils/model-metadata.ts` `reasoningFor(spec)` emits both vocabularies, with the representation above. A toggle model offers Off/On there, unless the user's row says otherwise. Delete the duplicate `ALL_THINKING_LEVELS` and the three capitalisation copies.
   - **The Go→Gemini lookup and the rest use one helper** that finds the target mode's adapter, re-wrapped on `llm/adapters-updated`.
   - **Tests:**
     - for every catalog model reachable through another mode on each plane, picker efforts = the levels dispatch accepts (both from the hidden-route adapter);
     - a user-configured same-mode row's efforts and context reach both picker and dispatch unchanged;
     - a user row for an other-mode model is carried onto its hidden route.
   - **Verify** the "on" wire value per protocol with an e2e probe.
7. **P-T2 `test:` suite structure.**
   - Move the 9 mock-booting unit files into `test/mock/`, de-duplicated against `request-shapes.mock.ts`, and the 3 offline e2e files into mock.
   - Delete the self-testing harness and mock-gateway tests.
   - Turn constants into invariants.
   - Split the 7 big test files.
   - One shared e2e environment helper; remove duplicated helpers, device-login mock routes and the hard-coded `ses_`.
   - Coverage tests for `session-id` and `opencode-store-contract`, plus per-file floors for `lifecycle`/`stream-hook`/`fetch-patch`.
8. **P-T3 `ci:` CI and scripts.**
   - One unit run (`test:coverage`), with build before tests that read `lib/`, and type-check `test/**/*.tsx`.
   - One composite setup action; the catalog fork `if:` and the pnpm comments.
   - Paid e2e runs only on schedule or dispatch.
   - `check.ts` keeps lib freshness (once), the consumer install (loading the client half too) and the size tripwire; its pure file checks move to vitest.
   - The generators share helpers and one staleness rule; `verify-*` scripts exit non-zero; `capture-ui.sh` has no machine paths; `no-local-paths` covers every published file plus `.github/` and `*.sh`.
9. **P5 `refactor:` installers.** `installRemoteService(ctx, Service, contract, options)` replaces the three mount-once copies. Each reads the latest activation's settings and reports through `ctx.logger`. Update `scripts/check.ts:320-334`'s probe in the same PR.
10. **P6 `refactor:` one credential resolver.**
    - Parity test over the six deciders.
    - `utils/credential-policy.ts` + `credentials.ts`; the placeholder filter applied once.
    - The Gemini key gets the store fallback.
    - `CaptureStore` per root, evicting a key on 401.
    - No `process.env` in `fetch-patch`, `lifecycle` or `google-bridge`.
11. **P7 `refactor:` one source per table.**
    - `utils/protocols.ts`: SDKs, one protocol map, one plane table, one `planeForRoute` (four copies today); `ROUTE_FOR_PROTOCOL` derived from it.
    - One `formatUsd`.
    - One `specFor(route, id)`.
12. **P8 `refactor:` settings table.**
    - First, a snapshot test of the derived `Config`.
    - Then `settings-table.ts` drives the schema (schemastery `union`/`const`/`loose`, checking that `loose` and `volatile` compose), the resolver, the types, the card, the copy and the manifest.
    - Delete the 14 dead copy keys and `modelMarkers`; fix the zh `title`.
13. **P9 `refactor:` remote seam.**
    - `defineRemote` contracts, `markRemote`, `callRemote` (one unwrap, parsed by the contract).
    - Delete `isGoUsage` and the four hand-written unwraps; add the `opencodeGoUsage` constant.
    - The parity test reads the contracts.
14. **P10a `refactor:` pure module moves, no behaviour change.**
    - `models-discovery` → `host/*`.
    - `responses-provider` → `host/internal-routes.ts`, with the loader lookups moved into `cordis-context.ts`.
    - `go-discovery` → `credentials.ts`.
    - `usage-ui` → css/time/state/copy; `parseFailure` → the usage contract.
    - `fetch-patch` → `request/`.
15. **P10b `fix:` catalog state.**
    - The parse is pure and returns `deprecated`; refresh replaces the maps.
    - The refresh promise returns `{ ok, deprecated }` for the purge.
    - The shim carries deprecated ids, and the staleness check compares the whole output.
    - The purge makes one edit per entry and skips no-op entries.
16. **P11 `refactor:` UI on the primitives.**
    - `SegmentedControl`, `Button` with `icon`, `useDismissOnOutsidePointer`, one `ActionRow`.
    - Theme tokens only; inline styles moved to CSS.
    - Re-measure the bundle budget.
17. **P12 `ci:`** make lint warnings gating once `src/` is at zero.

**Upstream asks (deepseek-harness)**, each unlocking a deletion here:

- a `registerAdapter(…, { listed: false })` option → delete the listing patch;
- a `resolveProfiles` export from `llm-pi-ai` → replace the `llmFacade` Proxy mount (`responses-provider.ts:610-722`) with `new PiAiAdapter(…)` + `registerAdapter`;
- a `reasoning` field on `LlmDiscoveredModel` → Settings can offer Off/On when the user adopts a model;
- a supported way for one provider to serve models in several modes (an adapter delegation seam, or one registration answering per model) → `merge-modes` stops reading the adapter map, and the hidden routes can go.

## Order

```
P0 → P1a → P1b → P2 (2.0.0) → P-T1 → P3 → P4 → P-T2 → P-T3 → P5 → P6 → P7 → P8 → P9 → P10a → P10b → P11 → P12
```

- **P1a first:** shipped breakage.
- **P2 bundles every breaking change into one major:** D2, D4, D6, D9 and the D1 note.
- **P-T1 before P3/P4:** they rewrite the same patch sites, and need the reload test and `patchMethod`.
- **P3/P4 deliver the product rules.** P4 generalizes mode merging and removes the catalog fill.
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
- For P3/P4, a host-level test against the cloned harness logic (`buildModelCatalog`, `discoverModels`, `resolveCallWithInfo`) over the fake host shows:
  - the composer is declared-only;
  - Settings is pi's list plus the missing catalog models;
  - a user-configured row's efforts and context reach both picker and dispatch unchanged;
  - an internal-route toggle model offers Off/On.
- P4's e2e probe confirms the "on" wire value per protocol against the live gateway (opt-in job).
- Push, open the PR with a Conventional title, and watch CI to green before starting the next phase.
