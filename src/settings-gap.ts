/**
 * The card's two calls about the catalog gap: read it, and close it.
 *
 * Both go through the same Remote guard as the other card actions, and both name
 * every failure instead of collapsing it into `undefined` — "no service", "no
 * config editor" and "the host refused" are three different problems for whoever
 * clicks.
 *
 * @module dsh-opencode-patch/settings-gap
 */

import {
  GAP_NAMESPACE,
  type CatalogGapReport,
  type DeclareResult,
} from "./model-gap-contract.ts";
import { remoteNamespace, remoteNamespaceOf } from "./settings-remote.ts";
import { isRecord } from "./utils/guards.ts";

/** What one read of the gap produced. */
export type GapOutcome =
  | { readonly kind: "read"; readonly report: CatalogGapReport }
  | { readonly kind: "unavailable" }
  | { readonly kind: "failed"; readonly message: string };

/** What one declare produced. */
export type DeclareOutcome =
  | { readonly kind: "declared"; readonly result: DeclareResult }
  | { readonly kind: "unavailable" }
  | { readonly kind: "failed"; readonly message: string };

const namespaceOf = (scope: unknown) =>
  remoteNamespaceOf(scope, GAP_NAMESPACE) ??
  remoteNamespace(isRecord(scope) ? scope.remote : undefined, GAP_NAMESPACE);

/**
 * The message one failure carries, whatever was thrown.
 *
 * Exported and pure because the `unknown` half is a branch nobody can reach from
 * a Promise: a rejection reason is not required to be an Error, and a transport
 * that surfaces a string must not crash the caller's error path. Testing it here
 * is the only way to exercise that branch without writing a rejection the lint
 * rules correctly refuse.
 *
 * @param error - anything thrown or rejected.
 * @returns its message when it is an Error, its string form otherwise.
 */
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The value inside a `{ ok, value }` envelope, or the value itself. */
const valueOf = (answer: unknown): unknown =>
  isRecord(answer) && "value" in answer ? answer.value : answer;

/**
 * Ask the host which catalog models this deployment does not declare.
 *
 * @param scope - the settings scope the card was rendered with.
 * @returns the outcome; never throws.
 */
export const readGap = async (scope: unknown): Promise<GapOutcome> => {
  const call = namespaceOf(scope)?.gap;
  if (typeof call !== "function") {
    console.warn(
      "[dsh-opencode-patch] gap: no opencodeModelGap service on the remote"
    );
    return { kind: "unavailable" };
  }
  try {
    const value = valueOf(await call());
    if (!isRecord(value) || !Array.isArray(value.planes)) {
      return {
        kind: "failed",
        message: "the host answered something that is not a gap report",
      };
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the shape was just checked field by field.
    return { kind: "read", report: value as unknown as CatalogGapReport };
  } catch (error: unknown) {
    return { kind: "failed", message: messageOf(error) };
  }
};

/**
 * Ask the host to append models to a route's declaration.
 *
 * @param scope - the settings scope the card was rendered with.
 * @param route - `opencode` (Zen) or `opencode-go`.
 * @param ids - the catalog ids to declare.
 * @returns the outcome; never throws.
 */
export const declareModels = async (
  scope: unknown,
  route: string,
  ids: readonly string[]
): Promise<DeclareOutcome> => {
  const call = namespaceOf(scope)?.declare;
  if (typeof call !== "function") {
    console.warn(
      "[dsh-opencode-patch] declare: no opencodeModelGap service on the remote"
    );
    return { kind: "unavailable" };
  }
  try {
    const value = valueOf(await call({ ids, route }));
    if (!isRecord(value) || !Array.isArray(value.added)) {
      return {
        kind: "failed",
        message: "the host answered something that is not a declare result",
      };
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the shape was just checked field by field.
    return { kind: "declared", result: value as unknown as DeclareResult };
  } catch (error: unknown) {
    return { kind: "failed", message: messageOf(error) };
  }
};
