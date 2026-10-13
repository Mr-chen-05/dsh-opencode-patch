/**
 * Where an OpenCode installation keeps its files, resolved the way OpenCode
 * resolves them.
 *
 * This is a port of two files in the OpenCode sources, and it exists because the
 * path is not a constant: `~/.local/share/opencode/opencode.db` is right on a
 * stable channel and wrong under a moved `$XDG_DATA_HOME`, a named channel, or an
 * `$OPENCODE_DB` override.
 *
 * - `packages/util/src/global-roots.ts` — the directory. It is XDG on every
 *   platform, so macOS and Windows use `~/.local/share` too; `os.os.homedir()` is the
 *   only platform-dependent call, which is why `home` is a parameter here.
 * - `packages/cli/src/database-path.ts` — the filename, which varies by channel.
 *
 * Nothing here reads the environment or the filesystem: the caller passes both, so
 * the resolution can be tested on any platform from any platform.
 *
 * @module dsh-opencode-patch/opencode-paths
 */

import path from "node:path";

/** The channels whose database is named plainly rather than per channel. */
const STABLE_CHANNELS = new Set(["latest", "dev", "beta", "next", "prod"]);

/** What {@link opencodeRoots} reads. */
export interface OpencodeEnvironment {
  /** The user's home directory, as `os.os.homedir()` would report it. */
  readonly home: string;
  /** Environment variables; absent ones are `undefined`. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The OpenCode channel, as `OPENCODE_CHANNEL` carries it. */
  readonly channel?: string | undefined;
}

/** The directories an installation roots itself in. */
export interface OpencodeRoots {
  readonly cache: string;
  readonly config: string;
  readonly data: string;
  readonly state: string;
  readonly tmp: string;
}

/**
 * Resolve the XDG roots the way `roots("opencode")` does.
 *
 * Each falls back to a `~`-relative path, and `tmp` to the platform temporary
 * directory, which the caller supplies for the same reason it supplies `home`.
 *
 * @param environment - home, environment variables, and the channel.
 * @param tmp - the platform temporary directory.
 * @returns the five roots.
 */
export const opencodeRoots = (
  environment: OpencodeEnvironment,
  tmp: string
): OpencodeRoots => {
  const { env, home } = environment;
  const root = (variable: string, fallback: string): string =>
    path.join(env[variable] ?? path.join(home, fallback), "opencode");
  return {
    cache: root("XDG_CACHE_HOME", ".cache"),
    config: root("XDG_CONFIG_HOME", ".config"),
    data: root("XDG_DATA_HOME", path.join(".local", "share")),
    state: root("XDG_STATE_HOME", path.join(".local", "state")),
    tmp: path.join(tmp, "opencode"),
  };
};

/**
 * The database filename, before it is joined to a root.
 *
 * `$OPENCODE_DB` wins outright, including when it is `:memory:`. Otherwise a
 * stable channel — or `$OPENCODE_DISABLE_CHANNEL_DB` — gives `opencode.db`, and
 * anything else gives `opencode-<channel>.db` with characters outside
 * `[a-zA-Z0-9._-]` replaced by `-`, which is what the original does.
 *
 * @param environment - home, environment variables, and the channel.
 * @returns the filename, or `:memory:`.
 */
export const opencodeDatabaseFile = (
  environment: OpencodeEnvironment
): string => {
  const { channel, env } = environment;
  const declared = env.OPENCODE_DB;
  if (declared !== undefined && declared.length > 0) {
    return declared;
  }
  const disable = env.OPENCODE_DISABLE_CHANNEL_DB;
  const stable =
    (channel !== undefined && STABLE_CHANNELS.has(channel)) ||
    disable === "1" ||
    disable === "true";
  if (stable || channel === undefined || channel.length === 0) {
    return "opencode.db";
  }
  return `opencode-${channel.replaceAll(/[^a-zA-Z0-9._-]/gu, "-")}.db`;
};

/**
 * The absolute path of the credential database, or `:memory:`.
 *
 * The one place the two resolutions meet: the filename lives under **data**, not
 * under config, so a reader that used one root for both would look in the wrong
 * directory.
 *
 * @param environment - home, environment variables, and the channel.
 * @param tmp - the platform temporary directory.
 * @returns the path to open, or `:memory:`.
 */
export const opencodeDatabasePath = (
  environment: OpencodeEnvironment,
  tmp: string
): string => {
  const file = opencodeDatabaseFile(environment);
  return file === ":memory:"
    ? file
    : path.join(opencodeRoots(environment, tmp).data, file);
};
