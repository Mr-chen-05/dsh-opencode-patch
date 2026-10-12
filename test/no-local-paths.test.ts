/**
 * The hard rule, as a test rather than as a habit.
 *
 * An absolute path from a development machine must never appear anywhere a third
 * party can read, and the rule says the check belongs BEFORE the commit — because
 * once it ships, removing it means rewriting content and history, force-pushing
 * over every tag and invalidating published provenance.
 *
 * So this reads the tree and the built artifacts, and it accepts exactly the
 * placeholders the rule prescribes: `/home/you/…`, `/Users/you/…`,
 * `C:/Users/you/…` and `C:\Users\<name>` in the rule's own prose. Everything else
 * that names a real home directory is a failure that names the file.
 *
 * @module dsh-opencode-patch/no-local-paths.test
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = new URL("..", import.meta.url).pathname;

/** Directories a third party can read: the tree, plus the build output. */
const SCANNED = ["src", "test", "docs", "scripts", "lib"];
const SCANNED_FILES = [
  "AGENTS.md",
  "README.md",
  "package.json",
  "cordis.patch.yml",
];

/** A home prefix followed by a name that is not the rule's placeholder. */
const LOCAL_PATH =
  /(?:\/Users\/|\/home\/|C:\\Users\\|C:\/Users\/)(?!you(?:\/|\\|["'`\s]|$)|<name>)[A-Za-z0-9._-]+/gu;

const walk = async (dir: string): Promise<string[]> => {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // `lib/` is build output and may not exist yet; its absence is not a failure.
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry === "node_modules" || entry.startsWith(".")) {
      continue;
    }
    const full = join(dir, entry);
    const info = await stat(full);
    if (info.isDirectory()) {
      found.push(...(await walk(full)));
    } else if (/\.(?:ts|tsx|js|mjs|md|json|ya?ml)$/u.test(entry)) {
      found.push(full);
    }
  }
  return found;
};

describe("the hard rule: no local path leaves the machine", () => {
  it("finds no home directory in the tree or the build output", async () => {
    const files = SCANNED_FILES.map((name) => join(ROOT, name));
    for (const dir of SCANNED) {
      files.push(...(await walk(join(ROOT, dir))));
    }

    const offenders: string[] = [];
    for (const file of files) {
      // This file is the one exception, and it has to be: proving the check can
      // tell a placeholder from a real home directory means writing one of each
      // down. Every other file is scanned.
      if (file.endsWith("no-local-paths.test.ts")) {
        continue;
      }
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        continue;
      }
      for (const match of text.matchAll(LOCAL_PATH)) {
        offenders.push(`${relative(ROOT, file)}: ${match[0]}`);
      }
    }

    // The message names the file and the path, because the whole point is that a
    // violation must be found before it is committed rather than after.
    expect(offenders).toEqual([]);
  });

  it("accepts the placeholders the rule prescribes", () => {
    // The check has to be able to tell the two apart, so it is asserted directly
    // rather than inferred from a tree that happens to be clean.
    const allowed = [
      "/home/you/projects/my-app",
      "/Users/you/dev/my-app",
      "C:/Users/you/projects/my-app",
      "/Users/<name>/…",
    ];
    for (const sample of allowed) {
      expect(sample.match(LOCAL_PATH), sample).toBeNull();
    }
    const forbidden = [
      "/Users/someone/projects/app",
      "/home/someone/app",
      "C:\\Users\\someone\\app",
    ];
    for (const sample of forbidden) {
      expect(sample.match(LOCAL_PATH), sample).not.toBeNull();
    }
  });
});
