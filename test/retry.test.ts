import { describe, expect, it, vi } from "vitest";

import { retryUntilAnswered } from "../src/utils/retry.ts";

describe("utils/retry: retryUntilAnswered", () => {
  const noSleep = () => Promise.resolve();

  it("returns the first answer without retrying when immediately defined", async () => {
    let calls = 0;
    const read = () => {
      calls += 1;
      return Promise.resolve("ready");
    };
    const result = await retryUntilAnswered(read, 5, noSleep);
    expect(result).toBe("ready");
    expect(calls).toBe(1);
  });

  it("retries when read returns undefined until an answer arrives", async () => {
    let calls = 0;
    const read = () => {
      calls += 1;
      return Promise.resolve(calls < 3 ? undefined : "finally");
    };
    const result = await retryUntilAnswered(read, 5, noSleep);
    expect(result).toBe("finally");
    expect(calls).toBe(3);
  });

  it("retries when read throws an error on intermediate attempts and returns answer", async () => {
    let calls = 0;
    const read = () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("transient socket glitch");
      }
      if (calls === 2) {
        return Promise.reject(new Error("cold-start timeout"));
      }
      return Promise.resolve("recovered");
    };
    const result = await retryUntilAnswered(read, 5, noSleep);
    expect(result).toBe("recovered");
    expect(calls).toBe(3);
  });

  it("returns undefined after exhausting all attempts when read continuously returns undefined", async () => {
    let calls = 0;
    const read = async () => {
      calls += 1;
    };
    const result = await retryUntilAnswered(read, 4, noSleep);
    expect(result).toBeUndefined();
    expect(calls).toBe(4);
  });

  it("returns undefined and logs a warning when all attempts throw errors", async () => {
    let calls = 0;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const read = () => {
      calls += 1;
      return Promise.reject(new Error("repeated outage"));
    };
    try {
      const result = await retryUntilAnswered(read, 3, noSleep);
      expect(result).toBeUndefined();
      expect(calls).toBe(3);
      expect(warnSpy).toHaveBeenCalledWith(
        "[dsh-opencode-patch] retry: all attempts failed",
        expect.any(Error)
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("aborts early without calling sleep or further attempts when live() returns false initially", async () => {
    let calls = 0;
    const sleep = vi.fn(() => Promise.resolve());
    const read = async () => {
      calls += 1;
      return "unreached";
    };
    const result = await retryUntilAnswered(read, 5, sleep, () => false);
    expect(result).toBeUndefined();
    expect(calls).toBe(0);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("aborts during retry progression when live() transitions to false", async () => {
    let calls = 0;
    let alive = true;
    const read = async () => {
      calls += 1;
      alive = false;
    };
    const result = await retryUntilAnswered(read, 5, noSleep, () => alive);
    expect(result).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("uses the default sleep calculation when sleep is omitted", async () => {
    // Testing that the default sleep parameter can be executed without error
    let calls = 0;
    const read = () => {
      calls += 1;
      return Promise.resolve(calls < 2 ? undefined : "done");
    };
    const result = await retryUntilAnswered(read, 2);
    expect(result).toBe("done");
    expect(calls).toBe(2);
  });
});
