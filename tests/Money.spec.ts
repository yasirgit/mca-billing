import { describe, expect, it } from "vitest";
import { Money } from "../src/utils/Money";

describe("Money", () => {
  it("serializes with exactly two decimals", () => {
    expect(Money.of("12345.67").toString()).toBe("12345.67");
    expect(Money.of("100").toString()).toBe("100.00");
    expect(Money.of(0).toString()).toBe("0.00");
  });

  it("rounds 9184.60 at 17 percent half-up to 1561.38", () => {
    expect(Money.of("9184.60").percent(17).toString()).toBe("1561.38");
  });

  it("computes 11 percent of 150000.00 as 16500.00", () => {
    expect(Money.of("150000.00").percent(11).toString()).toBe("16500.00");
  });

  it("rounds half-up at the third decimal", () => {
    // 0.05 * 10% = 0.005 -> 0.01
    expect(Money.of("0.05").percent(10).toString()).toBe("0.01");
    // 0.04 * 10% = 0.004 -> 0.00
    expect(Money.of("0.04").percent(10).toString()).toBe("0.00");
  });

  it("avoids IEEE-754 drift in addition", () => {
    let sum = Money.zero();
    for (let i = 0; i < 10; i++) sum = sum.add(Money.of("0.10"));
    expect(sum.toString()).toBe("1.00");
    expect(sum.equals(Money.of("1.00"))).toBe(true);
  });

  it("supports subtract, compare and min", () => {
    const a = Money.of("10000.00");
    const b = Money.of("6500.00");
    expect(a.subtract(b).toString()).toBe("3500.00");
    expect(Money.min(a, b, Money.of("9999.99")).toString()).toBe("6500.00");
    expect(b.lessThan(a)).toBe(true);
    expect(a.greaterThan(b)).toBe(true);
    expect(a.subtract(a).isZero()).toBe(true);
    expect(b.subtract(a).isNegative()).toBe(true);
  });
});
