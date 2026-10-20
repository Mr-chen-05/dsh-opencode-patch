/**
 * Deterministic OpenCode session identity.
 *
 * The gateway rejects requests without a valid OpenCode session id, and it must
 * stay stable for a DSH session or every turn looks like a new conversation to
 * the prompt cache. Everything here is a pure derivation from the DSH session
 * id and, when the Host knows it, the session's creation time — no table, no
 * randomness, no state to lose on restart.
 *
 * One value breaks that rule on purpose: `newOpenCodeMessageId`, the message id
 * a turn sends as `x-opencode-request`. It is identity for the gateway's own
 * metrics and accounting, not affinity, and the vendor mints a fresh one per
 * user message — so it does too.
 *
 * @module dsh-opencode-patch/session
 */

import { createHash, randomBytes } from "node:crypto";

import { OPENCODE_USER_AGENT } from "./identity.ts";
import {
  deriveSessionId,
  pinnedSessionId,
  type SessionDigest,
} from "./utils/session-id.ts";

export {
  PARENT_SESSION_ALT_HEADER,
  PARENT_SESSION_HEADER,
  SESSION_AFFINITY_HEADER,
  SESSION_HEADER,
  SESSION_ID_HEADER,
  deriveSessionId,
  isOpenCodeMessageId,
  isOpenCodeSessionId,
  pinnedSessionId,
  sessionIdForRequest,
  type SessionDigest,
} from "./utils/session-id.ts";

/** Canonical OpenCode CLI User-Agent the DSH LLM adapter strips. */
export const OPENCODE_UA = OPENCODE_USER_AGENT;

/** The vendor's base62 alphabet, character for character. */
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Characters carrying the timestamp. */
const TIME_HEX_LENGTH = 12;

/** Characters of the random suffix, for `randomBytes` below. */
const RANDOM_LENGTH = 14;

/** The digest a session id is derived from: the only crypto this module does. */
export const digestOf = (sessionId: string): SessionDigest => {
  const bytes = createHash("sha256").update(sessionId).digest();
  return { bytes, hex: Buffer.from(bytes).toString("hex") };
};

/**
 * Derive the OpenCode session id for a DSH session.
 *
 * The construction is `utils/session-id.ts`; this is where the digest comes
 * from. Split so the algorithm is testable without arranging a crypto module,
 * and so the one impure step is visible as exactly one line.
 *
 * @param sessionId - the DSH session id.
 * @param createdAt - that session's creation time in ms, when known.
 * @returns the derived `ses_…` id.
 */
export const openCodeSessionIdFor = (
  sessionId: string | number,
  createdAt?: number
): string => deriveSessionId(digestOf(String(sessionId)), createdAt);

/**
 * Session id for a streamed turn, or `undefined` when there is none to carry.
 *
 * Always derives: raw DSH UUIDs satisfy no gateway, while derived `ses_…`
 * values route stably everywhere a UUID would.
 *
 * @param sessionId - the DSH session id carried by the turn.
 * @param createdAt - that session's creation time in milliseconds, when the
 * Host's session service can supply it.
 */
export const headerValueFor = (
  sessionId: string | number | undefined | null,
  createdAt?: number
): string | undefined => {
  if (sessionId === undefined || sessionId === null) {
    return undefined;
  }
  const raw = String(sessionId);
  if (raw.length === 0) {
    return undefined;
  }
  return openCodeSessionIdFor(raw, createdAt);
};

/**
 * Fallback session id for requests issued outside any tracked turn.
 *
 * Prefers the configured environment variable (headless runs pin one id per
 * process) and otherwise derives a stable id for the reserved `"default"`
 * conversation. This is the one function here that reads the environment: the
 * RULE it applies is `pinnedSessionId` in `utils/`, which takes the value.
 *
 * @param envName - environment variable consulted first; defaults to
 * `OPENCODE_SESSION_ID` when blank.
 */
export const fallbackSessionId = (envName?: string): string => {
  const name =
    envName !== undefined && envName.length > 0 ? envName : undefined;
  return pinnedSessionId(
    name === undefined ? undefined : process.env[name],
    digestOf
  );
};

/** Counter disambiguating message ids minted within one millisecond. */
let messageCounter = 0;

/**
 * A fresh message id for `x-opencode-request`, minted the way the vendor does.
 *
 * Identity for the gateway's own metrics and accounting, not affinity: the
 * vendor mints a fresh one per user message, so this does too. The only stateful
 * function in this module, which is why it is here rather than in `utils/`.
 *
 * @param now - the millisecond to anchor the id to.
 * @returns a `msg_<12hex><14base62>` id.
 */
export const newOpenCodeMessageId = (now: number = Date.now()): string => {
  const milliseconds = Number.isSafeInteger(now) && now >= 0 ? now : Date.now();
  const counter = messageCounter % 4096;
  messageCounter += 1;
  const time = (BigInt(milliseconds) * 4096n + BigInt(counter)) % 2n ** 48n;

  const bytes = randomBytes(RANDOM_LENGTH);
  let random = "";
  for (let index = 0; index < RANDOM_LENGTH; index += 1) {
    const byte = bytes[index];
    if (byte !== undefined) {
      random += BASE62[byte % BASE62.length] ?? "0";
    }
  }

  return `msg_${time.toString(16).padStart(TIME_HEX_LENGTH, "0")}${random}`;
};
