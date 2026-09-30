import fs from 'node:fs';
import WebSocket from 'ws';
import { atomicWrite, ConfigStore } from './runtimeConfig';
export interface TapeTrade { a: number; T: number; p: string; q: string; m: boolean; }
export interface ShadowOrder {
  id: string; symbol: string; entryPrice: number; quantity: number; targetTp: number;
  createdAt: number; fillTime?: number; entryDeadline: number; holdMs: number;
  queueAheadUsd: number; consumedUsd: number; exitConsumedQty: number; lastTradeId?: number;
  state: 'ARMED' | 'FILLED' | 'TP' | 'TIME_STOP' | 'CANCELED' | 'INCOMPLETE';
  exitPrice?: number; grossPnlUsd?: number; reason?: string;
}
export function consumeTape(order: ShadowOrder, trade: TapeTrade) {
  if (!['ARMED', 'FILLED'].includes(order.state) || trade.T < order.createdAt || !Number.isFinite(trade.a) || trade.a <= (order.lastTradeId ?? -1)) return;
  const price = Number(trade.p), quantity = Number(trade.q);
  if (!(price > 0 && quantity > 0)) return;
  if (order.lastTradeId !== undefined && trade.a !== order.lastTradeId + 1) {
    order.state = 'INCOMPLETE'; order.reason = 'Aggregate trade sequence gap; excluded from performance.'; return;
  }
  order.lastTradeId = trade.a;
  if (order.state === 'ARMED') {
    if (trade.T >= order.entryDeadline) { order.state = 'CANCELED'; return; }
    // m=true: buyer is maker, so the aggressor is selling into bids.
    if (trade.m && price <= order.entryPrice) order.consumedUsd += price * quantity;
    if (order.consumedUsd >= order.queueAheadUsd + order.entryPrice * order.quantity) {
      order.state = 'FILLED'; order.fillTime = trade.T;
    }
  } else if (trade.T < order.fillTime! + order.holdMs && !trade.m && price >= order.targetTp) {
    order.exitConsumedQty += quantity;
    if (order.exitConsumedQty >= order.quantity) {
      order.state = 'TP'; order.exitPrice = order.targetTp;
      order.grossPnlUsd = (order.targetTp - order.entryPrice) * order.quantity;
    }
  }
}
export class ShadowExecution {
  orders: ShadowOrder[] = [];
  private feeds = new Map<string, WebSocket>();
  private busy = false;
  constructor(private config: ConfigStore, private file: string) {
    if (fs.existsSync(file)) this.orders = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const order of this.orders) if (['ARMED', 'FILLED'].includes(order.state)) {
      order.state = 'INCOMPLETE'; order.reason = 'Process restarted; tape continuity lost. Excluded from performance.';
    }
    this.save();
  }
  private save() { atomicWrite(this.file, this.orders); }
  status() { return { source: 'MAINNET_AGGTRADE_SHADOW', model: 'Estimated FIFO volume; no exchange fill or fee guarantee', orders: this.orders }; }
  arm(symbol: string, entryPrice: number, queueAtLevelUsd: number, automatic = false) {
    const c = this.config.get();
    if (c.mode !== 'PAPER' || c.halted || (automatic && !c.autoExecute)) throw new Error('Shadow entries disabled by backend config');
    if (c.allowedSymbols.length && !c.allowedSymbols.includes(symbol)) throw new Error('Symbol excluded by backend filter');
    const active = this.orders.filter(o => ['ARMED', 'FILLED'].includes(o.state));
    if (active.length >= c.maxActiveSlots || active.some(o => o.symbol === symbol)) throw new Error('Shadow slot unavailable');
    const ws = new WebSocket(`wss://fstream.binance.com/market/ws/${symbol.toLowerCase()}@aggTrade`);
    const order: ShadowOrder = { id: `shadow-${symbol}-${Date.now()}`, symbol, entryPrice,
      quantity: c.marginPerSlotUsd * c.leverage / entryPrice, targetTp: entryPrice * (1 + c.takeProfitPct),
      createdAt: Date.now(), entryDeadline: Date.now() + c.entryTimeoutSeconds * 1000, holdMs: c.holdSeconds * 1000,
      queueAheadUsd: Math.max(c.usdQueueHurdle, queueAtLevelUsd), consumedUsd: 0, exitConsumedQty: 0, state: 'ARMED' };
    this.orders.push(order); this.save(); this.feeds.set(order.id, ws);
    ws.on('message', raw => {
      try {
        const t = JSON.parse(raw.toString());
        if (t.e !== 'aggTrade') return;
        const previousState = order.state;
        consumeTape(order, t);
        if (order.state !== previousState) this.save();
        if (!['ARMED', 'FILLED'].includes(order.state)) ws.close();
      } catch { /* Invalid tape messages cannot fill orders. */ }
    });
    const interrupted = () => {
      if (['ARMED', 'FILLED'].includes(order.state)) {
        order.state = 'INCOMPLETE'; order.reason = 'Market feed disconnected; excluded from performance.'; this.save();
      }
      this.feeds.delete(order.id);
    };
    ws.on('close', interrupted); ws.on('error', () => { interrupted(); ws.terminate(); });
    return order;
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const o of this.orders.filter(o => ['ARMED', 'FILLED'].includes(o.state))) {
        const halted = this.config.get().halted;
        if (o.state === 'ARMED' && (halted || Date.now() >= o.entryDeadline)) o.state = 'CANCELED';
        if (o.state === 'FILLED' && (halted || Date.now() >= o.fillTime! + o.holdMs)) {
          try {
            const response = await fetch(`https://fapi.binance.com/fapi/v1/ticker/bookTicker?symbol=${o.symbol}`, { signal: AbortSignal.timeout(5000) });
            const book = await response.json();
            if (!response.ok || !(Number(book.bidPrice) > 0)) throw new Error('No executable bid');
            // Estimated market exit from observed bid; no manufactured bounce.
            if (o.state !== 'FILLED') continue;
            o.exitPrice = Number(book.bidPrice); o.grossPnlUsd = (o.exitPrice! - o.entryPrice) * o.quantity;
            o.state = 'TIME_STOP';
          } catch { o.state = 'INCOMPLETE'; o.reason = 'Exit quote unavailable; excluded from performance.'; }
        }
        if (!['ARMED', 'FILLED'].includes(o.state)) { this.save(); this.feeds.get(o.id)?.close(); }
      }
    } finally { this.busy = false; }
  }
}
