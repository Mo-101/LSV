import type { RuntimeConfig } from './runtimeConfig';
export interface Candidate { symbol: string; liquidationUsd: number; detectedAt: number; floor: number; }
interface Dependencies {
  config: () => RuntimeConfig;
  status: () => { connected: boolean; positions: Array<{ symbol: string; managed?: boolean }>; reconciliation?: unknown[] };
  submit: (candidate: Candidate) => Promise<unknown>;
  now?: () => number;
}
export class AutomaticBatches {
  private candidates = new Map<string, Candidate>();
  private busy = false;
  private now: () => number;
  private batch = 0;
  private message = 'Waiting for automatic demo mode';
  private lastErrors: string[] = [];
  constructor(private deps: Dependencies) { this.now = deps.now ?? Date.now; }
  offer(candidate: Candidate) {
    if (!Number.isFinite(candidate.liquidationUsd) || candidate.liquidationUsd <= 0) return;
    if (!Number.isFinite(candidate.floor) || candidate.floor <= 0) return;
    this.candidates.set(candidate.symbol, candidate);
  }
  private ranked() {
    const config = this.deps.config();
    for (const [symbol, candidate] of this.candidates) {
      if (this.now() - candidate.detectedAt > 30000 || candidate.liquidationUsd < config.minLiquidationUsd ||
        (config.allowedSymbols.length && !config.allowedSymbols.includes(symbol))) this.candidates.delete(symbol);
    }
    return [...this.candidates.values()].sort((a, b) => b.liquidationUsd - a.liquidationUsd || b.detectedAt - a.detectedAt);
  }
  status() { return { policy: 'PER_SLOT', ranking: 'Fresh qualifying liquidation volume, highest first; not a profitability prediction', batch: this.batch, busy: this.busy, message: this.message, candidates: this.ranked(), lastErrors: this.lastErrors }; }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const config = this.deps.config();
      this.ranked();
      if (config.mode !== 'LIVE' || !config.autoExecute || config.halted) { this.message = 'Automatic demo entries disabled'; return; }
      const status = this.deps.status();
      if (!status.connected) { this.message = 'Waiting for a fresh Binance snapshot'; return; }
      if (status.reconciliation?.length) { this.message = 'Waiting for execution reconciliation'; return; }
      const occupied = new Set(status.positions.map(p => p.symbol));
      const unmanaged = new Set(status.positions.filter(p => !p.managed).map(p => p.symbol));
      if (occupied.size >= config.maxActiveSlots) { this.message = 'All execution slots occupied; waiting for a free slot'; return; }
      const candidates = this.ranked();
      if (!candidates.length) { this.message = 'Waiting for fresh qualifying liquidation signals'; return; }
      let accepted = 0;
      this.lastErrors = [];
      for (const candidate of candidates) {
        const latest = this.deps.config();
        if (latest.mode !== 'LIVE' || latest.halted || !latest.autoExecute) break;
        if (this.now() - candidate.detectedAt > 30000) { this.candidates.delete(candidate.symbol); continue; }
        if (occupied.size >= latest.maxActiveSlots) break;
        if (occupied.has(candidate.symbol)) continue;
        this.candidates.delete(candidate.symbol);
        if (unmanaged.has(candidate.symbol)) { this.lastErrors.push(`${candidate.symbol}: unmanaged exchange exposure blocks this slot`); continue; }
        try {
          await this.deps.submit(candidate);
          accepted++; occupied.add(candidate.symbol);
        } catch (e) { this.lastErrors.push(`${candidate.symbol}: ${e instanceof Error ? e.message : String(e)}`); }
      }
      if (accepted) this.batch++;
      this.message = accepted ? `Batch ${this.batch}: ${accepted} demo entries accepted; waiting for exchange fills` : 'No candidate passed final execution checks';
    } finally { this.busy = false; }
  }
}
