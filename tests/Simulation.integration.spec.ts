import { beforeEach, describe, expect, it } from "vitest";
import type { AdvanceDto } from "../src/api/BillingApiClient";
import { AdvanceState } from "../src/domain/AdvanceState";
import { Logger } from "../src/infrastructure/Logger";
import { Metrics } from "../src/infrastructure/Metrics";
import { BalanceCalculator } from "../src/services/BalanceCalculator";
import { BillingEngine } from "../src/services/BillingEngine";
import { ChargeProcessor } from "../src/services/ChargeProcessor";
import { RevenueProcessor } from "../src/services/RevenueProcessor";
import { Simulator } from "../src/simulation/Simulator";
import { InMemoryStateStore } from "../src/store/StateStore";
import { Money } from "../src/utils/Money";
import { FakeBillingApi } from "./helpers/FakeBillingApi";

/**
 * Full simulation against a scripted fake API combining every behaviour:
 * late-discovered advances, delayed revenue, 530 charge rejections, the
 * daily cap split, final-charge clamping and billing completion.
 */
describe("Simulation (integration)", () => {
  let api: FakeBillingApi;
  let store: InMemoryStateStore;
  let metrics: Metrics;
  let simulator: Simulator;

  // Advance 1: owes 11000.00, 11% of revenue. A 150000.00 revenue day forces
  // a cap split (16500 -> 10000 + clamp), exercising clamping to outstanding.
  const advance1: AdvanceDto = {
    id: 1,
    customer_id: 1,
    mandate_id: 10,
    created: "2022-01-01",
    total_advanced: "10000.00",
    fee: "1000.00",
    repayment_start_date: "2022-01-03",
    repayment_percentage: 11,
  };

  // Advance 2: appears on Jan 5, delayed revenue + rejected charges.
  const advance2: AdvanceDto = {
    id: 2,
    customer_id: 2,
    mandate_id: 20,
    created: "2022-01-05",
    total_advanced: "500.00",
    fee: "50.00",
    repayment_start_date: "2022-01-06",
    repayment_percentage: 10,
  };

  beforeEach(() => {
    api = new FakeBillingApi();
    store = new InMemoryStateStore();
    metrics = new Metrics();
    const logger = new Logger("silent");
    const engine = new BillingEngine(
      api,
      store,
      new RevenueProcessor(api, store, logger, metrics),
      new ChargeProcessor(api, store, logger, metrics),
      logger,
      metrics,
    );
    simulator = new Simulator(engine, "2022-01-01", "2022-01-14", logger);
  });

  it("ends with all advances completed and ledgers exactly matching obligations", async () => {
    api.advancesByDay = (today) =>
      today >= "2022-01-05" ? [advance1, advance2] : [advance1];

    // Customer 1: huge revenue on Jan 2 -> 16500.00 repayment, capped.
    api.setRevenue(1, "2022-01-02", "150000.00");
    for (const d of ["03", "04", "05", "06", "07", "08", "09", "10", "11", "12", "13"]) {
      api.setRevenue(1, `2022-01-${d}`, "0.00");
    }

    // Customer 2: Jan 5 revenue arrives late (Jan 8); rest covers the balance.
    api.setRevenue(2, "2022-01-05", "2000.00", "2022-01-08"); // -> 200.00
    api.setRevenue(2, "2022-01-06", "1500.00"); // -> 150.00
    api.setRevenue(2, "2022-01-07", "1000.00"); // -> 100.00
    api.setRevenue(2, "2022-01-08", "3000.00"); // -> 300.00, clamped to 100.00
    for (const d of ["09", "10", "11", "12", "13"]) {
      api.setRevenue(2, `2022-01-${d}`, "0.00");
    }

    // Mandate 20 rejects all charges on Jan 7.
    api.chargeHook = (mandateId, _a, today) =>
      mandateId === 20 && today === "2022-01-07"
        ? { kind: "rejected" }
        : undefined;

    await simulator.run();

    for (const advance of store.allAdvances()) {
      expect(advance.state).toBe(AdvanceState.Completed);
      expect(
        BalanceCalculator.amountRepaid(store.ledgerFor(advance.id)).equals(
          advance.totalRepayable,
        ),
      ).toBe(true);
    }

    // Advance 1: 16500.00 owed from revenue but obligation is 11000.00:
    // Jan 3 charges min(16500, 10000 cap, 11000) = 10000, Jan 4 the
    // remainder min(6500, 10000, 1000) = 1000. Never overcharged.
    expect(
      api.successfulCharges
        .filter((c) => c.mandateId === 10)
        .map((c) => ({ amount: c.amount, today: c.today })),
    ).toEqual([
      { amount: "10000.00", today: "2022-01-03" },
      { amount: "1000.00", today: "2022-01-04" },
    ]);

    // Advance 2: Jan 6 bills Jan 5's revenue -> unavailable, backlogged.
    // Jan 7 bills Jan 6 (150.00) -> rejected. Jan 8: backlog drains FIFO —
    // rejected 150.00, then late 200.00, then Jan 7's 100.00; Jan 9 clamps
    // the final charge to the remaining 100.00.
    expect(
      api.successfulCharges
        .filter((c) => c.mandateId === 20)
        .map((c) => ({ amount: c.amount, today: c.today })),
    ).toEqual([
      { amount: "150.00", today: "2022-01-08" },
      { amount: "200.00", today: "2022-01-08" },
      { amount: "100.00", today: "2022-01-08" },
      { amount: "100.00", today: "2022-01-09" },
    ]);

    // billing_complete fired exactly once per advance.
    expect(api.completedAdvances.map((c) => c.advanceId).sort()).toEqual([1, 2]);
    expect(metrics.counter("billing_complete")).toBe(2);

    // No residue anywhere.
    expect(store.revenueBacklogDepth()).toBe(0);
    expect(store.chargeBacklogDepth()).toBe(0);
    expect(store.deadLetters()).toHaveLength(0);

    // Idempotency keys never repeated across all attempts.
    const keys = api.chargeAttempts.map((c) => c.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("flags unsettled advances at the end of the period instead of dropping them", async () => {
    api.advancesByDay = () => [advance1];
    // Revenue never becomes available -> nothing can be billed.
    api.setRevenue(1, "2022-01-02", "1000.00", "2023-01-01");

    await simulator.run();

    const advance = store.getAdvance(1)!;
    expect(advance.state).toBe(AdvanceState.Active);
    expect(
      BalanceCalculator.outstanding(advance, store.ledgerFor(1)).equals(
        Money.of("11000.00"),
      ),
    ).toBe(true);
    expect(store.revenueBacklogDepth()).toBeGreaterThan(0);
  });
});
