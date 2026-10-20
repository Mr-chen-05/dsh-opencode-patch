/**
 * What a purge answers, in a module both bundles may import.
 *
 * The client shows the count; the host computes it. Keeping the shape here
 * rather than in either side means the two cannot drift, and the bundle rule
 * (a client module reaches nothing host-only) is satisfied by construction.
 *
 * @module dsh-opencode-patch/purge-contract
 */

import type { RemoteResult } from "@deepseek-ai/dsh-typert-protocol";

/** One model removed from the deployment's own provider declaration. */
export interface PurgedModel {
  /** The provider route it was declared on, e.g. `opencode-go`. */
  readonly provider: string;
  /** The model id, as the profile spelled it. */
  readonly id: string;
}

/** The outcome of one purge. */
export interface PurgeResult {
  /** Every id removed, in declaration order. Empty when nothing was retired. */
  readonly removed: readonly PurgedModel[];
  /**
   * Whether the catalog had anything to say at all.
   *
   * `false` means the refresh did not land (offline, or a rejected reply) — the
   * distinction matters because "nothing was deprecated" and "the catalog could
   * not be read" otherwise produce the same empty list and the same sentence.
   */
  readonly catalogRead: boolean;
}

/** The remote namespace the host mounts and the card calls. */
export const PURGE_NAMESPACE = "opencodeModelPurge";

/** The one failure a purge reports: the profile cannot be rewritten here. */
export const PURGE_UNAVAILABLE = "opencode/purge-unavailable";

declare module "@deepseek-ai/dsh-typert-protocol" {
  interface RemoteErrorDetailsMap {
    "opencode/purge-unavailable": {
      /**
       * `false` for every rejection: a missing config editor and a profile with
       * no opencode provider are both states of the deployment, not transient
       * faults, so the card reports them instead of offering a retry.
       */
      readonly configured?: boolean;
      readonly retainPrevious?: boolean;
      readonly retryable?: boolean;
    };
  }
  interface TypertRemoteNamespaceMap {
    opencodeModelPurge: {
      purge: () => Promise<RemoteResult<PurgeResult>>;
    };
  }
}
