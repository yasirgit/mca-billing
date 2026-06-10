import { describe, expect, it } from "vitest";
import { Advance } from "../src/domain/Advance";
import { AdvanceState } from "../src/domain/AdvanceState";
import type { ChargeLedgerEvent } from "../src/domain/ChargeLedgerEvent";
import { BalanceCalculator } from "../src/services/BalanceCalculator";
import { Money } from "../src/utils/Money";

function makeAdvance(): Advance {
  return new Advance({
    id: 1,
    customerId: 1,
    mandateId: 2,
    created: "2022-01-02",
    totalAdvanced: Money.of("60000.00"),
    fee: Money.of("2500.00"),
    repaymentStartDate: "2022-01-05",
    repaymentPercentage: 60,
  });
}

function event(amount: string, chargedOn = "2022-01-05"): ChargeLedgerEvent {
  return {
    eventId: 1,
    advanceId: 1,
    mandateId: 2,
    amount: Money.of(amount),
    chargedOn,
    sourceRevenueDate: "2022-01-04",
    status: "SETTLED",
  };
}

describe("Advance", () => {
  it("derives totalRepayable and the first billable revenue date", () => {
    const advance = makeAdvance();
    expect(advance.totalRepayable.toString()).toBe("62500.00");
    expect(advance.nextRevenueDateToFetch).toBe("2022-01-04");
  });

  it("hands out each revenue date exactly once, forward only", () => {
    const advance = makeAdvance();
    expect(advance.collectDueRevenueDates("2022-01-06")).toEqual([
      "2022-01-04",
      "2022-01-05",
      "2022-01-06",
    ]);
    expect(advance.collectDueRevenueDates("2022-01-06")).toEqual([]);
    expect(advance.nextRevenueDateToFetch).toBe("2022-01-07");
  });

  it("enforces ACTIVE -> REPAID -> COMPLETED transitions", () => {
    const advance = makeAdvance();
    expect(() => advance.markCompleted()).toThrow();
    advance.markRepaid();
    expect(advance.state).toBe(AdvanceState.Repaid);
    expect(() => advance.markRepaid()).toThrow();
    advance.markCompleted();
    expect(advance.state).toBe(AdvanceState.Completed);
    expect(() => advance.markCompleted()).toThrow();
  });
});

describe("BalanceCalculator", () => {
  it("folds the ledger into repaid and outstanding", () => {
    const advance = makeAdvance();
    const events = [event("10000.00"), event("2500.00")];
    expect(BalanceCalculator.amountRepaid(events).toString()).toBe("12500.00");
    expect(BalanceCalculator.outstanding(advance, events).toString()).toBe(
      "50000.00",
    );
    expect(BalanceCalculator.isSettled(advance, events)).toBe(false);
  });

  it("reports settled when ledger total equals total repayable", () => {
    const advance = makeAdvance();
    const events = [event("60000.00"), event("2500.00")];
    expect(BalanceCalculator.isSettled(advance, events)).toBe(true);
  });

  it("throws if the ledger exceeds the obligation (invariant breach)", () => {
    const advance = makeAdvance();
    const events = [event("62500.00"), event("0.01")];
    expect(() => BalanceCalculator.outstanding(advance, events)).toThrow();
  });

  it("sums only the given day's charges for the cap", () => {
    const events = [
      event("10000.00", "2022-01-05"),
      event("6500.00", "2022-01-06"),
    ];
    expect(
      BalanceCalculator.chargedOnDay(events, "2022-01-05").toString(),
    ).toBe("10000.00");
    expect(
      BalanceCalculator.chargedOnDay(events, "2022-01-07").toString(),
    ).toBe("0.00");
  });
});
