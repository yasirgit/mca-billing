import { beforeEach, describe, expect, it } from "vitest";
import { ApiStatusError } from "../src/api/BillingApiClient";
import { RevenueProcessor } from "../src/services/RevenueProcessor";
import { Metrics } from "../src/infrastructure/Metrics";
import { FakeBillingApi } from "./helpers/FakeBillingApi";
import { makeAdvance, makeStoreWith, silentLogger } from "./helpers/fixtures";
import type { InMemoryStateStore } from "../src/store/StateStore";
import type { Advance } from "../src/domain/Advance";

describe("RevenueProcessor", () => {
  let api: FakeBillingApi;
  let store: InMemoryStateStore;
  let advance: Advance;
  let metrics: Metrics;
  let processor: RevenueProcessor;

  beforeEach(() => {
    api = new FakeBillingApi();
    // repayment starts 2022-01-05 at 10% -> first billable revenue date 2022-01-04
    advance = makeAdvance();
    store = makeStoreWith(advance);
    metrics = new Metrics();
    processor = new RevenueProcessor(api, store, silentLogger(), metrics);
  });

  it("bills repayment_percentage of the previous day's revenue from repayment_start_date", async () => {
    api.setRevenue(1, "2022-01-04", "500.00");

    await processor.processRevenues("2022-01-04"); // before start: no-op
    expect(store.chargeBacklogFor(1)).toHaveLength(0);

    await processor.processRevenues("2022-01-05");
    const queue = store.chargeBacklogFor(1);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.amount.toString()).toBe("50.00");
    expect(queue[0]!.sourceRevenueDate).toBe("2022-01-04");
  });

  it("catches up on multiple due revenue dates for late-discovered advances", async () => {
    api.setRevenue(1, "2022-01-04", "100.00");
    api.setRevenue(1, "2022-01-05", "200.00");
    api.setRevenue(1, "2022-01-06", "300.00");

    await processor.processRevenues("2022-01-07");
    const queue = store.chargeBacklogFor(1);
    expect(queue.map((i) => i.sourceRevenueDate)).toEqual([
      "2022-01-04",
      "2022-01-05",
      "2022-01-06",
    ]);
    expect(queue.map((i) => i.amount.toString())).toEqual([
      "10.00",
      "20.00",
      "30.00",
    ]);
  });

  it("backlogs a revenue date on 530 and bills it the day it becomes available", async () => {
    api.setRevenue(1, "2022-01-04", "500.00", "2022-01-07");

    await processor.processRevenues("2022-01-05");
    expect(store.chargeBacklogFor(1)).toHaveLength(0);
    expect(store.revenueBacklogFor(1)).toHaveLength(1);

    api.setRevenue(1, "2022-01-05", "0.00");
    await processor.processRevenues("2022-01-06");
    expect(store.revenueBacklogFor(1)[0]!.attempts).toBe(2);

    api.setRevenue(1, "2022-01-06", "0.00");
    await processor.processRevenues("2022-01-07");
    expect(store.revenueBacklogFor(1)).toHaveLength(0);
    const queue = store.chargeBacklogFor(1);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.amount.toString()).toBe("50.00");
    expect(metrics.counter("revenue_backlog_added")).toBe(1);
  });

  it("is idempotent: re-running the same day cannot double-bill a revenue date", async () => {
    api.setRevenue(1, "2022-01-04", "500.00");
    await processor.processRevenues("2022-01-05");
    await processor.processRevenues("2022-01-05");
    expect(store.chargeBacklogFor(1)).toHaveLength(1);
    expect(metrics.counter("revenue_fetched")).toBe(1);
  });

  it("marks zero revenue as processed without enqueuing a charge", async () => {
    api.setRevenue(1, "2022-01-04", "0.00");
    await processor.processRevenues("2022-01-05");
    expect(store.chargeBacklogFor(1)).toHaveLength(0);
    expect(store.hasProcessedRevenue(1, "2022-01-04")).toBe(true);
  });

  it("does not bill backlogged revenue once the advance is settled", async () => {
    api.setRevenue(1, "2022-01-04", "500.00", "2022-01-08");
    await processor.processRevenues("2022-01-05");
    expect(store.revenueBacklogFor(1)).toHaveLength(1);

    store.appendLedgerEvent({
      advanceId: 1,
      mandateId: 2,
      amount: advance.totalRepayable,
      chargedOn: "2022-01-06",
      sourceRevenueDate: "2022-01-04",
    });

    api.setRevenue(1, "2022-01-05", "100.00");
    api.setRevenue(1, "2022-01-06", "100.00");
    api.setRevenue(1, "2022-01-07", "100.00");
    await processor.processRevenues("2022-01-08");
    expect(store.revenueBacklogFor(1)).toHaveLength(0);
    expect(store.chargeBacklogFor(1)).toHaveLength(0);
  });

  it("treats transport failures as unavailable-today and backlogs the date", async () => {
    api.revenueHook = () => new ApiStatusError(503, "/revenues");
    await processor.processRevenues("2022-01-05");
    expect(store.revenueBacklogFor(1).map((i) => i.revenueDate)).toEqual([
      "2022-01-04",
    ]);

    api.revenueHook = undefined;
    api.setRevenue(1, "2022-01-04", "500.00");
    api.setRevenue(1, "2022-01-05", "0.00");
    await processor.processRevenues("2022-01-06");
    expect(store.revenueBacklogFor(1)).toHaveLength(0);
    expect(store.chargeBacklogFor(1)).toHaveLength(1);
  });

  it("skips processing when the advance run lock is already held", async () => {
    api.setRevenue(1, "2022-01-04", "500.00");
    const owner = "external";
    expect(store.tryAcquireAdvanceRun(advance.id, owner)).toBe(true);

    await processor.processRevenues("2022-01-05");
    expect(store.chargeBacklogFor(1)).toHaveLength(0);

    store.releaseAdvanceRun(advance.id, owner);
  });
});
