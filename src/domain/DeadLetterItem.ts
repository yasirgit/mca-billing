import type { IsoDate } from "../utils/Dates";

/**
 * Terminal parking for operations that exhausted retries or are unsafe to
 * retry automatically (e.g. an ambiguous charge POST outcome where the money
 * may or may not have moved). Preserved for manual reconciliation instead of
 * crashing or silently dropping.
 */
export interface DeadLetterItem {
  id: number;
  operation: "charge" | "billing_complete";
  payload: Record<string, unknown>;
  error: string;
  occurredOn: IsoDate;
  attempts: number;
}
