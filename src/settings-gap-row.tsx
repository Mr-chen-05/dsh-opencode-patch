/**
 * The "what does the vendor offer that I have not declared?" row.
 *
 * Why it exists: the picker shows exactly what the profile declares, because a
 * list the plugin does not own must never be widened by the plugin. That rule is
 * right and it has a cost the user feels directly — a free model the vendor ships
 * this week is invisible until someone edits YAML, which reads as "the plugin is
 * broken" rather than "nothing declared it".
 *
 * So the gap is shown, and closing it is one explicit click: the declaration stays
 * the user's, and the plugin only ever writes what was asked for.
 *
 * {@link gapLine} is pure, so every branch is asserted without React — the same
 * contract `purgeLine` and `inspectLine` keep.
 *
 * @module dsh-opencode-patch/settings-gap-row
 */

import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import React from "react";

import type { CatalogGapEntry } from "./model-gap-contract.ts";
import type { Translate } from "./settings-copy.ts";
import type { DeclareOutcome, GapOutcome } from "./settings-gap.ts";

/** One plane's line in the report. */
export interface GapPlaneLine {
  /** Free models that are not declared — the ones the button would add. */
  readonly free: readonly CatalogGapEntry[];
  readonly route: string;
  /** How many paid models are also undeclared, for honesty rather than action. */
  readonly paid: number;
}

/** What one gap read renders. */
export interface GapReport {
  readonly note?: string;
  readonly planes: readonly GapPlaneLine[];
  readonly warn: boolean;
}

/** The report for one gap read. Pure, so a test can call it. */
export const gapLine = (t: Translate, outcome: GapOutcome): GapReport => {
  if (outcome.kind === "unavailable") {
    return { note: t("gapUnavailable"), planes: [], warn: true };
  }
  if (outcome.kind === "failed") {
    return {
      note: `${t("gapFailed")}: ${outcome.message}`,
      planes: [],
      warn: true,
    };
  }
  const { report } = outcome;
  // "Nothing is missing" and "nothing could be compared" are different answers,
  // and the shipped shim makes the second one ordinary on a cold start.
  if (!report.catalogRead) {
    return { note: t("gapCatalogUnread"), planes: [], warn: true };
  }
  const planes = report.planes.map((plane) => ({
    free: plane.missing.filter((entry) => entry.free),
    paid: plane.missing.filter((entry) => !entry.free).length,
    route: plane.route,
  }));
  const nothing = planes.every(
    (plane) => plane.free.length === 0 && plane.paid === 0
  );
  return {
    note: nothing ? t("gapNone") : undefined,
    planes,
    warn: false,
  };
};

/** What one declare renders: one line, and whether it reads as a problem. */
export const declareLine = (
  t: Translate,
  outcome: DeclareOutcome
): { line: string; warn: boolean } => {
  if (outcome.kind === "unavailable") {
    return { line: t("gapUnavailable"), warn: true };
  }
  if (outcome.kind === "failed") {
    return { line: `${t("gapFailed")}: ${outcome.message}`, warn: true };
  }
  if (outcome.result.added.length === 0) {
    return { line: t("gapNothingAdded"), warn: false };
  }
  return {
    line: `${String(outcome.result.added.length)} ${t("gapAdded")}`,
    warn: false,
  };
};

export interface GapRowProps {
  onDeclare: (route: string, ids: readonly string[]) => Promise<DeclareOutcome>;
  onRead: () => Promise<GapOutcome>;
  t: Translate;
}

/**
 * The row: one button to read the gap, then a line per plane with the free models
 * it is missing and the one click that declares them.
 */
export const GapRow: React.FC<GapRowProps> = (props) => {
  const [state, setState] = React.useState<{
    busy: boolean;
    declaring?: string;
    line?: { line: string; warn: boolean };
    report?: GapReport;
  }>({ busy: false });

  const run = async (): Promise<void> => {
    setState({ busy: true });
    const outcome = await props.onRead();
    setState({ busy: false, report: gapLine(props.t, outcome) });
  };

  const declareFree = async (
    route: string,
    ids: readonly string[]
  ): Promise<void> => {
    setState((previous) => ({ ...previous, declaring: route }));
    const outcome = await props.onDeclare(route, ids);
    setState((previous) => ({
      ...previous,
      declaring: undefined,
      line: declareLine(props.t, outcome),
    }));
  };

  const { report } = state;

  return (
    <div
      style={{
        borderBottom: "0.5px solid var(--dsw-alias-border-l2)",
        marginBottom: 16,
        paddingBottom: 14,
      }}
    >
      <div
        style={{
          alignItems: "center",
          display: "flex",
          gap: 12,
          justifyContent: "space-between",
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {props.t("gapTitle")}
          </div>
          <div
            style={{
              color: "var(--dsw-alias-label-caption)",
              fontSize: 12,
              marginTop: 2,
            }}
          >
            {props.t("gapHint")}
          </div>
        </div>
        <Button
          disabled={state.busy}
          onClick={() => {
            void run();
          }}
          size="sm"
          variant="outline"
        >
          {state.busy ? props.t("gapBusy") : props.t("gapCheck")}
        </Button>
      </div>

      {report !== undefined && (
        <div style={{ fontSize: 12, marginTop: 8 }}>
          {report.planes
            .filter((plane) => plane.free.length > 0)
            .map((plane) => (
              <div
                key={plane.route}
                style={{
                  alignItems: "center",
                  display: "flex",
                  gap: 8,
                  justifyContent: "space-between",
                  padding: "2px 0",
                }}
              >
                <span
                  style={{
                    color: "var(--dsw-alias-label-secondary)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {`${plane.route}: ${plane.free.map((entry) => entry.name).join(", ")}`}
                </span>
                <Button
                  disabled={state.declaring !== undefined}
                  onClick={() => {
                    void declareFree(
                      plane.route,
                      plane.free.map((entry) => entry.id)
                    );
                  }}
                  size="sm"
                  variant="outline"
                >
                  {state.declaring === plane.route
                    ? props.t("gapAddBusy")
                    : props.t("gapAddFree")}
                </Button>
              </div>
            ))}
          {report.planes
            .filter((plane) => plane.free.length === 0 && plane.paid > 0)
            .map((plane) => (
              <div
                key={`paid-${plane.route}`}
                style={{ color: "var(--dsw-alias-label-caption)" }}
              >
                {`${plane.route}: ${String(plane.paid)} ${props.t("gapPaidOnly")}`}
              </div>
            ))}
          {report.note !== undefined && (
            <div
              style={{
                color: report.warn
                  ? "var(--dsw-alias-label-warning, var(--dsw-alias-label-caption))"
                  : "var(--dsw-alias-label-caption)",
                marginTop: 6,
              }}
            >
              {report.note}
            </div>
          )}
          {state.line !== undefined && (
            <div
              style={{
                color: state.line.warn
                  ? "var(--dsw-alias-label-warning, var(--dsw-alias-label-caption))"
                  : "var(--dsw-alias-label-caption)",
                marginTop: 6,
              }}
            >
              {state.line.line}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
