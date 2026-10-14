import { describe, expect, it } from "vitest";

import { isNewFormatKey, pairedEndpointUrl } from "../src/endpoint-pairing.ts";

/**
 * The two matched sets, and the formats that choose between them.
 *
 * Read from the client's catalogs: `models.dev` names `…/zen/v1` and
 * `…/zen/go/v1`, while `models.opencode.ai` — what 2.x uses — names
 * `…/inference/v1` and `…/inference/go/v1`. The credential formats pair with
 * them, so a mismatch is refused in a way that reads like an entitlement fault.
 */
describe("endpoint-pairing: a credential decides its endpoint family", () => {
  // The shape OpenCode 2.x mints, captured from the installed client.
  const NEW_KEY = "oc_sk_ac6304e0f930_Y6PcGUkm0zefzqlVLVTfJKnCkV5-iZuP";
  // The shape the installation's older credential has.
  const OLD_KEY = `oc_sk_${"a".repeat(45)}`;

  it("recognises the 2.x format by its embedded identifier", () => {
    expect(isNewFormatKey(NEW_KEY)).toBe(true);
    expect(isNewFormatKey(OLD_KEY)).toBe(false);
    expect(isNewFormatKey("")).toBe(false);
    const absent: unknown = undefined;
    expect(isNewFormatKey(absent)).toBe(false);
    // Twelve hex and an underscore, not merely "a long key".
    expect(isNewFormatKey("oc_sk_ZZZZZZZZZZZZ_rest")).toBe(false);
  });

  it("moves a new-format credential onto the new endpoint", () => {
    expect(
      pairedEndpointUrl("https://opencode.ai/zen/v1/chat/completions", NEW_KEY)
    ).toBe("https://opencode.ai/inference/v1/chat/completions");
    expect(
      pairedEndpointUrl(
        "https://opencode.ai/zen/go/v1/chat/completions",
        NEW_KEY
      )
    ).toBe("https://opencode.ai/inference/go/v1/chat/completions");
  });

  it("moves an old-format credential onto the old endpoint", () => {
    expect(
      pairedEndpointUrl(
        "https://opencode.ai/inference/v1/chat/completions",
        OLD_KEY
      )
    ).toBe("https://opencode.ai/zen/v1/chat/completions");
    expect(
      pairedEndpointUrl("https://opencode.ai/inference/go/v1/messages", OLD_KEY)
    ).toBe("https://opencode.ai/zen/go/v1/messages");
  });

  it("leaves a matched pair exactly as it arrived", () => {
    const url = "https://opencode.ai/inference/v1/responses";
    expect(pairedEndpointUrl(url, NEW_KEY)).toBe(url);
    const old = "https://opencode.ai/zen/v1/responses";
    expect(pairedEndpointUrl(old, OLD_KEY)).toBe(old);
  });

  it("does not move a URL it does not recognise", () => {
    // The rewrite must not be a general URL rewriter: anything outside the two
    // families is somebody else's traffic.
    for (const url of [
      "https://api.deepseek.com/v1/chat/completions",
      "https://opencode.ai/config.json",
      "https://opencode.ai/inference",
    ]) {
      expect(pairedEndpointUrl(url, NEW_KEY)).toBe(url);
    }
  });
});
