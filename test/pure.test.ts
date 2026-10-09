import { describe, expect, it } from "vitest";
import { basicPassword, bearerToken, keyMatches, safeEqual } from "../src/auth.js";
import { clientIp, normalizeIp } from "../src/clientIp.js";
import { safeCloseCode, safeCloseReason } from "../src/closeCode.js";
import { readConfig } from "../src/config.js";
import { ago, escapeHtml, renderDashboard } from "../src/dashboard.js";
import { formatLine } from "../src/log.js";
import { byPresence, presenceOf } from "../src/presence.js";
import { pipeOf } from "../src/socketPipe.js";
import type { DaemonRecord } from "../src/store.js";

const record: DaemonRecord = {
  id: "r_0123456789abcdef0123456789abcdef",
  secretHash: "x",
  name: "MacBook Pro",
  version: "0.1.0",
  access: [],
  localIps: ["192.168.1.20"],
  publicIp: "203.0.113.7",
  lastSeen: "2026-09-27T10:00:00.000Z",
  createdAt: "2026-09-01T00:00:00.000Z",
};
const NOW = Date.parse("2026-09-27T12:00:00.000Z");

describe("auth", () => {
  it("reads bearer and basic credentials", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer  abc ")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
    expect(basicPassword("Basic " + Buffer.from("admin:s3:cret").toString("base64"))).toBe("s3:cret");
    expect(basicPassword("Basic " + Buffer.from("nocolon").toString("base64"))).toBeNull();
  });
  it("compares safely and treats a missing configured key as open", () => {
    expect(safeEqual("a", "a")).toBe(true);
    expect(safeEqual("a", "ab")).toBe(false);
    expect(keyMatches(undefined, null)).toBe(true);
    expect(keyMatches("k", null)).toBe(false);
    expect(keyMatches("k", "k")).toBe(true);
  });
});

describe("clientIp", () => {
  it("uses the socket unless a proxy is trusted", () => {
    expect(clientIp({ remoteAddress: "::ffff:10.0.0.2", forwardedFor: "203.0.113.7", trustedProxies: 0 })).toBe("10.0.0.2");
    expect(clientIp({ remoteAddress: "10.0.0.2", forwardedFor: "203.0.113.7", trustedProxies: 1 })).toBe("203.0.113.7");
    expect(clientIp({ remoteAddress: "10.0.0.2", forwardedFor: undefined, trustedProxies: 1 })).toBe("10.0.0.2");
    expect(normalizeIp("::1")).toBe("::1");
  });
  it("believes only what the trusted proxies wrote, never what the client sent", () => {
    // One proxy appends the address it saw: everything before it came from the client.
    expect(clientIp({ remoteAddress: "10.0.0.2", forwardedFor: "198.51.100.9, 203.0.113.7", trustedProxies: 1 })).toBe("203.0.113.7");
    expect(clientIp({ remoteAddress: "10.0.0.2", forwardedFor: ["198.51.100.9", "203.0.113.7"], trustedProxies: 1 })).toBe("203.0.113.7");
    // Two proxies: the client is two entries from the right.
    expect(clientIp({ remoteAddress: "10.0.0.2", forwardedFor: "198.51.100.9, 203.0.113.7, 192.0.2.1", trustedProxies: 2 })).toBe("203.0.113.7");
    expect(clientIp({ remoteAddress: "10.0.0.2", forwardedFor: "203.0.113.7", trustedProxies: 2 })).toBe("203.0.113.7");
    expect(clientIp({ remoteAddress: "10.0.0.2", forwardedFor: "::ffff:203.0.113.7", trustedProxies: 1 })).toBe("203.0.113.7");
    expect(clientIp({ remoteAddress: "10.0.0.2", forwardedFor: "2001:db8::7", trustedProxies: 1 })).toBe("2001:db8::7");
  });
  it("falls back to the socket for anything that is not an IP address", () => {
    expect(clientIp({ remoteAddress: "10.0.0.2", forwardedFor: "x".repeat(5000), trustedProxies: 1 })).toBe("10.0.0.2");
    expect(clientIp({ remoteAddress: "10.0.0.2", forwardedFor: "203.0.113.7:4242", trustedProxies: 1 })).toBe("10.0.0.2");
    expect(clientIp({ remoteAddress: "10.0.0.2", forwardedFor: " , ", trustedProxies: 1 })).toBe("10.0.0.2");
  });
});

describe("log", () => {
  it("keeps a line on one line whatever a name holds", () => {
    const line = formatLine("info", "Mac online: Studio\n2026-01-01T00:00:00.000Z ERROR forged\r\u2028x", { id: "r_1" }, new Date(0));
    expect(line).toBe("1970-01-01T00:00:00.000Z INFO  Mac online: Studio 2026-01-01T00:00:00.000Z ERROR forged x id=r_1");
    expect(formatLine("warn", "plain", { reason: "two\nlines" }, new Date(0))).not.toContain("\n");
    expect(formatLine("warn", "plain", { reason: "bell\u0007" }, new Date(0))).toContain('reason="bell\\u0007"');
  });
});

describe("socketPipe", () => {
  const fake = (bufferedAmount: number, readyState = 1) => {
    const calls: string[] = [];
    const ws = { readyState, OPEN: 1, CONNECTING: 0, bufferedAmount, send: (t: string) => void calls.push(`send ${t}`), close: (c: number) => void calls.push(`close ${c}`), terminate: () => void calls.push("terminate") };
    return { calls, pipe: pipeOf(ws, 100) };
  };
  it("sends while the peer keeps up and drops a peer that stopped reading", () => {
    const ok = fake(100);
    ok.pipe.send("a");
    expect(ok.calls).toEqual(["send a"]);
    const stalled = fake(101);
    stalled.pipe.send("a");
    expect(stalled.calls).toEqual(["terminate"]);
  });
  it("sends nothing to a socket that is not open", () => {
    const closing = fake(0, 2);
    closing.pipe.send("a");
    closing.pipe.close(1000, "");
    expect(closing.calls).toEqual([]);
  });
});

describe("closeCode", () => {
  it("keeps valid codes and replaces reserved ones", () => {
    expect(safeCloseCode(4401)).toBe(4401);
    expect(safeCloseCode(1006)).toBe(1000);
    expect(safeCloseCode(undefined)).toBe(1000);
    expect(Buffer.byteLength(safeCloseReason("é".repeat(100)))).toBeLessThanOrEqual(123);
  });
});

describe("config", () => {
  it("has defaults and reads keys", () => {
    const c = readConfig({}, "/srv");
    expect(c).toMatchObject({ port: 8787, host: "0.0.0.0", dataDir: "/srv/data", trustedProxies: 0 });
    expect(c.registrationKey).toBeUndefined();
    const d = readConfig({ PORT: "9000", GRENADE_RELAY_DATA: "/data", GRENADE_RELAY_ADMIN_KEY: "a", GRENADE_RELAY_REGISTRATION_KEY: "r", GRENADE_RELAY_TRUST_PROXY: "1" }, "/srv");
    expect(d).toMatchObject({ port: 9000, dataDir: "/data", adminKey: "a", registrationKey: "r", trustedProxies: 1 });
    expect(readConfig({ GRENADE_RELAY_TRUST_PROXY: "true" }, "/").trustedProxies).toBe(1);
    expect(readConfig({ GRENADE_RELAY_TRUST_PROXY: "2" }, "/").trustedProxies).toBe(2);
    expect(readConfig({ GRENADE_RELAY_TRUST_PROXY: "0" }, "/").trustedProxies).toBe(0);
    expect(() => readConfig({ GRENADE_RELAY_TRUST_PROXY: "yes" }, "/")).toThrow(/number of proxies/);
    expect(() => readConfig({ PORT: "nope" }, "/")).toThrow();
    expect(c.maxDaemons).toBe(5000);
    expect(readConfig({ GRENADE_RELAY_MAX_MACS: "200" }, "/").maxDaemons).toBe(200);
    expect(() => readConfig({ GRENADE_RELAY_MAX_MACS: "0" }, "/")).toThrow(/GRENADE_RELAY_MAX_MACS/);
  });
});

describe("presence", () => {
  it("reports offline with the stored lastSeen", () => {
    expect(presenceOf(record, null, NOW)).toEqual({
      id: record.id, name: "MacBook Pro", version: "0.1.0", online: false,
      lastSeen: "2026-09-27T10:00:00.000Z", publicIp: "203.0.113.7", localIps: ["192.168.1.20"],
    });
  });
  it("reports online with since and lastSeen = now", () => {
    const p = presenceOf(record, NOW - 60_000, NOW);
    expect(p.online).toBe(true);
    expect(p.since).toBe("2026-09-27T11:59:00.000Z");
    expect(p.lastSeen).toBe("2026-09-27T12:00:00.000Z");
  });
  it("sorts online first, then most recent", () => {
    const a = presenceOf({ ...record, name: "A" }, null, NOW);
    const b = presenceOf({ ...record, name: "B" }, NOW, NOW);
    const c = presenceOf({ ...record, name: "C", lastSeen: "2026-09-27T11:00:00.000Z" }, null, NOW);
    expect([a, b, c].sort(byPresence).map((p) => p.name)).toEqual(["B", "C", "A"]);
  });
});

describe("dashboard", () => {
  it("escapes names and shows status and IPs", () => {
    const html = renderDashboard([presenceOf({ ...record, name: "<b>evil</b>" }, null, NOW), presenceOf(record, NOW - 300_000, NOW)], NOW, "0.1.0");
    expect(html).toContain("&lt;b&gt;evil&lt;/b&gt;");
    expect(html).not.toContain("<b>evil</b>");
    expect(html).toContain("last seen 2 h ago");
    expect(html).toContain("for 5 min");
    expect(html).toContain("203.0.113.7");
    expect(html).toContain("1 of 2 Macs online");
    expect(html).toContain('http-equiv="refresh"');
  });
  it("says how to connect when empty", () => {
    expect(renderDashboard([], NOW, "0.1.0")).toContain("grenade relay on");
  });
  it("formats ages", () => {
    expect(ago(10_000)).toBe("just now");
    expect(ago(3 * 86_400_000)).toBe("3 d ago");
    expect(escapeHtml(`"'&`)).toBe("&quot;&#39;&amp;");
  });
});

describe("RegistrationLimiter", () => {
  it("lets an address register so many new ids an hour, then none until its window ends", async () => {
    const { RegistrationLimiter } = await import("../src/registrationLimiter.js");
    const l = new RegistrationLimiter({ perAddress: 2, windowMs: 1000 });
    expect(l.take("203.0.113.7", 0)).toBe(true);
    expect(l.take("203.0.113.7", 10)).toBe(true);
    expect(l.take("203.0.113.7", 20)).toBe(false);
    expect(l.take("198.51.100.1", 20)).toBe(true);
    expect(l.take("203.0.113.7", 1000)).toBe(true);
    l.sweep(5000);
    expect(l.size).toBe(0);
  });
});

describe("PushLimiter overall", () => {
  it("caps every push the relay sends in a minute, whoever sends it and to whichever phone", async () => {
    const { PushLimiter } = await import("../src/push/pushLimiter.js");
    const l = new PushLimiter({ overall: 3 });
    expect(l.take("203.0.113.1", "a", 0)).toBe(0);
    expect(l.take("203.0.113.2", "b", 0)).toBe(0);
    expect(l.take("203.0.113.3", "c", 0)).toBe(0);
    expect(l.take("203.0.113.4", "d", 1000)).toBe(59);
    expect(l.take("203.0.113.4", "d", 60_000)).toBe(0);
  });
});
