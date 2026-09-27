/** Pure: which IP a request came from. Behind a trusted proxy (Caddy) that is the first X-Forwarded-For entry. */
export function clientIp(input: { remoteAddress: string | undefined; forwardedFor: string | string[] | undefined; trustProxy: boolean }): string | undefined {
  if (input.trustProxy) {
    const raw = Array.isArray(input.forwardedFor) ? input.forwardedFor[0] : input.forwardedFor;
    const first = raw?.split(",")[0]?.trim();
    if (first) return normalizeIp(first);
  }
  return input.remoteAddress ? normalizeIp(input.remoteAddress) : undefined;
}

/** `::ffff:203.0.113.7` → `203.0.113.7`; anything else unchanged. */
export function normalizeIp(ip: string): string {
  return ip.startsWith("::ffff:") && ip.includes(".") ? ip.slice(7) : ip;
}
