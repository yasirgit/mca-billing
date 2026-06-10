import type { IsoDate } from "../utils/Dates";

/**
 * A revenue date we owe billing for but could not fetch yet (the API
 * returned 530 "not yet available", or transport failed for the day).
 * Unique per (advanceId, revenueDate); re-attempted every subsequent day
 * until available or the advance settles.
 */
export interface RevenueBacklogItem {
  advanceId: number;
  customerId: number;
  revenueDate: IsoDate;
  /** Simulated date of the first failed fetch, for ageing/diagnostics. */
  firstAttempt: IsoDate;
  attempts: number;
}
