import {
  HttpBillingApiClient,
} from "./api/BillingApiClient";
import { RetryableBillingApiClient } from "./api/RetryableBillingApiClient";
import { startDocsServer } from "./infrastructure/DocsServer";
import { Logger, type LogLevel } from "./infrastructure/Logger";
import { Metrics } from "./infrastructure/Metrics";
import { RetryPolicy } from "./infrastructure/RetryPolicy";
import { BillingEngine } from "./services/BillingEngine";
import { ChargeProcessor } from "./services/ChargeProcessor";
import { RevenueProcessor } from "./services/RevenueProcessor";
import { InMemoryStateStore } from "./store/StateStore";
import { SimulationReporter } from "./simulation/SimulationReporter";
import { Simulator } from "./simulation/Simulator";

const config = {
  baseUrl: process.env.BASE_URL ?? "https://billing.eng-test.wayflyer.com/v2",
  startDate: process.env.START_DATE ?? "2022-01-01",
  endDate: process.env.END_DATE ?? "2022-02-01",
  logLevel: (process.env.LOG_LEVEL ?? "info") as LogLevel,
  docsPort: Number(process.env.DOCS_PORT ?? 3000),
};

async function main(): Promise<void> {
  const logger = new Logger(config.logLevel);
  const metrics = new Metrics();

  await startDocsServer({ port: config.docsPort, apiTarget: config.baseUrl });
  logger.info("docs_server_started", {
    swaggerUi: `http://localhost:${config.docsPort}/`,
    openapiSpec: `http://localhost:${config.docsPort}/openapi.yaml`,
    apiProxy: `http://localhost:${config.docsPort}/v2 -> ${config.baseUrl}`,
  });

  const retryPolicy = new RetryPolicy({
    maxRetries: 3,
    baseDelayMs: 100,
    maxDelayMs: 2000,
    onRetry: (attempt, delayMs, error) => {
      metrics.increment("retry_attempt");
      logger.warn("api_retry", {
        attempt,
        delayMs: Math.round(delayMs),
        error: String(error),
      });
    },
  });

  const api = new RetryableBillingApiClient(
    new HttpBillingApiClient(config.baseUrl),
    retryPolicy,
    logger,
    metrics,
  );

  const store = new InMemoryStateStore();
  const revenueProcessor = new RevenueProcessor(api, store, logger, metrics);
  const chargeProcessor = new ChargeProcessor(api, store, logger, metrics);
  const engine = new BillingEngine(
    api,
    store,
    revenueProcessor,
    chargeProcessor,
    logger,
    metrics,
  );

  const simulator = new Simulator(engine, config.startDate, config.endDate, logger);
  await simulator.run();

  new SimulationReporter(store, metrics).print();

  // The docs server keeps the process alive for browser testing.
  logger.info("docs_server_running", {
    swaggerUi: `http://localhost:${config.docsPort}/`,
    hint: "Press Ctrl+C to exit",
  });
}

main().catch((error) => {
  console.error("Fatal error during simulation:", error);
  process.exitCode = 1;
});
