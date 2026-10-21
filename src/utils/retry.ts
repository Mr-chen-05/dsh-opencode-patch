/**
 * Generic retry loop over an asynchronous operation that may return undefined or throw.
 *
 * This is a pure algorithm: it takes the operation, the retry limit, the sleep
 * mechanism and an optional liveness probe. No context, no globals, no I/O.
 *
 * @module dsh-opencode-patch/retry
 */

/**
 * Attempt to read a defined value until an answer arrives or attempts are exhausted.
 *
 * Each attempt awaits the reader. If the reader resolves a defined value, that value
 * is returned immediately. If the reader returns undefined or throws an error, the attempt
 * is considered unfulfilled:
 * - If `live()` returns false, the loop aborts immediately without further attempts.
 * - Otherwise, it sleeps for the duration determined by `sleep(attempt)` and tries again.
 * - If all attempts are exhausted, it returns `undefined`.
 *
 * @param read - the async reader operation.
 * @param attempts - maximum number of attempts (defaults to 5).
 * @param sleep - callback taking attempt index (0-based) and returning a sleep Promise.
 * @param live - optional predicate polled before each attempt; returning false aborts.
 * @returns the first defined answer, or `undefined` if unfulfilled.
 */
export const retryUntilAnswered = async <T>(
  read: () => Promise<T | undefined>,
  attempts = 5,
  sleep: (attempt: number) => Promise<void> = (attempt) =>
    new Promise((resolve) => {
      setTimeout(resolve, 300 * (attempt + 1));
    }),
  live: () => boolean = () => true
): Promise<T | undefined> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!live()) {
      return undefined;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential retry by design
      const next = await read();
      if (next !== undefined) {
        return next;
      }
    } catch (error: unknown) {
      lastError = error;
    }
    if (attempt < attempts - 1) {
      // oxlint-disable-next-line no-await-in-loop -- delay between attempts
      await sleep(attempt);
    }
  }
  if (lastError !== undefined) {
    console.warn("[dsh-opencode-patch] retry: all attempts failed", lastError);
  }
  return undefined;
};
