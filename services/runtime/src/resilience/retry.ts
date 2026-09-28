import { TimeoutError } from "./timeout";

export interface RetryOptions {
  maxAttempts: number;
  baseMs: number;
  maxMs?: number;
  jitter: "full" | "none";
  onAttempt?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

interface HasStatus {
  status: number;
}

function hasStatus(error: unknown): error is HasStatus {
  return typeof error === "object" && error !== null && typeof (error as HasStatus).status === "number";
}

/** Timeouts, 5xx and 429 are worth retrying. Everything else (400, 401, 404, ...) is not. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof TimeoutError) return true;
  if (hasStatus(error)) {
    return error.status >= 500 || error.status === 429;
  }
  return false;
}

function delayForAttempt(attempt: number, baseMs: number, maxMs: number, jitter: "full" | "none"): number {
  const capped = Math.min(maxMs, baseMs * 2 ** attempt);
  return jitter === "full" ? Math.random() * capped : capped;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries `fn` on timeouts, 5xx and 429 only - never on other 4xx errors, since
 * those mean the request itself was wrong and retrying won't fix it. Delay before
 * attempt n is `baseMs * 2^n`, capped at `maxMs`, with full jitter (`random(0, delay)`)
 * unless `jitter: "none"`.
 */
export async function retry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { maxAttempts, baseMs, maxMs = 30_000, jitter, onAttempt } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxAttempts || !isRetryable(error)) {
        throw error;
      }
      const delayMs = delayForAttempt(attempt, baseMs, maxMs, jitter);
      onAttempt?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }

  throw new Error("unreachable");
}
