// The push route with a fake sender: every answer it can give, and what it must never log.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PushRequest } from "../src/frames.js";
import type { Fields, Logger } from "../src/log.js";
import type { ApnsSender } from "../src/push/apnsClient.js";
import { PushLimiter } from "../src/push/pushLimiter.js";
import type { ApnsResult, RouteReply } from "../src/push/pushResult.js";
import { MAX_PUSH_BODY_BYTES, handlePush, type PushRouteDeps, type PushRouteInput } from "../src/push/pushRoute.js";
import type { Upstream } from "../src/push/upstream.js";

const fixture = readFileSync(join(import.meta.dirname, "fixtures", "http.relay.push.request.json"), "utf8");
const request = JSON.parse(fixture) as PushRequest;
const NOW = Date.parse("2026-09-29T12:00:00.000Z");

function collectingLogger() {
  const lines: string[] = [];
  const write = (level: string) => (msg: string, fields?: Fields) => void lines.push(`${level} ${msg} ${JSON.stringify(fields ?? {})}`);
  const log: Logger = { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") };
  return { log, lines };
}

function fakeSender(result: ApnsResult = { status: 200 }) {
  const sent: PushRequest[] = [];
  const sender: ApnsSender = { send: async (r) => (sent.push(r), result) };
  return { sender, sent };
}

function fakeUpstream(reply: RouteReply = { status: 200, body: { ok: true } }) {
  const forwarded: string[] = [];
  const upstream: Upstream = { url: "https://up.example.com", forward: async (raw) => (forwarded.push(raw), reply) };
  return { upstream, forwarded };
}

function setup(over: Partial<PushRouteDeps> = {}) {
  const { log, lines } = collectingLogger();
  const deps: PushRouteDeps = { topics: ["com.adamchew.grenade"], apns: null, upstream: null, limiter: new PushLimiter(), log, now: () => NOW, ...over };
  const post = (input: Partial<PushRouteInput> = {}) => handlePush({ authorization: null, hops: false, ip: "203.0.113.7", rawBody: fixture, ...input }, deps);
  return { post, lines };
}

describe("push route", () => {
  it("sends a push and answers 200", async () => {
    const { sender, sent } = fakeSender();
    const { post } = setup({ apns: sender });
    expect(await post()).toEqual({ status: 200, body: { ok: true } });
    expect(sent).toEqual([request]);
  });

  it("answers 401 without the registration key, before it reads anything", async () => {
    const { sender, sent } = fakeSender();
    const { post } = setup({ apns: sender, registrationKey: "team-key" });
    expect(await post({ rawBody: "not even json" })).toEqual({ status: 401, body: { error: "unauthorized" } });
    expect(await post({ authorization: "wrong" })).toEqual({ status: 401, body: { error: "unauthorized" } });
    expect((await post({ authorization: "team-key" })).status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("answers 400 to a body that is not a push", async () => {
    const { post } = setup({ apns: fakeSender().sender });
    for (const rawBody of ["", "nope", "{}", JSON.stringify({ ...request, deviceToken: "<9f3c 9f3c>" }), JSON.stringify({ ...request, c: "not base64!" }), JSON.stringify({ ...request, provider: "fcm" })]) {
      expect(await post({ rawBody }), rawBody).toEqual({ status: 400, body: { error: "bad_request" } });
    }
  });

  it("answers 413 to a body over 8 KB", async () => {
    const { post } = setup({ apns: fakeSender().sender });
    expect(await post({ rawBody: fixture + " ".repeat(MAX_PUSH_BODY_BYTES) })).toEqual({ status: 413, body: { error: "too_large" } });
  });

  it("answers 403 for an app its key does not send for", async () => {
    const { sender, sent } = fakeSender();
    const { post } = setup({ apns: sender });
    expect(await post({ rawBody: JSON.stringify({ ...request, topic: "com.example.other" }) })).toEqual({ status: 403, body: { error: "topic_not_served" } });
    expect(sent).toHaveLength(0);
  });

  it("answers 403 when the push service says the token belongs to another app", async () => {
    const { post } = setup({ apns: fakeSender({ status: 400, reason: "DeviceTokenNotForTopic" }).sender });
    expect(await post()).toEqual({ status: 403, body: { error: "topic_not_served" } });
  });

  it("answers 410 for a dead device token", async () => {
    const { post } = setup({ apns: fakeSender({ status: 410, reason: "Unregistered" }).sender });
    expect(await post()).toEqual({ status: 410, body: { error: "unregistered" } });
  });

  it("answers 502 when the push service fails", async () => {
    const { post } = setup({ apns: fakeSender({ status: 0, reason: "timeout" }).sender });
    expect(await post()).toEqual({ status: 502, body: { error: "apns_failed" } });
  });

  it("answers 429 with Retry-After past 20 pushes a minute to one phone", async () => {
    const { sender, sent } = fakeSender();
    const { post } = setup({ apns: sender });
    for (let i = 0; i < 20; i++) expect((await post({ ip: `198.51.100.${i}` })).status).toBe(200);
    expect(await post()).toEqual({ status: 429, body: { error: "rate_limited" }, headers: { "Retry-After": "60" } });
    expect(sent).toHaveLength(20);
  });

  it("answers 503 without a key and without an upstream", async () => {
    const { post } = setup();
    expect(await post()).toEqual({ status: 503, body: { error: "push_unavailable" } });
  });

  it("passes the body on unchanged when it has no key, whatever the topic", async () => {
    const { upstream, forwarded } = fakeUpstream();
    const { post } = setup({ upstream, topics: [] });
    const other = JSON.stringify({ ...request, topic: "com.example.other" });
    expect(await post({ rawBody: other })).toEqual({ status: 200, body: { ok: true } });
    expect(forwarded).toEqual([other]);
  });

  it("answers what the upstream answered", async () => {
    const { post } = setup({ upstream: fakeUpstream({ status: 410, body: { error: "unregistered" } }).upstream });
    expect(await post()).toEqual({ status: 410, body: { error: "unregistered" } });
  });

  it("never passes on a push that was passed on already", async () => {
    const { upstream, forwarded } = fakeUpstream();
    const { post } = setup({ upstream });
    expect(await post({ hops: true })).toEqual({ status: 503, body: { error: "push_unavailable" } });
    expect(forwarded).toHaveLength(0);
  });

  it("sends a passed-on push when it holds the key", async () => {
    const { sender, sent } = fakeSender();
    const { post } = setup({ apns: sender, upstream: fakeUpstream().upstream });
    expect((await post({ hops: true })).status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("never logs a device token or the sealed content", async () => {
    const replies: Array<[Partial<PushRouteDeps>, Partial<PushRouteInput>]> = [
      [{ apns: fakeSender().sender }, {}],
      [{ apns: fakeSender({ status: 410, reason: "Unregistered" }).sender }, {}],
      [{ apns: fakeSender({ status: 0, reason: "timeout" }).sender }, {}],
      [{ apns: fakeSender().sender }, { rawBody: JSON.stringify({ ...request, topic: "com.example.other" }) }],
      [{ apns: fakeSender().sender, limiter: new PushLimiter({ perToken: 0 }) }, {}],
      [{ upstream: fakeUpstream().upstream }, {}],
      [{ upstream: fakeUpstream({ status: 502, body: { error: "apns_failed" } }).upstream }, {}],
      [{}, {}],
      [{ registrationKey: "k" }, {}],
      [{ apns: fakeSender().sender }, { rawBody: fixture.slice(0, 200) }],
    ];
    const all: string[] = [];
    for (const [deps, input] of replies) {
      const { post, lines } = setup(deps);
      await post(input);
      expect(lines.length, JSON.stringify(input)).toBeGreaterThan(0);
      all.push(...lines);
    }
    const text = all.join("\n");
    expect(text).not.toContain(request.deviceToken);
    expect(text).not.toContain(request.deviceToken.slice(0, 16));
    expect(text).not.toContain(request.c.slice(0, 16));
    expect(text).not.toContain(request.e);
    expect(text).toMatch(/"phone":"[0-9a-f]{8}"/);
  });
});
