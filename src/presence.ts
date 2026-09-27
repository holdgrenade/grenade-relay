/** Pure: what the relay tells a phone (or an admin) about one daemon. */
import type { Presence } from "./frames.js";
import type { DaemonRecord } from "./store.js";

/** `onlineSince` is when the current link registered, or null while offline. */
export function presenceOf(record: DaemonRecord, onlineSince: number | null, now: number): Presence {
  const p: Presence = {
    id: record.id,
    name: record.name,
    version: record.version,
    online: onlineSince !== null,
    lastSeen: onlineSince !== null ? new Date(now).toISOString() : record.lastSeen,
    localIps: record.localIps,
  };
  if (onlineSince !== null) p.since = new Date(onlineSince).toISOString();
  if (record.publicIp) p.publicIp = record.publicIp;
  return p;
}

/** Online first, then most recently seen, then by name. */
export function byPresence(a: Presence, b: Presence): number {
  if (a.online !== b.online) return a.online ? -1 : 1;
  if (a.lastSeen !== b.lastSeen) return a.lastSeen < b.lastSeen ? 1 : -1;
  return a.name.localeCompare(b.name);
}
