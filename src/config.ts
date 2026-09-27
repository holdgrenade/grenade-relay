/** Pure: turns the environment into the relay's settings. */
import { join } from "node:path";

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
  };
}
