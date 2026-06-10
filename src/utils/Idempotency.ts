import type { IsoDate } from "./Dates";

/**
 * Deterministic idempotency key for one charge execution.
 *
 * - `itemId` identifies the logical charge backlog item (splits get new ids,
 *   so the executed portion and its remainder never share a key).
 * - `attempt` distinguishes business re-issues across days (a 530-rejected
 *   charge transferred no money, so its next-day re-issue is a new logical
 *   attempt), while staying stable across in-call transport retries.
 */
export function chargeIdempotencyKey(
  advanceId: number,
  sourceRevenueDate: IsoDate,
  itemId: number,
  attempt: number,
): string {
  return `charge:${advanceId}:${sourceRevenueDate}:${itemId}:${attempt}`;
}
