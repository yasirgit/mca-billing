/** ISO calendar date, `yyyy-mm-dd`. Lexicographic order == chronological order. */
export type IsoDate = string;

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function compareDates(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Inclusive range of consecutive days. */
export function* dateRange(start: IsoDate, end: IsoDate): Generator<IsoDate> {
  for (let d = start; compareDates(d, end) <= 0; d = addDays(d, 1)) {
    yield d;
  }
}
