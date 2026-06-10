import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "http";
import { readFile } from "fs/promises";
import { join } from "path";
import { fileURLToPath } from "url";

export interface DocsServerOptions {
  port: number;
  /** Upstream billing API that /v2/* requests are proxied to. */
  apiTarget: string;
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
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
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
    `servers:\n  - url: ${localServer}\n    description: Local proxy for browser testing (forwards to the live API)\n  - url: https://billing.eng-test.wayflyer.com/v2\n    description: Live API (direct; may be blocked by CORS in the browser)`,
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
 * Serves Swagger UI for docs/openapi.yaml plus a /v2 proxy to the live
 * billing API so the endpoints can be exercised from the browser without
 * CORS issues. Resolves once the server is listening.
 */
export function startDocsServer(options: DocsServerOptions): Promise<Server> {
  const { port, apiTarget } = options;

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

      if (pathname === "/v2" || pathname.startsWith("/v2/")) {
        const apiPath = pathname.slice("/v2".length) || "/";
        await proxyApi(req, res, `${apiPath}${url.search}`, apiTarget);
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
