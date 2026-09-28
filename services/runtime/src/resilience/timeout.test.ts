import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withTimeout, TimeoutError } from "./timeout";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("withTimeout", () => {
  it("resolves normally when fn completes before the timeout", async () => {
    const fn = vi.fn().mockResolvedValue("ok");

    await expect(withTimeout(fn, 1000)).resolves.toBe("ok");
  });

  it("throws TimeoutError and aborts the signal when fn exceeds the timeout", async () => {
    let capturedSignal: AbortSignal | undefined;
    const fn = (signal: AbortSignal) => {
      capturedSignal = signal;
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    };

    const settled = expect(withTimeout(fn, 1000)).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await settled;
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("propagates a non-abort error from fn unchanged", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(withTimeout(fn, 1000)).rejects.toThrow("boom");
  });
});
