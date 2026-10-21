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

describe("architecture · a property read is a declared dependency", () => {
  const SRC = join(import.meta.dirname, "..", "src");

  /**
   * Cordis's own framework members, mixed onto every context. Reading these
   * needs no declaration — they are not services.
   */
  const FRAMEWORK = new Set([
    "baseUrl",
    "effect",
    "fiber",
    "get",
    "inject",
    "logger",
    "on",
    "plugin",
    "provide",
    "root",
  ]);

  /**
   * The CLIENT half's context, which is a different object from the host's.
   *
   * Every read there is optional (`ctx.remote === undefined`,
   * `ctx.slots?.inject?.(…)`), which is the pattern the host half must use for
   * its optional services and does. They are not `inject` declarations because
   * the host plugin declares only `llm` — see the next test.
   */
  const CLIENT_OPTIONAL = new Set([
    "configForms",
    "locale",
    "modelDirectories",
    "remote",
    "slots",
  ]);

  /** The one service the plugin DECLARES, so reading it as a property is right. */
  const DECLARED = new Set(["llm"]);

  /** Every `ctx.<name>` in a file, excluding `ctx.get("name")`. */
  const serviceReads = (file: string): string[] => {
    const source = stripComments(readFileSync(join(SRC, file), "utf8"));
    const names = new Set<string>();
    // Two shapes are the same bug: `ctx.loader` and `(ctx as {loader}).loader`.
    // The cast form is what a "quick fix" looks like, and matching only the
    // first let a planted regression pass.
    for (const match of source.matchAll(
      /\bctx\.([A-Za-z][A-Za-z0-9_]*)|\bctx as [^\n]*\}\)\.([A-Za-z][A-Za-z0-9_]*)/gu
    )) {
      const name = match[1] ?? match[2];
      if (
        name === undefined ||
        FRAMEWORK.has(name) ||
        CLIENT_OPTIONAL.has(name) ||
        DECLARED.has(name)
      ) {
        continue;
      }
      names.add(name);
    }
    return [...names];
  };

  const sourceFiles = (): string[] => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.tsx?$/u.test(entry.name)) {
          files.push(full.slice(SRC.length + 1));
        }
      }
    };
    walk(SRC);
    return files;
  };

  it("reads no host service as a property except the declared `llm`", () => {
    // Cordis THROWS `cannot get property "X" without inject` for an undeclared
    // name, and its `inject` form has no required/optional split: a declared
    // service is REQUIRED, so declaring the optional ones would stop the plugin
    // activating on a headless host — a silent total failure.
    //
    // Consequence: every optional host service must be read through `ctx.get`,
    // which reads the store without consulting `inject`. This shipped as two
    // real bugs: `isLoaderHost` — which exists to answer "is there a loader?" —
    // read `ctx.loader` and threw, and `loaderOf` read it before its own
    // guarded fallback. Both failed the mount.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      for (const name of serviceReads(file)) {
        offenders.push(`${file}: ctx.${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("declares `llm`, the one service the plugin cannot work without", async () => {
    const { inject } = await import("../src/identity.ts");
    expect(inject).toContain("llm");
  });
});

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
