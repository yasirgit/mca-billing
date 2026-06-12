import { Money } from "../utils/Money";
import type { IsoDate } from "../utils/Dates";

/** Wire shape of an advance from GET /advances. */
export interface AdvanceDto {
  id: number;
  customer_id: number;
  mandate_id: number;
  created: IsoDate;
  total_advanced: string;
  fee: string;
  repayment_start_date: IsoDate;
  repayment_percentage: number;
}

/** 530 on revenue is a business outcome ("not ready"), not an error. */
export type RevenueResult =
  | { kind: "available"; amount: Money }
  | { kind: "unavailable" };

/** 530 on charge is a definitive rejection: no money moved, safe to re-issue. */
export type ChargeOutcome = { kind: "charged" } | { kind: "rejected" };

/** Definitive non-2xx HTTP response (the server told us what happened). */
export class ApiStatusError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
  ) {
    super(`${endpoint} responded with HTTP ${status}`);
    this.name = "ApiStatusError";
  }
}

/**
 * No definitive response received (DNS failure, timeout, connection reset).
 * For non-idempotent POSTs the outcome is AMBIGUOUS: the request may have
 * been processed. Callers must not blindly retry charges on this error.
 */
export class NetworkError extends Error {
  constructor(
    readonly endpoint: string,
    cause: unknown,
  ) {
    super(`Network failure calling ${endpoint}: ${String(cause)}`);
    this.name = "NetworkError";
  }
}

/**
 * Port for the Wayflyer billing API. Services depend on this interface only;
 * resilience is layered on via the RetryableBillingApiClient decorator.
 */
export interface BillingApiClient {
  getAdvances(today: IsoDate): Promise<AdvanceDto[]>;
  getRevenue(
    customerId: number,
    forDate: IsoDate,
    today: IsoDate,
  ): Promise<RevenueResult>;
  charge(
    mandateId: number,
    amount: Money,
    today: IsoDate,
    idempotencyKey: string,
  ): Promise<ChargeOutcome>;
  billingComplete(advanceId: number, today: IsoDate): Promise<void>;
}

const REVENUE_NOT_AVAILABLE = 530;
const CHARGE_NOT_POSSIBLE = 530;

export class HttpBillingApiClient implements BillingApiClient {
  constructor(private readonly baseUrl: string) {}

  // TODO: validate response payloads with a runtime schema (e.g. zod): bound
  // repayment_percentage, reject negative amounts and malformed dates, rather
  // than trusting the wire shape (acceptable here per the reliable-API assumption).
  async getAdvances(today: IsoDate): Promise<AdvanceDto[]> {
    const body = await this.request("GET", "/advances", today);
    return (JSON.parse(body) as { advances: AdvanceDto[] }).advances;
  }

  async getRevenue(
    customerId: number,
    forDate: IsoDate,
    today: IsoDate,
  ): Promise<RevenueResult> {
    const endpoint = `/customers/${customerId}/revenues/${forDate}`;
    try {
      const body = await this.request("GET", endpoint, today);
      const { amount } = JSON.parse(body) as { amount: string };
      return { kind: "available", amount: Money.of(amount) };
    } catch (error) {
      if (
        error instanceof ApiStatusError &&
        error.status === REVENUE_NOT_AVAILABLE
      ) {
        return { kind: "unavailable" };
      }
      throw error;
    }
  }

  async charge(
    mandateId: number,
    amount: Money,
    today: IsoDate,
    idempotencyKey: string,
  ): Promise<ChargeOutcome> {
    const endpoint = `/mandates/${mandateId}/charge`;
    try {
      await this.request(
        "POST",
        endpoint,
        today,
        { amount: amount.toString() },
        idempotencyKey,
      );
      return { kind: "charged" };
    } catch (error) {
      if (
        error instanceof ApiStatusError &&
        error.status === CHARGE_NOT_POSSIBLE
      ) {
        return { kind: "rejected" };
      }
      throw error;
    }
  }

  async billingComplete(advanceId: number, today: IsoDate): Promise<void> {
    await this.request("POST", `/advances/${advanceId}/billing_complete`, today, {});
  }

  private async request(
    method: "GET" | "POST",
    endpoint: string,
    today: IsoDate,
    body?: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<string> {
    const headers: Record<string, string> = { Today: today };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${endpoint}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (cause) {
      throw new NetworkError(endpoint, cause);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new ApiStatusError(response.status, endpoint);
    }
    return text;
  }
}
