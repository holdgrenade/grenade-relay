// The push route over real sockets: one relay alone, two relays in a row, and the APNs client against a local
// HTTP/2 server. Nothing here talks to Apple or to the main relay.
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Http2Server, type IncomingHttpHeaders, type ServerHttp2Session } from "node:http2";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PushRequest, PushRouteRequest } from "../src/frames.js";
import { silentLogger } from "../src/log.js";
import { createApnsSender, type ApnsSender } from "../src/push/apnsClient.js";
import { PushLimiter } from "../src/push/pushLimiter.js";
import type { ApnsResult } from "../src/push/pushResult.js";
import { createUpstream, type Upstream } from "../src/push/upstream.js";
import { startRelay, type PushOptions, type RunningRelay } from "../src/server.js";

const fixture = readFileSync(join(import.meta.dirname, "fixtures", "http.relay.push.request.json"), "utf8");
const request = JSON.parse(fixture) as PushRequest;

const relays: RunningRelay[] = [];
const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const r of relays.splice(0)) await r.stop();
  for (const c of closers.splice(0)) await c();
});

async function relay(push: PushOptions | undefined, registrationKey?: string): Promise<string> {
  const r = await startRelay({ port: 0, host: "127.0.0.1", dataFile: null, log: silentLogger, version: "test", registrationKey, ...(push ? { push } : {}) });
  relays.push(r);
  return `http://127.0.0.1:${r.port}`;
}

function fakeSender(result: ApnsResult = { status: 200 }) {
  const sent: PushRouteRequest[] = [];
  const sender: ApnsSender = { send: async (r) => (sent.push(r), result) };
  return { sender, sent };
}

const post = (base: string, body: string = fixture, headers: Record<string, string> = {}) =>
  fetch(`${base}/v1/push`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

describe("POST /v1/push", () => {
  it("sends the push and answers 200", async () => {
    const { sender, sent } = fakeSender();
    const base = await relay({ apns: sender, topics: ["com.holdgrenade.grenade"] });
    const res = await post(base);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sent).toEqual([request]);
  });

  it("answers 503 on a relay that was given no way to push", async () => {
    const res = await post(await relay(undefined));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "push_unavailable" });
  });

  it("asks for the registration key on a relay that has one", async () => {
    const base = await relay({ apns: fakeSender().sender, topics: ["com.holdgrenade.grenade"] }, "team-key");
    expect((await post(base)).status).toBe(401);
    expect((await post(base, fixture, { authorization: "Bearer team-key" })).status).toBe(200);
  });

  it("answers 400, 413 and 429 with Retry-After", async () => {
    const base = await relay({ apns: fakeSender().sender, topics: ["com.holdgrenade.grenade"], limiter: new PushLimiter({ perToken: 1 }) });
    expect((await post(base, "{}")).status).toBe(400);
    const big = await post(base, JSON.stringify({ ...request, c: "A".repeat(9000) }));
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: "too_large" });
    expect((await post(base)).status).toBe(200);
    const limited = await post(base);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("keeps answering 405 to other posts and 404 to a GET", async () => {
    const base = await relay({ apns: fakeSender().sender, topics: ["com.holdgrenade.grenade"] });
    expect((await fetch(`${base}/v1/daemons`, { method: "POST", body: "{}" })).status).toBe(405);
    expect((await fetch(`${base}/health`, { method: "POST", body: "{}" })).status).toBe(405);
    expect((await fetch(`${base}/v1/push`)).status).toBe(404);
  });
});

describe("a relay without a push key", () => {
  it("passes the push to its upstream, which sends it", async () => {
    const { sender, sent } = fakeSender();
    const main = await relay({ apns: sender, topics: ["com.holdgrenade.grenade"] });
    const own = await relay({ upstream: createUpstream({ url: main }) });
    const res = await post(own);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sent).toEqual([request]);
  });

  it("hands back what the upstream answered", async () => {
    const main = await relay({ apns: fakeSender({ status: 410, reason: "Unregistered" }).sender, topics: ["com.holdgrenade.grenade"] });
    const own = await relay({ upstream: createUpstream({ url: main }) });
    const res = await post(own);
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "unregistered" });
  });

  it("brings the upstream's registration key", async () => {
    const { sender, sent } = fakeSender();
    const main = await relay({ apns: sender, topics: ["com.holdgrenade.grenade"] }, "main-key");
    expect((await post(await relay({ upstream: createUpstream({ url: main }) }))).status).toBe(401);
    expect((await post(await relay({ upstream: createUpstream({ url: main, key: "main-key" }) }))).status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("answers 502 when the upstream cannot be reached", async () => {
    const own = await relay({ upstream: createUpstream({ url: "http://127.0.0.1:9", timeoutMs: 500 }) });
    const res = await post(own);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "apns_failed" });
  });

  it("does not go round in circles when its upstream is itself", async () => {
    let self = "";
    let forwards = 0;
    const upstream: Upstream = { url: "self", forward: (raw) => (forwards++, createUpstream({ url: self }).forward(raw)) };
    self = await relay({ upstream });
    const res = await post(self);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "push_unavailable" });
    expect(forwards).toBe(1);
  });

  it("two relays that point at each other stop after one hop", async () => {
    let second = "";
    const first = await relay({ upstream: { url: "second", forward: (raw) => createUpstream({ url: second }).forward(raw) } });
    second = await relay({ upstream: createUpstream({ url: first }) });
    expect((await post(first)).status).toBe(503);
  });
});

/** A stand-in for Apple's push service: HTTP/2 without TLS on a local port. */
async function pushService(answer: (headers: IncomingHttpHeaders, body: string) => { status: number; body?: string } | "hang") {
  const seen: Array<{ headers: IncomingHttpHeaders; body: string }> = [];
  const sessions = new Set<ServerHttp2Session>();
  const server: Http2Server = createServer();
  server.on("session", (s) => {
    sessions.add(s);
    s.on("close", () => sessions.delete(s));
  });
  let opened = 0;
  server.on("session", () => opened++);
  server.on("stream", (stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (c: string) => (body += c));
    stream.on("error", () => {});
    stream.on("end", () => {
      seen.push({ headers, body });
      const a = answer(headers, body);
      if (a === "hang") return;
      stream.respond({ ":status": a.status });
      stream.end(a.body ?? "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () =>
    new Promise<void>((resolve) => {
      for (const s of sessions) s.destroy();
      server.close(() => resolve());
    });
  closers.push(close);
  return { origin, seen, sessionsOpened: () => opened, dropSessions: () => sessions.forEach((s) => s.destroy()), close };
}

function sender(origin: string, timeoutMs = 2000) {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const s = createApnsSender({ credentials: { key: privateKey, keyId: "KEY1234567", teamId: "TEAM123456" }, origin: () => origin, timeoutMs });
  closers.push(() => s.close?.());
  return s;
}

describe("APNs client", () => {
  it("posts the message over one HTTP/2 session and reads the answer", async () => {
    const apple = await pushService(() => ({ status: 200 }));
    const s = sender(apple.origin);
    expect(await s.send(request)).toEqual({ status: 200 });
    expect(await s.send(request)).toEqual({ status: 200 });
    expect(apple.sessionsOpened()).toBe(1);
    const first = apple.seen[0]!;
    expect(first.headers[":method"]).toBe("POST");
    expect(first.headers[":path"]).toBe(`/3/device/${request.deviceToken}`);
    expect(first.headers["apns-topic"]).toBe("com.holdgrenade.grenade");
    expect(first.headers["apns-push-type"]).toBe("alert");
    expect(first.headers["apns-collapse-id"]).toBe(request.collapse);
    expect(String(first.headers["authorization"])).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(apple.seen[1]!.headers["authorization"]).toBe(first.headers["authorization"]);
    expect(JSON.parse(first.body).g).toEqual({ v: 1, e: request.e, c: request.c });
  });

  it("sends a board push to the activity's token as a liveactivity push", async () => {
    const apple = await pushService(() => ({ status: 200 }));
    const examples = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "board.examples.json"), "utf8"));
    expect(await sender(apple.origin).send(examples.request)).toEqual({ status: 200 });
    const seen = apple.seen[0]!;
    expect(seen.headers[":path"]).toBe(`/3/device/${examples.request.pushToken}`);
    for (const [name, value] of Object.entries(examples.apns.alert.headers)) expect(seen.headers[name], name).toBe(value);
    expect(seen.headers["apns-collapse-id"]).toBeUndefined();
    expect(JSON.parse(seen.body)).toEqual(examples.apns.alert.payload);
  });

  it("reports the reason of a refusal", async () => {
    const apple = await pushService(() => ({ status: 410, body: '{"reason":"Unregistered","timestamp":1}' }));
    expect(await sender(apple.origin).send(request)).toEqual({ status: 410, reason: "Unregistered" });
  });

  it("makes a new provider token after one was refused", async () => {
    let n = 0;
    const apple = await pushService(() => (n++ === 0 ? { status: 403, body: '{"reason":"ExpiredProviderToken"}' } : { status: 200 }));
    const s = sender(apple.origin);
    expect(await s.send(request)).toEqual({ status: 403, reason: "ExpiredProviderToken" });
    await new Promise((r) => setTimeout(r, 1100)); // the next token's `iat` is a later second
    expect(await s.send(request)).toEqual({ status: 200 });
    expect(apple.seen[1]!.headers["authorization"]).not.toBe(apple.seen[0]!.headers["authorization"]);
  });

  it("opens a new session after the old one went away", async () => {
    const apple = await pushService(() => ({ status: 200 }));
    const s = sender(apple.origin);
    expect((await s.send(request)).status).toBe(200);
    apple.dropSessions();
    await new Promise((r) => setTimeout(r, 50));
    expect((await s.send(request)).status).toBe(200);
    expect(apple.sessionsOpened()).toBe(2);
  });

  it("gives up after the timeout", async () => {
    const apple = await pushService(() => "hang");
    expect(await sender(apple.origin, 100).send(request)).toEqual({ status: 0, reason: "timeout" });
  });

  it("answers status 0 when the service cannot be reached", async () => {
    const apple = await pushService(() => ({ status: 200 }));
    const s = sender(apple.origin, 500);
    await apple.close();
    const down = await s.send(request);
    expect(down.status).toBe(0);
    expect(down.reason).toBeTruthy();
  });
});
