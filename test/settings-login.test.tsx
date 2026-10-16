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
      flowId: "flow-test",
      intervalSeconds: 60,
      userCode: "HQFZ-NQPQ",
      verificationUri: "https://opencode.ai/console/device",
      verificationUriComplete:
        "https://opencode.ai/console/device?user_code=HQFZ-NQPQ",
    }),
  cancel: () => Promise.resolve(),
  poll: () => Promise.resolve({ kind: "pending" }),
  read: () => Promise.resolve({ orgs: [], plane: "opencode", signedIn: false }),
  ...overrides,
});

describe("settings: the sign-in row", () => {
  it("cancels a flow it started, on the way out", async () => {
    // A flow started from the card could only be abandoned by reloading the page.
    // The contract and the service already had `cancel`; the effect that owns the
    // poll loop now calls it on the way out.
    const cancelled: string[] = [];
    const view = render(
      <LoginSection
        login={calls({
          begin: () =>
            Promise.resolve({
              expiresInSeconds: 600,
              flowId: "flow-cancel-me",
              intervalSeconds: 5,
              userCode: "ABCD-EFGH",
              verificationUri: "https://x",
            }),
          cancel: (flowId: string) => {
            cancelled.push(flowId);
            return Promise.resolve();
          },
        })}
        t={t}
      />
    );
    const button = view.container.querySelector('button[type="button"]')!;
    fireEvent.click(button);
    await waitFor(() => {
      expect(view.container.textContent).toContain("ABCD-EFGH");
    });
    // Unmounting is the abandonment path.
    view.unmount();
    expect(cancelled).toEqual(["flow-cancel-me"]);
  });

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

  it("offers both planes, and signs in to the one that is selected", async () => {
    // There are TWO authentication routes, one per gateway plane, and a grant is
    // stored per plane. A row that never said which one always wrote to Zen - so
    // a deployment living on Go could not sign in on the plane it uses, and
    // could not see the grant it already had.
    const begun: string[] = [];
    const read: string[] = [];
    const view = render(
      <LoginSection
        login={calls({
          begin: (plane: string) => {
            begun.push(plane);
            return Promise.resolve({ userCode: "X" } as never);
          },
          read: (plane: string) => {
            read.push(plane);
            return Promise.resolve({ plane, signedIn: false } as never);
          },
        })}
        t={t}
      />
    );

    // Both planes are offered, and Zen - what the row always used - is the default.
    expect(zh.loginPlaneZen).toBeTruthy();
    expect(zh.loginPlaneGo).toBeTruthy();
    const radios = [
      ...view.container.querySelectorAll<HTMLInputElement>(
        'input[type="radio"]'
      ),
    ];
    expect(radios).toHaveLength(2);
    const zen = radios[0] as HTMLInputElement;
    const go = radios[1] as HTMLInputElement;
    await waitFor(() => {
      expect(zen.checked).toBe(true);
      expect(go.checked).toBe(false);
    });
    // And it describes the plane it is showing.
    await waitFor(() => {
      expect(read).toContain("opencode");
    });

    // Choosing the other plane re-reads it and signs in THERE.
    fireEvent.click(go);
    await waitFor(() => {
      expect(read).toContain("opencode-go");
    });
    fireEvent.click(view.container.querySelector('button[type="button"]')!);
    await waitFor(() => {
      expect(begun).toEqual(["opencode-go"]);
    });
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
      .mockResolvedValueOnce({ intervalSeconds: 10, kind: "slow_down" })
      .mockResolvedValueOnce({ kind: "pending" })
      .mockResolvedValue({ kind: "signed-in" });
    const view = render(
      <LoginSection
        login={calls({
          begin: () =>
            Promise.resolve({
              expiresInSeconds: 600,
              flowId: "flow-timer-test",
              intervalSeconds: 1,
              userCode: "HQFZ-NQPQ",
              verificationUri: "https://opencode.ai/console/device",
            }),
          poll: async () => {
            const result = await poll();
            if (result.kind === "slow_down") {
              return { ...result, intervalSeconds: 10 };
            }
            return result;
          },
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
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1100);
    expect(poll).toHaveBeenCalledTimes(3);
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
              flowId: "flow-expired-test",
              intervalSeconds: 0,
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
              flowId: "flow-timer-test",
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
          flowId: "flow-remote-test",
          intervalSeconds: 1,

          userCode: "X",
          verificationUri: "https://x",
        },
      }),
    cancel: () => Promise.resolve({ ok: true, value: { kind: "cancelled" } }),
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
    await expect(wired?.read("opencode")).resolves.toMatchObject({
      signedIn: false,
    });
    await expect(wired?.poll("flow-remote-test")).resolves.toEqual({
      kind: "pending",
    });
    await expect(wired?.begin("opencode")).resolves.toMatchObject({
      userCode: "X",
    });
  });

  it("reports rather than throws when cordis refuses the namespace access", () => {
    // The error the reporter's screenshot showed, and why neither the meter nor
    // the sign-in row appeared: cordis guards property access on a remote
    // service by NAME, and an undeclared namespace THROWS
    // `cannot get property "remote.opencodeLogin" without inject` rather than
    // answering `undefined`. An optional chain cannot catch a throw, so the read
    // is guarded and the absence is reported like any other.
    const warnings: unknown[][] = [];
    const spy = vi
      .spyOn(console, "warn")
      .mockImplementation((...args: unknown[]) => {
        warnings.push(args);
      });
    try {
      const throwing = new Proxy(
        {},
        {
          get: (_target, prop) => {
            if (prop === "opencodeLogin") {
              throw new TypeError(
                'cannot get property "remote.opencodeLogin" without inject'
              );
            }
          },
        }
      );
      const view = render(
        <LoginSection login={loginCalls({ remote: throwing } as never)} t={t} />
      );
      // The row still renders, and says so rather than taking the page down.
      expect(view.container.textContent).toContain(zh.loginSignedOut);
      const line = warnings
        .map((args) => args.map(String).join(" "))
        .find((text) => text.includes("no opencodeLogin service"));
      expect(line, "the guarded read must report, not throw").toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("answers calls even when no login remote is mounted, so the row renders", () => {
    // The opposite of the meter's rule, and deliberately. Resolving the remote once
    // at inject time raced the asynchronous mount and left the row absent with no
    // retry; returning the calls unconditionally is what makes it render at all. A
    // host that mounted no service now shows a row that says so, which is better
    // than "no row" and "no service" looking identical.
    const absent = loginCalls({ remote: {} } as never);
    expect(absent).toBeDefined();
    expect(typeof absent.begin).toBe("function");
    expect(typeof absent.cancel).toBe("function");
    expect(typeof absent.poll).toBe("function");
    expect(typeof absent.read).toBe("function");
    // And the missing service still surfaces where a caller can see it.
    return expect(absent.read("opencode")).rejects.toThrow(/did not answer/u);
  });

  it("sees a remote that mounts after the calls were built", async () => {
    // The bug this fix exists for, and the case the previous version failed: the
    // injector builds the card's props while the remote is still mounting, so the
    // remote appears AFTER loginCalls has already run. Resolving once meant the row
    // was absent for the life of the page; resolving per call means the calls handed
    // out work as soon as the service arrives.
    //
    // The assertion is that the call REACHES the service, not what the service
    // answers - the parser's own shape is covered elsewhere, and this test is about
    // which remote the call resolved.
    const ctx = { remote: {} } as { remote: Record<string, unknown> };
    const built = loginCalls(ctx as never);
    const asked: string[] = [];
    ctx.remote.opencodeLogin = {
      begin: () => {
        asked.push("begin");
        return Promise.resolve({ error: "stub", ok: false });
      },
      cancel: () => {
        asked.push("cancel");
        return Promise.resolve({ error: "stub", ok: false });
      },
      poll: () => {
        asked.push("poll");
        return Promise.resolve({ error: "stub", ok: false });
      },
      state: () => {
        asked.push("state");
        return Promise.resolve({ error: "stub", ok: false });
      },
    };
    await expect(built.read("opencode")).rejects.toThrow(/stub/u);
    await expect(built.begin("opencode")).rejects.toThrow(/stub/u);
    await expect(built.poll("flow-x")).rejects.toThrow(/stub/u);
    expect(asked).toEqual(["state", "begin", "poll"]);
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
