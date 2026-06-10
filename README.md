# Wayflyer MCA Billing

A daily billing system for Merchant Cash Advances: every day it discovers
advances, fetches each customer's previous-day revenue, charges the agreed
percentage against the advance's mandate (respecting the daily cap), and
marks billing complete once principal + fee are fully repaid.

## Setup & Run

Requires Node.js >= 20.

```bash
npm install
npm start          # runs the full simulation (2022-01-01 .. 2022-02-01)
npm test           # runs the test suite (49 tests)
npm run typecheck  # strict TypeScript check
```

Configuration via environment variables (all optional):

| Variable     | Default                                    |
|--------------|--------------------------------------------|
| `BASE_URL`   | `https://billing.eng-test.wayflyer.com/v2` |
| `START_DATE` | `2022-01-01`                               |
| `END_DATE`   | `2022-02-01`                               |
| `LOG_LEVEL`  | `info` (`debug`/`info`/`warn`/`error`/`silent`) |
| `DOCS_PORT`  | `3000` (Swagger UI / docs server port)     |

The run emits structured JSON logs and ends with a reconciliation report:
per-advance repaid/outstanding balances rebuilt from the ledger, residual
backlogs, dead letters, and a metrics dump.

## Design Overview

```
Simulator -> BillingEngine (per day)
               1. sync advances        GET /advances
               2. RevenueProcessor     GET /customers/:id/revenues/:date
                    revenue 530  -> RevenueBacklog (re-tried daily)
                    revenue OK   -> repayment % -> ChargeBacklog
               3. ChargeProcessor      POST /mandates/:id/charge
                    clamp = min(amount, cap headroom, outstanding)
                    success      -> append ChargeLedgerEvent (immutable)
                    530 rejected -> re-queue for next day
                    cap split    -> remainder re-queued at head
               4. completion check     POST /advances/:id/billing_complete
                    ledger settled -> REPAID -> COMPLETED (exactly once)
```

Key decisions:

- **Ledger-based accounting** — amount repaid is always a fold over
  immutable `ChargeLedgerEvent`s, never a mutable counter. Every cent is
  auditable (date, advance, mandate, source revenue date), balances are
  rebuildable, and the model maps 1:1 onto an append-only table in
  production.
- **Explicit backlog queues** — pending revenue dates and pending charge
  amounts are first-class items with provenance and retry counts, not an
  accumulator. This is what makes delayed revenue, 530 rejections, daily-cap
  splits and settlement cancellation safe and observable.
- **Idempotency** — a revenue date lives in exactly one of: ahead of the
  cursor, the backlog, or the processed set, so it can never be billed
  twice. Charges carry deterministic idempotency keys; `billing_complete`
  is gated by the `ACTIVE -> REPAID -> COMPLETED` state machine.
- **Overcharge prevention** — every charge is clamped to
  `min(amount, daily-cap headroom, outstanding balance)`; the daily cap is
  per advance (mandates can be shared) and only settled money counts toward
  it.
- **Exact money** — `decimal.js` with half-up rounding to 2 dp; no IEEE-754
  drift; wire format is always `"0.00"`.
- **Fault tolerance** — full-jitter exponential retries for idempotent GETs,
  per-endpoint circuit breakers, and a dead-letter queue for ambiguous
  charge outcomes (a network failure mid-POST may have charged the customer,
  so it is parked for reconciliation, never blind-retried).

## API Documentation

The consumed Wayflyer billing API is documented as an OpenAPI 3 spec in
[docs/openapi.yaml](docs/openapi.yaml) (all four endpoints, the `Today`
simulation header, money encoding, and the 530 semantics). View it with any
Swagger tooling, e.g.:

```bash
npx @redocly/cli preview-docs docs/openapi.yaml   # local docs server
```

or paste it into <https://editor.swagger.io>.

### Browser testing (Swagger UI + local proxy)

The docs server starts automatically with the main run:

```bash
npm start
```

Then open <http://localhost:3000/> in your browser. It stays up after the
simulation finishes so the endpoints can be explored (Ctrl+C to exit).

The docs server serves:

| URL | Purpose |
|-----|---------|
| `http://localhost:3000/` | Swagger UI (Try it out) |
| `http://localhost:3000/openapi.yaml` | OpenAPI spec |
| `http://localhost:3000/v2/*` | Proxy to the live Wayflyer API (avoids browser CORS) |

In Swagger UI, select **Local proxy for browser testing** as the server. Every
request needs a `Today: yyyy-mm-dd` header (pre-filled as `2022-01-02` if
missing). Override the port with `DOCS_PORT` and the upstream API with
`BASE_URL`.

## Project Structure

```
src/
  api/             BillingApiClient port + HTTP impl; Retryable decorator
  domain/          Advance, AdvanceState, backlog items, ledger event, DLQ item
  services/        RevenueProcessor, ChargeProcessor, BalanceCalculator, BillingEngine
  store/           StateStore port + InMemoryStateStore
  infrastructure/  RetryPolicy, CircuitBreaker, Logger, Metrics, DocsServer
  utils/           Money (decimal.js), Dates, Idempotency keys
  simulation/      Simulator, SimulationReporter
  main.ts          composition root
tests/             unit + integration specs (scripted FakeBillingApi)
```

## Interpretation Notes

- "Every day we charge a percentage of the previous day's sales" + "repayments
  start on `repayment_start_date`" is read as: on day `D >= repayment_start_date`
  we bill the revenue of `D - 1`, so the first billable revenue date is
  `repayment_start_date - 1`.
- The daily `10000.00` cap is applied **per advance** (the spec says "against
  any advance"); two advances sharing a mandate may together exceed it.
- A 530 charge rejection consumes no cap headroom — no money moved.
- The simulation stops at `END_DATE`; advances that could not finish repaying
  (e.g. persistently rejecting mandates or unavailable revenue) are surfaced
  in the final report as ACTIVE with their outstanding balances and residual
  backlogs.

## Production Migration

Business logic is isolated behind two ports, so only adapters change:

| In-memory (assignment)            | Production                                    |
|-----------------------------------|-----------------------------------------------|
| `InMemoryStateStore`              | PostgreSQL (unique keys enforce idempotency; ledger as append-only table) |
| Backlog queues                    | Kafka topics with consumer groups + DLQ topics |
| Daily cap totals / idempotency    | Redis (atomic counters with daily TTL, SETNX keys) |
| `Simulator`                       | Scheduler (cron/Temporal) invoking `BillingEngine.runBilling(today)` |
| `Metrics` / `Logger`              | Prometheus / structured log shipping           |

## TODOs / Conscious Trade-offs

- TODO: persist DLQ items with enough context to drive an automated
  reconciliation job (query the provider for the ambiguous charge's outcome).
- TODO: the daily loop processes advances sequentially; production would
  parallelise per-advance work with per-advance ordering guarantees.
- TODO: surface backlog *age* (not just depth) as a metric to alert on
  starving advances.
- TODO: make the daily cap and retry/breaker parameters externally
  configurable per environment.
