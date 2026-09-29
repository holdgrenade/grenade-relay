/**
 * HTTP + WebSocket front of the relay. Routes requests to the hub and keeps links alive with pings.
 *   GET /health · GET /v1/presence/<id> · GET /v1/daemons (admin) · GET / (dashboard, admin)
 *   POST /v1/push (one sealed push to a phone, see src/push/)
 *   WS /v1/daemon (daemon links) · WS /v1/connect/<id> (phone pipes)
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { basicPassword, bearerToken, keyMatches } from "./auth.js";
import { clientIp } from "./clientIp.js";
import { renderDashboard } from "./dashboard.js";
import { RELAY_CONNECT_PATH, RELAY_DAEMONS_PATH, RELAY_DAEMON_PATH, RELAY_PRESENCE_PATH, RELAY_PUSH_PATH, RelayId } from "./frames.js";
import { Hub, type Admission, type Pipe } from "./hub.js";
import type { Logger } from "./log.js";
import type { ApnsSender } from "./push/apnsClient.js";
import { PushLimiter } from "./push/pushLimiter.js";
import { MAX_PUSH_BODY_BYTES, handlePush } from "./push/pushRoute.js";
import { HOPS_HEADER, type Upstream } from "./push/upstream.js";
import { DaemonStore } from "./store.js";

export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
export const REGISTER_TIMEOUT_MS = 5000;

/** How `POST /v1/push` delivers. With neither `apns` nor `upstream` it answers 503. */
export interface PushOptions {
  /** Sends to Apple's push service; set when the relay holds a push key. */
  apns?: ApnsSender;
  /** Bundle ids the push key sends for. */
  topics?: string[];
  /** Where pushes are passed on to when there is no key. */
  upstream?: Upstream;
  limiter?: PushLimiter;
}

export interface RelayOptions {
  port: number;
  host: string;
  /** Where daemons.json lives; null keeps records in memory. */
  dataFile: string | null;
  registrationKey?: string | undefined;
  adminKey?: string | undefined;
  trustProxy?: boolean;
  push?: PushOptions;
  log: Logger;
  version: string;
  /** How often to ping every socket, and how long without a pong before it is dropped. */
  pingIntervalMs?: number;
  deadAfterMs?: number;
  registerTimeoutMs?: number;
  now?: () => number;
}

export interface RunningRelay {
  port: number;
  hub: Hub;
  stop(): Promise<void>;
}

const REFUSALS: Record<Exclude<Admission, "ok">, [number, string]> = {
  unauthorized: [401, "Unauthorized"],
  unknown: [404, "Not Found"],
  offline: [503, "Service Unavailable"],
  busy: [429, "Too Many Requests"],
};

export async function startRelay(o: RelayOptions): Promise<RunningRelay> {
  const now = o.now ?? Date.now;
  const store = new DaemonStore(o.dataFile);
  const hub = new Hub({ store, log: o.log, registrationKey: o.registrationKey, now });
  const ipOf = (req: IncomingMessage) =>
    clientIp({ remoteAddress: req.socket.remoteAddress, forwardedFor: req.headers["x-forwarded-for"], trustProxy: o.trustProxy ?? false });

  const http: Server = createServer((req, res) => {
    try {
      route(req, res);
    } catch (e) {
      o.log.error("HTTP request failed", { url: req.url, error: e });
      if (!res.headersSent) json(res, 500, { error: "internal" });
    }
  });

  const pushLimiter = o.push?.limiter ?? new PushLimiter();

  async function push(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const rawBody = await readCapped(req, MAX_PUSH_BODY_BYTES);
      const reply = await handlePush(
        { authorization: bearerToken(req.headers.authorization), hops: req.headers[HOPS_HEADER] !== undefined, ip: ipOf(req), rawBody },
        { registrationKey: o.registrationKey, topics: o.push?.topics ?? [], apns: o.push?.apns ?? null, upstream: o.push?.upstream ?? null, limiter: pushLimiter, log: o.log, now },
      );
      // A body that was cut off is still arriving: answer, then let the connection go.
      const cut = Buffer.byteLength(rawBody, "utf8") > MAX_PUSH_BODY_BYTES;
      json(res, reply.status, reply.body, cut ? { ...reply.headers, Connection: "close" } : reply.headers);
    } catch (e) {
      o.log.error("Push request failed", { error: e });
      if (!res.headersSent) json(res, 500, { error: "internal" });
    }
  }

  function route(req: IncomingMessage, res: ServerResponse): void {
    const path = new URL(req.url ?? "/", "http://relay").pathname;
    if (req.method === "POST" && path === RELAY_PUSH_PATH) return void push(req, res);
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method_not_allowed" });
    if (path === "/health") return json(res, 200, { ok: true, version: o.version });
    if (path.startsWith(RELAY_PRESENCE_PATH)) {
      const r = hub.presence(path.slice(RELAY_PRESENCE_PATH.length), bearerToken(req.headers.authorization));
      return json(res, r.status, r.body);
    }
    if (path === RELAY_DAEMONS_PATH) {
      if (!o.adminKey) return json(res, 404, { error: "not_found" });
      if (!keyMatches(o.adminKey, bearerToken(req.headers.authorization))) return json(res, 401, { error: "unauthorized" });
      return json(res, 200, { daemons: hub.list() });
    }
    if (path === "/") {
      if (!o.adminKey) return json(res, 404, { error: "not_found" });
      if (!keyMatches(o.adminKey, basicPassword(req.headers.authorization))) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Grenade relay", charset="UTF-8"', "Content-Type": "text/plain" });
        return void res.end("Sign in with any user name and the relay's admin key.\n");
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return void res.end(renderDashboard(hub.list(), now(), o.version));
    }
    json(res, 404, { error: "not_found" });
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const lastPong = new WeakMap<WebSocket, number>();

  http.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? "/", "http://relay").pathname;
    const ip = ipOf(req);
    if (path === RELAY_DAEMON_PATH) {
      return wss.handleUpgrade(req, socket, head, (ws) => acceptDaemon(ws, ip, bearerToken(req.headers.authorization)));
    }
    if (path.startsWith(RELAY_CONNECT_PATH)) {
      const id = path.slice(RELAY_CONNECT_PATH.length);
      const admission: Admission = RelayId.safeParse(id).success ? hub.admitPhone(id, bearerToken(req.headers.authorization)) : "unknown";
      if (admission !== "ok") return refuseUpgrade(socket, ...REFUSALS[admission]);
      return wss.handleUpgrade(req, socket, head, (ws) => acceptPhone(ws, id, ip));
    }
    refuseUpgrade(socket, 404, "Not Found");
  });

  function acceptDaemon(ws: WebSocket, ip: string | undefined, authorization: string | null): void {
    track(ws);
    const link = hub.attachDaemon(pipeOf(ws), ip, authorization);
    const timer = setTimeout(() => {
      if (!hub.isRegistered(link) && !link.closed) {
        ws.close(4408, "no register within 5s");
        hub.handleDaemonClose(link);
      }
    }, o.registerTimeoutMs ?? REGISTER_TIMEOUT_MS);
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      hub.handleDaemonMessage(link, data.toString());
    });
    ws.on("close", () => {
      clearTimeout(timer);
      hub.handleDaemonClose(link);
    });
    ws.on("error", (e) => o.log.debug("Mac link error", { error: e }));
  }

  function acceptPhone(ws: WebSocket, id: string, ip: string | undefined): void {
    track(ws);
    const pipe = hub.attachPhone(id, pipeOf(ws), ip);
    if (!pipe) return;
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      hub.handlePhoneMessage(pipe, data.toString());
    });
    ws.on("close", () => hub.handlePhoneClose(pipe));
    ws.on("error", (e) => o.log.debug("Phone pipe error", { error: e }));
  }

  function track(ws: WebSocket): void {
    lastPong.set(ws, now());
    ws.on("pong", () => lastPong.set(ws, now()));
  }

  // Every socket is pinged; one silent for `deadAfterMs` is terminated, which fires its close handler.
  // For a daemon that is how a sleeping or unplugged Mac goes offline.
  const deadAfter = o.deadAfterMs ?? 30_000;
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (now() - (lastPong.get(ws) ?? 0) > deadAfter) {
        ws.terminate();
        continue;
      }
      ws.ping();
    }
  }, o.pingIntervalMs ?? 15_000);
  heartbeat.unref();

  const gc = setInterval(() => {
    const n = store.forgetStale(now(), (id) => hub.isLive(id));
    if (n) o.log.info(`Forgot ${n} Mac${n === 1 ? "" : "s"} not seen for 90 days`);
  }, 60 * 60 * 1000);
  gc.unref();
  store.forgetStale(now(), () => false);

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(o.port, o.host, () => {
      http.off("error", reject);
      resolve();
    });
  });
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : o.port;

  return {
    port,
    hub,
    async stop() {
      clearInterval(heartbeat);
      clearInterval(gc);
      o.push?.apns?.close?.();
      hub.closeAll();
      for (const ws of wss.clients) ws.terminate();
      store.flush();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      });
    },
  };
}

function pipeOf(ws: WebSocket): Pipe {
  return {
    send: (text) => {
      if (ws.readyState === ws.OPEN) ws.send(text);
    },
    close: (code, reason) => {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, reason);
    },
  };
}

function refuseUpgrade(socket: Duplex, status: number, text: string): void {
  const body = JSON.stringify({ error: text.toLowerCase().replace(/ /g, "_") });
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

/** Reads a request body, but no more than a little past `max` bytes: the rest is left unread. */
function readCapped(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      chunks.push(chunk);
      size += chunk.length;
      if (size > max) {
        req.pause();
        finish();
      }
    });
    req.on("end", finish);
    req.on("error", (e) => (settled ? undefined : reject(e)));
  });
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text), "Cache-Control": "no-store", ...headers });
  res.end(text);
}
