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
 */
export interface StateStore {
  // Advances
  addAdvanceIfAbsent(advance: Advance): boolean;
  getAdvance(id: number): Advance | undefined;
  allAdvances(): Advance[];

  // Idempotency: processed revenue dates
  hasProcessedRevenue(advanceId: number, date: IsoDate): boolean;
  markRevenueProcessed(advanceId: number, date: IsoDate): void;

  // Revenue backlog
  revenueBacklogFor(advanceId: number): RevenueBacklogItem[];
  upsertRevenueBacklog(
    advanceId: number,
    customerId: number,
    revenueDate: IsoDate,
    attemptedOn: IsoDate,
  ): { isNew: boolean };
  removeRevenueBacklog(advanceId: number, revenueDate: IsoDate): void;
  clearRevenueBacklog(advanceId: number): RevenueBacklogItem[];
  revenueBacklogDepth(): number;

  // Charge backlog (FIFO per advance)
  enqueueCharge(params: NewChargeParams): ChargeBacklogItem;
  enqueueChargeFront(params: NewChargeParams): ChargeBacklogItem;
  peekCharge(advanceId: number): ChargeBacklogItem | undefined;
  removeChargeItem(advanceId: number, itemId: number): void;
  bumpChargeAttempts(advanceId: number, itemId: number): void;
  chargeBacklogFor(advanceId: number): ChargeBacklogItem[];
  clearChargeBacklog(advanceId: number): ChargeBacklogItem[];
  chargeBacklogDepth(): number;

  // Ledger
  appendLedgerEvent(params: NewLedgerEventParams): ChargeLedgerEvent;
  ledgerFor(advanceId: number): ChargeLedgerEvent[];
  allLedgerEvents(): ChargeLedgerEvent[];
  chargedOn(advanceId: number, day: IsoDate): Money;

  // Dead letters
  addDeadLetter(
    operation: DeadLetterItem["operation"],
    payload: Record<string, unknown>,
    error: string,
    occurredOn: IsoDate,
    attempts: number,
  ): DeadLetterItem;
  deadLetters(): DeadLetterItem[];
}

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

  addAdvanceIfAbsent(advance: Advance): boolean {
    if (this.advances.has(advance.id)) return false;
    this.advances.set(advance.id, advance);
    return true;
  }

  getAdvance(id: number): Advance | undefined {
    return this.advances.get(id);
  }

  allAdvances(): Advance[] {
    return [...this.advances.values()];
  }

  hasProcessedRevenue(advanceId: number, date: IsoDate): boolean {
    return this.processedRevenue.get(advanceId)?.has(date) ?? false;
  }

  markRevenueProcessed(advanceId: number, date: IsoDate): void {
    let set = this.processedRevenue.get(advanceId);
    if (!set) {
      set = new Set();
      this.processedRevenue.set(advanceId, set);
    }
    set.add(date);
  }

  revenueBacklogFor(advanceId: number): RevenueBacklogItem[] {
    return [...(this.revenueBacklog.get(advanceId) ?? [])];
  }

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

  removeRevenueBacklog(advanceId: number, revenueDate: IsoDate): void {
    const items = this.revenueBacklog.get(advanceId);
    if (!items) return;
    const idx = items.findIndex((i) => i.revenueDate === revenueDate);
    if (idx >= 0) items.splice(idx, 1);
  }

  clearRevenueBacklog(advanceId: number): RevenueBacklogItem[] {
    const items = this.revenueBacklog.get(advanceId) ?? [];
    this.revenueBacklog.delete(advanceId);
    return items;
  }

  revenueBacklogDepth(): number {
    let depth = 0;
    for (const items of this.revenueBacklog.values()) depth += items.length;
    return depth;
  }

  enqueueCharge(params: NewChargeParams): ChargeBacklogItem {
    const item = this.buildChargeItem(params);
    this.chargeQueue(params.advanceId).push(item);
    return item;
  }

  /** For cap-split remainders: stays at the head so per-advance FIFO holds. */
  enqueueChargeFront(params: NewChargeParams): ChargeBacklogItem {
    const item = this.buildChargeItem(params);
    this.chargeQueue(params.advanceId).unshift(item);
    return item;
  }

  peekCharge(advanceId: number): ChargeBacklogItem | undefined {
    return this.chargeBacklog.get(advanceId)?.[0];
  }

  removeChargeItem(advanceId: number, itemId: number): void {
    const items = this.chargeBacklog.get(advanceId);
    if (!items) return;
    const idx = items.findIndex((i) => i.id === itemId);
    if (idx >= 0) items.splice(idx, 1);
  }

  bumpChargeAttempts(advanceId: number, itemId: number): void {
    const item = this.chargeBacklog
      .get(advanceId)
      ?.find((i) => i.id === itemId);
    if (item) item.attempts++;
  }

  chargeBacklogFor(advanceId: number): ChargeBacklogItem[] {
    return [...(this.chargeBacklog.get(advanceId) ?? [])];
  }

  clearChargeBacklog(advanceId: number): ChargeBacklogItem[] {
    const items = this.chargeBacklog.get(advanceId) ?? [];
    this.chargeBacklog.delete(advanceId);
    return items;
  }

  chargeBacklogDepth(): number {
    let depth = 0;
    for (const items of this.chargeBacklog.values()) depth += items.length;
    return depth;
  }

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

  ledgerFor(advanceId: number): ChargeLedgerEvent[] {
    return [...(this.ledgerByAdvance.get(advanceId) ?? [])];
  }

  allLedgerEvents(): ChargeLedgerEvent[] {
    return [...this.ledgerByAdvance.values()].flat();
  }

  chargedOn(advanceId: number, day: IsoDate): Money {
    return BalanceCalculator.chargedOnDay(this.ledgerFor(advanceId), day);
  }

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

  deadLetters(): DeadLetterItem[] {
    return [...this.dlq];
  }

  private buildChargeItem(params: NewChargeParams): ChargeBacklogItem {
    if (!params.amount.isPositive()) {
      throw new Error(
        `Charge backlog item must have a positive amount, got ${params.amount}`,
      );
    }
    return { id: this.nextChargeItemId++, attempts: 0, ...params };
  }

  private chargeQueue(advanceId: number): ChargeBacklogItem[] {
    let items = this.chargeBacklog.get(advanceId);
    if (!items) {
      items = [];
      this.chargeBacklog.set(advanceId, items);
    }
    return items;
  }
}
