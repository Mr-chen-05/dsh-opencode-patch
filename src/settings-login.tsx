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

/** The three remote calls a sign-in row makes. */
export interface LoginRemoteCalls {
  readonly begin: () => Promise<LoginChallenge>;
  readonly poll: () => Promise<LoginPollResult>;
  readonly read: () => Promise<LoginState>;
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

const codeStyle: React.CSSProperties = {
  fontFamily: "var(--dsw-font-mono, monospace)",
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
  const [state, setState] = useState<LoginState>();
  const [challenge, setChallenge] = useState<LoginChallenge>();
  const [failure, setFailure] = useState<string>();
  /** The challenge the poll loop is chasing, so a replacement stops the old one. */
  const chasing = useRef<LoginChallenge | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (login === undefined) {
      return;
    }
    try {
      setState(await login.read());
    } catch (error) {
      console.warn("[dsh-opencode-patch] login state read failed", error);
    }
  }, [login]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // One poll loop per challenge, at the interval the Console asked for. It ends
  // on its own three ways — signed in, refused, or expired — so a page left open
  // does not ask forever.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    if (challenge !== undefined && login !== undefined) {
      chasing.current = challenge;
      const everyMs = Math.max(challenge.intervalSeconds, 1) * 1000;
      const deadline = Date.now() + challenge.expiresInSeconds * 1000;
      const tick = async (): Promise<void> => {
        if (chasing.current !== challenge) {
          return;
        }
        if (Date.now() > deadline) {
          chasing.current = null;
          setChallenge(undefined);
          setFailure(t("loginExpired"));
          return;
        }
        let outcome: LoginPollResult;
        try {
          outcome = await login.poll();
        } catch (error) {
          console.warn("[dsh-opencode-patch] login poll failed", error);
          return;
        }
        if (outcome.kind === "pending") {
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
      timer = setInterval(() => {
        void tick();
      }, everyMs);
    }
    // One return path: the effect's cleanup is the same whether or not a flow is
    // in flight, so the rule that wants consistency gets it.
    return () => {
      if (timer !== undefined) {
        clearInterval(timer);
      }
    };
  }, [challenge, login, refresh, t]);

  const start = async (): Promise<void> => {
    if (login === undefined) {
      return;
    }
    setFailure(undefined);
    try {
      setChallenge(await login.begin());
    } catch (error) {
      console.warn("[dsh-opencode-patch] login could not start", error);
      setFailure(error instanceof Error ? error.message : t("loginFailed"));
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

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={rowStyle}>
        <span>{t("loginTitle")}</span>
        <span>{statusOf(state, t)}</span>
      </div>
      {challenge === undefined ? (
        <div style={rowStyle}>
          <span>{failure ?? ""}</span>
          <button onClick={onStart} type="button">
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
