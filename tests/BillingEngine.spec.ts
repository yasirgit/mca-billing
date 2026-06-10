import { beforeEach, describe, expect, it } from "vitest";
import type { AdvanceDto } from "../src/api/BillingApiClient";
import { AdvanceState } from "../src/domain/AdvanceState";
import { Metrics } from "../src/infrastructure/Metrics";
import { BalanceCalculator } from "../src/services/BalanceCalculator";
import { BillingEngine } from "../src/services/BillingEngine";
import { ChargeProcessor } from "../src/services/ChargeProcessor";
import { RevenueProcessor } from "../src/services/RevenueProcessor";
import { InMemoryStateStore } from "../src/store/StateStore";
import { FakeBillingApi } from "./helpers/FakeBillingApi";
import { silentLogger } from "./helpers/fixtures";

function dto(overrides: Partial<AdvanceDto> = {}): AdvanceDto {
  return {
    id: 1,
    customer_id: 1,
    mandate_id: 2,
    created: "2022-01-02",
    total_advanced: "90.00",
    fee: "10.00",
    repayment_start_date: "2022-01-03",
    repayment_percentage: 50,
    ...overrides,
  };
}

describe("BillingEngine", () => {
  let api: FakeBillingApi;
  let store: InMemoryStateStore;
  let metrics: Metrics;
  let engine: BillingEngine;

  beforeEach(() => {
    api = new FakeBillingApi();
    store = new InMemoryStateStore();
    metrics = new Metrics();
    const logger = silentLogger();
    engine = new BillingEngine(
      api,
      store,
      new RevenueProcessor(api, store, logger, metrics),
      new ChargeProcessor(api, store, logger, metrics),
      logger,
      metrics,
    );
  });

  it("discovers new advances as they appear, without resetting known ones", async () => {
    api.advancesByDay = (today) =>
      today >= "2022-01-03" ? [dto(), dto({ id: 2 })] : [dto()];

    await engine.runBilling("2022-01-02");
    expect(store.allAdvances().map((a) => a.id)).toEqual([1]);

    await engine.runBilling("2022-01-03");
    expect(store.allAdvances().map((a) => a.id)).toEqual([1, 2]);
    expect(metrics.counter("advances_discovered")).toBe(2);
  });

  it("runs the full lifecycle: bill daily, settle, billing_complete exactly once", async () => {
    // Owes 100.00 total; 50% of revenue per day.
    api.advancesByDay = () => [dto()];
    api.setRevenue(1, "2022-01-02", "120.00"); // -> 60.00
    api.setRevenue(1, "2022-01-03", "100.00"); // -> 50.00, clamped to 40.00
    api.setRevenue(1, "2022-01-04", "100.00"); // not needed

    for (const day of ["2022-01-02", "2022-01-03", "2022-01-04", "2022-01-05"]) {
      await engine.runBilling(day);
    }

    expect(api.successfulCharges.map((c) => c.amount)).toEqual([
      "60.00",
      "40.00",
    ]);
    const advance = store.getAdvance(1)!;
    expect(advance.state).toBe(AdvanceState.Completed);
    expect(BalanceCalculator.isSettled(advance, store.ledgerFor(1))).toBe(true);
    expect(api.completedAdvances).toEqual([
      { advanceId: 1, today: "2022-01-04" },
    ]);
    expect(metrics.counter("billing_complete")).toBe(1);
  });

  it("retries billing_complete on a later day without recharging", async () => {
    api.advancesByDay = () => [dto()];
    api.setRevenue(1, "2022-01-02", "200.00"); // -> 100.00 settles in one charge
    api.completeHook = (_id, today) =>
      today === "2022-01-03" ? new Error("HTTP 503") : undefined;

    await engine.runBilling("2022-01-03");
    expect(store.getAdvance(1)!.state).toBe(AdvanceState.Repaid);

    api.setRevenue(1, "2022-01-03", "100.00"); // must NOT be billed
    await engine.runBilling("2022-01-04");
    expect(store.getAdvance(1)!.state).toBe(AdvanceState.Completed);
    expect(api.successfulCharges.map((c) => c.amount)).toEqual(["100.00"]);
    expect(api.completedAdvances).toHaveLength(1);
  });

  it("re-running the same day is a no-op", async () => {
    api.advancesByDay = () => [dto()];
    api.setRevenue(1, "2022-01-02", "20.00"); // -> 10.00

    await engine.runBilling("2022-01-03");
    await engine.runBilling("2022-01-03");
    expect(api.successfulCharges.map((c) => c.amount)).toEqual(["10.00"]);
  });

  it("survives an advance-sync failure and keeps billing known advances", async () => {
    api.advancesByDay = () => [dto()];
    api.setRevenue(1, "2022-01-02", "20.00");
    await engine.runBilling("2022-01-02");

    api.advancesByDay = () => {
      throw new Error("HTTP 503");
    };
    await engine.runBilling("2022-01-03");
    expect(api.successfulCharges.map((c) => c.amount)).toEqual(["10.00"]);
  });
});
