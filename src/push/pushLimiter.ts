/**
 * How many pushes a sender and a phone may get per minute (PROTOCOL.md "Push route": 60 per sender address,
 * 20 per device token), and how many the relay sends in all (1200): many addresses sending to made-up tokens would
 * otherwise reach Apple without bound, under the one key every phone's pushes depend on. Fixed windows that start
 * with a key's first push. No clock: the caller passes `now`.
 */
export interface LimiterOptions {
  perSender?: number;
  perToken?: number;
  /** Every push this relay sends or passes on, whoever sent it. */
  overall?: number;
  windowMs?: number;
  /** Expired windows are swept once this many keys are held. */
  sweepAbove?: number;
}

interface Window {
  startedAt: number;
  count: number;
}

export class PushLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly perSender: number;
  private readonly perToken: number;
  private readonly overall: number;
  private readonly windowMs: number;
  private readonly sweepAbove: number;

  constructor(o: LimiterOptions = {}) {
    this.perSender = o.perSender ?? 60;
    this.perToken = o.perToken ?? 20;
    this.overall = o.overall ?? 1200;
    this.windowMs = o.windowMs ?? 60_000;
    this.sweepAbove = o.sweepAbove ?? 10_000;
  }

  /**
   * Counts one push. Returns 0 when it may go, else the seconds until it may.
   * A refused push counts against nobody. `token` is any stable name for the phone (a hash of its device token).
   */
  take(sender: string | undefined, token: string, now: number): number {
    const keys: Array<[string, number]> = [[`t:${token}`, this.perToken], ["all", this.overall]];
    if (sender !== undefined) keys.push([`s:${sender}`, this.perSender]);
    let wait = 0;
    for (const [key, limit] of keys) {
      const w = this.live(key, now);
      if (w && w.count >= limit) wait = Math.max(wait, Math.ceil((w.startedAt + this.windowMs - now) / 1000));
    }
    if (wait > 0) return wait;
    for (const [key] of keys) {
      const w = this.live(key, now);
      if (w) w.count++;
      else this.windows.set(key, { startedAt: now, count: 1 });
    }
    if (this.windows.size > this.sweepAbove) this.sweep(now);
    return 0;
  }

  /** How many keys are held (for tests). */
  get size(): number {
    return this.windows.size;
  }

  /** Forgets every window that has ended. */
  sweep(now: number): void {
    for (const [key, w] of this.windows) if (now - w.startedAt >= this.windowMs) this.windows.delete(key);
  }

  private live(key: string, now: number): Window | undefined {
    const w = this.windows.get(key);
    if (!w) return undefined;
    if (now - w.startedAt >= this.windowMs || now < w.startedAt) {
      this.windows.delete(key);
      return undefined;
    }
    return w;
  }
}
