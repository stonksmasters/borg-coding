import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { readFileSync } from "node:fs";

const remotePort = Number(process.env.BORG_REMOTE_PORT ?? 4313);
const gatewayUrl = process.env.BORG_GATEWAY_URL ?? "http://127.0.0.1:4312";
const configuredPairingCode = process.env.BORG_REMOTE_PAIRING_CODE?.trim();
const pairingCode = configuredPairingCode && /^\d{6}$/.test(configuredPairingCode)
  ? configuredPairingCode
  : String(randomInt(100000, 1000000));

const sessions = new Map<string, number>();
const attempts = new Map<string, { count: number; resetAt: number }>();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const PAIR_WINDOW_MS = 60_000;
const MAX_PAIR_ATTEMPTS = 8;
const MAX_BODY_BYTES = 1_000_000;

const staticFiles = new Map<string, { file: string; contentType: string }>([
  ["/", { file: "index.html", contentType: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", contentType: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", contentType: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", contentType: "text/css; charset=utf-8" }],
  ["/manifest.webmanifest", { file: "manifest.webmanifest", contentType: "application/manifest+json; charset=utf-8" }],
  ["/sw.js", { file: "sw.js", contentType: "text/javascript; charset=utf-8" }],
  ["/icon.svg", { file: "icon.svg", contentType: "image/svg+xml" }],
]);

function securityHeaders() {
  return {
    "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "x-frame-options": "DENY",
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  response.writeHead(status, {
    ...securityHeaders(),
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extra,
  });
  response.end(JSON.stringify(body));
}

function sendStatic(response: ServerResponse, pathname: string) {
  const asset = staticFiles.get(pathname);
  if (!asset) return false;
  try {
    const content = readFileSync(new URL(`../../remote/${asset.file}`, import.meta.url));
    response.writeHead(200, {
      ...securityHeaders(),
      "content-type": asset.contentType,
      "cache-control": asset.file === "sw.js" ? "no-cache" : "public, max-age=300",
      ...(asset.file === "sw.js" ? { "service-worker-allowed": "/" } : {}),
    });
    response.end(content);
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : "Unable to load remote client." });
  }
  return true;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    request.on("data", (chunk: Buffer | string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large."));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(request);
  return body.trim() ? JSON.parse(body) as Record<string, unknown> : {};
}

function requestIp(request: IncomingMessage) {
  return request.socket.remoteAddress ?? "unknown";
}

function isLoopback(address: string | undefined) {
  if (!address) return false;
  return address === "::1"
    || address === "127.0.0.1"
    || address.startsWith("127.")
    || address === "::ffff:127.0.0.1"
    || address.startsWith("::ffff:127.");
}

function localAddresses() {
  const addresses = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      addresses.add(entry.address);
    }
  }
  return [...addresses].sort();
}

function parseCookies(request: IncomingMessage) {
  const cookies = new Map<string, string>();
  for (const pair of String(request.headers.cookie ?? "").split(";")) {
    const index = pair.indexOf("=");
    if (index < 0) continue;
    cookies.set(pair.slice(0, index).trim(), decodeURIComponent(pair.slice(index + 1).trim()));
  }
  return cookies;
}

function purgeExpiredSessions() {
  const now = Date.now();
  for (const [token, expiresAt] of sessions) {
    if (expiresAt <= now) sessions.delete(token);
  }
}

function sessionToken(request: IncomingMessage) {
  purgeExpiredSessions();
  const cookie = parseCookies(request).get("borg_remote");
  const bearer = String(request.headers.authorization ?? "").match(/^Bearer\s+(.+)$/i)?.[1];
  const token = cookie ?? bearer ?? "";
  return token && sessions.has(token) ? token : null;
}

function pairingAllowed(ip: string) {
  const now = Date.now();
  const current = attempts.get(ip);
  if (!current || current.resetAt <= now) {
    attempts.set(ip, { count: 0, resetAt: now + PAIR_WINDOW_MS });
    return true;
  }
  return current.count < MAX_PAIR_ATTEMPTS;
}

function notePairFailure(ip: string) {
  const now = Date.now();
  const current = attempts.get(ip);
  if (!current || current.resetAt <= now) {
    attempts.set(ip, { count: 1, resetAt: now + PAIR_WINDOW_MS });
    return;
  }
  current.count += 1;
}

function equalCode(candidate: string) {
  if (candidate.length !== pairingCode.length) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(pairingCode));
}

async function proxyJson(response: ServerResponse, path: string, init: RequestInit = {}) {
  try {
    const upstream = await fetch(`${gatewayUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(120_000),
    });
    const body = await upstream.text();
    response.writeHead(upstream.status, {
      ...securityHeaders(),
      "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(body);
  } catch (error) {
    sendJson(response, 502, { error: error instanceof Error ? error.message : "BORG desktop gateway is unavailable." });
  }
}

async function proxyStream(request: IncomingMessage, response: ServerResponse, path: string, body?: string) {
  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  response.once("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  try {
    const upstream = await fetch(`${gatewayUrl}${path}`, {
      method: request.method,
      headers: body === undefined ? undefined : { "content-type": request.headers["content-type"] ?? "application/json" },
      body,
      signal: controller.signal,
    });
    if (!upstream.body) {
      return sendJson(response, upstream.status, { error: await upstream.text().catch(() => "Upstream stream unavailable.") });
    }
    response.writeHead(upstream.status, {
      ...securityHeaders(),
      "content-type": upstream.headers.get("content-type") ?? "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    const reader = upstream.body.getReader();
    while (!controller.signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) response.write(value);
    }
  } catch (error) {
    if (!controller.signal.aborted && !response.headersSent) {
      sendJson(response, 502, { error: error instanceof Error ? error.message : "BORG stream unavailable." });
    }
  } finally {
    if (!response.writableEnded) response.end();
  }
}

const server = createServer((request, response) => {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://localhost:${remotePort}`);
  const pathname = url.pathname;

  if (method === "GET" && pathname === "/health") {
    return sendJson(response, 200, {
      status: "ok",
      remote: true,
      pairedSessions: sessions.size,
      gateway: gatewayUrl,
    });
  }

  if (method === "GET" && pathname === "/api/local-info") {
    if (!isLoopback(request.socket.remoteAddress)) return sendJson(response, 403, { error: "Local setup information is only available from this computer." });
    const addresses = localAddresses();
    return sendJson(response, 200, {
      pairingCode,
      port: remotePort,
      addresses,
      urls: addresses.map((address) => `http://${address}:${remotePort}`),
      installability: "LAN HTTP is supported for remote control. PWA installation requires a secure origin.",
    });
  }

  if (method === "POST" && pathname === "/api/pair") {
    const ip = requestIp(request);
    if (!pairingAllowed(ip)) return sendJson(response, 429, { error: "Too many pairing attempts. Try again in about a minute." });
    void readJson(request).then((input) => {
      const candidate = String(input.code ?? "").trim();
      if (!/^\d{6}$/.test(candidate) || !equalCode(candidate)) {
        notePairFailure(ip);
        return sendJson(response, 401, { error: "Pairing code is incorrect." });
      }
      attempts.delete(ip);
      const token = randomBytes(32).toString("base64url");
      sessions.set(token, Date.now() + SESSION_TTL_MS);
      return sendJson(response, 200, { paired: true }, {
        "set-cookie": `borg_remote=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
      });
    }).catch((error) => sendJson(response, 400, { error: error instanceof Error ? error.message : "Invalid pairing request." }));
    return;
  }

  if (method === "POST" && pathname === "/api/logout") {
    const token = sessionToken(request);
    if (token) sessions.delete(token);
    return sendJson(response, 200, { loggedOut: true }, {
      "set-cookie": "borg_remote=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
    });
  }

  if (pathname.startsWith("/api/remote/") && !sessionToken(request)) {
    return sendJson(response, 401, { error: "Pair this device with BORG first." });
  }

  if (method === "GET" && pathname === "/api/remote/status") {
    void Promise.all([
      fetch(`${gatewayUrl}/health`, { signal: AbortSignal.timeout(5_000) }).then((result) => result.json()),
      fetch(`${gatewayUrl}/api/sessions`, { signal: AbortSignal.timeout(5_000) }).then((result) => result.json()),
    ]).then(([health, sessionList]) => {
      sendJson(response, 200, { health, sessions: (sessionList as { sessions?: unknown[] }).sessions ?? [] });
    }).catch((error) => sendJson(response, 502, { error: error instanceof Error ? error.message : "BORG desktop gateway is unavailable." }));
    return;
  }

  if (method === "GET" && pathname === "/api/remote/sessions") {
    void proxyJson(response, "/api/sessions");
    return;
  }

  const remoteSessionRoute = pathname.match(/^\/api\/remote\/sessions\/([^/]+)$/);
  if (method === "GET" && remoteSessionRoute) {
    void proxyJson(response, `/api/sessions/${encodeURIComponent(decodeURIComponent(remoteSessionRoute[1]))}`);
    return;
  }

  const remoteStopRoute = pathname.match(/^\/api\/remote\/sessions\/([^/]+)\/stop$/);
  if (method === "POST" && remoteStopRoute) {
    void proxyJson(response, `/api/sessions/${encodeURIComponent(decodeURIComponent(remoteStopRoute[1]))}/stop`, { method: "POST" });
    return;
  }

  if (method === "POST" && pathname === "/api/remote/chat") {
    void readBody(request)
      .then((body) => proxyStream(request, response, "/api/chat", body))
      .catch((error) => sendJson(response, 400, { error: error instanceof Error ? error.message : "Invalid chat request." }));
    return;
  }

  const workflowRoute = pathname.match(/^\/api\/remote\/tasks\/([^/]+)\/workflow-status$/);
  if (method === "GET" && workflowRoute) {
    void proxyJson(response, `/api/tasks/${encodeURIComponent(decodeURIComponent(workflowRoute[1]))}/workflow-status`);
    return;
  }

  const debugRoute = pathname.match(/^\/api\/remote\/tasks\/([^/]+)\/debug$/);
  if (method === "GET" && debugRoute) {
    void proxyJson(response, `/api/control/tasks/${encodeURIComponent(decodeURIComponent(debugRoute[1]))}/snapshot`);
    return;
  }

  const approvalRoute = pathname.match(/^\/api\/remote\/tasks\/([^/]+)\/approval$/);
  if (method === "POST" && approvalRoute) {
    void readBody(request)
      .then((body) => proxyJson(response, `/api/tasks/${encodeURIComponent(decodeURIComponent(approvalRoute[1]))}/approval`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }))
      .catch((error) => sendJson(response, 400, { error: error instanceof Error ? error.message : "Invalid approval request." }));
    return;
  }

  const retryRoute = pathname.match(/^\/api\/remote\/tasks\/([^/]+)\/retry$/);
  if (method === "POST" && retryRoute) {
    void proxyStream(request, response, `/api/tasks/${encodeURIComponent(decodeURIComponent(retryRoute[1]))}/retry`, "");
    return;
  }

  if (method === "GET" && sendStatic(response, pathname)) return;

  sendJson(response, 404, { error: "Not found." });
});

server.listen(remotePort, "0.0.0.0", () => {
  const urls = localAddresses().map((address) => `http://${address}:${remotePort}`);
  console.log(`BORG LAN remote listening on port ${remotePort}.`);
  console.log(`Open http://127.0.0.1:${remotePort} on this computer to see the current pairing code.`);
  for (const url of urls) console.log(`Phone URL: ${url}`);
});

async function shutdown(signal: string) {
  console.log(`[lifecycle] remote gateway shutdown requested: ${signal}`);
  sessions.clear();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  process.exit(0);
}

process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
