import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { retry } from "./retry";
import { TimeoutError } from "./timeout";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("retry", () => {
  it("succeeds on the first attempt without any delay", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const onAttempt = vi.fn();

    const result = await retry(fn, { maxAttempts: 5, baseMs: 100, jitter: "none", onAttempt });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onAttempt).not.toHaveBeenCalled();
  });

  it("follows the baseMs * 2^attempt schedule (no jitter) across 5 attempts", async () => {
    const fn = vi.fn().mockRejectedValue({ status: 500 });
    const onAttempt = vi.fn();

    const settled = expect(
      retry(fn, { maxAttempts: 5, baseMs: 100, maxMs: 10_000, jitter: "none", onAttempt })
    ).rejects.toEqual({ status: 500 });
    await vi.runAllTimersAsync();
    await settled;

    expect(fn).toHaveBeenCalledTimes(5);
    const delays = onAttempt.mock.calls.map((call) => call[0].delayMs);
    // attempts 1-4 trigger a delay before the retry (attempt 5 exhausts maxAttempts, no further delay)
    expect(delays).toEqual([200, 400, 800, 1600]);
  });

  it("caps the delay at maxMs", async () => {
    const fn = vi.fn().mockRejectedValue({ status: 500 });
    const onAttempt = vi.fn();

    const settled = expect(
      retry(fn, { maxAttempts: 3, baseMs: 1000, maxMs: 1500, jitter: "none", onAttempt })
    ).rejects.toEqual({ status: 500 });
    await vi.runAllTimersAsync();
    await settled;

    const delays = onAttempt.mock.calls.map((call) => call[0].delayMs);
    expect(delays).toEqual([1500, 1500]);
  });

  it("does not retry a 400 - fails fast on the first attempt", async () => {
    const fn = vi.fn().mockRejectedValue({ status: 400 });
    const onAttempt = vi.fn();

    await expect(retry(fn, { maxAttempts: 5, baseMs: 100, jitter: "none", onAttempt })).rejects.toEqual({
      status: 400,
    });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(onAttempt).not.toHaveBeenCalled();
  });

  it("retries a 429", async () => {
    const fn = vi.fn().mockRejectedValueOnce({ status: 429 }).mockResolvedValueOnce("ok");

    const settled = expect(retry(fn, { maxAttempts: 3, baseMs: 10, jitter: "none" })).resolves.toBe("ok");
    await vi.runAllTimersAsync();
    await settled;
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries a TimeoutError", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new TimeoutError(50)).mockResolvedValueOnce("ok");

    const settled = expect(retry(fn, { maxAttempts: 3, baseMs: 10, jitter: "none" })).resolves.toBe("ok");
    await vi.runAllTimersAsync();
    await settled;
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxAttempts and throws the last error", async () => {
    const fn = vi.fn().mockRejectedValue({ status: 503 });

    const settled = expect(retry(fn, { maxAttempts: 3, baseMs: 10, jitter: "none" })).rejects.toEqual({
      status: 503,
    });
    await vi.runAllTimersAsync();
    await settled;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("keeps full-jitter delays within [0, cappedDelay]", async () => {
    const fn = vi.fn().mockRejectedValue({ status: 500 });
    const onAttempt = vi.fn();

    const settled = expect(
      retry(fn, { maxAttempts: 2, baseMs: 100, maxMs: 10_000, jitter: "full", onAttempt })
    ).rejects.toEqual({ status: 500 });
    await vi.runAllTimersAsync();
    await settled;

    const delayMs = onAttempt.mock.calls[0][0].delayMs;
    expect(delayMs).toBeGreaterThanOrEqual(0);
    expect(delayMs).toBeLessThanOrEqual(200);
  });
});
