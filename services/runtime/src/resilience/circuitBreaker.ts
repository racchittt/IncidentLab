export type CircuitState = "closed" | "open" | "half-open";

export class CircuitOpenError extends Error {
  constructor() {
    super("Circuit breaker is open");
    this.name = "CircuitOpenError";
  }
}

export interface CircuitBreakerOptions {
  failureThreshold: number;
  openMs: number;
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

/**
 * closed -> open after `failureThreshold` consecutive failures.
 * open -> half-open once `openMs` has passed since it opened.
 * half-open lets exactly one trial call through: success -> closed,
 * failure -> open again (and the openMs clock restarts).
 */
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private halfOpenTrialInFlight = false;

  constructor(private readonly options: CircuitBreakerOptions) {}

  getState(): CircuitState {
    return this.state;
  }

  private transition(to: CircuitState): void {
    const from = this.state;
    this.state = to;
    if (from !== to) {
      this.options.onStateChange?.(from, to);
    }
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.openedAt < this.options.openMs) {
        throw new CircuitOpenError();
      }
      this.transition("half-open");
    }

    if (this.state === "half-open") {
      if (this.halfOpenTrialInFlight) {
        throw new CircuitOpenError();
      }
      this.halfOpenTrialInFlight = true;
      try {
        const result = await fn();
        this.consecutiveFailures = 0;
        this.transition("closed");
        return result;
      } catch (error) {
        this.openedAt = Date.now();
        this.transition("open");
        throw error;
      } finally {
        this.halfOpenTrialInFlight = false;
      }
    }

    try {
      const result = await fn();
      this.consecutiveFailures = 0;
      return result;
    } catch (error) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.options.failureThreshold) {
        this.openedAt = Date.now();
        this.transition("open");
      }
      throw error;
    }
  }
}
