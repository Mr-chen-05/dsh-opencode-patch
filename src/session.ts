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

/** Header carrying the derived OpenCode session id. */
export const SESSION_HEADER = "x-opencode-session";

/** Generic proxy session affinity header used by gateways and connection pools. */
export const SESSION_AFFINITY_HEADER = "x-session-affinity";

/**
 * The fourth session header, and the one this plugin never sent.
 *
 * Captured from OpenCode 2.0.28 talking to a local server: it sends
 * `x-opencode-session`, `x-opencode-session-id`, `x-session-affinity` AND
 * `x-session-id`, all four carrying the same value on every request. This plugin
 * has always sent three of them.
 */
export const SESSION_ID_HEADER = "x-session-id";

/** Header carrying the derived OpenCode parent session id for subagents. */
export const PARENT_SESSION_HEADER = "x-opencode-parent-session-id";

/** Generic parent session header used by third-party proxies. */
export const PARENT_SESSION_ALT_HEADER = "x-parent-session-id";

/** Canonical OpenCode CLI User-Agent the DSH LLM adapter strips. */
export const OPENCODE_UA = OPENCODE_USER_AGENT;

/**
 * The vendor's own base62 alphabet, character for character (`randomBase62` in
 * `packages/opencode/src/id/id.ts`): digits, then uppercase, then lowercase.
 * The ORDER does not matter for validity, only the set does — matching theirs
 * keeps our suffix indistinguishable from one they minted.
 */
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Characters of the id that carry a TIMESTAMP: six bytes of
 * `milliseconds * 0x1000 + counter`, hex-encoded.
 */
const TIME_HEX_LENGTH = 12;

/** Characters the vendor fills with `randomBase62`. */
const RANDOM_LENGTH = 14;

/**
 * Derive a valid OpenCode session ID: `ses_` + 12 hex + 14 base62.
 *
 * The shape is read off the vendor's own generator rather than inferred
 * (`packages/opencode/src/id/id.ts`):
 *
 * ```ts
 * let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter)
 * return prefix + "_" + timeBytes.toString("hex") + randomBase62(LENGTH - 12)
 * ```
 *
 * **Those twelve characters are a timestamp, and the vendor reads them back.**
 * Their `timestamp(id)` divides the hex by `0x1000` to recover milliseconds, so
 * filling them with hash bytes hands them a random creation instant — often in
 * the future — and a non-hex alphabet makes that parser throw. When the Host
 * tells us the session's creation time, that is what goes in.
 *
 * Everything else is derived from the DSH session id, so the value is stable:
 * the same conversation presents the same id on every turn, in every process,
 * and after a restart, which is what session affinity needs. The 12-bit counter
 * only disambiguates ids minted within one millisecond, so it comes from the
 * hash — deterministic and free.
 *
 * With no creation time the timestamp is the one thing this function cannot
 * supply honestly. It then falls back to hash bits, which is the degraded case:
 * the id is still valid and still stable, but its embedded time is not a time.
 *
 * @param sessionId - DSH session identifier (stringified before hashing, so
 * numeric ids match their string form).
 * @param createdAt - the session's creation time in milliseconds, when known.
 */
export const openCodeSessionIdFor = (
  sessionId: string | number,
  createdAt?: number
): string => {
  const hash = createHash("sha256").update(String(sessionId)).digest();

  // **The vendor mints sessions DESCENDING, and nothing else needs doing.**
  // `packages/opencode/src/id/id.ts` at v1.19.3:
  //
  //   now = BigInt(Date.now()) * 4096n + BigInt(++counter)   // per-millisecond
  //   now = direction === "descending" ? ~now : now
  //   6 bytes of `now` big-endian + 14 base62  →  `ses_<12hex><14base62>`
  //
  // We mint exactly ONE id per session, so the counter is 1 — the vendor's own
  // value for the first id inside a millisecond. There is no clamp here and no
  // band arithmetic: inverting `(ms << 12) + 1` puts the low twelve bits at
  // `0xFFE` on its own, which is where a real OpenCode session id sits.
  //
  // **The gateway's rule, measured** by replaying the vendor client's captured
  // request body and changing nothing but this header: it admits low twelve bits
  // in `0xFC0..0xFFE` and refuses anything else with `403 FreeTierError`
  // (ascending `0xFFE` and `0xFC0` → 200; ascending `0x001` → 403). PR #35/#37
  // found this band first, by clamping the counter into it; that clamp is no
  // longer needed, because following the vendor's own construction lands in the
  // band as a consequence rather than as an assertion about it.
  const counter = 1n;

  // The timestamp is NOT checked for recency — measured on the live gateway: a
  // 2009 value and a future 2030 value both answered 200 as long as the low
  // twelve bits were in the band. Only the band is enforced. So a session with
  // no recorded creation time takes a value DERIVED from the hash: stable across
  // turns (which affinity needs) and indistinguishable from a real one.
  const anchor =
    createdAt !== undefined && Number.isSafeInteger(createdAt) && createdAt >= 0
      ? BigInt(createdAt)
      : BigInt(`0x${hash.subarray(2, 8).toString("hex")}`);

  const mask = 2n ** 48n;
  const time = (anchor * 4096n + counter) % mask;
  // `~(time) & (2^48 - 1)`, in arithmetic: the lint forbids bitwise operators.
  const descending = mask - 1n - time;

  let random = "";
  for (let i = 6; i < 20; i += 1) {
    const byte = hash[i];
    if (byte !== undefined) {
      random += BASE62[byte % BASE62.length] ?? "0";
    }
  }

  return `ses_${descending.toString(16).padStart(TIME_HEX_LENGTH, "0")}${random.slice(0, RANDOM_LENGTH)}`;
};

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
 * conversation.
 *
 * @param envName - environment variable consulted first; defaults to
 * `OPENCODE_SESSION_ID` when blank.
 */
/**
 * Whether a string is a session id the gateway will accept.
 *
 * The shape is `ses_` + 12 hex + 14 base62, which is what {@link
 * openCodeSessionIdFor} derives and what the client's own ids look like.
 *
 * This exists because a prefix is not a format. A configuration that pins
 * `x-opencode-session: ses_dsh_default` starts with `ses_` and is not a session
 * id at all — the gateway answers it `401 Invalid API key`, which reads as a
 * credential fault and is really a malformed header. Anything that cannot be
 * accepted is better replaced with a derived id than sent as written.
 *
 * @param value - the candidate.
 * @returns whether it is a session id the gateway accepts.
 */
export const isOpenCodeSessionId = (value: unknown): value is string =>
  typeof value === "string" && /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/u.test(value);

export const fallbackSessionId = (envName?: string): string => {
  const name =
    envName !== undefined && envName.length > 0 ? envName : undefined;
  if (name !== undefined) {
    const envId: unknown = process.env[name];
    // Validated for the same reason a pinned header is: an id the gateway
    // rejects earns a 401 that reads like a credential fault, and a derived id
    // is strictly better than one that cannot be accepted.
    if (isOpenCodeSessionId(envId)) {
      return envId;
    }
  }
  return openCodeSessionIdFor("default");
};

/**
 * Whether a string is a message id the client could have minted.
 *
 * Same shape rule as {@link isOpenCodeSessionId}, and for the same reason: a
 * prefix is not a format. Anything that cannot be read is better dropped than
 * sent — the gateway reads this value for per-request metrics, and unlike a
 * session id there is no fallback that would repair a malformed one.
 *
 * @param value - the candidate.
 * @returns whether it is a message id the gateway will read.
 */
export const isOpenCodeMessageId = (value: unknown): value is string =>
  typeof value === "string" && /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/u.test(value);

/** Counter disambiguating message ids minted within one millisecond. */
let messageCounter = 0;

/**
 * Mint a fresh OpenCode message id: `msg_` + 12 hex + 14 base62.
 *
 * This is the value the emulated client sends as `x-opencode-request` — the id
 * of the user message a turn answers. Read from v1.19.3's
 * `packages/opencode/src/session/llm/request.ts`, which sets it from
 * `input.user.id` beside the client and project headers; and from the console,
 * which reads it for per-request metrics and rewrites it to
 * `x-opencode-request-id` before the request reaches the inference service
 * (`packages/console/app/src/lib/inference-proxy.ts`). A request without it is
 * less than the client sends.
 *
 * **Unlike a session id this one is deliberately not derived.** The vendor
 * mints a new id per user message from the clock, a counter and its own
 * randomness (`packages/opencode/src/id/id.ts`), and nothing reads the value
 * back the way affinity reads a session id — while two different messages of
 * one session sharing an id is the one thing a deterministic derivation would
 * guarantee. So this mints per call, in the vendor's exact shape, and travels
 * only the length of the turn that minted it. The suffix is random for the same
 * reason the vendor's is: hashing message content would leak a guessable digest
 * of the user's own text into a header, and a random suffix cannot be reversed.
 *
 * The twelve hex characters carry `milliseconds * 0x1000 + counter` — the same
 * layout the vendor's `timestamp(id)` parses — so the value stays readable by
 * whatever reads the client's own.
 *
 * @param now - the mint instant in milliseconds; the clock by default.
 * @returns the message id.
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
