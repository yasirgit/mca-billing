import Decimal from "decimal.js";

const DECIMAL_PLACES = 2;

/**
 * Exact base-10 money arithmetic. All amounts are normalised to two decimal
 * places with half-up rounding; serialisation always emits "0.00" format as
 * required by the API.
 */
export class Money {
  private constructor(private readonly value: Decimal) {}

  static of(input: string | number | Decimal): Money {
    return new Money(
      new Decimal(input).toDecimalPlaces(DECIMAL_PLACES, Decimal.ROUND_HALF_UP),
    );
  }

  static zero(): Money {
    return Money.of(0);
  }

  static min(first: Money, ...rest: Money[]): Money {
    return rest.reduce((min, m) => (m.lessThan(min) ? m : min), first);
  }

  add(other: Money): Money {
    return Money.of(this.value.plus(other.value));
  }

  subtract(other: Money): Money {
    return Money.of(this.value.minus(other.value));
  }

  /** `pct`% of this amount, rounded half-up to two decimal places. */
  percent(pct: number): Money {
    return Money.of(this.value.times(pct).dividedBy(100));
  }

  compare(other: Money): number {
    return this.value.comparedTo(other.value);
  }

  equals(other: Money): boolean {
    return this.compare(other) === 0;
  }

  lessThan(other: Money): boolean {
    return this.compare(other) < 0;
  }

  greaterThan(other: Money): boolean {
    return this.compare(other) > 0;
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  /** API wire format: two decimal places, e.g. "12345.67". */
  toString(): string {
    return this.value.toFixed(DECIMAL_PLACES);
  }

  toJSON(): string {
    return this.toString();
  }
}
