/**
 * The sign-in row: what a device flow looks like from the settings page.
 *
 * **Three states and nothing else**, because that is all the host answers:
 * nothing stored, a code waiting on a human, or a signed-in account. A host that
 * does not answer renders as nothing stored, with the failure reported where it
 * was caught.
 *
 * **The credential never reaches this component.** It calls three remote methods
 * that answer a state, a challenge and an outcome; the token is written and read
 * on the host, and a surface that never receives it cannot leak it.
 *
 * @module dsh-opencode-patch/settings-login
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  LoginChallenge,
  LoginPollResult,
  LoginState,
} from "./login-contract.ts";
import type { Translate } from "./settings-copy.ts";

/**
 * The planes a login can be written to.
 *
 * There are two authentication routes, one per gateway plane, and a grant is
 * stored per plane. Both are offered because a deployment may hold a different
 * account on each, and because the grant the row shows must be the one it
 * describes.
 */
export const LOGIN_PLANES = ["opencode", "opencode-go"] as const;

/** One plane a sign-in can be written to. */
export type LoginPlane = (typeof LOGIN_PLANES)[number];

/** The remote calls a sign-in row makes. */
export interface LoginRemoteCalls {
  readonly begin: (plane: LoginPlane) => Promise<LoginChallenge>;
  readonly cancel: (flowId: string) => Promise<void>;
  readonly poll: (flowId: string) => Promise<LoginPollResult>;
  readonly read: (plane: LoginPlane) => Promise<LoginState>;
}

/** What this row needs from the page. */
export interface LoginSectionProps {
  /** The remote's three calls; absent when the host mounted no login service. */
  login?: LoginRemoteCalls;
  /** The active UI language, read at render so a switch moves this row too. */
  getLocale?: () => string | undefined;
  t: Translate;
}

const rowStyle: React.CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: 8,
  justifyContent: "space-between",
};

const planeLabelStyle: React.CSSProperties = {
  alignItems: "center",
  display: "inline-flex",
  gap: 4,
};

const codeStyle: React.CSSProperties = {
  // The host names its code face `--ds-font-family-code`; `--dsw-font-mono`
  // does not exist, so the previous value silently fell back to `monospace`.
  fontFamily: "var(--ds-font-family-code, var(--dsw-font-family, monospace))",
  fontSize: 16,
  letterSpacing: "0.08em",
};

/**
 * The status line: who is signed in, or that nobody is.
 *
 * @param state - the host's answer, or nothing while it has not answered.
 * @param t - the translator.
 * @returns the line to render.
 */
export const statusOf = (
  state: LoginState | undefined,
  t: Translate
): string => {
  if (state?.signedIn !== true) {
    return t("loginSignedOut");
  }
  const { email } = state;
  if (email === undefined) {
    return t("loginSignedIn");
  }
  return `${t("loginSignedIn")} · ${email}`;
};

/**
 * The sign-in row.
 *
 * @param props - the remote's calls and the translator.
 * @returns the row, or nothing when the host mounted no login service.
 */
export const LoginSection: React.FC<LoginSectionProps> = (
  props: LoginSectionProps
) => {
  const { login, t } = props;
  const [plane, setPlane] = useState<LoginPlane>("opencode");
  const [state, setState] = useState<LoginState>();
  const [challenge, setChallenge] = useState<LoginChallenge>();
  const [failure, setFailure] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [challengeReceivedAt, setChallengeReceivedAt] = useState<number>();
  /** The challenge the poll loop is chasing, so a replacement stops the old one. */
  const chasing = useRef<LoginChallenge | null>(null);
  /** Invalidates a begin call that resolves after the row moved on or unmounted. */
  const startGeneration = useRef(0);

  useEffect(
    () => () => {
      startGeneration.current += 1;
      chasing.current = null;
    },
    []
  );

  const refresh = useCallback(async (): Promise<void> => {
    if (login === undefined) {
      return;
    }
    try {
      setState(await login.read(plane));
    } catch (error) {
      console.warn("[dsh-opencode-patch] login state read failed", error);
    }
  }, [login, plane]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // One poll loop per challenge, at the interval the Console asked for. It ends
  // on its own three ways — signed in, refused, or expired — so a page left open
  // does not ask forever.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (challenge !== undefined && login !== undefined) {
      chasing.current = challenge;
      const expirySeconds =
        Number.isFinite(challenge.expiresInSeconds) &&
        challenge.expiresInSeconds >= 0
          ? challenge.expiresInSeconds
          : 600;
      const deadline =
        (challengeReceivedAt ?? Date.now()) + expirySeconds * 1000;
      const schedule = (seconds: number | undefined): void => {
        const intervalSeconds =
          typeof seconds === "number" &&
          Number.isFinite(seconds) &&
          seconds >= 0
            ? seconds
            : 5;
        const remainingMs = Math.max(deadline - Date.now(), 1);
        const intervalMs = Math.max(intervalSeconds * 1000, 1000);
        timer = setTimeout(
          () => {
            void tick();
          },
          Math.min(intervalMs, remainingMs)
        );
      };
      const tick = async (): Promise<void> => {
        if (chasing.current !== challenge) {
          return;
        }
        if (Date.now() >= deadline) {
          chasing.current = null;
          setChallenge(undefined);
          setFailure(t("loginExpired"));
          return;
        }
        let outcome: LoginPollResult;
        try {
          outcome = await login.poll(challenge.flowId);
        } catch (error) {
          console.warn("[dsh-opencode-patch] login poll failed", error);
          if (chasing.current === challenge) {
            schedule(challenge.intervalSeconds);
          }
          return;
        }
        if (chasing.current !== challenge) {
          return;
        }
        if (outcome.kind === "pending" || outcome.kind === "slow_down") {
          schedule(outcome.intervalSeconds ?? challenge.intervalSeconds);
          return;
        }
        chasing.current = null;
        setChallenge(undefined);
        if (outcome.kind === "signed-in") {
          setFailure(undefined);
          await refresh();
          return;
        }
        setFailure(outcome.detail ?? t("loginFailed"));
      };
      schedule(challenge.intervalSeconds);
    }
    // One return path: the effect's cleanup is the same whether or not a flow is
    // in flight, so the rule that wants consistency gets it.
    return () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (challenge !== undefined) {
        void (async () => {
          try {
            await login?.cancel(challenge.flowId);
          } catch (error: unknown) {
            console.warn(
              "[dsh-opencode-patch] login cancellation failed",
              error
            );
          }
        })();
      }
    };
  }, [challenge, challengeReceivedAt, login, refresh, t]);

  const start = async (): Promise<void> => {
    if (login === undefined || starting) {
      return;
    }
    const generation = startGeneration.current + 1;
    startGeneration.current = generation;
    setStarting(true);
    setFailure(undefined);
    try {
      const nextChallenge = await login.begin(plane);
      if (generation !== startGeneration.current) {
        await login.cancel(nextChallenge.flowId);
        return;
      }
      setChallengeReceivedAt(Date.now());
      setChallenge(nextChallenge);
    } catch (error) {
      if (generation === startGeneration.current) {
        console.warn("[dsh-opencode-patch] login could not start", error);
        setFailure(error instanceof Error ? error.message : t("loginFailed"));
      }
    } finally {
      if (generation === startGeneration.current) {
        setStarting(false);
      }
    }
  };

  if (login === undefined) {
    return <></>;
  }

  // A statement, not an expression: the lint allows `void` where it discards a
  // promise deliberately, and rejects it inside an arrow body.
  const onStart = (): void => {
    void start();
  };

  const signedIn = state?.signedIn === true;
  const link =
    challenge === undefined
      ? undefined
      : (challenge.verificationUriComplete ?? challenge.verificationUri);

  // The plane this row is writing to and describing. Two radio inputs rather
  // than a select, because it is two choices and the host's own primitives offer
  // no radio: the row already styles its own button, and two labelled buttons
  // keep the choice visible without a second component. The signed-in status is
  // per plane, so switching re-reads - which is what `refresh` depending on
  // `plane` does.
  const onPlane = (next: LoginPlane): void => {
    startGeneration.current += 1;
    setStarting(false);
    chasing.current = null;
    setChallenge(undefined);
    setChallengeReceivedAt(undefined);
    setFailure(undefined);
    setPlane(next);
  };

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={rowStyle}>
        <span>{t("loginTitle")}</span>
        <span>{statusOf(state, t)}</span>
      </div>
      <div style={rowStyle} role="group">
        <span>{t("loginPlane")}</span>
        {LOGIN_PLANES.map((option) => (
          <label key={option} style={planeLabelStyle}>
            <input
              checked={plane === option}
              name="dsh-opencode-login-plane"
              onChange={() => {
                onPlane(option);
              }}
              type="radio"
              value={option}
            />
            {t(option === "opencode" ? "loginPlaneZen" : "loginPlaneGo")}
          </label>
        ))}
      </div>
      {challenge === undefined ? (
        <div style={rowStyle}>
          <span>{failure ?? ""}</span>
          <button
            aria-busy={starting}
            disabled={starting}
            onClick={onStart}
            type="button"
          >
            {signedIn ? t("loginAgain") : t("loginAction")}
          </button>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 4 }}>
          <span style={codeStyle}>{challenge.userCode}</span>
          <a href={link} rel="noreferrer" target="_blank">
            {link}
          </a>
          <span>{t("loginWaiting")}</span>
        </div>
      )}
    </div>
  );
};
