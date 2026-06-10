import { Money } from "../utils/Money";
import { addDays, compareDates, type IsoDate } from "../utils/Dates";
import { AdvanceState } from "./AdvanceState";

export interface AdvanceProps {
  id: number;
  customerId: number;
  mandateId: number;
  created: IsoDate;
  totalAdvanced: Money;
  fee: Money;
  repaymentStartDate: IsoDate;
  repaymentPercentage: number;
}

/**
 * Aggregate root for one Merchant Cash Advance.
 *
 * Invariants:
 * - `totalRepayable` (= totalAdvanced + fee) is immutable.
 * - The revenue cursor only moves forward; each revenue date is handed out
 *   exactly once (it then lives in the backlog or the processed set).
 * - State transitions are only ACTIVE -> REPAID -> COMPLETED.
 */
export class Advance {
  readonly id: number;
  readonly customerId: number;
  readonly mandateId: number;
  readonly created: IsoDate;
  readonly totalAdvanced: Money;
  readonly fee: Money;
  readonly repaymentStartDate: IsoDate;
  readonly repaymentPercentage: number;

  private _state: AdvanceState = AdvanceState.Active;
  private _nextRevenueDateToFetch: IsoDate;

  constructor(props: AdvanceProps) {
    this.id = props.id;
    this.customerId = props.customerId;
    this.mandateId = props.mandateId;
    this.created = props.created;
    this.totalAdvanced = props.totalAdvanced;
    this.fee = props.fee;
    this.repaymentStartDate = props.repaymentStartDate;
    this.repaymentPercentage = props.repaymentPercentage;
    // On `repayment_start_date` we bill the previous day's revenue, so the
    // first billable revenue date is the day before repayment starts.
    this._nextRevenueDateToFetch = addDays(props.repaymentStartDate, -1);
  }

  get state(): AdvanceState {
    return this._state;
  }

  get nextRevenueDateToFetch(): IsoDate {
    return this._nextRevenueDateToFetch;
  }

  /** Principal plus fee: the total the customer must repay. */
  get totalRepayable(): Money {
    return this.totalAdvanced.add(this.fee);
  }

  /**
   * Hands out every not-yet-scheduled revenue date up to and including
   * `upTo`, moving the cursor forward past them. Forward-only by design.
   */
  collectDueRevenueDates(upTo: IsoDate): IsoDate[] {
    const dates: IsoDate[] = [];
    while (compareDates(this._nextRevenueDateToFetch, upTo) <= 0) {
      dates.push(this._nextRevenueDateToFetch);
      this._nextRevenueDateToFetch = addDays(this._nextRevenueDateToFetch, 1);
    }
    return dates;
  }

  markRepaid(): void {
    if (this._state !== AdvanceState.Active) {
      throw new Error(
        `Advance ${this.id}: invalid transition ${this._state} -> REPAID`,
      );
    }
    this._state = AdvanceState.Repaid;
  }

  markCompleted(): void {
    if (this._state !== AdvanceState.Repaid) {
      throw new Error(
        `Advance ${this.id}: invalid transition ${this._state} -> COMPLETED`,
      );
    }
    this._state = AdvanceState.Completed;
  }
}
