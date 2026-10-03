/**
 * Pure: which IP a request came from. Each proxy you run appends the address it saw to X-Forwarded-For, so with
 * `trustedProxies` of them in front, the client is that many entries from the right. Entries further left are
 * whatever the client sent and are never believed. Anything that is not an IP address falls back to the socket.
 */
import { isIP } from "node:net";

export function clientIp(input: { remoteAddress: string | undefined; forwardedFor: string | string[] | undefined; trustedProxies: number }): string | undefined {
  if (input.trustedProxies > 0) {
    const raw = Array.isArray(input.forwardedFor) ? input.forwardedFor.join(",") : (input.forwardedFor ?? "");
    const entries = raw.split(",").map((e) => e.trim()).filter(Boolean);
    // Fewer entries than proxies: every one of them was written by a proxy, so the leftmost is the client.
    const seen = entries[Math.max(0, entries.length - input.trustedProxies)];
    if (seen && isIP(normalizeIp(seen))) return normalizeIp(seen);
  }
  return input.remoteAddress ? normalizeIp(input.remoteAddress) : undefined;
}

/** `::ffff:203.0.113.7` → `203.0.113.7`; anything else unchanged. */
export function normalizeIp(ip: string): string {
  return ip.startsWith("::ffff:") && ip.includes(".") ? ip.slice(7) : ip;
}
