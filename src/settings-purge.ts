/**
 * The card's one destructive action: ask the host to delete the retired models
 * this deployment declares.
 *
 * The call is a Remote, like the quota read: the purge needs the profile and the
 * config editor, neither of which a browser has. Every failure is named rather
 * than collapsed into `undefined`, because "no service", "no config editor" and
 * "the host refused" are three different problems for whoever clicks it.
 *
 * @module dsh-opencode-patch/settings-purge
 */

import { isRecord } from "./guards.ts";
import { PURGE_NAMESPACE, type PurgeResult } from "./purge-contract.ts";
import { remoteNamespace, remoteNamespaceOf } from "./settings-remote.ts";

/** What one click produced, in a shape the card can render without guessing. */
export type PurgeOutcome =
  | { readonly kind: "purged"; readonly result: PurgeResult }
  | { readonly kind: "unavailable" }
  | { readonly kind: "failed"; readonly message: string };

/** The Remote's namespace, read through the shared guard (see settings-remote). */
const namespaceOf = (scope: unknown) =>
  remoteNamespaceOf(scope, PURGE_NAMESPACE) ??
  remoteNamespace(isRecord(scope) ? scope.remote : undefined, PURGE_NAMESPACE);

/**
 * Ask the host to purge, once.
 *
 * @param scope - the settings scope the card was rendered with.
 * @returns the outcome; never throws.
 */
export const purgeDeprecatedModels = async (
  scope: unknown
): Promise<PurgeOutcome> => {
  const namespace = namespaceOf(scope);
  const call = namespace?.purge;
  if (typeof call !== "function") {
    console.warn(
      "[dsh-opencode-patch] purge: no opencodeModelPurge service on the remote"
    );
    return { kind: "unavailable" };
  }
  try {
    const answer: unknown = await call();
    const value = isRecord(answer) && "value" in answer ? answer.value : answer;
    if (!isRecord(value) || !Array.isArray(value.removed)) {
      return {
        kind: "failed",
        message: "the host answered something that is not a purge result",
      };
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the shape was just checked field by field.
    return { kind: "purged", result: value as unknown as PurgeResult };
  } catch (error: unknown) {
    return {
      kind: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
};
