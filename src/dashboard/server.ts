import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { childLogger } from "../logger.js";
import { dashboardBus, fmtClock, type TimelineEvent } from "./bus.js";
import type { DashboardState } from "./state.js";

const log = childLogger("dashboard-http");

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(HERE, "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

export interface HttpDeps {
  port: number;
  /** Called on every request so the host can refresh state before responding. */
  getState: () => Promise<DashboardState>;
  /** Buffer of recent timeline events served to new SSE clients. */
  replay: () => TimelineEvent[];
}

/**
 * Boot a dashboard HTTP server on `port`. Serves static assets from
 * `dashboard/public` and exposes `/api/state` (JSON snapshot) plus
 * `/api/timeline` (Server-Sent Events stream).
 */
export async function startHttpServer(deps: HttpDeps): Promise<{
  close: () => Promise<void>;
}> {
  const server = createServer(async (req, res) => {
    try {
      await route(req, res, deps);
    } catch (err) {
      log.warn({ err: String(err), url: req.url }, "request failed");
      send(res, 500, "text/plain", "internal error");
    }
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(deps.port, resolveListen);
  });
  log.info({ port: deps.port }, "dashboard http listening");
  return {
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
      }),
  };
}

async function route(req: IncomingMessage, res: ServerResponse, deps: HttpDeps): Promise<void> {
  const url = req.url ?? "/";
  if (url.startsWith("/api/state")) {
    const state = await deps.getState();
    send(res, 200, "application/json; charset=utf-8", JSON.stringify(state));
    return;
  }
  if (url.startsWith("/api/timeline")) {
    handleSse(res, deps);
    return;
  }
  if (url === "/" || url === "/index.html") {
    await serveStatic(res, join(PUBLIC_DIR, "index.html"));
    return;
  }
  // Anything else: treat as static file lookup.
  const safePath = join(PUBLIC_DIR, url.replace(/\.\./g, ""));
  if (!safePath.startsWith(PUBLIC_DIR)) {
    send(res, 403, "text/plain", "forbidden");
    return;
  }
  try {
    const st = await stat(safePath);
    if (st.isFile()) await serveStatic(res, safePath);
    else send(res, 404, "text/plain", "not found");
  } catch {
    send(res, 404, "text/plain", "not found");
  }
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

async function serveStatic(res: ServerResponse, path: string): Promise<void> {
  const buf = await readFile(path);
  send(res, 200, MIME[extname(path)] ?? "application/octet-stream", buf);
}

function handleSse(res: ServerResponse, deps: HttpDeps): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": dashboard stream\n\n");

  // Replay recent events so a freshly opened browser gets immediate context.
  for (const ev of deps.replay()) {
    res.write(`event: ${ev.kind}\ndata: ${JSON.stringify(ev)}\n\n`);
  }
  res.write(`event: hello\ndata: ${JSON.stringify({ ts: fmtClock(new Date().toISOString()) })}\n\n`);

  const unsub = dashboardBus.on((ev) => {
    res.write(`event: ${ev.kind}\ndata: ${JSON.stringify(ev)}\n\n`);
  });

  // Heartbeat every 15s to keep proxies from closing the connection.
  const beat = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 15000);

  reqOnClose(res, () => {
    clearInterval(beat);
    unsub();
  });
}

function reqOnClose(res: ServerResponse, cb: () => void): void {
  res.on("close", cb);
}