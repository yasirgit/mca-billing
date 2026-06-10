export interface RetryPolicyOptions {
  /** Number of retries after the initial attempt (total attempts = maxRetries + 1). */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injectable for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for deterministic tests; must return a number in [0, 1). */
  random?: () => number;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Exponential backoff with FULL jitter:
 *
 *   delay_n = uniform(0, min(maxDelayMs, baseDelayMs * 2^n))
 *
 * Full jitter spreads retries uniformly across the backoff window, avoiding
 * the synchronized "thundering herd" that fixed or equal-jitter schedules
 * produce after a shared dependency failure.
 */
export class RetryPolicy {
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly onRetry?: RetryPolicyOptions["onRetry"];

  constructor(options: RetryPolicyOptions = {}) {
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 100;
    this.maxDelayMs = options.maxDelayMs ?? 2000;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.onRetry = options.onRetry;
  }

  delayFor(attempt: number): number {
    const cap = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempt);
    return this.random() * cap;
  }

  async execute<T>(
    fn: () => Promise<T>,
    isRetryable: (error: unknown) => boolean,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (attempt >= this.maxRetries || !isRetryable(error)) {
          throw error;
        }
        const delay = this.delayFor(attempt);
        this.onRetry?.(attempt + 1, delay, error);
        await this.sleep(delay);
      }
    }
  }
}
