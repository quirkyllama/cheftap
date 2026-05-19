// Simple sliding-window rate limiter used to keep us under per-minute Google
// Docs write quotas. Each acquire() resolves only when we're inside the budget.
export class RateLimiter {
  private times: number[] = [];
  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs: number,
    private readonly label = 'rate',
  ) {}

  async acquire(): Promise<void> {
    // Loop because between sleeps another caller may have used the freed slot.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const now = Date.now();
      this.times = this.times.filter((t) => t > now - this.windowMs);
      if (this.times.length < this.maxPerWindow) {
        this.times.push(now);
        return;
      }
      const oldest = this.times[0]!;
      const wait = Math.max(20, oldest + this.windowMs - now + 50);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
