import { describe, expect, it, vi } from "vitest";
import {
  CircuitBreaker,
  CircuitOpenError,
} from "../src/infrastructure/CircuitBreaker";

function makeBreaker(clock: { now: number }, onStateChange?: () => void) {
  return new CircuitBreaker({
    name: "test",
    failureThreshold: 3,
    cooldownMs: 1000,
    now: () => clock.now,
    onStateChange,
  });
}

const failing = () => Promise.reject(new Error("transport"));
const succeeding = () => Promise.resolve("ok");

describe("CircuitBreaker", () => {
  it("stays closed below the failure threshold and resets on success", async () => {
    const breaker = makeBreaker({ now: 0 });
    await expect(breaker.execute(failing)).rejects.toThrow("transport");
    await expect(breaker.execute(failing)).rejects.toThrow("transport");
    await expect(breaker.execute(succeeding)).resolves.toBe("ok");
    await expect(breaker.execute(failing)).rejects.toThrow("transport");
    expect(breaker.state).toBe("CLOSED");
  });

  it("opens after threshold consecutive failures and fails fast", async () => {
    const breaker = makeBreaker({ now: 0 });
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(failing)).rejects.toThrow("transport");
    }
    expect(breaker.state).toBe("OPEN");
    await expect(breaker.execute(succeeding)).rejects.toThrow(CircuitOpenError);
  });

  it("half-opens after cooldown and closes on a successful probe", async () => {
    const clock = { now: 0 };
    const breaker = makeBreaker(clock);
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(failing)).rejects.toThrow();
    }
    clock.now = 1000;
    await expect(breaker.execute(succeeding)).resolves.toBe("ok");
    expect(breaker.state).toBe("CLOSED");
  });

  it("re-opens when the half-open probe fails", async () => {
    const clock = { now: 0 };
    const breaker = makeBreaker(clock);
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(failing)).rejects.toThrow();
    }
    clock.now = 1000;
    await expect(breaker.execute(failing)).rejects.toThrow("transport");
    expect(breaker.state).toBe("OPEN");
    await expect(breaker.execute(succeeding)).rejects.toThrow(CircuitOpenError);
  });

  it("emits state transitions", async () => {
    const transitions: string[] = [];
    const clock = { now: 0 };
    const breaker = new CircuitBreaker({
      name: "test",
      failureThreshold: 1,
      cooldownMs: 1000,
      now: () => clock.now,
      onStateChange: (from, to) => transitions.push(`${from}->${to}`),
    });
    await expect(breaker.execute(failing)).rejects.toThrow();
    clock.now = 1000;
    await breaker.execute(succeeding);
    expect(transitions).toEqual([
      "CLOSED->OPEN",
      "OPEN->HALF_OPEN",
      "HALF_OPEN->CLOSED",
    ]);
  });
});
