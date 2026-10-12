/**
 * The login seam's shapes, and the one thing it must never carry.
 *
 * @module dsh-opencode-patch/login-contract.test
 */

import { describe, expect, it } from "vitest";

import {
  loginRemote,
  parseLoginBeginQuery,
  parseLoginChallenge,
  parseLoginPoll,
  parseLoginState,
} from "../src/login-contract.ts";

describe("login-contract: the state a surface may see", () => {
  it("carries an email, an org and the orgs, and nothing else", () => {
    const state = parseLoginState({
      email: "someone@example.com",
      orgId: "wrk_first",
      orgs: [
        { id: "wrk_first", name: "First" },
        { id: "wrk_second", name: "Second" },
      ],
      plane: "opencode",
      signedIn: true,
    });
    expect(state).toEqual({
      email: "someone@example.com",
      orgId: "wrk_first",
      orgs: [
        { id: "wrk_first", name: "First" },
        { id: "wrk_second", name: "Second" },
      ],
      plane: "opencode",
      signedIn: true,
    });
  });

  it("DROPS a credential a host mistakenly sends", () => {
    // The rule this exists for. A surface that lists who is signed in has no
    // reason to hold the token, and a value it never receives is one it cannot
    // log, render or leak — so the parser is a whitelist, not a passthrough.
    const state = parseLoginState({
      accessToken: "st_should_never_travel",
      email: "someone@example.com",
      orgs: [],
      plane: "opencode",
      refreshToken: "rt_should_never_travel",
      signedIn: true,
    });
    expect(JSON.stringify(state)).not.toContain("st_should_never_travel");
    expect(JSON.stringify(state)).not.toContain("rt_should_never_travel");
    expect(Object.keys(state).toSorted()).toEqual([
      "email",
      "orgs",
      "plane",
      "signedIn",
    ]);
  });

  it("renders a grant whose owner was never read", () => {
    // "Signed in, owner unknown" is a real state — a token stored before the
    // owner could be read — and a surface has to be able to say it rather than
    // either inventing an email or showing nothing.
    const state = parseLoginState({
      orgs: [],
      plane: "opencode",
      signedIn: true,
    });
    expect(state.signedIn).toBe(true);
    expect(state.email).toBeUndefined();
    expect(state.orgId).toBeUndefined();
  });

  it("refuses a state it cannot describe", () => {
    for (const bad of [
      {},
      { orgs: [] },
      { plane: "opencode", signedIn: true },
      { orgs: "not a list", plane: "opencode", signedIn: true },
      { orgs: [{ id: "wrk_x" }], plane: "opencode", signedIn: true },
      { orgs: ["not an object"], plane: "opencode", signedIn: true },
      "not an object",
    ]) {
      expect(() => parseLoginState(bad), JSON.stringify(bad)).toThrow(
        TypeError
      );
    }
  });

  it("defaults a missing signedIn to false, which is the safe direction", () => {
    // A state that does not say is treated as not signed in: the surface shows
    // nothing rather than a phantom account.
    expect(parseLoginState({ orgs: [], plane: "opencode" }).signedIn).toBe(
      false
    );
  });

  it("treats signedIn as true only when it is exactly true", () => {
    // A truthy string would render as signed in, which is the wrong direction to
    // guess in: the surface would show an account that is not there.
    const state = parseLoginState({
      orgs: [],
      plane: "opencode",
      signedIn: "yes",
    });
    expect(state.signedIn).toBe(false);
  });
});

describe("login-contract: what a surface sends and shows", () => {
  it("accepts an absent query, and a plane when one is named", () => {
    expect(parseLoginBeginQuery()).toEqual({});
    expect(parseLoginBeginQuery({})).toEqual({});
    expect(parseLoginBeginQuery({ plane: "opencode-go" })).toEqual({
      plane: "opencode-go",
    });
    expect(() => parseLoginBeginQuery("nope")).toThrow(TypeError);
  });

  it("refuses a challenge missing a field a surface must render", () => {
    const complete = {
      expiresInSeconds: 600,
      intervalSeconds: 5,
      userCode: "HQFZ-NQPQ",
      verificationUri: "https://opencode.ai/console/device",
    };
    expect(parseLoginChallenge(complete)).toEqual(complete);
    expect(
      parseLoginChallenge({
        ...complete,
        verificationUriComplete:
          "https://opencode.ai/console/device?user_code=HQFZ-NQPQ",
      }).verificationUriComplete
    ).toContain("user_code=HQFZ-NQPQ");

    // A code with no URL to open is not a challenge: the human would have
    // nothing to do with it.
    expect(() =>
      parseLoginChallenge({ ...complete, verificationUri: undefined })
    ).toThrow(TypeError);
    expect(() =>
      parseLoginChallenge({ ...complete, userCode: undefined })
    ).toThrow(TypeError);
    expect(() =>
      parseLoginChallenge({ ...complete, intervalSeconds: undefined })
    ).toThrow(TypeError);
  });

  it("reads the three poll outcomes and refuses any other", () => {
    expect(parseLoginPoll({ kind: "pending" })).toEqual({
      detail: undefined,
      kind: "pending",
    });
    expect(parseLoginPoll({ detail: "declined", kind: "failed" })).toEqual({
      detail: "declined",
      kind: "failed",
    });
    expect(parseLoginPoll({ kind: "signed-in" })).toEqual({
      detail: undefined,
      kind: "signed-in",
    });
    // An unknown outcome must not be read as one of the three: a surface that
    // guessed "pending" would poll forever, and one that guessed "signed-in"
    // would show an account that is not there.
    expect(() => parseLoginPoll({ kind: "granted" })).toThrow(TypeError);
    expect(() => parseLoginPoll({})).toThrow(TypeError);
  });
});

describe("login-contract: the remote a surface mounts", () => {
  it("exposes the three calls a device flow needs, and no credential", () => {
    const methods = loginRemote.descriptors.map(
      (descriptor) => descriptor.method
    );
    expect(methods.toSorted()).toEqual(["begin", "poll", "state"]);
    expect(loginRemote.package).toBe("dsh-opencode-patch");
    for (const descriptor of loginRemote.descriptors) {
      expect(descriptor.namespace).toBe("opencodeLogin");
      expect(descriptor.service).toBe("opencodeLogin");
    }
    // Nothing the surface can call answers with a token: the results are a
    // challenge, a poll outcome and a state, in that order.
    expect(JSON.stringify(loginRemote)).not.toContain("accessToken");
  });
});
