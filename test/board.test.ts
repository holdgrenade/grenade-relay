// Board pushes (PROTOCOL.md "Board push route"): the APNs message from the shared fixture, strict validation, and the
// route sending, limiting and passing them upstream like sealed pushes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BoardPushRequest, parsePushRouteRequest, type PushRequest, type PushRouteRequest } from "../src/frames.js";
import type { Fields, Logger } from "../src/log.js";
import type { ApnsSender } from "../src/push/apnsClient.js";
import { boardApnsMessage, boardHeaders, boardPayload } from "../src/push/boardPayload.js";
import { PushLimiter } from "../src/push/pushLimiter.js";
import { handlePush, type PushRouteDeps, type PushRouteInput } from "../src/push/pushRoute.js";
import type { Upstream } from "../src/push/upstream.js";

const dir = join(import.meta.dirname, "fixtures");
const examples = JSON.parse(readFileSync(join(dir, "board.examples.json"), "utf8"));
const raw = readFileSync(join(dir, "http.relay.push.board.request.json"), "utf8");
const board = BoardPushRequest.parse(JSON.parse(raw));
const sealedRaw = readFileSync(join(dir, "http.relay.push.request.json"), "utf8");
const sealed = JSON.parse(sealedRaw) as PushRequest;

describe("board fixtures", () => {
  it("the request body is the example's request", () => {
    expect(board).toEqual(examples.request);
    expect(examples.request.state).toEqual(examples.state);
  });
});

describe("board APNs message", () => {
  const cases: Array<[string, BoardPushRequest]> = [
    ["alert", board],
    ["update", { ...board, alert: false }],
    ["end", { ...board, event: "end", alert: false }],
  ];
  for (const [name, request] of cases) {
    it(`reproduces the fixture's ${name}`, () => {
      const want = examples.apns[name];
      expect(boardHeaders(request)).toEqual(want.headers);
      expect(boardPayload(request)).toEqual(want.payload);
      // Same bytes as the fixture, key order included.
      expect(JSON.stringify(boardPayload(request))).toBe(JSON.stringify(want.payload));
    });
  }

  it("an end ignores alert", () => {
    expect(boardPayload({ ...board, event: "end", alert: true })).toEqual(examples.apns.end.payload);
  });

  it("addresses the activity's push token with the provider token", () => {
    const m = boardApnsMessage(board, "jwt");
    expect(m.host).toBe("api.push.apple.com");
    expect(m.path).toBe(`/3/device/${board.pushToken}`);
    expect(m.headers).toEqual({ authorization: "bearer jwt", ...examples.apns.alert.headers, "content-type": "application/json" });
    expect(m.headers).not.toHaveProperty("apns-collapse-id");
    expect(JSON.parse(m.body)).toEqual(examples.apns.alert.payload);
    expect(boardApnsMessage({ ...board, environment: "sandbox" }, "jwt").host).toBe("api.sandbox.push.apple.com");
  });
});

describe("board validation", () => {
  const entry = board.state.sessions[0]!;
  const withEntry = (e: Record<string, unknown>) => ({ ...board, state: { ...board.state, sessions: [e] } });
  const bad: Array<[string, unknown]> = [
    ["a text field at the top", { ...board, title: "Fix the login bug" }],
    ["a text field in the state", { ...board, state: { ...board.state, name: "MacBook" } }],
    ["a text field in an entry", withEntry({ ...entry, title: "Fix the login bug" })],
    ["a status it does not know", withEntry({ ...entry, s: "waiting" })],
    ["a key that is too short", withEntry({ ...entry, k: "476c55c1" })],
    ["a key that is not hex", withEntry({ ...entry, k: "476c55c1bbe6d75z" })],
    ["a key in capitals", withEntry({ ...entry, k: "476C55C1BBE6D750" })],
    ["a session id for a key", withEntry({ ...entry, k: "gr-grenade-cli" })],
    ["a time that is not whole seconds", withEntry({ ...entry, t: 1791020412.5 })],
    ["an ISO time", withEntry({ ...entry, t: "2026-10-03T09:40:12.000Z" })],
    ["an `at` that is not an integer", { ...board, at: 1791020414.2 }],
    ["an event it does not know", { ...board, event: "start" }],
    ["another version", { ...board, state: { ...board.state, v: 2 } }],
    ["more than 12 sessions", { ...board, state: { v: 1, sessions: Array.from({ length: 13 }, () => entry) } }],
    ["no push token", { ...board, pushToken: undefined }],
    ["another kind", { ...board, kind: "banner" }],
    ["a sealed push with a kind", { ...sealed, kind: "board" }],
  ];
  for (const [name, body] of bad) {
    it(`refuses ${name}`, () => expect(parsePushRouteRequest(JSON.parse(JSON.stringify(body)))).toBeNull());
  }

  it("still reads a sealed push", () => {
    expect(parsePushRouteRequest(sealed)).toEqual(sealed);
  });
});

// ---- the route --------------------------------------------------------------

function collectingLogger() {
  const lines: string[] = [];
  const write = (level: string) => (msg: string, fields?: Fields) => void lines.push(`${level} ${msg} ${JSON.stringify(fields ?? {})}`);
  const log: Logger = { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") };
  return { log, lines };
}

function setup(over: Partial<PushRouteDeps> = {}) {
  const { log, lines } = collectingLogger();
  const sent: PushRouteRequest[] = [];
  const forwarded: string[] = [];
  const apns: ApnsSender = { send: async (r) => (sent.push(r), { status: 200 }) };
  const upstream: Upstream = { url: "https://up.example.com", forward: async (body) => (forwarded.push(body), { status: 200, body: { ok: true } }) };
  const deps: PushRouteDeps = { topics: ["com.holdgrenade.grenade"], apns, upstream: null, limiter: new PushLimiter(), log, now: () => 1791020414000, ...over };
  if (over.upstream === undefined && over.apns === null) deps.upstream = upstream;
  const post = (input: Partial<PushRouteInput> = {}) => handlePush({ authorization: null, hops: false, ip: "203.0.113.7", rawBody: raw, ...input }, deps);
  return { post, sent, forwarded, lines };
}

describe("board push route", () => {
  it("sends a board push with the key", async () => {
    const { post, sent } = setup();
    expect(await post()).toEqual({ status: 200, body: { ok: true } });
    expect(sent).toEqual([board]);
  });

  it("answers 400 to a board push with anything extra", async () => {
    const { post, sent } = setup();
    expect(await post({ rawBody: JSON.stringify({ ...board, title: "secret" }) })).toEqual({ status: 400, body: { error: "bad_request" } });
    expect(sent).toHaveLength(0);
  });

  it("checks the topic when it holds the key", async () => {
    const { post } = setup();
    expect(await post({ rawBody: JSON.stringify({ ...board, topic: "com.example.other" }) })).toEqual({ status: 403, body: { error: "topic_not_served" } });
  });

  it("answers 410 for a dead push token", async () => {
    const { post } = setup({ apns: { send: async () => ({ status: 410, reason: "Unregistered" }) } });
    expect(await post()).toEqual({ status: 410, body: { error: "unregistered" } });
  });

  it("passes the body on unchanged without a key, once", async () => {
    const { post, forwarded } = setup({ apns: null });
    expect(await post()).toEqual({ status: 200, body: { ok: true } });
    expect(forwarded).toEqual([raw]);
    expect(await post({ hops: true })).toEqual({ status: 503, body: { error: "push_unavailable" } });
    expect(forwarded).toHaveLength(1);
  });

  it("counts toward the same per-sender limit as sealed pushes", async () => {
    const { post } = setup({ limiter: new PushLimiter({ perSender: 3 }) });
    expect((await post({ rawBody: sealedRaw })).status).toBe(200);
    expect((await post({ rawBody: sealedRaw })).status).toBe(200);
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(429);
    expect((await post({ rawBody: sealedRaw })).status).toBe(429);
  });

  it("limits pushes to one activity token to 20 a minute", async () => {
    const { post } = setup();
    for (let i = 0; i < 20; i++) expect((await post({ ip: `198.51.100.${i}` })).status).toBe(200);
    expect(await post()).toEqual({ status: 429, body: { error: "rate_limited" }, headers: { "Retry-After": "60" } });
  });

  it("never logs the push token", async () => {
    const all: string[] = [];
    for (const over of [{}, { apns: null }, { apns: { send: async () => ({ status: 410, reason: "Unregistered" }) } }, { limiter: new PushLimiter({ perToken: 0 }) }] as Partial<PushRouteDeps>[]) {
      const { post, lines } = setup(over);
      await post();
      all.push(...lines);
    }
    const text = all.join("\n");
    expect(text).not.toContain(board.pushToken.slice(0, 16));
    expect(text).toMatch(/"phone":"[0-9a-f]{8}"/);
  });
});
