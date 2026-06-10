import {
  ApiStatusError,
  NetworkError,
  type AdvanceDto,
  type BillingApiClient,
  type ChargeOutcome,
  type RevenueResult,
} from "./BillingApiClient";
import { CircuitBreaker, type CircuitBreakerOptions } from "../infrastructure/CircuitBreaker";
import type { RetryPolicy } from "../infrastructure/RetryPolicy";
import type { Logger } from "../infrastructure/Logger";
import type { Metrics } from "../infrastructure/Metrics";
import type { Money } from "../utils/Money";
import type { IsoDate } from "../utils/Dates";

/**
 * Retryable 5xx server errors. 530 never reaches here for revenue/charge (it
 * is mapped to a typed business result inside HttpBillingApiClient), and is
 * excluded anyway: "not yet" must not be hammered in-call.
 */
const isRetryableStatus = (e: unknown): boolean =>
  e instanceof ApiStatusError && e.status >= 500 && e.status !== 530;

/** GETs are idempotent: ambiguous network failures are safe to retry too. */
const isRetryableForGet = (e: unknown): boolean =>
  e instanceof NetworkError || isRetryableStatus(e);

/**
 * Resilience decorator around the API port: per-endpoint-family circuit
 * breakers wrapping a full-jitter retry policy.
 *
 * Charge POSTs deliberately do NOT retry NetworkError: with no response the
 * charge may have landed, and a blind retry risks double-charging. The error
 * propagates so the ChargeProcessor can dead-letter it for reconciliation.
 * billing_complete is semantically idempotent, so it retries network errors.
 */
type BreakerFamily = "advances" | "revenues" | "charges" | "completion";

export class RetryableBillingApiClient implements BillingApiClient {
  private readonly breakers: Record<BreakerFamily, CircuitBreaker>;

  constructor(
    private readonly inner: BillingApiClient,
    private readonly retryPolicy: RetryPolicy,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
    breakerOptions: Omit<CircuitBreakerOptions, "name" | "onStateChange"> = {},
  ) {
    const makeBreaker = (name: string) =>
      new CircuitBreaker({
        ...breakerOptions,
        name,
        onStateChange: (from, to) => {
          this.metrics.increment(to === "OPEN" ? "circuit_opened" : "circuit_closed");
          this.logger.warn("circuit_state_change", { circuit: name, from, to });
        },
      });
    this.breakers = {
      advances: makeBreaker("advances"),
      revenues: makeBreaker("revenues"),
      charges: makeBreaker("charges"),
      completion: makeBreaker("completion"),
    };
  }

  getAdvances(today: IsoDate): Promise<AdvanceDto[]> {
    return this.call("advances", isRetryableForGet, () =>
      this.inner.getAdvances(today),
    );
  }

  getRevenue(
    customerId: number,
    forDate: IsoDate,
    today: IsoDate,
  ): Promise<RevenueResult> {
    return this.call("revenues", isRetryableForGet, () =>
      this.inner.getRevenue(customerId, forDate, today),
    );
  }

  charge(
    mandateId: number,
    amount: Money,
    today: IsoDate,
    idempotencyKey: string,
  ): Promise<ChargeOutcome> {
    return this.call("charges", isRetryableStatus, () =>
      this.inner.charge(mandateId, amount, today, idempotencyKey),
    );
  }

  billingComplete(advanceId: number, today: IsoDate): Promise<void> {
    return this.call("completion", isRetryableForGet, () =>
      this.inner.billingComplete(advanceId, today),
    );
  }

  private call<T>(
    family: BreakerFamily,
    isRetryable: (e: unknown) => boolean,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.breakers[family].execute(() =>
      this.retryPolicy.execute(async () => {
        try {
          return await fn();
        } catch (error) {
          this.metrics.increment(`api_error_${family}`);
          this.logger.warn("api_call_failed", {
            circuit: family,
            error: String(error),
          });
          throw error;
        }
      }, isRetryable),
    );
  }
}
