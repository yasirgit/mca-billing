/**
 * Lifecycle of an advance.
 *
 * ACTIVE    -> still owes money; revenue is billed and charges issued.
 * REPAID    -> ledger fully settled; billing_complete call still pending.
 * COMPLETED -> billing_complete acknowledged by the API; terminal.
 *
 * REPAID is distinct from COMPLETED so a failed billing_complete call can be
 * retried on a later day without any risk of further charging.
 */
export enum AdvanceState {
  Active = "ACTIVE",
  Repaid = "REPAID",
  Completed = "COMPLETED",
}
