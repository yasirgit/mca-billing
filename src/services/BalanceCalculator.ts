import type { Advance } from "../domain/Advance";
import type { ChargeLedgerEvent } from "../domain/ChargeLedgerEvent";
import { Money } from "../utils/Money";
import type { IsoDate } from "../utils/Dates";

/**
 * Pure folds over the charge ledger. All balance questions are answered from
 * ledger events so they are auditable and rebuildable.
 */
export const BalanceCalculator = {
  amountRepaid(events: readonly ChargeLedgerEvent[]): Money {
    return events.reduce((sum, e) => sum.add(e.amount), Money.zero());
  },

  outstanding(advance: Advance, events: readonly ChargeLedgerEvent[]): Money {
    const remaining = advance.totalRepayable.subtract(
      BalanceCalculator.amountRepaid(events),
    );
    if (remaining.isNegative()) {
      // Charges are clamped to the outstanding balance before execution, so
      // a negative balance means a bookkeeping bug, not a rounding artefact.
      throw new Error(
        `Advance ${advance.id}: ledger exceeds total repayable by ${remaining}`,
      );
    }
    return remaining;
  },

  isSettled(advance: Advance, events: readonly ChargeLedgerEvent[]): boolean {
    return BalanceCalculator.outstanding(advance, events).isZero();
  },

  chargedOnDay(events: readonly ChargeLedgerEvent[], day: IsoDate): Money {
    return events
      .filter((e) => e.chargedOn === day)
      .reduce((sum, e) => sum.add(e.amount), Money.zero());
  },
};
