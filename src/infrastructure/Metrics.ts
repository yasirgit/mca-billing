/**
 * In-memory counters and gauges, dumped in the end-of-run report. In
 * production this maps 1:1 onto a Prometheus registry.
 */
export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  gauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  counter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  snapshot(): { counters: Record<string, number>; gauges: Record<string, number> } {
    return {
      counters: Object.fromEntries(
        [...this.counters.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ),
      gauges: Object.fromEntries(
        [...this.gauges.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ),
    };
  }
}
