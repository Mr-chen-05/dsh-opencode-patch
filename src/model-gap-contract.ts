/**
 * Contract for the catalog gap: which models the vendor offers that this
 * deployment has not declared.
 *
 * Pure data, safe for the client bundle (no `node:`, no context).
 *
 * The gap exists because the picker shows EXACTLY what the profile declares —
 * `mergeDiscoveredModels` deliberately never widens a list the plugin does not
 * own. That rule is right (a picker led by models the deployment never selected
 * looks like a working picker while serving nothing), and its cost is that a free
 * model the vendor ships this week is invisible until someone edits YAML. This
 * seam is how the card closes that gap without breaking the rule: the reader sees
 * what is available and chooses, so the declaration stays the user's.
 *
 * @module dsh-opencode-patch/model-gap-contract
 */

export const GAP_NAMESPACE = "opencodeModelGap";

/** One catalog model the deployment does not declare. */
export interface CatalogGapEntry {
  readonly contextWindow: number;
  readonly free: boolean;
  readonly id: string;
  readonly maxTokens: number;
  readonly name: string;
}

/** One provider route's gap. */
export interface CatalogGapPlane {
  /** Ids the profile declares, in declaration order. */
  readonly declared: readonly string[];
  /** Active catalog models that are NOT declared, free ones first. */
  readonly missing: readonly CatalogGapEntry[];
  readonly route: string;
}

/** What one read of the gap answers. */
export interface CatalogGapReport {
  /**
   * Whether the live catalog answered. `false` means `missing` is empty because
   * nothing could be compared, not because nothing is missing.
   */
  readonly catalogRead: boolean;
  readonly planes: readonly CatalogGapPlane[];
}

/** What one declare call answers. */
export interface DeclareResult {
  /** The ids actually written, in the order they were appended. */
  readonly added: readonly string[];
  /** The route whose declaration was rewritten. */
  readonly route: string;
}
