/**
 * The org cache both sides share.
 *
 * @module dsh-opencode-patch/org-cache.test
 */

import { afterEach, describe, expect, it } from "vitest";

import { clearOrgs, orgFor, setOrg } from "../src/org-cache.ts";

afterEach(() => {
  clearOrgs();
});

describe("org-cache: the value the request hook reads", () => {
  it("answers what was recorded, per plane", () => {
    expect(orgFor("opencode")).toBeUndefined();
    setOrg("opencode", "wrk_zen");
    setOrg("opencode-go", "wrk_go");
    expect(orgFor("opencode")).toBe("wrk_zen");
    expect(orgFor("opencode-go")).toBe("wrk_go");
    // A plane nobody wrote is undefined rather than the other plane's answer.
    expect(orgFor("something-else")).toBeUndefined();
  });

  it("lets a later write replace an earlier one, which is the point", () => {
    // The cache is written at startup and again when a login completes; the second
    // write is what makes a sign-in visible to the requests that follow.
    setOrg("opencode", undefined);
    expect(orgFor("opencode")).toBeUndefined();
    setOrg("opencode", "wrk_after_login");
    expect(orgFor("opencode")).toBe("wrk_after_login");
    setOrg("opencode", undefined);
    expect(orgFor("opencode")).toBeUndefined();
  });
});
