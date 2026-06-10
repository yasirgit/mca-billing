import type { IsoDate } from "./Dates";

/**
 * Deterministic idempotency key for one charge execution.
 *
 * The key is intentionally derived from business context rather than internal
 * queue ids so it survives refactors of in-memory data structures.
 *
 * - `sourceRevenueDate` anchors the charge to one revenue day.
 * - `amount` and `createdOn` distinguish cap-split remainders from their
 *   original parent item.
 * - `attempt` distinguishes business re-issues across days (a 530-rejected
 *   charge transferred no money, so its next-day re-issue is a new logical
 *   attempt), while staying stable across in-call transport retries.
 */
export function chargeIdempotencyKey(
  advanceId: number,
  sourceRevenueDate: IsoDate,
  amount: string,
  createdOn: IsoDate,
  attempt: number,
): string {
  return `charge:${advanceId}:${sourceRevenueDate}:${amount}:${createdOn}:${attempt}`;
}
