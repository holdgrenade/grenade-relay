/**
 * Every daemon the relay has seen, kept in memory and saved to `<data>/daemons.json` (mode 0600).
 * Writes are debounced; `flush()` writes now. Records never hold a secret or an access key, only their SHA-256.
 * A save that fails (disk full, folder not writable) never throws: the relay goes on from memory, `onSaveError`
 * hears the first failure in a row, and the next change tries again.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface DaemonRecord {
  id: string;
  secretHash: string;
  name: string;
  version: string;
  /** SHA-256 hex of each paired phone's access key. */
  access: string[];
  localIps: string[];
  publicIp?: string;
  /** ISO time the link was last alive. */
  lastSeen: string;
  createdAt: string;
}

export const FORGET_AFTER_MS = 90 * 24 * 60 * 60 * 1000;
const SAVE_DELAY_MS = 1000;

export class DaemonStore {
  private readonly records = new Map<string, DaemonRecord>();
  private timer: NodeJS.Timeout | null = null;
  private saveFailing = false;

  /** `path` null keeps everything in memory (tests). */
  constructor(private readonly path: string | null, private readonly onSaveError: (error: unknown) => void = () => {}) {
    this.load();
  }

  get(id: string): DaemonRecord | undefined {
    return this.records.get(id);
  }

  all(): DaemonRecord[] {
    return [...this.records.values()];
  }

  put(record: DaemonRecord): void {
    this.records.set(record.id, record);
    this.scheduleSave();
  }

  /** Drops records not seen for 90 days, except ids in `live`. Returns how many went. */
  forgetStale(now: number, live: (id: string) => boolean): number {
    let n = 0;
    for (const r of this.records.values()) {
      if (!live(r.id) && now - Date.parse(r.lastSeen) > FORGET_AFTER_MS) {
        this.records.delete(r.id);
        n++;
      }
    }
    if (n) this.scheduleSave();
    return n;
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.all(), null, 2) + "\n", { mode: 0o600 });
      renameSync(tmp, this.path);
      this.saveFailing = false;
    } catch (e) {
      // This runs in a timer: an error thrown here would end the process.
      if (!this.saveFailing) this.onSaveError(e);
      this.saveFailing = true;
    }
  }

  private scheduleSave(): void {
    if (!this.path || this.timer) return;
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    this.timer.unref();
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      for (const r of JSON.parse(readFileSync(this.path, "utf8")) as DaemonRecord[]) this.records.set(r.id, r);
    } catch {
      /* corrupt file: start empty, the next save rewrites it */
    }
  }
}
