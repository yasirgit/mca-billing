import type { IsoDate } from "../utils/Dates";
import type { Money } from "../utils/Money";

/**
 * Append-only record of one successful charge. The ledger is the single
 * source of truth for how much has been repaid: balances are always a fold
 * over these events, never a mutable counter.
 */
export interface ChargeLedgerEvent {
  eventId: number;
  advanceId: number;
  mandateId: number;
  amount: Money;
  /** Simulated date the charge settled (drives the daily-cap accounting). */
  chargedOn: IsoDate;
  /** The revenue date this repayment originates from. */
  sourceRevenueDate: IsoDate;
  status: "SETTLED";
}
