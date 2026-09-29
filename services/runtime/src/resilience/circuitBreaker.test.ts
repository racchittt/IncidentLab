import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CircuitBreaker, CircuitOpenError } from "./circuitBreaker";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CircuitBreaker", () => {
  it("starts closed and lets calls through", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, openMs: 1000 });
    const fn = vi.fn().mockResolvedValue("ok");

    await expect(breaker.execute(fn)).resolves.toBe("ok");
    expect(breaker.getState()).toBe("closed");
  });

  it("opens after failureThreshold consecutive failures", async () => {
    const onStateChange = vi.fn();
    const breaker = new CircuitBreaker({ failureThreshold: 3, openMs: 1000, onStateChange });
    const fn = vi.fn().mockRejectedValue(new Error("boom"));

    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(fn)).rejects.toThrow("boom");
    }

    expect(breaker.getState()).toBe("open");
    expect(onStateChange).toHaveBeenCalledWith("closed", "open");
  });

  it("rejects immediately with CircuitOpenError while open, without calling fn", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, openMs: 10_000 });
    const fn = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(breaker.execute(fn)).rejects.toThrow("boom");
    expect(breaker.getState()).toBe("open");

    fn.mockClear();
    await expect(breaker.execute(fn)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("does not open on a failure count below the threshold", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, openMs: 1000 });
    const fn = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(breaker.execute(fn)).rejects.toThrow();
    await expect(breaker.execute(fn)).rejects.toThrow();

    expect(breaker.getState()).toBe("closed");
  });

  it("moves to half-open after openMs and closes on a successful trial", async () => {
    const onStateChange = vi.fn();
    const breaker = new CircuitBreaker({ failureThreshold: 1, openMs: 1000, onStateChange });
    const failing = vi.fn().mockRejectedValue(new Error("boom"));
    const succeeding = vi.fn().mockResolvedValue("ok");

    await expect(breaker.execute(failing)).rejects.toThrow();
    expect(breaker.getState()).toBe("open");

    await vi.advanceTimersByTimeAsync(1000);

    await expect(breaker.execute(succeeding)).resolves.toBe("ok");
    expect(breaker.getState()).toBe("closed");
    expect(onStateChange).toHaveBeenCalledWith("open", "half-open");
    expect(onStateChange).toHaveBeenCalledWith("half-open", "closed");
  });

  it("re-opens if the half-open trial call fails", async () => {
    const onStateChange = vi.fn();
    const breaker = new CircuitBreaker({ failureThreshold: 1, openMs: 1000, onStateChange });
    const failing = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(breaker.execute(failing)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1000);

    await expect(breaker.execute(failing)).rejects.toThrow();
    expect(breaker.getState()).toBe("open");
    expect(onStateChange).toHaveBeenCalledWith("half-open", "open");
  });

  it("only lets exactly one trial call through while half-open", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, openMs: 1000 });
    const failing = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(breaker.execute(failing)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1000);

    let resolveTrial!: (value: string) => void;
    const slowTrial = vi.fn(() => new Promise<string>((resolve) => (resolveTrial = resolve)));

    const first = breaker.execute(slowTrial);
    await expect(breaker.execute(vi.fn())).rejects.toBeInstanceOf(CircuitOpenError);

    resolveTrial("ok");
    await expect(first).resolves.toBe("ok");
  });
});
