import type { AdvanceDto, BillingApiClient } from "../api/BillingApiClient";
import { Advance } from "../domain/Advance";
import { AdvanceState } from "../domain/AdvanceState";
import type { Logger } from "../infrastructure/Logger";
import type { Metrics } from "../infrastructure/Metrics";
import type { StateStore } from "../store/StateStore";
import type { IsoDate } from "../utils/Dates";
import { Money } from "../utils/Money";
import { BalanceCalculator } from "./BalanceCalculator";
import type { ChargeProcessor } from "./ChargeProcessor";
import type { RevenueProcessor } from "./RevenueProcessor";

/**
 * Orchestrates one billing day:
 *
 *   1. sync newly-created advances from the API
 *   2. fetch due revenues and enqueue repayments  (RevenueProcessor)
 *   3. drain charge backlogs under cap and clamp  (ChargeProcessor)
 *   4. settle completions: REPAID -> billing_complete -> COMPLETED
 *
 * TODO: advances are processed sequentially; production would shard
 * per-advance work across workers with per-advance ordering and a durable
 * run checkpoint.
 */
export class BillingEngine {
  constructor(
    private readonly api: BillingApiClient,
    private readonly store: StateStore,
    private readonly revenueProcessor: RevenueProcessor,
    private readonly chargeProcessor: ChargeProcessor,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
  ) {}

  async runBilling(today: IsoDate): Promise<void> {
    this.logger.info("billing_day_started", { today });
    await this.syncAdvances(today);
    await this.revenueProcessor.processRevenues(today);
    await this.chargeProcessor.processCharges(today);
    await this.completeSettledAdvances(today);
    this.logger.info("billing_day_finished", { today });
  }

  private async syncAdvances(today: IsoDate): Promise<void> {
    let dtos: AdvanceDto[];
    try {
      dtos = await this.api.getAdvances(today);
    } catch (error) {
      // Known advances can still be billed today; new ones are picked up on
      // the next successful sync (the cursor catches their revenue up).
      this.logger.error("advance_sync_failed", { today, error: String(error) });
      return;
    }
    for (const dto of dtos) {
      const advance = this.toDomain(dto);
      if (this.store.addAdvanceIfAbsent(advance)) {
        this.metrics.increment("advances_discovered");
        this.logger.info("advance_discovered", {
          today,
          advanceId: advance.id,
          customerId: advance.customerId,
          totalRepayable: advance.totalRepayable.toString(),
          repaymentStartDate: advance.repaymentStartDate,
        });
      }
    }
  }

  private async completeSettledAdvances(today: IsoDate): Promise<void> {
    for (const advance of this.store.allAdvances()) {
      if (
        advance.state === AdvanceState.Active &&
        BalanceCalculator.isSettled(advance, this.store.ledgerFor(advance.id))
      ) {
        advance.markRepaid();
        this.store.clearRevenueBacklog(advance.id);
        this.store.clearChargeBacklog(advance.id);
        this.logger.info("advance_repaid", { today, advanceId: advance.id });
      }

      if (advance.state === AdvanceState.Repaid) {
        try {
          await this.api.billingComplete(advance.id, today);
          advance.markCompleted();
          this.metrics.increment("billing_complete");
          this.logger.info("billing_complete_acknowledged", {
            today,
            advanceId: advance.id,
          });
        } catch (error) {
          // Stays REPAID: retried on a later day; charging is already over.
          this.logger.error("billing_complete_failed", {
            today,
            advanceId: advance.id,
            error: String(error),
          });
        }
      }
    }
  }

  private toDomain(dto: AdvanceDto): Advance {
    return new Advance({
      id: dto.id,
      customerId: dto.customer_id,
      mandateId: dto.mandate_id,
      created: dto.created,
      totalAdvanced: Money.of(dto.total_advanced),
      fee: Money.of(dto.fee),
      repaymentStartDate: dto.repayment_start_date,
      repaymentPercentage: dto.repayment_percentage,
    });
  }
}
