import type { BillingEngine } from "../services/BillingEngine";
import type { Logger } from "../infrastructure/Logger";
import { dateRange, type IsoDate } from "../utils/Dates";

/**
 * Drives the engine through the simulated period, one day at a time, passing
 * the simulated date down so every API call carries the `Today` header.
 */
export class Simulator {
  constructor(
    private readonly engine: BillingEngine,
    private readonly startDate: IsoDate,
    private readonly endDate: IsoDate,
    private readonly logger: Logger,
  ) {}

  async run(): Promise<void> {
    this.logger.info("simulation_started", {
      start: this.startDate,
      end: this.endDate,
    });
    for (const today of dateRange(this.startDate, this.endDate)) {
      await this.engine.runBilling(today);
    }
    this.logger.info("simulation_finished", {});
  }
}
