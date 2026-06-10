import type { IsoDate } from "../utils/Dates";
import type { Money } from "../utils/Money";

/**
 * Money owed but not yet successfully charged — created when revenue is
 * processed, and re-queued on daily-cap splits or 530 rejections.
 *
 * Invariants: amount > 0; FIFO order per advance is preserved; a split
 * remainder becomes a NEW item (new id) so idempotency keys never collide
 * with the already-executed portion.
 */
export interface ChargeBacklogItem {
  id: number;
  advanceId: number;
  mandateId: number;
  amount: Money;
  /** The revenue date this money originates from (provenance/audit). */
  sourceRevenueDate: IsoDate;
  createdOn: IsoDate;
  attempts: number;
}
