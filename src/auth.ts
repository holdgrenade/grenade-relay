/** Pure credential helpers: hashing, constant-time compare, and reading Authorization headers. */
import { createHash, timingSafeEqual } from "node:crypto";

export function sha256hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Compares two strings without leaking where they differ. Different lengths are unequal. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** `Authorization: Bearer <token>` → token, else null. */
export function bearerToken(header: string | undefined): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return m?.[1] ?? null;
}

/** `Authorization: Basic base64(user:password)` → password, else null. The user name is ignored. */
export function basicPassword(header: string | undefined): string | null {
  const m = /^Basic\s+(\S+)\s*$/i.exec(header ?? "");
  if (!m?.[1]) return null;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon < 0 ? null : decoded.slice(colon + 1);
}

/** True when `presented` is the configured key. A relay without a key accepts anything. */
export function keyMatches(configured: string | undefined, presented: string | null): boolean {
  if (!configured) return true;
  return presented !== null && safeEqual(configured, presented);
}
