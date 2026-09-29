import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256hex } from "../src/auth.js";
import { DaemonList, E2EHello, Presence, PushError, PushRequest, PushResponse, RelayDaemonFrame, RelayServerFrame } from "../src/frames.js";

// Copies of ../grenade-protocol/fixtures. Re-copy them when the protocol changes.
const dir = join(import.meta.dirname, "fixtures");
const read = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));

describe("protocol fixtures", () => {
  it("every relay.daemon fixture parses as a RelayDaemonFrame", () => {
    for (const f of readdirSync(dir).filter((n) => n.startsWith("relay.daemon."))) expect(RelayDaemonFrame.safeParse(read(f)).success, f).toBe(true);
  });

  it("every relay.server fixture parses as a RelayServerFrame", () => {
    for (const f of readdirSync(dir).filter((n) => n.startsWith("relay.server."))) expect(RelayServerFrame.safeParse(read(f)).success, f).toBe(true);
  });

  it("covers every relay frame type with a fixture", () => {
    const names = readdirSync(dir);
    for (const o of RelayDaemonFrame.options) expect(names).toContain(`relay.daemon.${o.shape.type.value}.json`);
    for (const o of RelayServerFrame.options) expect(names).toContain(`relay.server.${o.shape.type.value}.json`);
  });

  it("HTTP bodies and the handshake parse", () => {
    expect(Presence.safeParse(read("http.relay.presence.json")).success).toBe(true);
    expect(DaemonList.safeParse(read("http.relay.daemons.json")).success).toBe(true);
    expect(E2EHello.safeParse(read("e2e.hello.json")).success).toBe(true);
  });

  it("the push route's bodies parse", () => {
    expect(PushRequest.safeParse(read("http.relay.push.request.json")).success).toBe(true);
    expect(PushResponse.safeParse(read("http.relay.push.response.json")).success).toBe(true);
    expect(PushError.safeParse(read("http.relay.push.error.json")).success).toBe(true);
  });

  it("hashes an access key the way the daemon does", () => {
    const v = read("e2e.vectors.json");
    expect(sha256hex(v.access.access)).toBe(v.access.accessHash);
  });
});
