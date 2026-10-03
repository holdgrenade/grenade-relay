import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DaemonStore, FORGET_AFTER_MS, type DaemonRecord } from "../src/store.js";

const rec = (id: string, lastSeen: string): DaemonRecord => ({
  id, secretHash: "h", name: id, version: "0.1.0", access: [], localIps: [], lastSeen, createdAt: lastSeen,
});

describe("DaemonStore", () => {
  it("persists records with mode 0600 and loads them back", () => {
    const path = join(mkdtempSync(join(tmpdir(), "relay-store-")), "daemons.json");
    const s = new DaemonStore(path);
    s.put(rec("r_a", "2026-09-27T12:00:00.000Z"));
    s.flush();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toHaveLength(1);
    expect(new DaemonStore(path).get("r_a")?.name).toBe("r_a");
  });

  it("goes on from memory when a save fails, and says so once", () => {
    // The folder's parent is a file, so nothing can be written there.
    const errors: unknown[] = [];
    const s = new DaemonStore("/dev/null/data/daemons.json", (e) => errors.push(e));
    s.put(rec("r_a", "2026-09-27T12:00:00.000Z"));
    expect(() => s.flush()).not.toThrow();
    s.put(rec("r_b", "2026-09-27T12:00:00.000Z"));
    s.flush();
    expect(errors).toHaveLength(1);
    expect(s.all()).toHaveLength(2);
  });

  it("forgets records not seen for 90 days unless live", () => {
    const s = new DaemonStore(null);
    const now = Date.parse("2026-09-27T12:00:00.000Z");
    const old = new Date(now - FORGET_AFTER_MS - 1000).toISOString();
    s.put(rec("r_old", old));
    s.put(rec("r_live", old));
    s.put(rec("r_new", new Date(now).toISOString()));
    expect(s.forgetStale(now, (id) => id === "r_live")).toBe(1);
    expect(s.all().map((r) => r.id).sort()).toEqual(["r_live", "r_new"]);
  });
});
