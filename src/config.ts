/** Pure: turns the environment into the relay's settings. */
import { join } from "node:path";
import { OFFICIAL_RELAY_URL } from "./frames.js";
import { normalizeUpstreamUrl } from "./push/upstream.js";

export const DEFAULT_PUSH_TOPIC = "com.holdgrenade.grenade";

/** How this relay delivers pushes (PROTOCOL.md "Push route"). */
export interface PushConfig {
  /** Set when the relay holds a key for Apple's push service. The key is given as text or as a file to read. */
  apns: { key?: string; keyFile?: string; keyId: string; teamId: string; topics: string[] } | null;
  /** The relay pushes are passed on to when there is no key. Null: not passed on. */
  upstream: string | null;
  upstreamKey: string | undefined;
}

export interface RelayConfig {
  port: number;
  host: string;
  dataDir: string;
  /** When set, daemons must present it to register. Private and enterprise relays set it; the public relay does not. */
  registrationKey: string | undefined;
  /** How many Macs the relay keeps records of; a new one past it is told to try again later. */
  maxDaemons: number;
  /** When set, enables GET /v1/daemons and the dashboard. */
  adminKey: string | undefined;
  /** How many proxies you run in front of the relay (0: none). The client IP is read that many X-Forwarded-For entries from the right. */
  trustedProxies: number;
  push: PushConfig;
}

export function readConfig(env: Record<string, string | undefined>, cwd: string): RelayConfig {
  const port = Number(env["PORT"] ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT must be a port number, got "${env["PORT"]}"`);
  const dataDir = env["GRENADE_RELAY_DATA"] ?? "./data";
  return {
    port,
    host: env["HOST"] || "0.0.0.0",
    dataDir: dataDir.startsWith("/") ? dataDir : join(cwd, dataDir),
    registrationKey: env["GRENADE_RELAY_REGISTRATION_KEY"] || undefined,
    maxDaemons: readMaxDaemons(env["GRENADE_RELAY_MAX_MACS"]),
    adminKey: env["GRENADE_RELAY_ADMIN_KEY"] || undefined,
    trustedProxies: readTrustedProxies(env["GRENADE_RELAY_TRUST_PROXY"]),
    push: readPushConfig(env),
  };
}

/** Unset: 5000. Otherwise a whole number of at least 1. */
function readMaxDaemons(value: string | undefined): number {
  const v = (value ?? "").trim();
  if (v === "") return 5000;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`GRENADE_RELAY_MAX_MACS must be how many Macs the relay may keep (1 or more), got "${value}"`);
  return n;
}

/** Unset, `0` or `false`: none. `1` or `true`: one proxy. A larger number: that many, one behind the other. */
function readTrustedProxies(value: string | undefined): number {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "" || v === "false") return 0;
  if (v === "true") return 1;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 16) throw new Error(`GRENADE_RELAY_TRUST_PROXY must be the number of proxies in front of the relay (0 to 16), got "${value}"`);
  return n;
}

function readPushConfig(env: Record<string, string | undefined>): PushConfig {
  const key = env["GRENADE_RELAY_APNS_KEY"] || undefined;
  const keyFile = env["GRENADE_RELAY_APNS_KEY_FILE"] || undefined;
  const keyId = env["GRENADE_RELAY_APNS_KEY_ID"] || undefined;
  const teamId = env["GRENADE_RELAY_APNS_TEAM_ID"] || undefined;
  const upstreamKey = env["GRENADE_RELAY_PUSH_UPSTREAM_KEY"] || undefined;
  if (key || keyFile) {
    if (!keyId || !teamId) {
      throw new Error("an APNs key needs GRENADE_RELAY_APNS_KEY_ID (the key's id) and GRENADE_RELAY_APNS_TEAM_ID (the Apple team id)");
    }
    const topics = (env["GRENADE_RELAY_APNS_TOPICS"] || DEFAULT_PUSH_TOPIC).split(",").map((t) => t.trim()).filter(Boolean);
    // An own key always wins: this relay sends by itself and passes nothing on.
    return { apns: { ...(key ? { key } : { keyFile: keyFile as string }), keyId, teamId, topics }, upstream: null, upstreamKey };
  }
  if (keyId || teamId) {
    throw new Error("GRENADE_RELAY_APNS_KEY_ID and GRENADE_RELAY_APNS_TEAM_ID are set without a key: set GRENADE_RELAY_APNS_KEY or GRENADE_RELAY_APNS_KEY_FILE");
  }
  const upstream = env["GRENADE_RELAY_PUSH_UPSTREAM"]?.trim();
  if (upstream?.toLowerCase() === "off") return { apns: null, upstream: null, upstreamKey };
  return { apns: null, upstream: upstream ? normalizeUpstreamUrl(upstream) : OFFICIAL_RELAY_URL, upstreamKey };
}
