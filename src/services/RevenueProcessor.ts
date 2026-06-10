import type { BillingApiClient } from "../api/BillingApiClient";
import type { Advance } from "../domain/Advance";
import { AdvanceState } from "../domain/AdvanceState";
import type { Logger } from "../infrastructure/Logger";
import type { Metrics } from "../infrastructure/Metrics";
import type { StateStore } from "../store/StateStore";
import { addDays, compareDates, type IsoDate } from "../utils/Dates";
import { BalanceCalculator } from "./BalanceCalculator";

/**
 * For every active advance, fetches the revenue for each due revenue date
 * (newly-due dates from the cursor plus previously backlogged ones), computes
 * the repayment amount and enqueues it on the charge backlog.
 *
 * Idempotency: a revenue date is in exactly one of three places — ahead of
 * the cursor, in the revenue backlog, or in the processed set — so it can
 * never be billed twice.
 */
export class RevenueProcessor {
  constructor(
    private readonly api: BillingApiClient,
    private readonly store: StateStore,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
  ) {}

  async processRevenues(today: IsoDate): Promise<void> {
    for (const advance of this.store.allAdvances()) {
      if (advance.state !== AdvanceState.Active) continue;
      if (compareDates(today, advance.repaymentStartDate) < 0) continue;
      await this.processAdvance(advance, today);
    }
    this.metrics.gauge("revenue_backlog_depth", this.store.revenueBacklogDepth());
  }

  private async processAdvance(advance: Advance, today: IsoDate): Promise<void> {
    // On day D we bill revenue up to and including D-1.
    const dueDates = new Set<IsoDate>([
      ...this.store.revenueBacklogFor(advance.id).map((i) => i.revenueDate),
      ...advance.collectDueRevenueDates(addDays(today, -1)),
    ]);

    for (const revenueDate of [...dueDates].sort(compareDates)) {
      if (this.store.hasProcessedRevenue(advance.id, revenueDate)) {
        this.store.removeRevenueBacklog(advance.id, revenueDate);
        continue;
      }
      if (BalanceCalculator.isSettled(advance, this.store.ledgerFor(advance.id))) {
        // Fully repaid: pending revenue must not generate further charges.
        this.store.removeRevenueBacklog(advance.id, revenueDate);
        this.logger.info("revenue_fetch_cancelled_settled", {
          today,
          advanceId: advance.id,
          revenueDate,
        });
        continue;
      }
      await this.fetchAndEnqueue(advance, revenueDate, today);
    }
  }

  private async fetchAndEnqueue(
    advance: Advance,
    revenueDate: IsoDate,
    today: IsoDate,
  ): Promise<void> {
    try {
      const result = await this.api.getRevenue(
        advance.customerId,
        revenueDate,
        today,
      );
      if (result.kind === "unavailable") {
        this.backlog(advance, revenueDate, today, "revenue_unavailable");
        return;
      }
      this.store.removeRevenueBacklog(advance.id, revenueDate);
      this.store.markRevenueProcessed(advance.id, revenueDate);
      this.metrics.increment("revenue_fetched");
      this.metrics.increment("revenue_backlog_processed");

      const repayment = result.amount.percent(advance.repaymentPercentage);
      this.logger.info("revenue_processed", {
        today,
        advanceId: advance.id,
        customerId: advance.customerId,
        revenueDate,
        revenue: result.amount.toString(),
        repayment: repayment.toString(),
      });
      if (repayment.isPositive()) {
        this.store.enqueueCharge({
          advanceId: advance.id,
          mandateId: advance.mandateId,
          amount: repayment,
          sourceRevenueDate: revenueDate,
          createdOn: today,
        });
        this.metrics.increment("charge_backlog_added");
      }
    } catch (error) {
      // Transport failure after retries (or open circuit): treat as
      // unavailable today and re-attempt on the next day.
      this.logger.error("revenue_fetch_failed", {
        today,
        advanceId: advance.id,
        revenueDate,
        error: String(error),
      });
      this.backlog(advance, revenueDate, today, "revenue_fetch_error");
    }
  }

  private backlog(
    advance: Advance,
    revenueDate: IsoDate,
    today: IsoDate,
    reason: string,
  ): void {
    const { isNew } = this.store.upsertRevenueBacklog(
      advance.id,
      advance.customerId,
      revenueDate,
      today,
    );
    this.metrics.increment("revenue_unavailable");
    if (isNew) this.metrics.increment("revenue_backlog_added");
    this.logger.info(reason, {
      today,
      advanceId: advance.id,
      customerId: advance.customerId,
      revenueDate,
    });
  }
}
