export class LiquidationWindow {
  private events = new Map<string, Array<{ time: number; usd: number }>>();

  add(symbol: string, side: string, usd: number, now = Date.now()) {
    // Separate long and short cascades; discard each event after 30 seconds.
    for (const [key, events] of this.events) {
      const recent = events.filter(event => now - event.time < 30000);
      if (recent.length) this.events.set(key, recent);
      else this.events.delete(key);
    }
    const key = `${symbol}:${side}`;
    const recent = this.events.get(key) || [];
    if (Number.isFinite(usd) && usd > 0) recent.push({ time: now, usd });
    this.events.set(key, recent);
    return { totalUsd: recent.reduce((sum, event) => sum + event.usd, 0), count: recent.length };
  }
}
