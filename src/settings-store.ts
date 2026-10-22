/**
 * Safe client-side Remote caller for inspecting the local OpenCode installation.
 *
 * Reads through the Cordis remote guard, handles unavailable remote/service,
 * and formats the outcome without throwing or leaking.
 *
 * @module dsh-opencode-patch/settings-store
 */

import {
  STORE_NAMESPACE,
  type OpencodeStoreInspection,
} from "./opencode-store-contract.ts";
import { remoteNamespace, remoteNamespaceOf } from "./settings-remote.ts";
import { isRecord } from "./utils/guards.ts";

export type StoreInspectOutcome =
  | { readonly kind: "inspected"; readonly inspection: OpencodeStoreInspection }
  | { readonly kind: "unavailable" }
  | { readonly kind: "failed"; readonly message: string };

const namespaceOf = (scope: unknown) =>
  remoteNamespaceOf(scope, STORE_NAMESPACE) ??
  remoteNamespace(isRecord(scope) ? scope.remote : undefined, STORE_NAMESPACE);

/**
 * Ask the host to inspect the local OpenCode installation.
 *
 * @param scope - the settings scope the card was rendered with.
 * @returns the outcome; never throws.
 */
export const inspectStore = async (
  scope: unknown
): Promise<StoreInspectOutcome> => {
  const namespace = namespaceOf(scope);
  const call = namespace?.inspect;
  if (typeof call !== "function") {
    console.warn(
      "[dsh-opencode-patch] store inspection: no opencodeStore service on the remote"
    );
    return { kind: "unavailable" };
  }
  try {
    const answer: unknown = await call();
    const value = isRecord(answer) && "value" in answer ? answer.value : answer;
    if (!isRecord(value) || typeof value.found !== "boolean") {
      return {
        kind: "failed",
        message: "host returned an invalid inspection shape",
      };
    }
    return {
      kind: "inspected",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      inspection: value as unknown as OpencodeStoreInspection,
    };
  } catch (error: unknown) {
    return {
      kind: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
};
