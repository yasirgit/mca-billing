export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export class CircuitOpenError extends Error {
  constructor(name: string) {
    super(`Circuit "${name}" is open; failing fast`);
    this.name = "CircuitOpenError";
  }
}

export interface CircuitBreakerOptions {
  name: string;
  /** Consecutive failures before the circuit opens. */
  failureThreshold?: number;
  /** How long the circuit stays open before allowing a probe. */
  cooldownMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

/**
 * CLOSED    -> calls pass; consecutive transport failures are counted.
 * OPEN      -> calls fail fast with CircuitOpenError until cooldown elapses.
 * HALF_OPEN -> a single probe is allowed; success closes, failure re-opens.
 *
 * Business outcomes (e.g. 530 "not yet") are mapped to typed results before
 * reaching the breaker, so only genuine transport faults trip it.
 */
export class CircuitBreaker {
  readonly name: string;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly onStateChange?: CircuitBreakerOptions["onStateChange"];

  private _state: CircuitState = "CLOSED";
  private consecutiveFailures = 0;
  private openedAt = 0;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.onStateChange = options.onStateChange;
  }

  get state(): CircuitState {
    return this._state;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this._state === "OPEN") {
      if (this.now() - this.openedAt < this.cooldownMs) {
        throw new CircuitOpenError(this.name);
      }
      this.transition("HALF_OPEN");
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    if (this._state === "HALF_OPEN") {
      this.transition("CLOSED");
    }
  }

  private onFailure(): void {
    if (this._state === "HALF_OPEN") {
      this.open();
      return;
    }
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.open();
    }
  }

  private open(): void {
    this.openedAt = this.now();
    this.consecutiveFailures = 0;
    this.transition("OPEN");
  }

  private transition(to: CircuitState): void {
    const from = this._state;
    if (from === to) return;
    this._state = to;
    this.onStateChange?.(from, to);
  }
}
