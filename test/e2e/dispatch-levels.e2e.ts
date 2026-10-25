/**
 * Dispatch against the real rule, live: a toggle model's "On" is a wire value
 * the gateway takes.
 *
 * Two readers decide whether a turn's saved thinking level survives. The
 * composer renders the Effort row the plane adapter answers, and dispatch
 * validates the saved effort with `getSupportedThinkingLevels` against the
 * model object the adapter built. Before P-R1 those were two decorators over
 * pi-ai's adapter, and when they disagreed `glm-5.3-flash-free` offered `high`
 * and `max` beside its name in the composer and answered
 * UNSUPPORTED_REASONING_EFFORT for both. Now both come from one rule
 * (`reasoningFor`, D1) folded into one model object (`planeModelFor`).
 *
 * The offline half — pi's own rule swept over the whole shipped catalog on both
 * planes, the offered levels exactly the accepted ones — is
 * `test/dispatch-levels.test.ts`, in the unit suite: it needs no network and no
 * port.
 *
 * This block is live and keyed: one toggle-only model per plane and
 * protocol, sent through the plane adapter on a tier-A host with the effort id
 * the picker's "On" carries, so the adapter builds the wire value and a
 * gateway that refuses it fails here rather than in a user's turn. It runs on
 * the `full` tier of `OPENCODE_E2E_KEYED` (the default when it is unset; CI
 * runs it nightly and on dispatch), and skips without the plane's key, on a
 * lower tier, and when no toggle model was entitled on the account (none
 * reached the gateway's body check).
 *
 * Opt-in (`OPENCODE_E2E=1`), like every file in this suite.
 */

import { describe, expect, it } from "vitest";

import { e2e } from "../support/e2e-env.ts";
import {
  drainStream,
  fakeCredentials,
  mountTierA,
  waitForPlaneOwner,
} from "../support/host.ts";
import {
  type CatalogModelSpec,
  OPENCODE_FAMILY_API,
  OPENCODE_GO_CATALOG,
  OPENCODE_ZEN_CATALOG,
  type Protocol,
  protocolForSdk,
  reasoningFor,
} from "../support/src.ts";

/** The process's own live-suite environment, read once at import. */
const E2E = e2e();

const ENABLED = E2E.live;

/**
 * The two plane routes, the catalog and family map each resolves from, and its
 * key — armed on the `full` tier only (`E2E.keyFor`), which is what may spend
 * one here.
 */
const PLANES = [
  {
    catalog: OPENCODE_ZEN_CATALOG,
    family: OPENCODE_FAMILY_API.zen,
    key: E2E.keyFor("opencode", "full"),
    route: "opencode",
  },
  {
    catalog: OPENCODE_GO_CATALOG,
    family: OPENCODE_FAMILY_API.go,
    key: E2E.keyFor("opencode-go", "full"),
    route: "opencode-go",
  },
] as const;

/** The first toggle-only model of each protocol on a plane: its efforts are named "On". */
const toggleModels = (
  plane: (typeof PLANES)[number]
): { spec: CatalogModelSpec; protocol: Protocol }[] => {
  const seen = new Map<Protocol, CatalogModelSpec>();
  for (const spec of plane.catalog) {
    const protocol = protocolForSdk(spec.provider_npm);
    if (protocol === undefined || seen.has(protocol)) {
      continue;
    }
    const reasoning = reasoningFor(spec, protocol);
    if (reasoning?.efforts.some((effort) => effort.name === "On") === true) {
      seen.set(protocol, spec);
    }
  }
  return [...seen].map(([protocol, spec]) => ({ protocol, spec }));
};

/** An answer about the account, not the wire: no paid access, no funds, rate limited. */
const ENTITLEMENT =
  /\b40[23]\b|\b429\b|access is disabled|Insufficient account funds/iu;

describe.skipIf(!ENABLED)(
  "live · a toggle model's On is a wire value the gateway takes",
  () => {
    const keyed = (plane: (typeof PLANES)[number]): boolean =>
      plane.key !== undefined && plane.key.length > 0;

    it.for(PLANES)(
      "$route: every toggle-only protocol accepts On through the plane adapter",
      { timeout: 120_000 },
      async (plane, context) => {
        // Without the plane's key there is nothing to send: reported as
        // skipped, never as a pass.
        context.skip(!keyed(plane), "no key for this plane");
        const toggles = toggleModels(plane);
        // Anti-vacuity: each plane carries at least one toggle-only model.
        expect(toggles.length).toBeGreaterThan(0);
        const ref =
          plane.route === "opencode"
            ? "OPENCODE_API_KEY"
            : "OPENCODE_GO_API_KEY";
        const tier = await mountTierA({
          credentials: fakeCredentials({ refs: { [ref]: plane.key ?? "" } }),
          plugin: {},
          providers: {
            [plane.route]: {
              apiKeyEnv: ref,
              models: toggles.map(({ spec }) => ({ id: spec.id })),
            },
          },
        });
        try {
          await waitForPlaneOwner(tier.llm, [plane.route]);
          const refused: string[] = [];
          let reached = 0;
          for (const { protocol, spec } of toggles) {
            // The id the picker's "On" carries, read from what the adapter
            // answers rather than assumed.
            const info = (await tier.llm.resolveModelInfo(
              plane.route,
              spec.id
            )) as { reasoning?: { efforts?: { id: string; name: string }[] } };
            const on = info.reasoning?.efforts?.find(
              (effort) => effort.name === "On"
            )?.id;
            expect(on, `${spec.id} offers no On`).toBeDefined();
            const drained = await drainStream(tier.llm, plane.route, spec.id, {
              reasoningEffort: on,
              signal: AbortSignal.timeout(60_000),
            });
            const message = drained.failureMessage ?? drained.error ?? "";
            if (ENTITLEMENT.test(message)) {
              continue;
            }
            reached += 1;
            if (
              drained.error !== undefined ||
              drained.finish?.kind === "error"
            ) {
              refused.push(`${spec.id} (${protocol}): ${message}`);
            }
          }
          // Every toggle model refused on entitlement: nothing about the wire
          // was observed, which is a skip, never a pass.
          context.skip(
            reached === 0,
            "no toggle model was entitled on this account"
          );
          expect(refused).toEqual([]);
        } finally {
          await tier.dispose();
        }
      }
    );
  }
);
