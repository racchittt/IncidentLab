export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Runs `fn` with an AbortSignal that fires after `ms`. `fn` is responsible for
 * passing the signal to whatever it's calling (fetch, most HTTP clients) so the
 * underlying request actually gets cancelled, not just abandoned.
 */
export async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  try {
    return await fn(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new TimeoutError(ms);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
