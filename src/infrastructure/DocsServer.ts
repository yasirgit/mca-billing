import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "http";
import { readFile } from "fs/promises";
import { join } from "path";
import { fileURLToPath } from "url";
import {
  ApiStatusError,
  NetworkError,
  type BillingApiClient,
} from "../api/BillingApiClient";
import type { IsoDate } from "../utils/Dates";
import { Money } from "../utils/Money";

export interface DocsServerOptions {
  port: number;
  /** Upstream billing API used when no app client is wired in. */
  apiTarget: string;
  /**
   * When set, /v2/* is served through this client (HttpBillingApiClient +
   * decorators) instead of a raw fetch proxy — breakpoints in the client
   * and retry/circuit-breaker layers will hit on Swagger/curl traffic.
   */
  api?: BillingApiClient;
  /** Runs one full billing day (sync → revenue → charge → complete). */
  onRunBillingDay?: (today: IsoDate) => Promise<void>;
}

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");

const FORWARDED_HEADERS = [
  "today",
  "content-type",
  "idempotency-key",
  "accept",
] as const;

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(body));
}

function headerValue(
  req: IncomingMessage,
  name: string,
): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function getTodayHeader(req: IncomingMessage): IsoDate | undefined {
  return headerValue(req, "today") as IsoDate | undefined;
}

function sendApiError(res: ServerResponse, error: unknown): void {
  if (error instanceof ApiStatusError) {
    sendJson(res, error.status, {
      error: "api_error",
      endpoint: error.endpoint,
      message: error.message,
    });
    return;
  }
  if (error instanceof NetworkError) {
    sendJson(res, 502, {
      error: "network_error",
      endpoint: error.endpoint,
      message: error.message,
    });
    return;
  }
  sendJson(res, 500, { error: "server_error", message: String(error) });
}

async function serveViaBillingClient(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  api: BillingApiClient,
): Promise<void> {
  const today = getTodayHeader(req);
  if (!today) {
    sendJson(res, 400, {
      error: "missing_today_header",
      message: "Set the Today header (yyyy-mm-dd).",
    });
    return;
  }

  try {
    if (req.method === "GET" && pathname === "/advances") {
      const advances = await api.getAdvances(today);
      sendJson(res, 200, { advances });
      return;
    }

    const revenueMatch = pathname.match(
      /^\/customers\/(\d+)\/revenues\/(\d{4}-\d{2}-\d{2})$/,
    );
    if (req.method === "GET" && revenueMatch) {
      const customerId = Number(revenueMatch[1]);
      const forDate = revenueMatch[2] as IsoDate;
      const result = await api.getRevenue(customerId, forDate, today);
      if (result.kind === "unavailable") {
        res.writeHead(530, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ error: "revenue_not_available" }));
        return;
      }
      sendJson(res, 200, { amount: result.amount.toString() });
      return;
    }

    const chargeMatch = pathname.match(/^\/mandates\/(\d+)\/charge$/);
    if (req.method === "POST" && chargeMatch) {
      const body = await readBody(req);
      const { amount } = JSON.parse((body ?? Buffer.from("{}")).toString()) as {
        amount: string;
      };
      const idempotencyKey =
        headerValue(req, "idempotency-key") ??
        `swagger:${chargeMatch[1]}:${today}:${amount}`;
      const outcome = await api.charge(
        Number(chargeMatch[1]),
        Money.of(amount),
        today,
        idempotencyKey,
      );
      if (outcome.kind === "rejected") {
        res.writeHead(530, { "Access-Control-Allow-Origin": "*" });
        res.end();
        return;
      }
      sendJson(res, 200, {});
      return;
    }

    const completeMatch = pathname.match(/^\/advances\/(\d+)\/billing_complete$/);
    if (req.method === "POST" && completeMatch) {
      await api.billingComplete(Number(completeMatch[1]), today);
      sendJson(res, 200, {});
      return;
    }

    res.writeHead(404, {
      "Content-Type": "text/plain",
      "Access-Control-Allow-Origin": "*",
    });
    res.end("Not found");
  } catch (error) {
    sendApiError(res, error);
  }
}

async function proxyApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathWithQuery: string,
  apiTarget: string,
): Promise<void> {
  const targetUrl = `${apiTarget}${pathWithQuery}`;
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = req.headers[name];
    if (value !== undefined) {
      headers.set(
        name === "today" ? "Today" : name,
        Array.isArray(value) ? value.join(", ") : value,
      );
    }
  }

  try {
    const body = await readBody(req);
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: body?.length ? body : undefined,
    });
    const responseBody = await upstream.arrayBuffer();
    res.writeHead(upstream.status, {
      "Content-Type":
        upstream.headers.get("content-type") ?? "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(Buffer.from(responseBody));
  } catch (error) {
    sendJson(res, 502, {
      error: "proxy_failed",
      message: String(error),
      target: targetUrl,
    });
  }
}

async function serveOpenApi(res: ServerResponse, port: number): Promise<void> {
  const raw = await readFile(join(ROOT, "docs/openapi.yaml"), "utf8");
  const localServer = `http://localhost:${port}/v2`;
  const patched = raw.replace(
    /servers:\s*\n\s*- url: https:\/\/billing\.eng-test\.wayflyer\.com\/v2/,
    `servers:\n  - url: ${localServer}\n    description: Local app client (Swagger hits HttpBillingApiClient)\n  - url: https://billing.eng-test.wayflyer.com/v2\n    description: Live API (direct; may be blocked by CORS in the browser)`,
  );
  res.writeHead(200, {
    "Content-Type": "application/yaml",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(patched);
}

function serveSwaggerUi(res: ServerResponse): void {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Wayflyer MCA Billing API</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css" />
  <style>
    html { box-sizing: border-box; overflow-y: scroll; }
    *, *:before, *:after { box-sizing: inherit; }
    body { margin: 0; background: #fafafa; }
    .topbar { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js" crossorigin></script>
  <script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-standalone-preset.js" crossorigin></script>
  <script>
    window.onload = function () {
      SwaggerUIBundle({
        url: "/openapi.yaml",
        dom_id: "#swagger-ui",
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        layout: "StandaloneLayout",
        persistAuthorization: true,
        tryItOutEnabled: true,
        requestInterceptor: function (req) {
          if (!req.headers["Today"] && !req.headers["today"]) {
            req.headers["Today"] = "2022-01-02";
          }
          return req;
        },
      });
    };
  </script>
</body>
</html>`;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

/**
 * Serves Swagger UI for docs/openapi.yaml. When `api` is provided, /v2/*
 * routes through the app's BillingApiClient; otherwise requests are proxied
 * directly to `apiTarget`. Resolves once the server is listening.
 */
export function startDocsServer(options: DocsServerOptions): Promise<Server> {
  const { port, apiTarget, api, onRunBillingDay } = options;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const pathname = url.pathname;

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "Today, Content-Type, Idempotency-Key, Accept",
      });
      res.end();
      return;
    }

    try {
      if (pathname === "/openapi.yaml") {
        await serveOpenApi(res, port);
        return;
      }

      if (pathname === "/billing/run-day" && req.method === "POST") {
        const today = getTodayHeader(req);
        if (!today) {
          sendJson(res, 400, {
            error: "missing_today_header",
            message: "Set the Today header (yyyy-mm-dd).",
          });
          return;
        }
        if (!onRunBillingDay) {
          sendJson(res, 503, { error: "billing_engine_not_configured" });
          return;
        }
        await onRunBillingDay(today);
        sendJson(res, 200, { ok: true, today });
        return;
      }

      if (pathname === "/v2" || pathname.startsWith("/v2/")) {
        const apiPath = pathname.slice("/v2".length) || "/";
        if (api) {
          await serveViaBillingClient(req, res, apiPath, api);
        } else {
          await proxyApi(req, res, `${apiPath}${url.search}`, apiTarget);
        }
        return;
      }

      if (pathname === "/" || pathname === "/docs") {
        serveSwaggerUi(res);
        return;
      }

      if (pathname === "/health") {
        sendJson(res, 200, { status: "ok", proxyTarget: apiTarget });
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    } catch (error) {
      sendJson(res, 500, { error: "server_error", message: String(error) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolve(server));
  });
}
