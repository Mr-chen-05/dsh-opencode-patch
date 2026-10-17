/**
 * Verification: session-id counter band claim.
 *
 * PR #37 (taykof) claims the OpenCode gateway passes only sessions whose
 * low-12 hex bits land in `f[c-f]x` — i.e. [0xfc0, 0xffe] — and 403s the
 * rest (~1.54% of a uniformly-distributed counter). The adopted change
 * clamps `counter` into that band.
 *
 * This script refutes the claim by porting the vendor's own generator
 * (`packages/opencode/src/id/id.ts`, `create()`) and showing what low-12
 * values the REAL OpenCode CLI produces. See `docs/upstream-findings.md` §3.1.
 *
 * Run: node --experimental-strip-types scripts/verify-session-band.ts
 *
 * @module scripts/verify-session-band
 */

import { openCodeSessionIdFor } from "../src/session.ts";

/**
 * Faithful port of upstream `packages/opencode/src/id/id.ts`.
 *
 * The bitwise shift/mask and the `BigInt(...)` calls are deliberate: this is a
 * byte-for-byte port of the vendor's arithmetic, and the point of the script is
 * that it reproduces THEIR output rather than a rewritten approximation. The
 * lint rules that object are disabled for exactly this file and this reason.
 */
/* oxlint-disable eslint/no-bitwise, unicorn/prefer-bigint-literals,
   unicorn/no-array-sort -- a faithful port of the vendor's own arithmetic */
const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijllmnopqrstuvwxyz";
let lastTimestamp = 0;
let counter = 0;

const upstreamCreate = (prefix: string, timestamp: number): string => {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter += 1;

  const now = BigInt(timestamp) * BigInt(0x1000) + BigInt(counter);
  const timeBytes = Buffer.alloc(6);
  for (let i = 0; i < 6; i += 1) {
    timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff));
  }
  return `${prefix}_${timeBytes.toString("hex")}${chars.slice(0, 14)}`;
};
/* oxlint-enable eslint/no-bitwise, unicorn/prefer-bigint-literals,
   unicorn/no-array-sort -- port ends here */

/** The low twelve bits: the last three hex characters of the 12-hex time. */
const low12 = (id: string): number =>
  Number.parseInt(id.slice(4, 16).slice(-3), 16);

const BAND_LO = 0xfc0;
const BAND_HI = 0xffe;

// ── 1. What the REAL OpenCode CLI produces ──────────────────────────────────
const upstreamLows: number[] = [];
for (let i = 0; i < 200_000; i += 1) {
  upstreamLows.push(low12(upstreamCreate("ses", 1_750_000_000_000 + i)));
}
const upstreamInBand = upstreamLows.filter((l) => l >= BAND_LO && l <= BAND_HI);
const upstreamDistinct = [...new Set(upstreamLows)].toSorted((a, b) => a - b);

console.log("── upstream OpenCode CLI (packages/opencode/src/id/id.ts) ──");
console.log(`samples             : ${upstreamLows.length}`);
console.log(
  `distinct low-12     : ${upstreamDistinct.map((v) => `0x${v.toString(16)}`).join(", ")}`
);
console.log(
  `in band [fc0,ffe]   : ${upstreamInBand.length} (${((upstreamInBand.length / upstreamLows.length) * 100).toFixed(4)}%)`
);
console.log(
  upstreamInBand.length === 0
    ? "  => upstream NEVER lands in the claimed band."
    : "  => upstream does land in the band."
);

// ── 2. What our derivation produces ─────────────────────────────────────────
const oursLows: number[] = [];
for (let i = 0; i < 50_000; i += 1) {
  oursLows.push(low12(openCodeSessionIdFor(`band-check-${i}`)));
}
const oursInBand = oursLows.filter((l) => l >= BAND_LO && l <= BAND_HI);

console.log("\n── our derivation (post-clamp) ──");
console.log(`samples             : ${oursLows.length}`);
console.log(
  `in band [fc0,ffe]   : ${oursInBand.length} (${((oursInBand.length / oursLows.length) * 100).toFixed(2)}%)`
);
console.log(
  `distinct low-12     : ${new Set(oursLows).size} of ${BAND_HI - BAND_LO + 1} possible`
);

// ── 3. The verdict ──────────────────────────────────────────────────────────
console.log("\n── verdict ──");
if (upstreamInBand.length === 0) {
  console.log(
    "REFUTED: the claimed pass band is one the vendor's own client never"
  );
  console.log("produces, so it cannot be a gateway admission rule.");
} else {
  console.log("CONFIRMED: upstream lands in the band.");
}
