/**
 * How many new relay ids one address may register (30 an hour): an open relay keeps a record for every id, so a
 * flood of them would fill its memory and disk. A Mac the relay already knows is never counted, and a refused
 * registration counts against nobody. Fixed windows that start with an address's first new id. No clock: the caller
 * passes `now`.
 */
export interface RegistrationLimiterOptions {
  perAddress?: number;
  windowMs?: number;
  /** Ended windows are swept once this many addresses are held. */
  sweepAbove?: number;
}

export class RegistrationLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();
  private readonly perAddress: number;
  private readonly windowMs: number;
  private readonly sweepAbove: number;

  constructor(o: RegistrationLimiterOptions = {}) {
    this.perAddress = o.perAddress ?? 30;
    this.windowMs = o.windowMs ?? 60 * 60_000;
    this.sweepAbove = o.sweepAbove ?? 10_000;
  }

  /** Counts one new id from `address`. False when the address has had its share this window. */
  take(address: string, now: number): boolean {
    const w = this.windows.get(address);
    if (w && now - w.startedAt < this.windowMs && now >= w.startedAt) {
      if (w.count >= this.perAddress) return false;
      w.count++;
      return true;
    }
    this.windows.set(address, { startedAt: now, count: 1 });
    if (this.windows.size > this.sweepAbove) this.sweep(now);
    return true;
  }

  /** How many addresses are held (for tests). */
  get size(): number {
    return this.windows.size;
  }

  /** Forgets every window that has ended. */
  sweep(now: number): void {
    for (const [address, w] of this.windows) if (now - w.startedAt >= this.windowMs) this.windows.delete(address);
  }
}
