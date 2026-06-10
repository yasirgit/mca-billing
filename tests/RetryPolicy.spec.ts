import { describe, expect, it, vi } from "vitest";
import { RetryPolicy } from "../src/infrastructure/RetryPolicy";

const instantSleep = () => Promise.resolve();

describe("RetryPolicy", () => {
  it("returns the first successful result without retrying", async () => {
    const policy = new RetryPolicy({ sleep: instantSleep });
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(policy.execute(fn, () => true)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries transient failures and eventually succeeds", async () => {
    const policy = new RetryPolicy({ maxRetries: 3, sleep: instantSleep });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue("ok");
    await expect(policy.execute(fn, () => true)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("gives up after maxRetries and rethrows the last error", async () => {
    const policy = new RetryPolicy({ maxRetries: 2, sleep: instantSleep });
    const fn = vi.fn().mockRejectedValue(new Error("persistent"));
    await expect(policy.execute(fn, () => true)).rejects.toThrow("persistent");
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("does not retry non-retryable errors", async () => {
    const policy = new RetryPolicy({ maxRetries: 5, sleep: instantSleep });
    const fn = vi.fn().mockRejectedValue(new Error("530"));
    await expect(
      policy.execute(fn, (e) => !(e as Error).message.includes("530")),
    ).rejects.toThrow("530");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("applies full jitter: delay_n = random * min(maxDelay, base * 2^n)", () => {
    const policy = new RetryPolicy({
      baseDelayMs: 100,
      maxDelayMs: 2000,
      random: () => 0.5,
    });
    expect(policy.delayFor(0)).toBe(50); // 0.5 * 100
    expect(policy.delayFor(1)).toBe(100); // 0.5 * 200
    expect(policy.delayFor(4)).toBe(800); // 0.5 * 1600
    expect(policy.delayFor(10)).toBe(1000); // capped: 0.5 * 2000
  });

  it("delays are uniformly bounded by the backoff cap", () => {
    const policy = new RetryPolicy({ baseDelayMs: 100, maxDelayMs: 2000 });
    for (let attempt = 0; attempt < 8; attempt++) {
      const cap = Math.min(2000, 100 * 2 ** attempt);
      for (let i = 0; i < 25; i++) {
        const d = policy.delayFor(attempt);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThan(cap);
      }
    }
  });

  it("reports each retry via onRetry", async () => {
    const onRetry = vi.fn();
    const policy = new RetryPolicy({
      maxRetries: 2,
      sleep: instantSleep,
      onRetry,
    });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("a"))
      .mockResolvedValue("ok");
    await policy.execute(fn, () => true);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Number), expect.any(Error));
  });
});
