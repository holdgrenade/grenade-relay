import { describe, expect, it } from "vitest";
import { sha256hex } from "../src/auth.js";
import { CLOSE_REPLACED, Hub, MAX_PIPES_PER_DAEMON, type Pipe } from "../src/hub.js";
import { silentLogger } from "../src/log.js";
import { DaemonStore } from "../src/store.js";

class FakeSocket implements Pipe {
  sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  send(text: string) { this.sent.push(text); }
  close(code: number, reason: string) { this.closed = { code, reason }; }
  frames() { return this.sent.map((s) => JSON.parse(s)); }
}

const ID = "r_0123456789abcdef0123456789abcdef";
const SECRET = "5".repeat(64);
const ACCESS = "phone-access-key";
const register = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "register", protocol: 1, id: ID, secret: SECRET, name: "MacBook Pro", version: "0.1.0", localIps: ["192.168.1.20"], access: [sha256hex(ACCESS)], ...over });

function setup(registrationKey?: string) {
  let t = Date.parse("2026-09-27T12:00:00.000Z");
  const hub = new Hub({ store: new DaemonStore(null), log: silentLogger, registrationKey, now: () => t });
  return { hub, advance: (ms: number) => (t += ms) };
}

function online(hub: Hub) {
  const sock = new FakeSocket();
  const link = hub.attachDaemon(sock, "203.0.113.7", null);
  hub.handleDaemonMessage(link, register());
  return { sock, link };
}

describe("Hub registration", () => {
  it("registers, answers with the public IP and shows online", () => {
    const { hub } = setup();
    const { sock } = online(hub);
    expect(sock.frames()).toEqual([{ type: "registered", publicIp: "203.0.113.7" }]);
    const p = hub.presence(ID, ACCESS);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ online: true, publicIp: "203.0.113.7", localIps: ["192.168.1.20"] });
  });

  it("refuses a first frame that is not register", () => {
    const { hub } = setup();
    const sock = new FakeSocket();
    hub.handleDaemonMessage(hub.attachDaemon(sock, undefined, null), JSON.stringify({ type: "update", name: "x" }));
    expect(sock.frames()[0]).toMatchObject({ type: "error", code: "bad_frame" });
    expect(sock.closed).not.toBeNull();
  });

  it("enforces the registration key", () => {
    const { hub } = setup("team-key");
    const bad = new FakeSocket();
    hub.handleDaemonMessage(hub.attachDaemon(bad, undefined, "wrong"), register());
    expect(bad.frames()[0]).toMatchObject({ type: "error", code: "unauthorized" });
    const good = new FakeSocket();
    hub.handleDaemonMessage(hub.attachDaemon(good, undefined, "team-key"), register());
    expect(good.frames()[0]).toMatchObject({ type: "registered" });
  });

  it("refuses a claimed id with another secret", () => {
    const { hub } = setup();
    online(hub);
    const thief = new FakeSocket();
    hub.handleDaemonMessage(hub.attachDaemon(thief, undefined, null), register({ secret: "6".repeat(64), name: "Thief" }));
    expect(thief.frames()[0]).toMatchObject({ type: "error", code: "id_taken" });
    expect(hub.presence(ID, ACCESS).body).toMatchObject({ name: "MacBook Pro", online: true });
  });

  it("a second link with the right secret replaces the first and closes its pipes", () => {
    const { hub } = setup();
    const first = online(hub);
    const phone = new FakeSocket();
    hub.attachPhone(ID, phone, undefined);
    const second = online(hub);
    expect(first.sock.closed?.code).toBe(CLOSE_REPLACED);
    expect(phone.closed?.code).toBe(4503);
    hub.handleDaemonClose(first.link); // the old socket's close event arrives later
    expect(hub.isRegistered(second.link)).toBe(true);
    expect(hub.presence(ID, ACCESS).body).toMatchObject({ online: true });
  });

  it("update replaces only the fields present", () => {
    const { hub } = setup();
    const { link } = online(hub);
    hub.handleDaemonMessage(link, JSON.stringify({ type: "update", localIps: ["10.0.0.8"] }));
    expect(hub.presence(ID, ACCESS).body).toMatchObject({ name: "MacBook Pro", localIps: ["10.0.0.8"] });
    hub.handleDaemonMessage(link, JSON.stringify({ type: "update", access: [] }));
    expect(hub.presence(ID, ACCESS).status).toBe(401);
  });
});

describe("Hub phone pipes", () => {
  it("admits by access key and daemon state", () => {
    const { hub } = setup();
    expect(hub.admitPhone(ID, ACCESS)).toBe("unknown");
    const { link } = online(hub);
    expect(hub.admitPhone(ID, "nope")).toBe("unauthorized");
    expect(hub.admitPhone(ID, null)).toBe("unauthorized");
    expect(hub.admitPhone(ID, ACCESS)).toBe("ok");
    for (let i = 0; i < MAX_PIPES_PER_DAEMON; i++) hub.attachPhone(ID, new FakeSocket(), undefined);
    expect(hub.admitPhone(ID, ACCESS)).toBe("busy");
    hub.handleDaemonClose(link);
    expect(hub.admitPhone(ID, ACCESS)).toBe("offline");
  });

  it("stops admitting a phone the Mac unpaired, and keeps admitting the others", () => {
    const { hub } = setup();
    const { link } = online(hub);
    hub.handleDaemonMessage(link, JSON.stringify({ type: "update", access: [sha256hex(ACCESS), sha256hex("second-phone")] }));
    expect(hub.admitPhone(ID, ACCESS)).toBe("ok");
    expect(hub.admitPhone(ID, "second-phone")).toBe("ok");
    hub.handleDaemonMessage(link, JSON.stringify({ type: "update", access: [sha256hex("second-phone")] }));
    expect(hub.admitPhone(ID, ACCESS)).toBe("unauthorized");
    expect(hub.presence(ID, ACCESS).status).toBe(401);
    expect(hub.admitPhone(ID, "second-phone")).toBe("ok");
    // Still refused while the Mac is off: the list is kept.
    hub.handleDaemonClose(link);
    expect(hub.admitPhone(ID, ACCESS)).toBe("unauthorized");
    expect(hub.admitPhone(ID, "second-phone")).toBe("offline");
  });

  it("routes open, data both ways, and close both ways", () => {
    const { hub } = setup();
    const { sock, link } = online(hub);
    const phone = new FakeSocket();
    const pipe = hub.attachPhone(ID, phone, "198.51.100.23")!;
    const pipe2 = hub.attachPhone(ID, new FakeSocket(), undefined)!;
    expect(pipe.conn).not.toBe(pipe2.conn);
    expect(sock.frames()[1]).toEqual({ type: "open", conn: pipe.conn, ip: "198.51.100.23" });

    hub.handlePhoneMessage(pipe, "sealed-1");
    expect(sock.frames().at(-1)).toEqual({ type: "data", conn: pipe.conn, text: "sealed-1" });
    hub.handleDaemonMessage(link, JSON.stringify({ type: "data", conn: pipe.conn, text: "sealed-2" }));
    expect(phone.sent).toEqual(["sealed-2"]);

    hub.handleDaemonMessage(link, JSON.stringify({ type: "close", conn: pipe.conn, code: 4401, reason: "unauthorized" }));
    expect(phone.closed).toEqual({ code: 4401, reason: "unauthorized" });
    hub.handlePhoneClose(pipe); // the phone socket's own close event: nothing more goes to the daemon
    expect(sock.frames().filter((f) => f.type === "close")).toHaveLength(0);

    hub.handlePhoneClose(pipe2);
    expect(sock.frames().at(-1)).toEqual({ type: "close", conn: pipe2.conn });
  });

  it("closes every pipe with 4503 when the daemon drops, and keeps presence for the phone", () => {
    const { hub, advance } = setup();
    const { link } = online(hub);
    const phone = new FakeSocket();
    hub.attachPhone(ID, phone, undefined);
    advance(60_000);
    hub.handleDaemonClose(link);
    expect(phone.closed?.code).toBe(4503);
    const p = hub.presence(ID, ACCESS);
    expect(p.body).toMatchObject({ online: false, lastSeen: "2026-09-27T12:01:00.000Z", publicIp: "203.0.113.7" });
    expect("since" in p.body).toBe(false);
  });
});
