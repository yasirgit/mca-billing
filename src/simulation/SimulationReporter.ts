import type { Metrics } from "../infrastructure/Metrics";
import { BalanceCalculator } from "../services/BalanceCalculator";
import type { StateStore } from "../store/StateStore";
import { Money } from "../utils/Money";

/**
 * End-of-run reconciliation: per-advance balances rebuilt from the ledger,
 * residual backlogs, dead letters and the metrics snapshot. Anything not
 * fully repaid by the end of the period is surfaced, never silently dropped.
 */
export class SimulationReporter {
  constructor(
    private readonly store: StateStore,
    private readonly metrics: Metrics,
    private readonly out: (line: string) => void = (line) =>
      process.stdout.write(line + "\n"),
  ) {}

  print(): void {
    const lines: string[] = [];
    lines.push("");
    lines.push("=".repeat(78));
    lines.push("SIMULATION REPORT");
    lines.push("=".repeat(78));

    let totalRepaid = Money.zero();
    let totalOutstanding = Money.zero();

    for (const advance of this.store.allAdvances()) {
      const ledger = this.store.ledgerFor(advance.id);
      const repaid = BalanceCalculator.amountRepaid(ledger);
      const outstanding = BalanceCalculator.outstanding(advance, ledger);
      totalRepaid = totalRepaid.add(repaid);
      totalOutstanding = totalOutstanding.add(outstanding);

      const revenueBacklog = this.store.revenueBacklogFor(advance.id);
      const chargeBacklog = this.store.chargeBacklogFor(advance.id);
      const queuedAmount = chargeBacklog.reduce(
        (sum, i) => sum.add(i.amount),
        Money.zero(),
      );

      lines.push("");
      lines.push(
        `Advance ${advance.id} (customer ${advance.customerId}, mandate ${advance.mandateId})  [${advance.state}]`,
      );
      lines.push(
        `  total repayable: ${advance.totalRepayable}  repaid: ${repaid}  outstanding: ${outstanding}`,
      );
      lines.push(
        `  ledger events: ${ledger.length}  pending charges: ${chargeBacklog.length} (${queuedAmount})  pending revenue dates: ${revenueBacklog.length}`,
      );
      if (revenueBacklog.length > 0) {
        lines.push(
          `  unresolved revenue dates: ${revenueBacklog
            .map((i) => i.revenueDate)
            .join(", ")}`,
        );
      }
    }

    lines.push("");
    lines.push("-".repeat(78));
    lines.push(`TOTAL repaid: ${totalRepaid}   TOTAL outstanding: ${totalOutstanding}`);

    const dlq = this.store.deadLetters();
    lines.push(`Dead letters: ${dlq.length}`);
    for (const item of dlq) {
      lines.push(
        `  [${item.occurredOn}] ${item.operation} ${JSON.stringify(item.payload)} - ${item.error}`,
      );
    }

    lines.push("");
    lines.push("Metrics:");
    const { counters, gauges } = this.metrics.snapshot();
    for (const [name, value] of Object.entries(counters)) {
      lines.push(`  ${name}: ${value}`);
    }
    for (const [name, value] of Object.entries(gauges)) {
      lines.push(`  ${name} (gauge): ${value}`);
    }
    lines.push("=".repeat(78));

    for (const line of lines) this.out(line);
  }
}
