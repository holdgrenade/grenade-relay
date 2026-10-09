// Pure parts of the push route: the provider token, the APNs message, the reply mapping, the limiter, the settings.
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readConfig } from "../src/config.js";
import { OFFICIAL_RELAY_URL, PushRequest } from "../src/frames.js";
import { ProviderTokens, TOKEN_LIFETIME_MS, apnsToken, readApnsKey } from "../src/push/apnsToken.js";
import { PushLimiter } from "../src/push/pushLimiter.js";
import { apnsBody, apnsMessage } from "../src/push/pushPayload.js";
import { isTokenRefused, refusal, replyForApns } from "../src/push/pushResult.js";
import { normalizeUpstreamUrl } from "../src/push/upstream.js";

const request = PushRequest.parse(JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "http.relay.push.request.json"), "utf8")));
const NOW = Date.parse("2026-09-29T12:00:00.000Z");

/** A key like the .p8 Apple issues: P-256, PKCS#8 PEM. */
function p8() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { pem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(), publicKey: createPublicKey(privateKey) };
}
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

describe("apnsToken", () => {
  it("is an ES256 JWT the key's public half verifies", () => {
    const { pem, publicKey } = p8();
    const token = apnsToken({ key: readApnsKey(pem), keyId: "ABC123DEFG", teamId: "TEAM123456" }, NOW);
    const [header, claims, signature] = token.split(".") as [string, string, string];
    expect(decode(header)).toEqual({ alg: "ES256", kid: "ABC123DEFG" });
    expect(decode(claims)).toEqual({ iss: "TEAM123456", iat: NOW / 1000 });
    const raw = Buffer.from(signature, "base64url");
    expect(raw).toHaveLength(64);
    expect(verify("sha256", Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, raw)).toBe(true);
  });

  it("reads a key pasted with literal \\n and refuses anything that is not a .p8", () => {
    const { pem } = p8();
    expect(readApnsKey(pem.trim().replace(/\n/g, "\\n")).asymmetricKeyType).toBe("ec");
    expect(() => readApnsKey("not a key")).toThrow(/\.p8/);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(() => readApnsKey(rsa)).toThrow(/EC key/);
  });

  it("reuses a token for 50 minutes, then makes a new one", () => {
    const tokens = new ProviderTokens({ key: readApnsKey(p8().pem), keyId: "K", teamId: "T" });
    const first = tokens.at(NOW);
    expect(tokens.at(NOW + TOKEN_LIFETIME_MS - 1)).toBe(first);
    const second = tokens.at(NOW + TOKEN_LIFETIME_MS);
    expect(second).not.toBe(first);
    expect(decode(second.split(".")[1] as string).iat).toBe((NOW + TOKEN_LIFETIME_MS) / 1000);
    tokens.reset();
    expect(tokens.at(NOW + TOKEN_LIFETIME_MS + 1000)).not.toBe(second);
  });
});

describe("apnsMessage", () => {
  it("sends the sealed content under a fallback alert", () => {
    expect(JSON.parse(apnsBody(request))).toEqual({
      aps: { alert: { title: "Grenade", body: "An agent is waiting for you" }, sound: "default", "mutable-content": 1 },
      g: { v: 1, e: request.e, c: request.c },
    });
    expect(Buffer.byteLength(apnsBody(request))).toBeLessThan(4096);
  });

  it("addresses the phone and sets the headers", () => {
    const m = apnsMessage(request, "jwt", NOW);
    expect(m.host).toBe("api.push.apple.com");
    expect(m.path).toBe(`/3/device/${request.deviceToken}`);
    expect(m.headers).toEqual({
      authorization: "bearer jwt",
      "apns-topic": "com.holdgrenade.grenade",
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-collapse-id": request.collapse,
      "apns-expiration": String(NOW / 1000 + 3600),
      "content-type": "application/json",
    });
    expect(apnsMessage({ ...request, environment: "sandbox" }, "jwt", NOW).host).toBe("api.sandbox.push.apple.com");
  });

  it("the largest sealed content still fits in 4 KB", () => {
    const big = { ...request, collapse: "c".repeat(64), c: "A".repeat(2800) };
    expect(PushRequest.safeParse(big).success).toBe(true);
    expect(Buffer.byteLength(apnsBody(big))).toBeLessThan(4096);
  });
});

describe("replyForApns", () => {
  it("maps what the push service answers", () => {
    expect(replyForApns({ status: 200 })).toEqual({ status: 200, body: { ok: true } });
    expect(replyForApns({ status: 410, reason: "Unregistered" })).toEqual({ status: 410, body: { error: "unregistered" } });
    expect(replyForApns({ status: 400, reason: "BadDeviceToken" })).toEqual({ status: 410, body: { error: "unregistered" } });
    for (const reason of ["DeviceTokenNotForTopic", "TopicDisallowed", "BadTopic"]) {
      expect(replyForApns({ status: 400, reason })).toEqual({ status: 403, body: { error: "topic_not_served" } });
    }
    expect(replyForApns({ status: 429, reason: "TooManyRequests" })).toEqual({ status: 429, body: { error: "rate_limited" }, headers: { "Retry-After": "60" } });
    expect(replyForApns({ status: 413, reason: "PayloadTooLarge" })).toEqual({ status: 413, body: { error: "too_large" } });
    for (const r of [{ status: 403, reason: "InvalidProviderToken" }, { status: 403, reason: "ExpiredProviderToken" }, { status: 400, reason: "BadCollapseId" }, { status: 500 }, { status: 503 }, { status: 0, reason: "timeout" }]) {
      expect(replyForApns(r)).toEqual({ status: 502, body: { error: "apns_failed" } });
    }
  });

  it("knows when the provider token was refused", () => {
    expect(isTokenRefused({ status: 403, reason: "ExpiredProviderToken" })).toBe(true);
    expect(isTokenRefused({ status: 403, reason: "InvalidProviderToken" })).toBe(true);
    expect(isTokenRefused({ status: 403, reason: "TopicDisallowed" })).toBe(false);
  });

  it("rounds Retry-After up to whole seconds, at least one", () => {
    expect(refusal("rate_limited", 0.2).headers).toEqual({ "Retry-After": "1" });
    expect(refusal("rate_limited", 12.1).headers).toEqual({ "Retry-After": "13" });
    expect(refusal("bad_request").headers).toBeUndefined();
  });
});

describe("PushLimiter", () => {
  it("lets 20 a minute through to one phone and says when the next may go", () => {
    const l = new PushLimiter();
    for (let i = 0; i < 20; i++) expect(l.take(`ip${i}`, "phone", NOW + i * 1000)).toBe(0);
    expect(l.take("other", "phone", NOW + 20_000)).toBe(40);
    expect(l.take("other", "phone", NOW + 59_999)).toBe(1);
    expect(l.take("other", "phone", NOW + 60_000)).toBe(0);
  });

  it("lets 60 a minute through from one sender", () => {
    const l = new PushLimiter();
    for (let i = 0; i < 60; i++) expect(l.take("1.2.3.4", `phone${i}`, NOW)).toBe(0);
    expect(l.take("1.2.3.4", "phone-new", NOW + 30_000)).toBe(30);
    expect(l.take("5.6.7.8", "phone-new", NOW + 30_000)).toBe(0);
  });

  it("a refused push counts against nobody", () => {
    const l = new PushLimiter({ perSender: 2, perToken: 1 });
    expect(l.take("ip", "a", NOW)).toBe(0);
    expect(l.take("ip", "a", NOW)).toBeGreaterThan(0); // the phone is over; the sender is not charged
    expect(l.take("ip", "b", NOW)).toBe(0);
    expect(l.take("ip", "c", NOW)).toBeGreaterThan(0);
  });

  it("works without a sender address", () => {
    const l = new PushLimiter({ perToken: 1 });
    expect(l.take(undefined, "a", NOW)).toBe(0);
    expect(l.take(undefined, "a", NOW)).toBe(60);
  });

  it("forgets windows that have ended", () => {
    const l = new PushLimiter({ sweepAbove: 10 });
    for (let i = 0; i < 10; i++) l.take(undefined, `phone${i}`, NOW);
    expect(l.size).toBe(11); // ten phones and the overall window
    l.take(undefined, "late", NOW + 61_000);
    expect(l.size).toBe(2);
  });
});

describe("push settings", () => {
  it("passes pushes to the main relay unless told otherwise", () => {
    expect(readConfig({}, "/").push).toEqual({ apns: null, upstream: OFFICIAL_RELAY_URL, upstreamKey: undefined });
    expect(readConfig({ GRENADE_RELAY_PUSH_UPSTREAM: "off" }, "/").push.upstream).toBeNull();
    expect(readConfig({ GRENADE_RELAY_PUSH_UPSTREAM: "relay.example.com/", GRENADE_RELAY_PUSH_UPSTREAM_KEY: "k" }, "/").push).toEqual({
      apns: null, upstream: "https://relay.example.com", upstreamKey: "k",
    });
    expect(() => readConfig({ GRENADE_RELAY_PUSH_UPSTREAM: "ftp://nope" }, "/")).toThrow(/relay URL/);
  });

  it("an own key sends by itself and passes nothing on", () => {
    const c = readConfig({ GRENADE_RELAY_APNS_KEY: "pem", GRENADE_RELAY_APNS_KEY_ID: "K", GRENADE_RELAY_APNS_TEAM_ID: "T", GRENADE_RELAY_PUSH_UPSTREAM: "https://up.example.com" }, "/");
    expect(c.push).toEqual({ apns: { key: "pem", keyId: "K", teamId: "T", topics: ["com.holdgrenade.grenade"] }, upstream: null, upstreamKey: undefined });
    const f = readConfig({ GRENADE_RELAY_APNS_KEY_FILE: "/run/secrets/apns.p8", GRENADE_RELAY_APNS_KEY_ID: "K", GRENADE_RELAY_APNS_TEAM_ID: "T", GRENADE_RELAY_APNS_TOPICS: "com.example.one, com.example.two" }, "/");
    expect(f.push.apns).toEqual({ keyFile: "/run/secrets/apns.p8", keyId: "K", teamId: "T", topics: ["com.example.one", "com.example.two"] });
  });

  it("refuses half a key", () => {
    expect(() => readConfig({ GRENADE_RELAY_APNS_KEY: "pem" }, "/")).toThrow(/GRENADE_RELAY_APNS_KEY_ID/);
    expect(() => readConfig({ GRENADE_RELAY_APNS_KEY: "pem", GRENADE_RELAY_APNS_KEY_ID: "K" }, "/")).toThrow(/GRENADE_RELAY_APNS_TEAM_ID/);
    expect(() => readConfig({ GRENADE_RELAY_APNS_KEY_ID: "K", GRENADE_RELAY_APNS_TEAM_ID: "T" }, "/")).toThrow(/without a key/);
  });

  it("normalizes an upstream URL", () => {
    expect(normalizeUpstreamUrl("https://relay.example.com/")).toBe("https://relay.example.com");
    expect(normalizeUpstreamUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(() => normalizeUpstreamUrl("wss://relay.example.com")).toThrow();
  });
});
