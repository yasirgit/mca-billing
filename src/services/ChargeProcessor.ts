import { NetworkError, type BillingApiClient } from "../api/BillingApiClient";
import type { Advance } from "../domain/Advance";
import { AdvanceState } from "../domain/AdvanceState";
import { CircuitOpenError } from "../infrastructure/CircuitBreaker";
import type { Logger } from "../infrastructure/Logger";
import type { Metrics } from "../infrastructure/Metrics";
import type { StateStore } from "../store/StateStore";
import type { IsoDate } from "../utils/Dates";
import { chargeIdempotencyKey } from "../utils/Idempotency";
import { Money } from "../utils/Money";
import { BalanceCalculator } from "./BalanceCalculator";

/** Max total charged per ADVANCE per day (not per mandate). */
export const DAILY_CHARGE_CAP = Money.of("10000.00");

/**
 * Drains each active advance's charge backlog FIFO, clamping every charge to
 *
 *   min(item.amount, cap headroom today, outstanding balance)
 *
 * Successful charges append immutable ledger events (the only thing that
 * counts toward the cap and the balance — a rejected charge moved no money,
 * so it consumes no headroom). Cap-split remainders are re-queued at the
 * head as NEW items; 530 rejections re-queue the whole item for tomorrow.
 */
export class ChargeProcessor {
  constructor(
    private readonly api: BillingApiClient,
    private readonly store: StateStore,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
    private readonly dailyCap: Money = DAILY_CHARGE_CAP,
  ) {}

  async processCharges(today: IsoDate): Promise<void> {
    for (const advance of this.store.allAdvances()) {
      if (advance.state !== AdvanceState.Active) continue;
      await this.drainAdvance(advance, today);
    }
    this.metrics.gauge("charge_backlog_depth", this.store.chargeBacklogDepth());
  }

  private async drainAdvance(advance: Advance, today: IsoDate): Promise<void> {
    let headroom = this.dailyCap.subtract(this.store.chargedOn(advance.id, today));

    while (true) {
      const item = this.store.peekCharge(advance.id);
      if (!item) return;

      const outstanding = BalanceCalculator.outstanding(
        advance,
        this.store.ledgerFor(advance.id),
      );
      if (outstanding.isZero()) {
        this.cancelBacklog(advance, today);
        return;
      }
      if (!headroom.isPositive()) {
        this.logger.info("daily_cap_reached", {
          today,
          advanceId: advance.id,
          pendingItems: this.store.chargeBacklogFor(advance.id).length,
        });
        return;
      }

      const toCharge = Money.min(item.amount, headroom, outstanding);
      const idempotencyKey = chargeIdempotencyKey(
        advance.id,
        item.sourceRevenueDate,
        item.id,
        item.attempts,
      );

      this.metrics.increment("charge_attempted");
      try {
        const outcome = await this.api.charge(
          advance.mandateId,
          toCharge,
          today,
          idempotencyKey,
        );
        if (outcome.kind === "rejected") {
          // Definitive 530: no money moved. Re-issue on a subsequent day.
          this.store.bumpChargeAttempts(advance.id, item.id);
          this.metrics.increment("charge_failure");
          this.logger.warn("charge_rejected", {
            today,
            advanceId: advance.id,
            mandateId: advance.mandateId,
            amount: toCharge.toString(),
            attempts: item.attempts + 1,
          });
          return; // The mandate is refusing today; stop draining this advance.
        }
        this.settleCharge(advance, item, toCharge, today);
        headroom = headroom.subtract(toCharge);
      } catch (error) {
        this.handleChargeError(advance, item, toCharge, today, error);
        return;
      }
    }
  }

  private settleCharge(
    advance: Advance,
    item: { id: number; amount: Money; sourceRevenueDate: IsoDate; createdOn: IsoDate },
    charged: Money,
    today: IsoDate,
  ): void {
    this.store.removeChargeItem(advance.id, item.id);
    this.store.appendLedgerEvent({
      advanceId: advance.id,
      mandateId: advance.mandateId,
      amount: charged,
      chargedOn: today,
      sourceRevenueDate: item.sourceRevenueDate,
    });
    this.metrics.increment("charge_success");
    this.logger.info("charge_settled", {
      today,
      advanceId: advance.id,
      mandateId: advance.mandateId,
      amount: charged.toString(),
      sourceRevenueDate: item.sourceRevenueDate,
    });

    const remainder = item.amount.subtract(charged);
    if (remainder.isPositive()) {
      // Cap/balance split: the unpaid remainder becomes a NEW head item so
      // FIFO order holds and idempotency keys never collide.
      this.store.enqueueChargeFront({
        advanceId: advance.id,
        mandateId: advance.mandateId,
        amount: remainder,
        sourceRevenueDate: item.sourceRevenueDate,
        createdOn: item.createdOn,
      });
      this.metrics.increment("charge_cap_splits");
      this.logger.info("charge_split", {
        today,
        advanceId: advance.id,
        charged: charged.toString(),
        remainder: remainder.toString(),
      });
    }
  }

  private handleChargeError(
    advance: Advance,
    item: { id: number; attempts: number },
    attemptedAmount: Money,
    today: IsoDate,
    error: unknown,
  ): void {
    if (error instanceof CircuitOpenError) {
      // Fail fast; items stay queued and are re-attempted when the circuit allows.
      this.logger.warn("charge_skipped_circuit_open", {
        today,
        advanceId: advance.id,
      });
      return;
    }
    if (error instanceof NetworkError) {
      // Ambiguous outcome: the charge may have landed. Never blind-retry —
      // park for manual reconciliation.
      this.store.removeChargeItem(advance.id, item.id);
      this.store.addDeadLetter(
        "charge",
        {
          advanceId: advance.id,
          mandateId: advance.mandateId,
          amount: attemptedAmount.toString(),
        },
        String(error),
        today,
        item.attempts + 1,
      );
      this.metrics.increment("dlq_added");
      this.logger.error("charge_ambiguous_dead_lettered", {
        today,
        advanceId: advance.id,
        amount: attemptedAmount.toString(),
        error: String(error),
      });
      return;
    }
    // Definitive server error after exhausting retries: nothing was charged;
    // keep the item and re-attempt tomorrow.
    this.store.bumpChargeAttempts(advance.id, item.id);
    this.metrics.increment("charge_failure");
    this.logger.error("charge_failed_transport", {
      today,
      advanceId: advance.id,
      error: String(error),
    });
  }

  private cancelBacklog(advance: Advance, today: IsoDate): void {
    const cancelled = this.store.clearChargeBacklog(advance.id);
    if (cancelled.length > 0) {
      this.logger.info("charge_backlog_cancelled_settled", {
        today,
        advanceId: advance.id,
        cancelledItems: cancelled.length,
        cancelledAmount: cancelled
          .reduce((sum, i) => sum.add(i.amount), Money.zero())
          .toString(),
      });
    }
  }
}
