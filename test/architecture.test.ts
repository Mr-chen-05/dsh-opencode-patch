/**
 * The `utils/` boundary, enforced rather than agreed.
 *
 * `utils` is the one folder every codebase has and every codebase lets rot,
 * because "utility" has no membership test — a function that reads a context and
 * causes a side effect is *arguably* a utility, and once one lands the folder
 * means nothing.
 *
 * So the membership test is a property: **a utility is a function of its
 * arguments.** No context, no globals, no I/O. This test is what makes that true
 * rather than aspirational — it fails the build, the way `scripts/check.ts`
 * already fails it for a client module reaching host-only code.
 *
 * @module test/architecture.test
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const UTILS_DIR = join(import.meta.dirname, "..", "src", "utils");

/** Every `.ts` file directly inside `src/utils/`. */
const utilityFiles = (): string[] =>
  readdirSync(UTILS_DIR)
    .filter((name) => name.endsWith(".ts"))
    .toSorted();

/** The source with `//` and block comments removed, keeping line structure. */
const stripComments = (source: string): string =>
  source
    .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
    .replaceAll(/^\s*\/\/.*$/gmu, "")
    .replaceAll(/\/\/.*$/gmu, "");

/** The module specifiers one file imports. */
const importsOf = (source: string): string[] => {
  const specifiers: string[] = [];
  const patterns = [/from\s+"([^"]+)"/gu, /import\s+"([^"]+)"/gu];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      if (match[1] !== undefined) {
        specifiers.push(match[1]);
      }
    }
  }
  return specifiers;
};

/** What a utility may not reach. Each entry names the rule it breaks. */
const FORBIDDEN: readonly {
  readonly matches: (specifier: string) => boolean;
  readonly because: string;
}[] = [
  {
    because:
      "a node built-in is I/O: the utility would need the filesystem or a stream to answer",
    matches: (s) => s.startsWith("node:"),
  },
  {
    because:
      "a cordis context is the world: a utility takes its inputs as arguments instead",
    matches: (s) => s.startsWith("@deepseek-ai/cordis"),
  },
  {
    because:
      "only guards.ts and other utilities may be imported; anything else is an effect module",
    matches: (s) => s.startsWith("../") || s.startsWith("./../"),
  },
];

describe("architecture · no source module imports a test library", () => {
  const SRC = join(import.meta.dirname, "..", "src");

  it("keeps vitest and testing-library out of everything in src/", () => {
    // Wider than `utils/`: an effect module importing `vitest` would be just as
    // fatal to a published package, and just as invisible in review. The gate on
    // `lib/client.js`'s requires catches it only if the import survives to the
    // bundle, which a type-only import does not.
    const violations: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/u.test(entry.name)) {
          continue;
        }
        const source = stripComments(readFileSync(full, "utf8"));
        if (/from\s+"(?:vitest|@testing-library[^"]*)"/u.test(source)) {
          violations.push(full.slice(SRC.length + 1));
        }
      }
    };
    walk(SRC);
    expect(violations).toEqual([]);
  });
});

describe("architecture · utils/ holds only pure functions", () => {
  it("has utilities to check", () => {
    // Without this the suite passes vacuously on an empty folder — the exact
    // "a grep over a directory that does not exist" failure.
    expect(utilityFiles().length).toBeGreaterThan(0);
  });

  it("imports nothing host-only, and nothing outside utils/", () => {
    const violations: string[] = [];
    for (const file of utilityFiles()) {
      const source = readFileSync(join(UTILS_DIR, file), "utf8");
      for (const specifier of importsOf(source)) {
        // `guards.ts` is dependency-free by construction and is the one
        // non-utility a utility may share.
        if (specifier === "./guards.ts") {
          continue;
        }
        for (const rule of FORBIDDEN) {
          if (rule.matches(specifier)) {
            violations.push(`${file} imports "${specifier}" — ${rule.because}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("never reads process.env, a global the arguments could have carried", () => {
    // Comments are stripped first: prose ABOUT the environment is exactly what
    // a rule explaining itself looks like, and a rule that flags its own
    // explanation would push the explanation out of the code.
    const violations = utilityFiles().filter((file) =>
      /process\.env/u.test(
        stripComments(readFileSync(join(UTILS_DIR, file), "utf8"))
      )
    );
    expect(violations).toEqual([]);
  });

  it("never calls fetch, which is I/O by definition", () => {
    const violations = utilityFiles().filter((file) => {
      // `fetch(` / `globalThis.fetch(` — but not the word inside a comment or a
      // longer identifier like `fetchPatch`.
      const source = stripComments(readFileSync(join(UTILS_DIR, file), "utf8"));
      return /(?:^|[^.\w])(?:fetch|globalThis\.fetch)\s*\(/mu.test(source);
    });
    expect(violations).toEqual([]);
  });
});
