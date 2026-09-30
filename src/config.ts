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
  /** When set, enables GET /v1/daemons and the dashboard. */
  adminKey: string | undefined;
  /** Take the client IP from X-Forwarded-For (only behind a proxy you run). */
  trustProxy: boolean;
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
    adminKey: env["GRENADE_RELAY_ADMIN_KEY"] || undefined,
    trustProxy: env["GRENADE_RELAY_TRUST_PROXY"] === "1" || env["GRENADE_RELAY_TRUST_PROXY"] === "true",
    push: readPushConfig(env),
  };
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
