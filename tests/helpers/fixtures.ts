import { Advance } from "../../src/domain/Advance";
import { Logger } from "../../src/infrastructure/Logger";
import { Metrics } from "../../src/infrastructure/Metrics";
import { InMemoryStateStore } from "../../src/store/StateStore";
import type { IsoDate } from "../../src/utils/Dates";
import { Money } from "../../src/utils/Money";

export const silentLogger = () => new Logger("silent");

export interface AdvanceOverrides {
  id?: number;
  customerId?: number;
  mandateId?: number;
  created?: IsoDate;
  totalAdvanced?: string;
  fee?: string;
  repaymentStartDate?: IsoDate;
  repaymentPercentage?: number;
}

export function makeAdvance(overrides: AdvanceOverrides = {}): Advance {
  return new Advance({
    id: overrides.id ?? 1,
    customerId: overrides.customerId ?? 1,
    mandateId: overrides.mandateId ?? 2,
    created: overrides.created ?? "2022-01-02",
    totalAdvanced: Money.of(overrides.totalAdvanced ?? "100000.00"),
    fee: Money.of(overrides.fee ?? "4000.00"),
    repaymentStartDate: overrides.repaymentStartDate ?? "2022-01-05",
    repaymentPercentage: overrides.repaymentPercentage ?? 10,
  });
}

export function makeStoreWith(...advances: Advance[]): InMemoryStateStore {
  const store = new InMemoryStateStore();
  for (const advance of advances) store.addAdvanceIfAbsent(advance);
  return store;
}

export const metrics = () => new Metrics();
