import { logger } from "./logger";

interface RetryOptions {
  retries?: number;
  delayMs?: number;
  label?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries `fn` with linear backoff. Used at startup so a dependency that isn't
 * ready yet (e.g. floci right after `depends_on` lets the container start) doesn't
 * take the whole service down.
 */
export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { retries = 10, delayMs = 1000, label = "operation" } = options;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
      logger.warn({ attempt, retries, err: error }, `${label} failed, retrying`);
      await sleep(delayMs * attempt);
    }
  }

  throw new Error("unreachable");
}
