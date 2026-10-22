# Improvement plan

An architecture review of the tree at 1.4.1, and the order in which to act on it. Each phase is one pull request with a Conventional Commit title, and each one lands behind tests that pin today's behaviour before anything moves. The first phase is already done; it is listed so the rest reads against what the suite now guarantees.

**How the findings were checked.** Every finding below was traced to the code. The ones marked _measured_ were also reproduced: a probe script, or a test that fails before the fix. The rest are _traced_, and the phase that addresses each one begins by writing the failing test. A finding that turns out wrong at that step is dropped, not forced.

## The shape of the problems

Most findings share one of four causes, and the phases are grouped by cause rather than by file:

| Cause | What it produces | Phases |
| :-- | :-- | :-- |
| **One decision written in several places** | copies that already disagree: credentials, protocol tables, reasoning levels, model metadata | 1, 2 |
| **Host patches without a lifecycle** | patches that stack or get stripped on reload, registrations that outlive their activation | 3, 4 |
| **Module state with process lifetime** | captured keys and catalog maps that survive a reload, and leaked between tests until phase 0 | 0, 1, 5 |
| **Modules that grew past one subject** | five files over 700 lines, each holding three to five jobs | 6 |

## Phase 0 — the suite and the confirmed defects (this pull request)

The suite now:

- refuses to start below `engines.node`. Below Node 24 it used to fail for engine reasons that looked like regressions.
- runs offline. It used to send 54 requests per run to `models.opencode.ai`, so a networked runner could swap the catalog mid-test.
- resets module state after every test. Shuffled runs used to fail on seeds 42 and 1234.
- runs in random order on Node 24 in CI. Node 24 is the declared floor, which no job ran before.
- walks the client bundle's import graph and fails on anything host-only.
- checks every Remote method a host service declares against a client descriptor.

The defects fixed, each with a test that fails without its fix:

| Defect | Status |
| :-- | :-- |
| a rejected internal-route mount escaped as an unhandled rejection, which can exit the host | measured |
| three early exits leaked the Gemini bridge registrations, and the next reload failed with `DUPLICATE_ADAPTER` | measured |
| a mount that failed to start kept its fiber and every route it had registered | measured |
| model discovery answered from the first activation's settings for the life of the process | measured |
| Zen turns on two models were priced at the Go rate (`deepseek-v4-pro`: 0.66 instead of 1.74 per million input tokens) | measured |
| the listing and model-info patches rewrote providers this plugin does not claim | measured |
| a relay's Go `/models` was answered with the Zen catalog | measured |
| the free-model check never read a `Request` body, which is how DSH sends a turn | measured |
| the meter's session fallback picked the newest session, not the one that just ran | measured |
| a key's tier was read from its prefix; `oc_sk_` keys are issued for Go too | measured |
| the store-inspection row called a namespace the client never mounted | measured |
| the credential reader's legacy-row fallback was not per integration, so it hid the Zen key | measured |

## Phase 1 — one credential resolver

**Problem.** Six places decide "which key for which plane", with different rules:

| Site | How it differs |
| :-- | :-- |
| `fetch-patch.ts` | ignores `KEY_SOURCE_ORDER` except for `configured`; hard-codes the env names; never reads the row's `apiKeyEnv` or literal key |
| `lifecycle.ts` `hasPlaneCredential` | reads `process.env` directly; asks for a captured key with no tier, so a Zen key satisfies Go |
| `go-discovery.ts` `resolveGoApiKey` | follows the policy order and filters placeholders — the reference behaviour |
| `go-discovery.ts` `resolveZenCreditInfo` | goes through `resolveRef`, which has no placeholder filter, so `OPENCODE_API_KEY=unused` counts as configured |
| `go-discovery.ts` `resolveRoutedKey` | exported, but no `src/` caller (_traced_) |
| `google-bridge.ts` `resolveGatewayKey` | no placeholder filter; throws on a miss; never reaches the installation store, because the caller always passes a reference (_traced_) |

**Plan.**

1. Write a **parity test first**: one table of inputs (policy × which sources hold a key × plane), asserted against every site above. Its failures are the real list of differences; record each as either "intended" or "bug".
2. Add `src/utils/credential-policy.ts`, which is pure: `chooseCredential({ plane, policy, sources })`, where `sources` holds values (request key, captured, declared env value, literal, store) rather than readers. It returns `{ key, source }` and applies the placeholder filter once.
3. Add `src/credentials.ts`, the effect half. It gathers the source values for a plane from the context, `process.env` and the capture store, then asks the utility.
4. Move each caller onto it, one per commit, with the parity test green after each. `hasPlaneCredential` becomes a thin wrapper that is still synchronous (it skips the async store).
5. Replace the module-level capture maps with a `CaptureStore` instance owned per root. Clear a key on a `401` answer, so a rotated key stops being sent.
6. `resolveRoutedKey` is a public export, so removing it is a breaking change. Mark it `@deprecated` in this phase and remove it in the next major.

**Done when** the parity test has one row per policy × source combination and every site answers it identically, and `grep process.env src/fetch-patch.ts src/lifecycle.ts src/google-bridge.ts` is empty.

## Phase 2 — one source per table

**Problem.** These tables are written more than once, and the copies drift:

- `PROTOCOL_FOR_SDK` (`responses-routes.ts`) and `GATEWAY_PROTOCOL_FOR_SDK` (`pi-provider.ts`) are identical. A comment says one has an extra entry; it does not.
- `PLANES` (`responses-routes.ts`) is a literal copy of `LEGACY_PLANE_API` (`pi-provider.ts`). A comment says they are the same table.
- There are four route-to-plane maps: `catalogPlaneForRoute`, `isPlaneRoute`, `responses-routes` `PLANES`, and `purge-service` `PLANES`.
- `ALL_THINKING_LEVELS` is defined twice. There are two `formatUsd` functions, with different contracts.
- **The picker and dispatch derive reasoning levels differently** (_measured_: 9 of 95 catalog models conflict). For a model with an on/off reasoning switch (`glm-5`, `minimax-m3`, `qwen3.7-plus`, …), the picker offers low, medium and high as separate levels, while dispatch sends all three as `on`. A comment in `models-discovery.ts` says the two never disagree.
- The model-metadata rule (overrides, context window, efforts, endpoint repair) is written four times: `toDiscovered` in `lifecycle.ts`, and `resolveModel`, `modelOf` and `decorateModelInfo` in `models-discovery.ts`. For the context window, the picker shows the catalog's value while dispatch keeps the adapter's.

**Plan.**

1. Add `src/utils/protocols.ts`: the SDK constants, the one protocol map, the plane table and the one `planeForRoute`. Derive `ROUTE_FOR_PROTOCOL` from it. `pi-provider` and `responses-routes` import from it, which also removes the import cycle that kept `PLANES` from being an alias.
2. Add `src/utils/model-metadata.ts`, pure: the override merge, the effective window, efforts and the reasoning map. The picker's levels and dispatch's map come from one function, so they cannot disagree.
3. Tests:
   - a property test over the **whole bundled catalog**, asserting picker levels ⇔ dispatch map for every model. It fails today on the 9 models above.
   - the same for the context window across `toDiscovered`, `decorateModelInfo` and `modelOf`.
4. **Decision needed:** what a toggle model's picker should offer. Either just "on/off", or the three levels with a note that they are equivalent. The first is closer to the vendor's own client.

**Done when** each table has one definition (a grep for each name finds one `export const`), and the catalog-wide property test passes.

## Phase 3 — a lifecycle for host patches

**Problem.**

- A live reload applies the new activation before it disposes the old one (`lifecycle.ts` documents this).
- Under that ordering, the identity-checked restores (`hideResponsesRoute`, `decorateModelDiscovery`, `decorateModelInfo`) never restore, so each reload leaves another wrapper in the chain.
- `decoratePlaneAdapters` restores unconditionally. The old activation's disposer strips the new one's wrappers, and the new disposer later puts back the old closures.
- `registeredRoutes` in `models-discovery.ts` is never cleared.
- The three root-scoped services each copy the same mount-once logic, with different logging (`console.warn` in two places, `ctx.logger` in one). `installUsageService` also captures the first activation's config for the life of the process.

**Plan.**

1. Build the test harness before any fix. Extract the faithful fake cordis from `test/responses-provider.test.ts` (`createHost`) into `test/support/fake-cordis.ts`. Add `test/reload.test.ts`, which runs:

   ```
   apply A → apply B → dispose A → assert B fully patched
                     → dispose B → assert every host method is the original
   ```

   for every patched method. It fails today.

2. Add one `patchMethod(target, key, impl)` that returns a disposer which restores **only if its own wrapper is still the current value**, and splices itself out of a chain otherwise. Use it at all four patch sites.
3. Add one `mountOncePerRoot(ctx, name, Service, options)` for the three services, reporting through `ctx.logger` with a console fallback. Each service reads its settings from the latest activation, as model discovery now does.

**Done when** the reload test passes for every host method this plugin replaces.

## Phase 4 — the protocol mount and the Gemini bridge

**Problem (traced).**

- `google-bridge.ts` finds the host's `dsh-llm-pi-ai` from the plugin's own location, while `responses-provider.ts` finds it from `ctx.baseUrl`. Under a `link:` install, pi can come from this repository's dev tree while the adapter class comes from the host's copy. That is the version skew the module header says it prevents.
- `internalRoutes: false` does not stop the bridge. The gap report then warns that every Gemini model "speaks a protocol no route serves", because bridge routes are never added to `served`.
- The bridge registers through `llm.registerAdapter.bind(llm)`, after awaits, and does not re-check the routes it saw at the start. An in-flight mount from the old activation can collide with the new one.
- `adapter-replacement.ts` is not wired. It also calls `registerAdapter` detached, without `this`, and its restore writes the map directly, so no `llm/adapters-updated` event fires.

**Plan.**

1. One `resolveHostPackage(ctx)` from `ctx.baseUrl`; pi is resolved from that wrapper's own location.
2. Move the bridge loop into `google-bridge.ts` as `mountGoogleBridges`, as its own installer, with its own disposer and the existing containment.
3. Add bridge routes to `served`. **Decision needed:** whether `internalRoutes: false` turns the bridge off. The config docs suggest it should.
4. Re-read the registered routes immediately before each register.
5. `adapter-replacement.ts`: either wire it, with a test against a class-based registry that reads `this`, or delete it. A module that is "the next step" for several releases is a module to delete.

## Phase 5 — catalog state

**Problem.**

- `parseModelsDevCatalog` clears module-level sets as a side effect, and it is a public export.
- `refreshCatalog` merges into the old maps and never removes anything, so a model retired after the shim was generated stays offered.
- The shim carries no deprecated ids, so `isDeprecatedModelOn` is always false before the first refresh.
- `lastRefreshSucceeded` is global. A background success can mask a failed forced refresh, which the purge then reports as `catalogRead: true`.
- The shim staleness check compares only the model arrays, so a move of the plane endpoints reads as "current".

**Plan.**

1. Make the parse pure: it returns `deprecated` and touches nothing.
2. Make refresh replace the maps rather than merge into them.
3. The refresh promise resolves `{ ok, deprecated }`, and the purge reads that rather than a global.
4. The generator emits the deprecated sets, and the staleness check compares the generator's whole output.
5. **Decision needed.** `toDiscovered` publishes the whole plane catalog under `opencode` and `opencode-go`, while `mergeDiscoveredModels` documents that discovery must never be widened past what the deployment declared. Both are active. Pick one and delete the other.
6. Purge: make one `edit` per entry that does both passes and skips entries with no change. Today every entry is rewritten, in two separate edits.

## Phase 6 — modules named after one subject

After phases 1–3 pin the behaviour, split these. Each split is a move with no behaviour change, verified by the unchanged suite.

| Module | Lines | Becomes |
| :-- | --: | :-- |
| `models-discovery.ts` | 1191 | `discovery-merge.ts`, `listing-policy.ts` (with a `route-registry.ts`), `plane-adapters.ts`, `model-info.ts`, and `utils/model-metadata.ts` from phase 2 |
| `responses-provider.ts` | 1213 | the loader and host-package lookups move to `cordis-context.ts`, which removes the third copy of `loaderOfContext`; `reasoningEffortsFor`, `modelsForSdk` and the declared-model diffs move to `utils/`, taking the catalog as a parameter |
| `go-discovery.ts` | 724 | `declaredProviderModels` moves next to discovery, on a shared `providerRows(ctx)`; credential parts go to phase 1's module |
| `usage-ui.ts` | 974 | `usage-styles.ts` (the 445-line stylesheet), `usage-time.ts`, `usage-copy.ts`, `usage-failure.ts` |
| `fetch-patch.ts` | 500 | a staged pipeline: claim → credential → headers → body, each stage a pure function in `utils/` over values. The body is parsed once, not up to three times per request. |

## Phase 7 — the remote seam

**Problem.**

- `"opencodeGoUsage"` is spelled as a literal 11 times across 5 files (_measured_).
- The `Object.defineProperty` remote marker block is copied three times.
- Result unwrapping is hand-written four times. `settings-purge.ts` still reports an `{ ok: false, error }` answer as "not a purge result" rather than the host's reason (_traced_); phase 0 fixed `settings-store.ts` only.
- `isGoUsage` in `settings-usage.tsx` is a third, looser validator next to `parseGoUsage`.

**Plan.** Each contract exports `{ namespace, methods, descriptors }`. Add one host helper, `markRemote(prototype, contract)`, and one client helper, `callRemote(scope, contract, method, argument)`, which unwraps the envelope and parses with the contract's codec. `remote-contract.test.ts` then reads the contracts directly instead of grepping.

## Phase 8 — test infrastructure

1. Make `architecture.test.ts`'s `utils/` walk recursive. It reads only the top level today.
2. `client-bundle.test.ts` runs against whatever is in `lib/`, which can be stale. Build first, or fail with "lib/ is older than src/" rather than testing an old artifact.
3. Bring the 23 lint warnings in `src/` to zero, then make warnings gating for `src/`.
4. Add per-file coverage floors for `fetch-patch.ts`, `lifecycle.ts` and `models-discovery.ts`, the three modules every request crosses.
5. Optionally, run mutation testing (Stryker) on `src/utils/`. That folder is pure by construction, so it is cheap there, and it measures whether the assertions would notice a changed branch, which line coverage does not.
6. Session spend: the store is never evicted, and `history` is copied on every turn but never read. Cap the store with LRU eviction, and drop `history` or give it a reader.

## Phase 9 — UI, against the house rules

- `usage-pill.tsx` re-implements outside-pointer dismissal and the hover grace that `@deepseek-ai/dsh-client-ui-primitives` ships. The house rule is to start from the host's built-ins.
- `settings-choice-field.tsx` hard-codes a stroke colour, which the house rule ("opt into the theme; do not re-declare it") forbids.

## Order, and why

```
0 ──► 1 ──► 3 ──► 6
      │     │
      ▼     ▼
      2     4 ──► 5
                  7, 8, 9 at any point
```

- **1 before 6.** Splitting `go-discovery.ts` before there is one resolver would split six rules into more files.
- **3 before 4.** The bridge's reload collision is one case of the general patch lifecycle.
- **2 is independent** of 1 and can land in parallel. Its property test is the cheapest high-value test in the plan.
- **6 last of the structural work.** A move is safe only when the suite pins the behaviour being moved, and phases 1–3 add the missing pins.

## Decisions the plan needs from the owner

1. What a toggle-reasoning model's picker offers (phase 2).
2. Whether `internalRoutes: false` turns off the Gemini bridge (phase 4).
3. Whether to wire or delete `adapter-replacement.ts` (phase 4).
4. Which discovery policy holds: publish the plane catalog, or never widen past the declaration (phase 5).
5. When to remove the deprecated `resolveRoutedKey` export, which is breaking (phase 1).
