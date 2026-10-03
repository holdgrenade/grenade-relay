// End to end over real sockets: a fake daemon and a fake phone talk through a relay on port 0.
import { mkdtempSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { sha256hex } from "../src/auth.js";
import { silentLogger } from "../src/log.js";
import { startRelay, type RunningRelay } from "../src/server.js";

const ID = "r_0123456789abcdef0123456789abcdef";
const SECRET = "5".repeat(64);
const ACCESS = "phone-access-key";
const ADMIN = "admin-key";

let relay: RunningRelay | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await relay?.stop();
  relay = null;
});

async function start(opts: { registrationKey?: string; pingIntervalMs?: number; deadAfterMs?: number; trustedProxies?: number } = {}) {
  relay = await startRelay({
    port: 0, host: "127.0.0.1", dataFile: join(mkdtempSync(join(tmpdir(), "relay-")), "daemons.json"),
    adminKey: ADMIN, log: silentLogger, version: "test", ...opts,
  });
  return `127.0.0.1:${relay.port}`;
}

/** A WebSocket that records messages and its close, with helpers to wait for them. */
function open(url: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(url, { headers });
  sockets.push(ws);
  const messages: string[] = [];
  let closed: { code: number; reason: string } | null = null;
  const waiters: (() => void)[] = [];
  const wake = () => waiters.splice(0).forEach((w) => w());
  ws.on("message", (d) => { messages.push(d.toString()); wake(); });
  ws.on("close", (code, reason) => { closed = { code, reason: reason.toString() }; wake(); });
  ws.on("error", () => wake());
  const until = async <T>(check: () => T | undefined | null | false, what: string): Promise<T> => {
    const deadline = Date.now() + 3000;
    for (;;) {
      const v = check();
      if (v) return v;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 50); });
    }
  };
  return {
    ws,
    messages,
    frames: () => messages.map((m) => JSON.parse(m)),
    opened: () => new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); }),
    nextFrame: (i: number) => until(() => messages[i] !== undefined && JSON.parse(messages[i]!), `frame ${i}`),
    nextText: (i: number) => until(() => messages[i], `message ${i}`),
    closed: () => until(() => closed, "close"),
  };
}

/** The HTTP status a refused upgrade answered with. */
function upgradeStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    sockets.push(ws);
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("open", () => resolve(101));
    ws.on("error", () => {});
  });
}

async function daemonOnline(host: string, headers: Record<string, string> = {}) {
  const d = open(`ws://${host}/v1/daemon`, headers);
  await d.opened();
  d.ws.send(JSON.stringify({ type: "register", protocol: 1, id: ID, secret: SECRET, name: "MacBook Pro", version: "0.1.0", localIps: ["192.168.1.20"], access: [sha256hex(ACCESS)] }));
  return d;
}

const get = (host: string, path: string, headers: Record<string, string> = {}) => fetch(`http://${host}${path}`, { headers });

const UPGRADE_HEADERS = "Host: relay\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n";

/** Sends one request exactly as written and answers with the status line. With `reset`, hangs up at once instead. */
function raw(host: string, request: string, reset = false): Promise<string> {
  return new Promise((resolve) => {
    const [address, port] = host.split(":") as [string, string];
    let answer = "";
    const socket = connect(Number(port), address, () => {
      socket.write(request);
      if (reset) socket.resetAndDestroy();
    });
    socket.on("data", (d) => (answer += d.toString()));
    socket.on("error", () => {});
    socket.on("close", () => resolve(answer.split("\r\n")[0] ?? ""));
  });
}

describe("relay server", () => {
  it("serves health", async () => {
    const host = await start();
    expect(await (await get(host, "/health")).json()).toEqual({ ok: true, version: "test" });
  });

  it("pipes frames between a phone and its daemon, and tells the daemon when the phone leaves", async () => {
    const host = await start();
    const d = await daemonOnline(host);
    expect(await d.nextFrame(0)).toMatchObject({ type: "registered", publicIp: "127.0.0.1" });

    const phone = open(`ws://${host}/v1/connect/${ID}`, { Authorization: `Bearer ${ACCESS}` });
    await phone.opened();
    const opened = await d.nextFrame(1);
    expect(opened).toMatchObject({ type: "open", ip: "127.0.0.1" });

    phone.ws.send('{"e2e":1,"e":"abc"}');
    expect(await d.nextFrame(2)).toEqual({ type: "data", conn: opened.conn, text: '{"e2e":1,"e":"abc"}' });
    d.ws.send(JSON.stringify({ type: "data", conn: opened.conn, text: "sealed" }));
    expect(await phone.nextText(0)).toBe("sealed");

    phone.ws.close();
    expect(await d.nextFrame(3)).toEqual({ type: "close", conn: opened.conn });
  });

  it("closes the phone with the daemon's code", async () => {
    const host = await start();
    const d = await daemonOnline(host);
    await d.nextFrame(0);
    const phone = open(`ws://${host}/v1/connect/${ID}`, { Authorization: `Bearer ${ACCESS}` });
    await phone.opened();
    const { conn } = await d.nextFrame(1);
    d.ws.send(JSON.stringify({ type: "close", conn, code: 4401, reason: "unauthorized" }));
    expect(await phone.closed()).toEqual({ code: 4401, reason: "unauthorized" });
  });

  it("answers presence 200/401/404 and refuses upgrades 401/404/503", async () => {
    const host = await start();
    const auth = { Authorization: `Bearer ${ACCESS}` };
    expect((await get(host, `/v1/presence/${ID}`, auth)).status).toBe(404);
    expect(await upgradeStatus(`ws://${host}/v1/connect/${ID}`, auth)).toBe(404);

    const d = await daemonOnline(host);
    await d.nextFrame(0);
    const p = await get(host, `/v1/presence/${ID}`, auth);
    expect(p.status).toBe(200);
    expect(await p.json()).toMatchObject({ id: ID, online: true, localIps: ["192.168.1.20"] });
    expect((await get(host, `/v1/presence/${ID}`, { Authorization: "Bearer wrong" })).status).toBe(401);
    expect(await upgradeStatus(`ws://${host}/v1/connect/${ID}`, { Authorization: "Bearer wrong" })).toBe(401);
    expect(await upgradeStatus(`ws://${host}/v1/connect/r_nope`, auth)).toBe(404);

    d.ws.close();
    await d.closed();
    await new Promise((r) => setTimeout(r, 50));
    expect(await upgradeStatus(`ws://${host}/v1/connect/${ID}`, auth)).toBe(503);
    expect(await (await get(host, `/v1/presence/${ID}`, auth)).json()).toMatchObject({ online: false });
  });

  it("drops a silent daemon, closes its phones with 4503 and shows it offline", async () => {
    const host = await start({ pingIntervalMs: 40, deadAfterMs: 120 });
    const d = await daemonOnline(host);
    await d.nextFrame(0);
    const phone = open(`ws://${host}/v1/connect/${ID}`, { Authorization: `Bearer ${ACCESS}` });
    await phone.opened();
    await d.nextFrame(1);
    // Stop answering pings, as a sleeping Mac would. (ws answers pings automatically; pausing the socket stops that.)
    (d.ws as unknown as { _socket: { pause(): void } })._socket.pause();
    expect((await phone.closed()).code).toBe(4503);
    const p = await (await get(host, `/v1/presence/${ID}`, { Authorization: `Bearer ${ACCESS}` })).json();
    expect(p.online).toBe(false);
  });

  it("refuses a claimed id with another secret", async () => {
    const host = await start();
    await (await daemonOnline(host)).nextFrame(0);
    const thief = open(`ws://${host}/v1/daemon`);
    await thief.opened();
    thief.ws.send(JSON.stringify({ type: "register", protocol: 1, id: ID, secret: "6".repeat(64), name: "Thief", version: "0.1.0", localIps: [], access: [] }));
    expect(await thief.nextFrame(0)).toMatchObject({ type: "error", code: "id_taken" });
    await thief.closed();
  });

  it("enforces a registration key", async () => {
    const host = await start({ registrationKey: "team-key" });
    const bad = await daemonOnline(host);
    expect(await bad.nextFrame(0)).toMatchObject({ type: "error", code: "unauthorized" });
    await bad.closed();
    const good = await daemonOnline(host, { Authorization: "Bearer team-key" });
    expect(await good.nextFrame(0)).toMatchObject({ type: "registered" });
  });

  it("guards the admin list and dashboard", async () => {
    const host = await start();
    await (await daemonOnline(host)).nextFrame(0);
    expect((await get(host, "/v1/daemons")).status).toBe(401);
    const list = await (await get(host, "/v1/daemons", { Authorization: `Bearer ${ADMIN}` })).json();
    expect(list.daemons).toHaveLength(1);
    const noAuth = await get(host, "/");
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get("www-authenticate")).toContain("Basic");
    const page = await get(host, "/", { Authorization: "Basic " + Buffer.from(`admin:${ADMIN}`).toString("base64") });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(await page.text()).toContain("MacBook Pro");
  });

  it("answers 400 to a request target that is not a path, and keeps running", async () => {
    const host = await start();
    expect(await raw(host, `GET // HTTP/1.1\r\n${UPGRADE_HEADERS}`)).toBe("HTTP/1.1 400 Bad Request");
    expect(await raw(host, "GET // HTTP/1.1\r\nHost: relay\r\nConnection: close\r\n\r\n")).toBe("HTTP/1.1 400 Bad Request");
    expect((await get(host, "/health")).status).toBe(200);
  });

  it("survives clients that hang up while an upgrade is being refused", async () => {
    const host = await start();
    for (let i = 0; i < 40; i++) await raw(host, `GET /v1/connect/${ID} HTTP/1.1\r\n${UPGRADE_HEADERS}`, true);
    await new Promise((r) => setTimeout(r, 50));
    expect((await get(host, "/health")).status).toBe(200);
  });

  it("takes a Mac's address from its proxy, not from what the client claims", async () => {
    const host = await start({ trustedProxies: 1 });
    // A proxy appends the address it saw; the entry before it is the client's own claim.
    const d = await daemonOnline(host, { "X-Forwarded-For": "198.51.100.9, 203.0.113.7" });
    expect(await d.nextFrame(0)).toEqual({ type: "registered", publicIp: "203.0.113.7" });
  });

  it("hides the admin endpoints when no admin key is set", async () => {
    relay = await startRelay({ port: 0, host: "127.0.0.1", dataFile: null, log: silentLogger, version: "test" });
    const host = `127.0.0.1:${relay.port}`;
    expect((await get(host, "/")).status).toBe(404);
    expect((await get(host, "/v1/daemons", { Authorization: "Bearer x" })).status).toBe(404);
  });

  it("closes a link that does not register in time", async () => {
    relay = await startRelay({ port: 0, host: "127.0.0.1", dataFile: null, log: silentLogger, version: "test", registerTimeoutMs: 50 });
    const d = open(`ws://127.0.0.1:${relay.port}/v1/daemon`);
    await d.opened();
    expect((await d.closed()).code).toBe(4408);
  });
});
