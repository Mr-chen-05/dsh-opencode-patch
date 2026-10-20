// @vitest-environment jsdom
/**
 * The purge row's presence and its one interaction.
 *
 * The card is a pure view: calling it returns the stub tree, so this walks that
 * tree rather than mounting a DOM. The action itself is tested separately; what
 * is asserted here is that the row exists only when the host can act, and that
 * the callback it receives is the one the page passed.
 */
import { describe, expect, it, vi } from "vitest";

import { OpencodeCard, purgeLine } from "../src/settings-card.tsx";

interface StubNode {
  props: Record<string, unknown>;
  type: unknown;
}

/** Every node in the stub tree, depth-first. */
const nodes = (value: unknown): StubNode[] => {
  if (Array.isArray(value)) {
    return value.flatMap((child: unknown) => nodes(child));
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const node = value as Partial<StubNode>;
  if (!("type" in node) || !("props" in node) || node.props === undefined) {
    return [];
  }
  const { children } = node.props;
  return [node as StubNode, ...nodes(children)];
};

const state = {
  fields: {},
  shell: {
    available: true,
    dirty: false,
    failed: false,
    invalid: false,
    saving: false,
    writable: true,
  },
};

const props = (extra: Record<string, unknown>) =>
  ({
    discard: () => {},
    edit: () => {},
    resetField: () => {},
    save: () => {},
    t: (key: string) => key,
    useOpencodeCard: (selector: (s: typeof state) => unknown) =>
      selector(state),
    view: "page",
    ...extra,
  }) as never;

/** The row is the node the card hands an `onPurge` callback to. */
const rowOf = (tree: unknown) =>
  nodes(tree).find((node) => typeof node.props.onPurge === "function");

describe("settings-card: the purge row", () => {
  it("is absent when the host mounted no purge action", () => {
    expect(rowOf(OpencodeCard(props({})))).toBeUndefined();
  });

  it("hands the action to the row when the host offers one", async () => {
    const purgeDeprecated = vi.fn(async () => ({
      kind: "purged",
      result: { catalogRead: true, removed: [] },
    }));
    const row = rowOf(OpencodeCard(props({ purgeDeprecated })));
    if (row === undefined) {
      throw new TypeError("the card rendered no purge row");
    }
    await (row.props.onPurge as () => Promise<unknown>)();
    expect(purgeDeprecated).toHaveBeenCalledTimes(1);
  });
});

describe("settings-card: what a purge outcome says", () => {
  const t = (key: string): string => key;

  it("reports the count when something was removed", () => {
    const view = purgeLine(t, {
      kind: "purged",
      result: {
        catalogRead: true,
        removed: [
          { id: "a", provider: "opencode" },
          { id: "b", provider: "opencode-go" },
        ],
      },
    });
    expect(view).toEqual({ line: "2 purgeRemoved", warn: false });
  });

  it("distinguishes a clean list from a catalog that could not be read", () => {
    expect(
      purgeLine(t, {
        kind: "purged",
        result: { catalogRead: true, removed: [] },
      })
    ).toEqual({ line: "purgeNothing", warn: false });
    expect(
      purgeLine(t, {
        kind: "purged",
        result: { catalogRead: false, removed: [] },
      })
    ).toEqual({ line: "purgeCatalogUnread", warn: true });
  });

  it("shows a refusal as a warning with its message", () => {
    expect(purgeLine(t, { kind: "unavailable" })).toEqual({
      line: "purgeUnavailable",
      warn: true,
    });
    expect(purgeLine(t, { kind: "failed", message: "boom" })).toEqual({
      line: "purgeFailed: boom",
      warn: true,
    });
  });
});
