/**
 * Verify the catalog, the picker's join, and the routing table against each other.
 *
 * This exists because the failures it catches are all INVISIBLE from the outside: a
 * model that is dropped is not filtered, not deprecated and not erroring — it is
 * simply absent. Four separate bugs in this repository had that shape, and each one
 * was found by a hand-written script that was then thrown away. This is that script,
 * kept.
 *
 * Checks, in order:
 *
 * 1. **Shim freshness** — the bundled `catalog-data.ts` must match the live registry.
 * 2. **Dead rows** — no offered model may answer `400 Model is unavailable` or
 *    `410 ModelDeprecated` (needs `--probe`; otherwise skipped).
 * 3. **The picker's join** — every servable model must reach `listModels(parentRoute)`,
 *    which is `listProviders() × listModels(id)` and is where 55 models went missing.
 * 4. **Routing** — every servable model must resolve to a route this plugin mounts.
 * 5. **Free-tier tools** — every free model must get the core-tool fallback.
 *
 * Usage:
 *
 * ```sh
 * node --experimental-strip-types scripts/verify-catalog.ts
 * node --experimental-strip-types scripts/verify-catalog.ts --probe
 * ```
 *
 * Exit code is 1 when any check fails, so it can gate a release.
 *
 * @module scripts/verify-catalog
 */

import {
  getLiveGoCatalog,
  getLiveZenCatalog,
  isRetiredModel,
  MODELS_OPENCODE_URL,
  parseModelsDevCatalog,
} from "../src/models-catalog.ts";
import {
  isServableModel,
  mergeDiscoveredModels,
} from "../src/models-discovery.ts";
import {
  internalRouteFor,
  ROUTE_FOR_PLANE_PROTOCOL,
} from "../src/responses-routes.ts";
import { openCodeSessionIdFor } from "../src/session.ts";
import { isCoreToolModel } from "../src/tool-fallback.ts";

const PROBE = process.argv.includes("--probe");
const failures: string[] = [];

const fail = (message: string): void => {
  failures.push(message);
  console.log(`  FAIL  ${message}`);
};

const ok = (message: string): void => {
  console.log(`  ok    ${message}`);
};

/** The routes this plugin mounts: both plane roots plus the plane table. */
const mountedRoutes = (): ReadonlySet<string> => {
  const routes = new Set<string>(["opencode", "opencode-go"]);
  for (const plane of Object.values(ROUTE_FOR_PLANE_PROTOCOL)) {
    for (const route of Object.values(plane.routes)) {
      routes.add(route);
    }
  }
  return routes;
};

// ── 1. Shim freshness ───────────────────────────────────────────────────────
console.log("\n1. shim freshness");
try {
  const response = await fetch(MODELS_OPENCODE_URL, {
    signal: AbortSignal.timeout(30_000),
  });
  const live = parseModelsDevCatalog(await response.json());
  for (const [plane, shipped, fresh] of [
    ["zen", getLiveZenCatalog(), live.zen],
    ["go", getLiveGoCatalog(), live.go],
  ] as const) {
    const shippedIds = new Set(shipped.map((m) => m.id));
    // The generator writes the live set MINUS the retired ids, so the comparison
    // has to apply the same filter. Comparing against the raw parse reports
    // `claude-sonnet-4` as "missing" — it is active in the registry, gone at the
    // gateway, and retired here, which is exactly why it is absent.
    const freshIds = new Set(
      fresh.filter((m) => !isRetiredModel(plane, m.id)).map((m) => m.id)
    );
    const missing = [...freshIds].filter((id) => !shippedIds.has(id));
    const extra = [...shippedIds].filter((id) => !freshIds.has(id));
    if (missing.length > 0 || extra.length > 0) {
      fail(
        `${plane} shim is stale: ${missing.length} missing, ${extra.length} extra ` +
          `(run scripts/regenerate-catalog-shim.ts --write)`
      );
    } else {
      ok(`${plane}: ${shippedIds.size} models match the registry`);
    }
  }
} catch (error) {
  console.log(`  skip  registry unreachable (${String(error).slice(0, 60)})`);
}

// ── 2. Dead rows ────────────────────────────────────────────────────────────
console.log(`\n2. dead rows ${PROBE ? "" : "(skipped: pass --probe)"}`);
if (PROBE) {
  // The gateway answers distinctly enough to classify every id with one token:
  // 401/403 means the model is there and only the credential is missing, 400
  // "Model is unavailable" and 410 ModelDeprecated mean it is gone.
  // **Probe each model on ITS OWN plane.** A Go-only model asked of the Zen
  // endpoint answers `400 Model is unavailable`, which reads as "gone" and is
  // not: it is on the other plane. The first version of this script did exactly
  // that and reported thirteen healthy Go models as dead.
  //
  // The Go plane also refuses a request carrying no session header ("Request is
  // missing x-opencode-session"), so one is minted for it.
  const session = openCodeSessionIdFor("verify-catalog");
  const classify = async (
    id: string,
    plane: "go" | "zen"
  ): Promise<"served" | "gone" | "unknown"> => {
    try {
      const endpoint =
        plane === "go"
          ? "https://opencode.ai/zen/go/v1/chat/completions"
          : "https://opencode.ai/zen/v1/chat/completions";
      const response = await fetch(endpoint, {
        body: JSON.stringify({
          max_tokens: 1,
          messages: [{ content: "hi", role: "user" }],
          model: id,
        }),
        headers: {
          "content-type": "application/json",
          ...(plane === "go"
            ? {
                "X-Session-Id": session,
                "x-opencode-session": session,
                "x-opencode-session-id": session,
                "x-session-affinity": session,
              }
            : {}),
        },
        method: "POST",
        signal: AbortSignal.timeout(25_000),
      });
      if (response.status === 401 || response.status === 403) {
        return "served";
      }
      if (response.status === 400 || response.status === 410) {
        return "gone";
      }
      return "unknown";
    } catch {
      return "unknown";
    }
  };
  const dead: string[] = [];
  for (const [plane, catalog] of [
    ["zen", getLiveZenCatalog()],
    ["go", getLiveGoCatalog()],
  ] as const) {
    for (const model of catalog) {
      if ((await classify(model.id, plane)) === "gone") {
        dead.push(`${plane}/${model.id}`);
      }
    }
  }
  if (dead.length > 0) {
    fail(`offered but gone: ${dead.join(", ")}`);
  } else {
    ok("every offered model answers");
  }
}

// ── 3. The picker's join ────────────────────────────────────────────────────
console.log("\n3. the picker's join");
for (const [route, catalog, plane] of [
  ["opencode", getLiveZenCatalog(), "zen"],
  ["opencode-go", getLiveGoCatalog(), "go"],
] as const) {
  // The adapter behind a parent route carries only its own protocol's models, so
  // the join is what publishes the rest. Simulated with an empty adapter list,
  // which is the worst case: everything must come from the catalog.
  const listed = mergeDiscoveredModels([], plane, catalog).filter((m) =>
    isServableModel(m.id, route)
  );
  const expected = catalog
    .filter((m) => isServableModel(m.id, route))
    .map((m) => m.id);
  const listedIds = new Set(listed.map((m) => m.id));
  const missing = expected.filter((id) => !listedIds.has(id));
  if (missing.length > 0) {
    fail(
      `${route}: ${missing.length} servable models never join: ${missing.slice(0, 5).join(", ")}`
    );
  } else {
    ok(`${route}: all ${expected.length} servable models are published`);
  }
}

// ── 4. Routing ──────────────────────────────────────────────────────────────
console.log("\n4. routing");
{
  const mounted = mountedRoutes();
  const unroutable: string[] = [];
  for (const [route, catalog] of [
    ["opencode", getLiveZenCatalog()],
    ["opencode-go", getLiveGoCatalog()],
  ] as const) {
    for (const model of catalog) {
      if (!isServableModel(model.id, route)) {
        continue;
      }
      const target = internalRouteFor(route, model.id, model.provider_npm);
      if (target !== undefined && !mounted.has(target)) {
        unroutable.push(`${route}/${model.id} -> ${target}`);
      }
    }
  }
  if (unroutable.length > 0) {
    fail(`unroutable: ${unroutable.join(", ")}`);
  } else {
    ok(
      `every servable model resolves to one of ${mounted.size} mounted routes`
    );
  }
}

// ── 5. Free-tier tools ──────────────────────────────────────────────────────
console.log("\n5. free-tier core tools");
{
  const uncovered: string[] = [];
  for (const model of [...getLiveZenCatalog(), ...getLiveGoCatalog()]) {
    if (model.is_free === true && !isCoreToolModel(model.id, "free")) {
      uncovered.push(model.id);
    }
  }
  if (uncovered.length > 0) {
    fail(`free models with no tool fallback: ${uncovered.join(", ")}`);
  } else {
    ok("every free model gets the core-tool fallback");
  }
}

// ── Verdict ─────────────────────────────────────────────────────────────────
console.log("");
if (failures.length > 0) {
  console.log(`FAILED: ${failures.length} check(s)`);
  process.exitCode = 1;
} else {
  console.log("PASS: catalog, join, routing and free-tier tools agree");
}
