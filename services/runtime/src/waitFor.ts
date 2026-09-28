import { logger } from "./logger";

interface WaitForOptions {
  attempts?: number;
  delayMs?: number;
  label?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries `fn` with linear backoff. Used at startup so a dependency that isn't
 * ready yet (e.g. floci right after `depends_on` lets the container start) doesn't
 * take the whole service down.
 */
export async function waitFor<T>(fn: () => Promise<T>, options: WaitForOptions = {}): Promise<T> {
  const { attempts = 10, delayMs = 1000, label = "operation" } = options;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === attempts) {
        throw error;
      }
      logger.warn({ attempt, attempts, err: error }, `${label} failed, retrying`);
      await sleep(delayMs * attempt);
    }
  }

  throw new Error("unreachable");
}
