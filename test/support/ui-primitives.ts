/**
 * Stand-ins for the host's UI primitives, so a test process can RENDER them.
 *
 * `@deepseek-ai/dsh-client-ui-primitives` imports `clsx`, which this package does
 * not install, so requiring the real module throws in a test — measured. Every
 * UI test used to work around that by walking the returned element tree by hand,
 * which never runs hooks, never runs handlers, and never noticed when the card
 * returned something React itself would reject.
 *
 * These render plain HTML. They are deliberately faithful only for the parts the
 * card's assertions are about — a label inside a `<button>`, a `<input>` whose
 * `checked` follows the prop — and they must stay small for that reason: a
 * stand-in that grows behaviour is a second implementation to keep in step.
 *
 * @module test/support/ui-primitives
 */
import { createElement } from "react";

const pass = (props: { children?: React.ReactNode }) => props.children;

/** A `Button` that renders its label inside a real `<button>`. */
export const Button = (props: {
  children?: React.ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  type?: string;
}) =>
  createElement(
    "button",
    {
      disabled: props.disabled,
      "data-kind": props.type,
      onClick: props.onClick,
      type: "button",
    },
    props.children
  );

/** A `SettingsForm` that renders its children and exposes the shell it got. */
export const SettingsForm = (props: {
  children?: React.ReactNode;
  shell?: unknown;
}) =>
  createElement(
    "form",
    { "data-shell": props.shell === undefined ? "none" : "given" },
    props.children
  );

/** A `Switch` that renders a checkbox, so `checked` is observable. */
export const Switch = (props: {
  checked?: boolean;
  disabled?: boolean;
  onChange?: (next: boolean) => void;
}) =>
  createElement("input", {
    checked: props.checked === true,
    disabled: props.disabled,
    onChange: () => props.onChange?.(!props.checked),
    readOnly: true,
    type: "checkbox",
  });

/** A `Tag` that renders its text. */
export const Tag = (props: { children?: React.ReactNode }) =>
  createElement("span", { "data-tag": "true" }, props.children);

/** Anything else the card reaches for and asserts nothing about. */
export const IconInfoOutlineRegular = () =>
  createElement("span", { "data-icon": "info" });

export const IconRefreshOutlineRegular = () =>
  createElement("span", { "data-icon": "refresh" });

export const StateDot = () => createElement("i", { "data-dot": "true" });

export const Tooltip = pass;

export const __esModule = true;
