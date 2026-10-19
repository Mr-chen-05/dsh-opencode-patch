/**
 * Every harness package this repository compiles or peers against stays on ONE
 * distribution channel.
 *
 * The alpha and `next`/rc channels are parallel tracks, not a version ordering:
 * `0.2.1-rc.2` sorts ABOVE `0.2.1-alpha.5` in semver, so a caret range written
 * against the alpha line silently resolves to the rc line — which is exactly how
 * this repository ended up with `dsh-llm-pi-ai` on alpha and three other harness
 * packages on rc. Compile-time deps made that invisible; the test below is what
 * makes it visible.
 *
 * The rule is not "the newest channel": it is "the channel the host runs". The
 * running host is `dsh@0.2.1-alpha.5`, so the tools follow alpha.
 *
 * @module test/harness-channel
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const manifest = (): Manifest =>
  JSON.parse(readFileSync("package.json", "utf8")) as Manifest;

/** The channel of a version string, or `undefined` for an untagged release. */
const channelOf = (spec: string): string | undefined => {
  const match = /-([a-z]+)\./u.exec(spec);
  return match?.[1];
};

/** Versions only: a range's bounds are what decide which channel it reaches. */
const versionsIn = (spec: string): string[] =>
  spec.match(/\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?/gu) ?? [];

describe("harness channel alignment", () => {
  const HOST_CHANNEL = "alpha";

  it("every harness dependency is pinned on the host's channel", () => {
    const deps = {
      ...manifest().dependencies,
      ...manifest().devDependencies,
    };
    const harness = Object.entries(deps).filter(([name]) =>
      name.startsWith("@deepseek-ai/")
    );
    expect(harness.length).toBeGreaterThan(0);
    for (const [name, spec] of harness) {
      // `schemastery` is a plain library rather than a harness surface, and its
      // version is an independent line; the check is about the harness packages
      // whose releases move together.
      if (name === "@deepseek-ai/schemastery") {
        continue;
      }
      const channel = channelOf(spec);
      expect(channel, `${name} is pinned with no channel: ${spec}`).toBe(
        HOST_CHANNEL
      );
    }
  });

  it("no pinned spec can float onto another channel", () => {
    // A caret range written against alpha resolves to rc, because rc sorts
    // higher. Every spec whose channel matters is therefore EXACT, and the peer
    // range names alpha at both bounds.
    const deps = {
      ...manifest().dependencies,
      ...manifest().devDependencies,
    };
    for (const [name, spec] of Object.entries(deps)) {
      if (!name.startsWith("@deepseek-ai/") || name.endsWith("schemastery")) {
        continue;
      }
      expect(spec, `${name} must be exact, not a range: ${spec}`).toMatch(
        /^\d+\.\d+\.\d+-alpha\.\d+$/u
      );
    }
  });

  it("the typert peer range spans alpha and nothing below it", () => {
    const peer =
      manifest().peerDependencies?.["@deepseek-ai/dsh-typert-protocol"];
    expect(peer).toBeDefined();
    const versions = versionsIn(peer ?? "");
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) {
      const channel = channelOf(version);
      if (channel === undefined) {
        // An untagged bound (`0.3.0`) is an upper FRAME, not a release: it
        // admits everything below it, which is what keeps alpha installable.
        continue;
      }
      expect(
        channel,
        `the peer range reaches ${version}, which is not alpha`
      ).toBe(HOST_CHANNEL);
    }
  });
});
