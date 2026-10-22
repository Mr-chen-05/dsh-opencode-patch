// @vitest-environment jsdom
/**
 * The catalog-gap row: what it says for each answer, and that its two buttons
 * actually perform their calls.
 *
 * The report is a pure function, so every branch is asserted without React; the
 * mounted cases then reach the two states a static render cannot (busy, and the
 * line a declare leaves behind).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock(
  "@deepseek-ai/dsh-client-ui-primitives",
  () => import("./support/ui-primitives.ts")
);

import type { CatalogGapEntry } from "../src/model-gap-contract.ts";
import { en } from "../src/settings-copy.ts";
import { declareLine, gapLine, GapRow } from "../src/settings-gap-row.tsx";
import type { DeclareOutcome, GapOutcome } from "../src/settings-gap.ts";

const t = (key: string): string =>
  (en as unknown as Record<string, string>)[key] ?? key;

const freeEntry = (id: string, name: string): CatalogGapEntry => ({
  contextWindow: 200_000,
  free: true,
  id,
  maxTokens: 32_000,
  name,
});

const paidEntry = (id: string): CatalogGapEntry => ({
  contextWindow: 1_000_000,
  free: false,
  id,
  maxTokens: 64_000,
  name: id,
});

const read = (planes: unknown[], catalogRead = true): GapOutcome => ({
  kind: "read",
  report: {
    catalogRead,
    planes: planes as never,
  },
});

describe("settings-gap-row: the report", () => {
  it("splits each plane into the free models it can add and the paid it will not", () => {
    const report = gapLine(
      t,
      read([
        {
          declared: ["mimo-v2.6-flash-free"],
          missing: [
            freeEntry("glm-5.3-flash-free", "GLM-5.3-Flash Free"),
            paidEntry("paid-model"),
          ],
          route: "opencode",
        },
      ])
    );
    expect(report.planes).toHaveLength(1);
    expect(report.planes[0]?.free.map((entry) => entry.id)).toEqual([
      "glm-5.3-flash-free",
    ]);
    expect(report.planes[0]?.paid).toBe(1);
    expect(report.warn).toBe(false);
    expect(report.note).toBeUndefined();
  });

  it("says nothing is undeclared when both sides are empty", () => {
    const report = gapLine(
      t,
      read([{ declared: ["a"], missing: [], route: "opencode" }])
    );
    expect(report.note).toBe(t("gapNone"));
    expect(report.warn).toBe(false);
  });

  it("distinguishes an unreadable catalog from an empty one", () => {
    // The distinction that matters: "nothing is missing" and "nothing could be
    // compared" look identical in the data and mean opposite things.
    const report = gapLine(t, read([], false));
    expect(report.note).toBe(t("gapCatalogUnread"));
    expect(report.warn).toBe(true);
  });

  it("says the host mounted no gap service", () => {
    const report = gapLine(t, { kind: "unavailable" });
    expect(report.note).toBe(t("gapUnavailable"));
    expect(report.warn).toBe(true);
  });

  it("carries the host's message when the read failed", () => {
    const report = gapLine(t, { kind: "failed", message: "boom" });
    expect(report.note).toBe(`${t("gapFailed")}: boom`);
    expect(report.warn).toBe(true);
  });
});

describe("settings-gap-row: the declare line", () => {
  it("counts what was added", () => {
    const line = declareLine(t, {
      kind: "declared",
      result: { added: ["a", "b"], route: "opencode" },
    });
    expect(line.line).toBe(`2 ${t("gapAdded")}`);
    expect(line.warn).toBe(false);
  });

  it("says so when there was nothing to add", () => {
    const line = declareLine(t, {
      kind: "declared",
      result: { added: [], route: "opencode" },
    });
    expect(line.line).toBe(t("gapNothingAdded"));
    expect(line.warn).toBe(false);
  });

  it("warns on the two failure outcomes", () => {
    expect(declareLine(t, { kind: "unavailable" })).toEqual({
      line: t("gapUnavailable"),
      warn: true,
    });
    expect(declareLine(t, { kind: "failed", message: "x" })).toEqual({
      line: `${t("gapFailed")}: x`,
      warn: true,
    });
  });
});

describe("settings-gap-row: the row", () => {
  it("renders the heading, the hint and the action", () => {
    const html = renderToStaticMarkup(
      createElement(GapRow, {
        onDeclare: () =>
          Promise.resolve<DeclareOutcome>({ kind: "unavailable" }),
        onRead: () => Promise.resolve<GapOutcome>({ kind: "unavailable" }),
        t,
      })
    );
    expect(html).toContain(t("gapTitle"));
    expect(html).toContain(t("gapHint"));
    expect(html).toContain(t("gapCheck"));
  });

  it("reads the gap, then declares the free models it found", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");

    const onRead = vi.fn(() =>
      Promise.resolve<GapOutcome>(
        read([
          {
            declared: [],
            missing: [freeEntry("glm-5.3-flash-free", "GLM-5.3-Flash Free")],
            route: "opencode",
          },
        ])
      )
    );
    const onDeclare = vi.fn(() =>
      Promise.resolve<DeclareOutcome>({
        kind: "declared",
        result: { added: ["glm-5.3-flash-free"], route: "opencode" },
      })
    );

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const settle = async (): Promise<void> => {
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      });
    };
    try {
      act(() => {
        root.render(createElement(GapRow, { onDeclare, onRead, t }));
      });
      const check = [...host.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").includes(t("gapCheck"))
      );
      expect(check, "the check button must be rendered").toBeDefined();
      act(() => {
        check?.click();
      });
      await settle();

      // The free model is named, and the button that declares it is offered.
      expect(host.textContent).toContain("GLM-5.3-Flash Free");
      const add = [...host.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").includes(t("gapAddFree"))
      );
      expect(add, "the add button must be rendered").toBeDefined();

      act(() => {
        add?.click();
      });
      await settle();

      expect(onDeclare).toHaveBeenCalledWith("opencode", [
        "glm-5.3-flash-free",
      ]);
      expect(host.textContent).toContain(`1 ${t("gapAdded")}`);
    } finally {
      act(() => {
        root.unmount();
      });
      host.remove();
    }
  });
});

describe("settings-gap-row: the states only a click reaches", () => {
  /** Mount the row over the given read/declare answers. */
  const mount = async (
    onRead: () => Promise<GapOutcome>,
    onDeclare: () => Promise<DeclareOutcome>
  ) => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const settle = async (): Promise<void> => {
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      });
    };
    const click = (label: string): void => {
      const button = [...host.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").includes(label)
      );
      act(() => {
        button?.click();
      });
    };
    const cleanup = (): void => {
      act(() => {
        root.unmount();
      });
      host.remove();
    };
    act(() => {
      root.render(createElement(GapRow, { onDeclare, onRead, t }));
    });
    return { cleanup, click, host, settle };
  };

  it("names the paid models it left alone, and warns when the catalog was unread", async () => {
    const view = await mount(
      () =>
        Promise.resolve<GapOutcome>(
          read([
            {
              declared: [],
              missing: [paidEntry("paid-model")],
              route: "opencode",
            },
          ])
        ),
      () => Promise.resolve<DeclareOutcome>({ kind: "unavailable" })
    );
    try {
      view.click(t("gapCheck"));
      await view.settle();
      expect(view.host.textContent).toContain(t("gapPaidOnly"));
    } finally {
      view.cleanup();
    }
  });

  it("renders the unreadable-catalog note as a warning", async () => {
    const view = await mount(
      () => Promise.resolve<GapOutcome>(read([], false)),
      () => Promise.resolve<DeclareOutcome>({ kind: "unavailable" })
    );
    try {
      view.click(t("gapCheck"));
      await view.settle();
      expect(view.host.textContent).toContain(t("gapCatalogUnread"));
    } finally {
      view.cleanup();
    }
  });

  it("shows a failed declare as a warning line", async () => {
    const view = await mount(
      () =>
        Promise.resolve<GapOutcome>(
          read([
            {
              declared: [],
              missing: [freeEntry("glm-5.3-flash-free", "GLM-5.3-Flash Free")],
              route: "opencode",
            },
          ])
        ),
      () => Promise.resolve<DeclareOutcome>({ kind: "failed", message: "boom" })
    );
    try {
      view.click(t("gapCheck"));
      await view.settle();
      view.click(t("gapAddFree"));
      await view.settle();
      expect(view.host.textContent).toContain(`${t("gapFailed")}: boom`);
    } finally {
      view.cleanup();
    }
  });
});
