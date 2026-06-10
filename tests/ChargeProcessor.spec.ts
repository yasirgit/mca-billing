import { beforeEach, describe, expect, it } from "vitest";
import { NetworkError } from "../src/api/BillingApiClient";
import { ChargeProcessor } from "../src/services/ChargeProcessor";
import { BalanceCalculator } from "../src/services/BalanceCalculator";
import { Metrics } from "../src/infrastructure/Metrics";
import { Money } from "../src/utils/Money";
import { FakeBillingApi } from "./helpers/FakeBillingApi";
import { makeAdvance, makeStoreWith, silentLogger } from "./helpers/fixtures";
import type { InMemoryStateStore } from "../src/store/StateStore";
import type { Advance } from "../src/domain/Advance";

describe("ChargeProcessor", () => {
  let api: FakeBillingApi;
  let store: InMemoryStateStore;
  let advance: Advance;
  let metrics: Metrics;
  let processor: ChargeProcessor;

  beforeEach(() => {
    api = new FakeBillingApi();
    advance = makeAdvance(); // owes 104000.00
    store = makeStoreWith(advance);
    metrics = new Metrics();
    processor = new ChargeProcessor(api, store, silentLogger(), metrics);
  });

  function enqueue(amount: string, sourceRevenueDate = "2022-01-04") {
    return store.enqueueCharge({
      advanceId: advance.id,
      mandateId: advance.mandateId,
      amount: Money.of(amount),
      sourceRevenueDate,
      createdOn: "2022-01-05",
    });
  }

  it("splits 16500.00 into 10000.00 then 6500.00 across two days (daily cap)", async () => {
    enqueue("16500.00");

    await processor.processCharges("2022-01-05");
    expect(api.successfulCharges.map((c) => c.amount)).toEqual(["10000.00"]);
    expect(store.chargeBacklogFor(1).map((i) => i.amount.toString())).toEqual([
      "6500.00",
    ]);

    await processor.processCharges("2022-01-06");
    expect(api.successfulCharges.map((c) => c.amount)).toEqual([
      "10000.00",
      "6500.00",
    ]);
    expect(store.chargeBacklogFor(1)).toHaveLength(0);
    expect(metrics.counter("charge_cap_splits")).toBe(1);
  });

  it("counts already-settled charges toward the day's cap", async () => {
    store.appendLedgerEvent({
      advanceId: 1,
      mandateId: 2,
      amount: Money.of("9000.00"),
      chargedOn: "2022-01-05",
      sourceRevenueDate: "2022-01-04",
    });
    enqueue("5000.00");

    await processor.processCharges("2022-01-05");
    expect(api.successfulCharges.map((c) => c.amount)).toEqual(["1000.00"]);
    expect(store.chargeBacklogFor(1).map((i) => i.amount.toString())).toEqual([
      "4000.00",
    ]);
  });

  it("applies the cap per advance, not per mandate", async () => {
    const sibling = makeAdvance({ id: 2, mandateId: 2 });
    store.addAdvanceIfAbsent(sibling);
    enqueue("10000.00");
    store.enqueueCharge({
      advanceId: 2,
      mandateId: 2,
      amount: Money.of("10000.00"),
      sourceRevenueDate: "2022-01-04",
      createdOn: "2022-01-05",
    });

    await processor.processCharges("2022-01-05");
    // 20000.00 total against the shared mandate on one day is fine.
    expect(api.successfulCharges.map((c) => c.amount)).toEqual([
      "10000.00",
      "10000.00",
    ]);
  });

  it("clamps the final charge to the outstanding balance and never overcharges", async () => {
    const small = makeAdvance({ id: 3, totalAdvanced: "100.00", fee: "5.00" });
    store.addAdvanceIfAbsent(small);
    store.enqueueCharge({
      advanceId: 3,
      mandateId: 2,
      amount: Money.of("200.00"),
      sourceRevenueDate: "2022-01-04",
      createdOn: "2022-01-05",
    });

    await processor.processCharges("2022-01-05");
    expect(api.successfulCharges.map((c) => c.amount)).toEqual(["105.00"]);
    // Remainder is cancelled because the advance is now settled.
    expect(store.chargeBacklogFor(3)).toHaveLength(0);
    expect(BalanceCalculator.isSettled(small, store.ledgerFor(3))).toBe(true);
  });

  it("re-queues the full amount on a 530 rejection and succeeds on a later day", async () => {
    enqueue("500.00");
    api.chargeHook = (_m, _a, today) =>
      today === "2022-01-05" ? { kind: "rejected" } : undefined;

    await processor.processCharges("2022-01-05");
    expect(api.successfulCharges).toHaveLength(0);
    expect(store.chargeBacklogFor(1)).toHaveLength(1);
    expect(store.chargeBacklogFor(1)[0]!.attempts).toBe(1);
    expect(metrics.counter("charge_failure")).toBe(1);

    await processor.processCharges("2022-01-06");
    expect(api.successfulCharges.map((c) => c.amount)).toEqual(["500.00"]);
    expect(store.chargeBacklogFor(1)).toHaveLength(0);
  });

  it("preserves FIFO order across failed days", async () => {
    enqueue("100.00", "2022-01-04");
    enqueue("200.00", "2022-01-05");
    api.chargeHook = (_m, _a, today) =>
      today === "2022-01-06" ? { kind: "rejected" } : undefined;

    await processor.processCharges("2022-01-06");
    await processor.processCharges("2022-01-07");
    expect(api.successfulCharges.map((c) => c.amount)).toEqual([
      "100.00",
      "200.00",
    ]);
  });

  it("uses distinct idempotency keys per re-issue and per split", async () => {
    enqueue("16500.00");
    api.chargeHook = (_m, _a, today) =>
      today === "2022-01-05" ? { kind: "rejected" } : undefined;

    await processor.processCharges("2022-01-05"); // rejected attempt
    await processor.processCharges("2022-01-06"); // 10000 + split remainder
    await processor.processCharges("2022-01-07"); // 6500 remainder (new item)

    const keys = api.chargeAttempts.map((c) => c.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("dead-letters ambiguous network failures instead of blind-retrying", async () => {
    enqueue("500.00");
    api.chargeHook = () => new NetworkError("/mandates/2/charge", "ECONNRESET");

    await processor.processCharges("2022-01-05");
    expect(store.chargeBacklogFor(1)).toHaveLength(0);
    expect(store.ledgerFor(1)).toHaveLength(0);
    expect(store.deadLetters()).toHaveLength(1);
    expect(store.deadLetters()[0]!.operation).toBe("charge");
    expect(metrics.counter("dlq_added")).toBe(1);
  });

  it("keeps the item for tomorrow after a definitive server error", async () => {
    enqueue("500.00");
    let calls = 0;
    api.chargeHook = () => {
      calls++;
      return calls === 1 ? new Error("HTTP 503 after retries") : undefined;
    };

    await processor.processCharges("2022-01-05");
    expect(store.chargeBacklogFor(1)).toHaveLength(1);

    await processor.processCharges("2022-01-06");
    expect(api.successfulCharges.map((c) => c.amount)).toEqual(["500.00"]);
  });

  it("cancels the backlog without charging once the advance is settled", async () => {
    store.appendLedgerEvent({
      advanceId: 1,
      mandateId: 2,
      amount: advance.totalRepayable,
      chargedOn: "2022-01-05",
      sourceRevenueDate: "2022-01-04",
    });
    enqueue("500.00");

    await processor.processCharges("2022-01-06");
    expect(api.chargeAttempts).toHaveLength(0);
    expect(store.chargeBacklogFor(1)).toHaveLength(0);
  });
});
