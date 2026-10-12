// @vitest-environment jsdom
/**
 * The sign-in row: the three states it renders, and the one it refuses to.
 *
 * @module dsh-opencode-patch/settings-login.test
 */

import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { en, zh } from "../src/settings-copy.ts";
import type { LoginRemoteCalls } from "../src/settings-login.tsx";
import { LoginSection } from "../src/settings-login.tsx";
import { loginCalls, unwrapRemote } from "../src/settings-page.tsx";

const t = (key: keyof typeof zh): string => zh[key];

const calls = (
  overrides: Partial<LoginRemoteCalls> = {}
): LoginRemoteCalls => ({
  begin: () =>
    Promise.resolve({
      expiresInSeconds: 600,
      intervalSeconds: 60,
      userCode: "HQFZ-NQPQ",
      verificationUri: "https://opencode.ai/console/device",
      verificationUriComplete:
        "https://opencode.ai/console/device?user_code=HQFZ-NQPQ",
    }),
  poll: () => Promise.resolve({ kind: "pending" }),
  read: () => Promise.resolve({ orgs: [], plane: "opencode", signedIn: false }),
  ...overrides,
});

describe("settings: the sign-in row", () => {
  it("renders nothing when the host mounted no login service", () => {
    // The same rule the meter follows: no remote, no row — absence rather than
    // an empty shell that looks broken.
    const view = render(<LoginSection t={t} />);
    expect(view.container.textContent).toBe("");
  });

  it("says nobody is signed in, and offers the action", async () => {
    const view = render(<LoginSection login={calls()} t={t} />);
    await waitFor(() => {
      expect(view.container.textContent).toContain(zh.loginSignedOut);
    });
    expect(view.container.textContent).toContain(zh.loginAction);
  });

  it("names the account once one is stored", async () => {
    const view = render(
      <LoginSection
        login={calls({
          read: () =>
            Promise.resolve({
              email: "someone@example.com",
              orgId: "wrk_first",
              orgs: [{ id: "wrk_first", name: "First" }],
              plane: "opencode",
              signedIn: true,
            }),
        })}
        t={t}
      />
    );
    await waitFor(() => {
      expect(view.container.textContent).toContain("someone@example.com");
    });
    // The action is still there, worded for someone already signed in.
    expect(view.container.textContent).toContain(zh.loginAgain);
  });

  it("shows the code and an openable URL once a flow starts", async () => {
    const begin = vi.fn(calls().begin);
    const view = render(<LoginSection login={calls({ begin })} t={t} />);
    await waitFor(() => {
      expect(view.container.textContent).toContain(zh.loginAction);
    });

    const [button] = within(view.container).getAllByRole("button");
    fireEvent.click(button);

    await waitFor(() => {
      expect(view.container.textContent).toContain("HQFZ-NQPQ");
    });
    expect(begin).toHaveBeenCalledTimes(1);
    // An absolute URL, because the Console answers a relative path and a link
    // that opens nothing is worse than no link.
    const [link] = within(view.container).getAllByRole("link");
    expect(link.getAttribute("href")).toBe(
      "https://opencode.ai/console/device?user_code=HQFZ-NQPQ"
    );
    expect(view.container.textContent).toContain(zh.loginWaiting);
  });

  it("reports a refused start rather than an empty row", async () => {
    const view = render(
      <LoginSection
        login={calls({ begin: () => Promise.reject(new Error("no store")) })}
        t={t}
      />
    );
    await waitFor(() => {
      expect(view.container.textContent).toContain(zh.loginAction);
    });
    const [button] = within(view.container).getAllByRole("button");
    fireEvent.click(button);
    await waitFor(() => {
      expect(view.container.textContent).toContain("no store");
    });
  });

  it("keeps the English row English", async () => {
    const view = render(
      <LoginSection login={calls()} t={(key: keyof typeof en) => en[key]} />
    );
    await waitFor(() => {
      expect(view.container.textContent).toContain(en.loginSignedOut);
    });
  });
});

describe("settings: the poll loop a sign-in runs", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops when the flow completes, and names the account", async () => {
    // The loop's own behaviour: it asks at the interval the Console gave, stops
    // the moment the state becomes signed in, and re-reads so the row can show
    // the email. Without this the row would sit on "waiting" forever.
    vi.useFakeTimers();
    const read = vi.fn(() =>
      Promise.resolve({ orgs: [], plane: "opencode", signedIn: false })
    );
    const poll = vi
      .fn()
      .mockResolvedValueOnce({ kind: "pending" })
      .mockResolvedValue({ kind: "signed-in" });
    const view = render(
      <LoginSection
        login={calls({
          begin: () =>
            Promise.resolve({
              expiresInSeconds: 600,
              intervalSeconds: 1,
              userCode: "HQFZ-NQPQ",
              verificationUri: "https://opencode.ai/console/device",
            }),
          poll,
          read: () =>
            poll.mock.calls.length > 1
              ? Promise.resolve({
                  email: "someone@example.com",
                  orgs: [],
                  plane: "opencode",
                  signedIn: true,
                })
              : read(),
        })}
        t={t}
      />
    );
    const [button] = within(view.container).getAllByRole("button");
    fireEvent.click(button);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1100);
    await vi.advanceTimersByTimeAsync(1100);
    vi.useRealTimers();
    await waitFor(() => {
      expect(view.container.textContent).toContain("someone@example.com");
    });
  });

  it("gives up when the code expires rather than asking forever", async () => {
    vi.useFakeTimers();
    const view = render(
      <LoginSection
        login={calls({
          begin: () =>
            Promise.resolve({
              expiresInSeconds: 0,
              intervalSeconds: 1,
              userCode: "HQFZ-NQPQ",
              verificationUri: "https://opencode.ai/console/device",
            }),
        })}
        t={t}
      />
    );
    const [button] = within(view.container).getAllByRole("button");
    fireEvent.click(button);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1100);
    vi.useRealTimers();
    await waitFor(() => {
      expect(view.container.textContent).toContain(zh.loginExpired);
    });
  });

  it("reports a refusal, which is terminal", async () => {
    vi.useFakeTimers();
    const view = render(
      <LoginSection
        login={calls({
          begin: () =>
            Promise.resolve({
              expiresInSeconds: 600,
              intervalSeconds: 1,
              userCode: "HQFZ-NQPQ",
              verificationUri: "https://opencode.ai/console/device",
            }),
          poll: () => Promise.resolve({ detail: "declined", kind: "failed" }),
        })}
        t={t}
      />
    );
    const [button] = within(view.container).getAllByRole("button");
    fireEvent.click(button);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1100);
    vi.useRealTimers();
    await waitFor(() => {
      expect(view.container.textContent).toContain("declined");
    });
  });
});

describe("settings: the calls the page hands the row", () => {
  const remote = {
    begin: () =>
      Promise.resolve({
        ok: true,
        value: {
          expiresInSeconds: 1,
          intervalSeconds: 1,
          userCode: "X",
          verificationUri: "https://x",
        },
      }),
    poll: () => Promise.resolve({ ok: true, value: { kind: "pending" } }),
    state: () =>
      Promise.resolve({
        ok: true,
        value: { orgs: [], plane: "opencode", signedIn: false },
      }),
  };

  it("unwraps each Remote result into the shape the row reads", async () => {
    const wired = loginCalls({ remote: { opencodeLogin: remote } } as never);
    expect(wired).toBeDefined();
    await expect(wired?.read()).resolves.toMatchObject({ signedIn: false });
    await expect(wired?.poll()).resolves.toEqual({ kind: "pending" });
    await expect(wired?.begin()).resolves.toMatchObject({ userCode: "X" });
  });

  it("is undefined when the host mounted no login remote", () => {
    // The same rule the meter keeps: no remote, no row — and no hard inject key
    // that would hold the whole plugin waiting for a service nobody mounted.
    expect(loginCalls({ remote: {} } as never)).toBeUndefined();
  });

  it("turns a failed Remote result into a thrown reason", async () => {
    // A refusal has to reach the row as a reason rather than as an empty value,
    // or a failed sign-in would render as a successful one with no account.
    await expect(
      unwrapRemote({ error: "no store", ok: false })
    ).rejects.toThrow("no store");
    await expect(unwrapRemote({ ok: false })).rejects.toThrow(
      /did not answer/u
    );
  });
});
