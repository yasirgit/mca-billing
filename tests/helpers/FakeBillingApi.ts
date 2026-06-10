import type {
  AdvanceDto,
  BillingApiClient,
  ChargeOutcome,
  RevenueResult,
} from "../../src/api/BillingApiClient";
import type { IsoDate } from "../../src/utils/Dates";
import { compareDates } from "../../src/utils/Dates";
import { Money } from "../../src/utils/Money";

interface RevenueEntry {
  amount: string;
  /** The simulated day from which the revenue becomes fetchable. */
  availableFrom: IsoDate;
}

export interface RecordedCharge {
  mandateId: number;
  amount: string;
  today: IsoDate;
  idempotencyKey: string;
}

/**
 * Scriptable in-memory stand-in for the live billing API. Hooks allow tests
 * to inject 530s and transport errors per call.
 */
export class FakeBillingApi implements BillingApiClient {
  advancesByDay: (today: IsoDate) => AdvanceDto[] = () => [];
  /** Return an Error to make the call throw, or a result to use it. */
  revenueHook?: (
    customerId: number,
    forDate: IsoDate,
    today: IsoDate,
  ) => RevenueResult | Error | undefined;
  /** Return an Error to make the call throw, or an outcome to use it. */
  chargeHook?: (
    mandateId: number,
    amount: Money,
    today: IsoDate,
  ) => ChargeOutcome | Error | undefined;
  completeHook?: (advanceId: number, today: IsoDate) => Error | undefined;

  readonly chargeAttempts: RecordedCharge[] = [];
  readonly successfulCharges: RecordedCharge[] = [];
  readonly completedAdvances: Array<{ advanceId: number; today: IsoDate }> = [];

  private readonly revenues = new Map<string, RevenueEntry>();

  setRevenue(
    customerId: number,
    forDate: IsoDate,
    amount: string,
    availableFrom?: IsoDate,
  ): void {
    this.revenues.set(`${customerId}:${forDate}`, {
      amount,
      availableFrom: availableFrom ?? forDate,
    });
  }

  async getAdvances(today: IsoDate): Promise<AdvanceDto[]> {
    return this.advancesByDay(today);
  }

  async getRevenue(
    customerId: number,
    forDate: IsoDate,
    today: IsoDate,
  ): Promise<RevenueResult> {
    const hooked = this.revenueHook?.(customerId, forDate, today);
    if (hooked instanceof Error) throw hooked;
    if (hooked) return hooked;

    const entry = this.revenues.get(`${customerId}:${forDate}`);
    if (!entry || compareDates(today, entry.availableFrom) < 0) {
      return { kind: "unavailable" };
    }
    return { kind: "available", amount: Money.of(entry.amount) };
  }

  async charge(
    mandateId: number,
    amount: Money,
    today: IsoDate,
    idempotencyKey: string,
  ): Promise<ChargeOutcome> {
    const record: RecordedCharge = {
      mandateId,
      amount: amount.toString(),
      today,
      idempotencyKey,
    };
    this.chargeAttempts.push(record);

    const hooked = this.chargeHook?.(mandateId, amount, today);
    if (hooked instanceof Error) throw hooked;
    if (hooked?.kind === "rejected") return hooked;

    this.successfulCharges.push(record);
    return { kind: "charged" };
  }

  async billingComplete(advanceId: number, today: IsoDate): Promise<void> {
    const error = this.completeHook?.(advanceId, today);
    if (error) throw error;
    this.completedAdvances.push({ advanceId, today });
  }
}
