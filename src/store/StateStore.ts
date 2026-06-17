import type { Advance } from "../domain/Advance";
import type { ChargeBacklogItem } from "../domain/ChargeBacklogItem";
import type { ChargeLedgerEvent } from "../domain/ChargeLedgerEvent";
import type { DeadLetterItem } from "../domain/DeadLetterItem";
import type { RevenueBacklogItem } from "../domain/RevenueBacklogItem";
import { BalanceCalculator } from "../services/BalanceCalculator";
import type { IsoDate } from "../utils/Dates";
import { Money } from "../utils/Money";

export interface NewChargeParams {
  advanceId: number;
  mandateId: number;
  amount: Money;
  sourceRevenueDate: IsoDate;
  createdOn: IsoDate;
}

export interface NewLedgerEventParams {
  advanceId: number;
  mandateId: number;
  amount: Money;
  chargedOn: IsoDate;
  sourceRevenueDate: IsoDate;
}

/**
 * Persistence port for all billing state. The in-memory implementation below
 * satisfies the assignment; a PostgreSQL/Redis/Kafka implementation would
 * sit behind this same interface without touching the services.
 *
 * TODO: production impl: PostgreSQL with UNIQUE(advance_id, revenue_date) for
 * idempotency and the ledger as an append-only table (see README migration table).
 */
export interface StateStore {
  // ── Advances ──────────────────────────────────────────────────────────────

  /**
   * Registers a newly discovered advance from the daily API sync.
   * Returns false if the advance already exists so sync is idempotent across
   * repeated billing days and partial sync failures.
   */
  addAdvanceIfAbsent(advance: Advance): boolean;

  /**
   * Looks up a single advance by id. Required when services need advance
   * metadata (mandate, repayment %, dates) without scanning all advances.
   */
  getAdvance(id: number): Advance | undefined;

  /**
   * Returns every known advance. BillingEngine, RevenueProcessor, and
   * ChargeProcessor iterate this each day to process all active advances.
   */
  allAdvances(): Advance[];

  // ── Idempotency: processed revenue dates ──────────────────────────────────

  /**
   * Checks whether revenue for a given date was already fetched and turned
   * into a charge. Prevents double-billing when a date reappears in the
   * backlog after a prior successful fetch.
   */
  hasProcessedRevenue(advanceId: number, date: IsoDate): boolean;

  /**
   * Records a revenue date as successfully processed. Called only after a
   * successful API fetch so a retried or backlogged date is never billed twice.
   */
  markRevenueProcessed(advanceId: number, date: IsoDate): void;

  // ── Revenue backlog ───────────────────────────────────────────────────────

  /**
   * Returns a snapshot of revenue dates that failed to fetch (unavailable or
   * transport error). RevenueProcessor merges these with newly-due dates each day.
   */
  revenueBacklogFor(advanceId: number): RevenueBacklogItem[];

  /**
   * Adds or retries a revenue date in the backlog when the API is unavailable.
   * Returns `{ isNew: true }` on first enqueue (for metrics); increments
   * attempts on subsequent days so retries are observable.
   */
  upsertRevenueBacklog(
    advanceId: number,
    customerId: number,
    revenueDate: IsoDate,
    attemptedOn: IsoDate,
  ): { isNew: boolean };

  /**
   * Removes one revenue date from the backlog after a successful fetch or when
   * the advance is settled and further revenue must not be collected.
   */
  removeRevenueBacklog(advanceId: number, revenueDate: IsoDate): void;

  /**
   * Drops the entire revenue backlog for an advance and returns what was
   * cleared. Used when an advance is fully repaid so stale backlog entries
   * cannot generate future charges.
   */
  clearRevenueBacklog(advanceId: number): RevenueBacklogItem[];

  /**
   * Total count of backlogged revenue items across all advances. Exposed as a
   * gauge metric to monitor API availability and retry pressure.
   */
  revenueBacklogDepth(): number;

  // ── Charge backlog (FIFO per advance) ─────────────────────────────────────

  /**
   * Appends a repayment charge to the tail of the advance's queue. Normal path
   * after RevenueProcessor computes a positive repayment from fetched revenue.
   */
  enqueueCharge(params: NewChargeParams): ChargeBacklogItem;

  /**
   * Prepends a charge to the head of the queue. Used when a cap or balance
   * split leaves a remainder: the remainder must be charged next (same revenue
   * date, new item id) to preserve per-advance FIFO and idempotency keys.
   */
  enqueueChargeFront(params: NewChargeParams): ChargeBacklogItem;

  /**
   * Returns the next charge to attempt without removing it. ChargeProcessor
   * peeks so it can abort the drain on rejection or error without losing
   * the item.
   */
  peekCharge(advanceId: number): ChargeBacklogItem | undefined;

  /**
   * Removes a charge item after a successful settlement or when parking an
   * ambiguous failure in the dead-letter queue.
   */
  removeChargeItem(advanceId: number, itemId: number): void;

  /**
   * Increments the attempt counter on a charge item. Drives idempotency key
   * rotation on 530 rejections and transport retries so the payment provider
   * treats each retry as a distinct charge attempt.
   */
  bumpChargeAttempts(advanceId: number, itemId: number): void;

  /**
   * Returns a snapshot of all pending charges for an advance. Used for logging
   * (e.g. items left when the daily cap is hit) and diagnostics.
   */
  chargeBacklogFor(advanceId: number): ChargeBacklogItem[];

  /**
   * Drops the entire charge backlog for an advance and returns what was
   * cleared. Used when the advance is fully repaid so pending charges are
   * cancelled rather than attempted.
   */
  clearChargeBacklog(advanceId: number): ChargeBacklogItem[];

  /**
   * Total count of pending charge items across all advances. Exposed as a
   * gauge metric to monitor processing backlog and daily-cap deferrals.
   */
  chargeBacklogDepth(): number;

  // ── Ledger ─────────────────────────────────────────────────────────────────

  /**
   * Appends an immutable settled-charge event. The ledger is the source of
   * truth for outstanding balance and daily cap headroom; only successful
   * charges create events.
   */
  appendLedgerEvent(params: NewLedgerEventParams): ChargeLedgerEvent;

  /**
   * Returns all ledger events for one advance. Used by BalanceCalculator to
   * decide settlement, outstanding balance, and whether to skip revenue fetches.
   */
  ledgerFor(advanceId: number): ChargeLedgerEvent[];

  /**
   * Returns every ledger event across all advances. Used by reporting and
   * simulation output to summarise billing activity.
   */
  allLedgerEvents(): ChargeLedgerEvent[];

  /**
   * Sums settled charges for an advance on a given calendar day. Required to
   * enforce the per-advance daily charge cap before attempting the next item.
   */
  chargedOn(advanceId: number, day: IsoDate): Money;

  // ── Dead letters ───────────────────────────────────────────────────────────

  /**
   * Records a charge that failed with an ambiguous outcome (e.g. network error
   * after retries). Items are removed from the charge backlog and parked here
   * for manual reconciliation instead of blind retry.
   */
  addDeadLetter(
    operation: DeadLetterItem["operation"],
    payload: Record<string, unknown>,
    error: string,
    occurredOn: IsoDate,
    attempts: number,
  ): DeadLetterItem;

  /**
   * Returns all dead-letter entries. Used by simulation reporting and ops
   * visibility into charges that need human review.
   */
  deadLetters(): DeadLetterItem[];
}

/**
 * In-memory reference implementation of {@link StateStore}. Holds all billing
 * state in process-local Maps/arrays; data is lost on restart but the shape
 * matches what a durable store would expose to the services.
 */
export class InMemoryStateStore implements StateStore {
  private readonly advances = new Map<number, Advance>();
  private readonly processedRevenue = new Map<number, Set<IsoDate>>();
  private readonly revenueBacklog = new Map<number, RevenueBacklogItem[]>();
  private readonly chargeBacklog = new Map<number, ChargeBacklogItem[]>();
  private readonly ledgerByAdvance = new Map<number, ChargeLedgerEvent[]>();
  private readonly dlq: DeadLetterItem[] = [];
  private nextChargeItemId = 1;
  private nextEventId = 1;
  private nextDlqId = 1;

  /** Inserts the advance only when its id is not already registered. */
  addAdvanceIfAbsent(advance: Advance): boolean {
    if (this.advances.has(advance.id)) return false;
    this.advances.set(advance.id, advance);
    return true;
  }

  /** O(1) lookup in the advances map. */
  getAdvance(id: number): Advance | undefined {
    return this.advances.get(id);
  }

  /** Defensive copy so callers cannot mutate internal map entries. */
  allAdvances(): Advance[] {
    return [...this.advances.values()];
  }

  /** Membership test in the per-advance processed-revenue set. */
  hasProcessedRevenue(advanceId: number, date: IsoDate): boolean {
    return this.processedRevenue.get(advanceId)?.has(date) ?? false;
  }

  /** Lazily creates the Set for an advance on first processed revenue date. */
  markRevenueProcessed(advanceId: number, date: IsoDate): void {
    let set = this.processedRevenue.get(advanceId);
    if (!set) {
      set = new Set();
      this.processedRevenue.set(advanceId, set);
    }
    set.add(date);
  }

  /** Defensive copy of the advance's revenue backlog array. */
  revenueBacklogFor(advanceId: number): RevenueBacklogItem[] {
    return [...(this.revenueBacklog.get(advanceId) ?? [])];
  }

  /**
   * One entry per (advance, revenueDate). Re-upserting the same date bumps
   * attempts instead of duplicating rows.
   */
  upsertRevenueBacklog(
    advanceId: number,
    customerId: number,
    revenueDate: IsoDate,
    attemptedOn: IsoDate,
  ): { isNew: boolean } {
    let items = this.revenueBacklog.get(advanceId);
    if (!items) {
      items = [];
      this.revenueBacklog.set(advanceId, items);
    }
    const existing = items.find((i) => i.revenueDate === revenueDate);
    if (existing) {
      existing.attempts++;
      return { isNew: false };
    }
    items.push({
      advanceId,
      customerId,
      revenueDate,
      firstAttempt: attemptedOn,
      attempts: 1,
    });
    return { isNew: true };
  }

  /** Splices out the matching revenue date; no-op if absent. */
  removeRevenueBacklog(advanceId: number, revenueDate: IsoDate): void {
    const items = this.revenueBacklog.get(advanceId);
    if (!items) return;
    const idx = items.findIndex((i) => i.revenueDate === revenueDate);
    if (idx >= 0) items.splice(idx, 1);
  }

  /** Deletes the map entry and returns the cleared items for logging. */
  clearRevenueBacklog(advanceId: number): RevenueBacklogItem[] {
    const items = this.revenueBacklog.get(advanceId) ?? [];
    this.revenueBacklog.delete(advanceId);
    return items;
  }

  /** Aggregates array lengths across all advances in the revenue backlog map. */
  revenueBacklogDepth(): number {
    let depth = 0;
    for (const items of this.revenueBacklog.values()) depth += items.length;
    return depth;
  }

  /** Builds an item and pushes it to the tail of the per-advance FIFO queue. */
  enqueueCharge(params: NewChargeParams): ChargeBacklogItem {
    const item = this.buildChargeItem(params);
    this.chargeQueue(params.advanceId).push(item);
    return item;
  }

  /** Builds an item and unshifts it to the head (cap-split remainder path). */
  enqueueChargeFront(params: NewChargeParams): ChargeBacklogItem {
    const item = this.buildChargeItem(params);
    this.chargeQueue(params.advanceId).unshift(item);
    return item;
  }

  /** Reads index 0 without dequeuing so failed drains leave the item in place. */
  peekCharge(advanceId: number): ChargeBacklogItem | undefined {
    return this.chargeBacklog.get(advanceId)?.[0];
  }

  /** Finds by item id and splices; order of remaining items is preserved. */
  removeChargeItem(advanceId: number, itemId: number): void {
    const items = this.chargeBacklog.get(advanceId);
    if (!items) return;
    const idx = items.findIndex((i) => i.id === itemId);
    if (idx >= 0) items.splice(idx, 1);
  }

  /** In-place increment; mutates the queued item referenced by id. */
  bumpChargeAttempts(advanceId: number, itemId: number): void {
    const item = this.chargeBacklog
      .get(advanceId)
      ?.find((i) => i.id === itemId);
    if (item) item.attempts++;
  }

  /** Defensive copy of the advance's charge backlog array. */
  chargeBacklogFor(advanceId: number): ChargeBacklogItem[] {
    return [...(this.chargeBacklog.get(advanceId) ?? [])];
  }

  /** Deletes the map entry and returns the cleared items for logging. */
  clearChargeBacklog(advanceId: number): ChargeBacklogItem[] {
    const items = this.chargeBacklog.get(advanceId) ?? [];
    this.chargeBacklog.delete(advanceId);
    return items;
  }

  /** Aggregates array lengths across all advances in the charge backlog map. */
  chargeBacklogDepth(): number {
    let depth = 0;
    for (const items of this.chargeBacklog.values()) depth += items.length;
    return depth;
  }

  /**
   * Append-only per advance. Assigns monotonic eventId and marks status
   * SETTLED because only successful charges reach this path.
   */
  appendLedgerEvent(params: NewLedgerEventParams): ChargeLedgerEvent {
    const event: ChargeLedgerEvent = {
      eventId: this.nextEventId++,
      ...params,
      status: "SETTLED",
    };
    let events = this.ledgerByAdvance.get(params.advanceId);
    if (!events) {
      events = [];
      this.ledgerByAdvance.set(params.advanceId, events);
    }
    events.push(event);
    return event;
  }

  /** Defensive copy of the advance's ledger array. */
  ledgerFor(advanceId: number): ChargeLedgerEvent[] {
    return [...(this.ledgerByAdvance.get(advanceId) ?? [])];
  }

  /** Flattens all per-advance ledger arrays for cross-advance reporting. */
  allLedgerEvents(): ChargeLedgerEvent[] {
    return [...this.ledgerByAdvance.values()].flat();
  }

  /** Delegates to BalanceCalculator so cap logic stays in one place. */
  chargedOn(advanceId: number, day: IsoDate): Money {
    return BalanceCalculator.chargedOnDay(this.ledgerFor(advanceId), day);
  }

  /** Appends to the in-memory DLQ with a monotonic id. */
  addDeadLetter(
    operation: DeadLetterItem["operation"],
    payload: Record<string, unknown>,
    error: string,
    occurredOn: IsoDate,
    attempts: number,
  ): DeadLetterItem {
    const item: DeadLetterItem = {
      id: this.nextDlqId++,
      operation,
      payload,
      error,
      occurredOn,
      attempts,
    };
    this.dlq.push(item);
    return item;
  }

  /** Defensive copy of the dead-letter array. */
  deadLetters(): DeadLetterItem[] {
    return [...this.dlq];
  }

  /**
   * Validates amount > 0 and assigns the next charge item id. Shared by
   * enqueueCharge and enqueueChargeFront so invariants are enforced once.
   */
  private buildChargeItem(params: NewChargeParams): ChargeBacklogItem {
    if (!params.amount.isPositive()) {
      throw new Error(
        `Charge backlog item must have a positive amount, got ${params.amount}`,
      );
    }
    return { id: this.nextChargeItemId++, attempts: 0, ...params };
  }

  /**
   * Lazily creates the per-advance charge queue array. Returns a mutable
   * reference so push/unshift/splice operate in place without re-fetching.
   */
  private chargeQueue(advanceId: number): ChargeBacklogItem[] {
    let items = this.chargeBacklog.get(advanceId);
    if (!items) {
      items = [];
      this.chargeBacklog.set(advanceId, items);
    }
    return items;
  }
}
