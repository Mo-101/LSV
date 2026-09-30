import fs from 'node:fs';
import crypto from 'node:crypto';
import { atomicWrite, ConfigStore } from './runtimeConfig';
import type { BinanceTestnetExecutor, ExchangeSnapshot, ExchangeOrder } from './binanceTestnetExecutor';

export interface ManagedTrade {
  symbol: string; clientId: string; entryOrderId?: number; entryPrice: number; quantity: number;
  marginUsd?: number; openedAt: number; fillTime?: number; entryDeadline: number; holdMs: number; targetTp: number;
  state: 'SUBMITTING' | 'ARMED' | 'FILLED' | 'CLOSING';
  tpClientId?: string; closeClientId?: string; lastError?: string; adopted?: boolean; adoptedClientIds?: string[]; takeProfitPct?: number;
}
type Exchange = Pick<BinanceTestnetExecutor, 'readExchangeState' | 'queryOrder' | 'ensureIsolatedMargin' | 'setLeverage' | 'placePostOnlyLimit' | 'placeMarketOrder' | 'cancelOrder'>;
const definitiveRejection = (result: any) => typeof result.raw?.code === 'number' && ![-1000, -1001, -1006, -1007].includes(result.raw.code);
const id = (kind: string) => `lsv-${kind}-${crypto.randomUUID().slice(0, 20)}`;

export function exchangeSlots(snapshot: ExchangeSnapshot, journal: Record<string, ManagedTrade>, now = Date.now()) {
  const rows: any[] = [];
  for (const p of snapshot.positions) {
    const managed = p.positionSide === 'BOTH' ? journal[p.symbol] : undefined;
    const amount = Number(p.positionAmt), price = Number(p.entryPrice), pnl = Number(p.unRealizedProfit);
    rows.push({ key: `${p.symbol}:${p.positionSide}`, symbol: p.symbol, side: amount > 0 ? 'BUY' : 'SELL',
      entryOrderId: managed?.entryOrderId ?? 0, entryPrice: price, quantity: Math.abs(amount),
      pnlUsd: pnl, pnlPct: price * Math.abs(amount) > 0 ? pnl / (price * Math.abs(amount)) * 100 : 0,
      filled: true, openedAt: managed?.openedAt ?? p.updateTime, holdSeconds: managed?.fillTime ? Math.max(0, Math.floor((now - managed.fillTime) / 1000)) : 0,
      managed: !!managed, state: managed?.state ?? 'UNMANAGED', lastError: managed?.lastError,
      targetTp: managed?.targetTp ?? null, tpOrderId: null,
    });
  }
  for (const o of snapshot.orders) {
    if (o.reduceOnly && rows.some(r => r.symbol === o.symbol && r.key.endsWith(`:${o.positionSide}`))) continue;
    const managed = journal[o.symbol];
    rows.push({ key: `order:${o.orderId}`, symbol: o.symbol, side: o.side, entryOrderId: o.orderId,
      entryPrice: Number(o.price), quantity: Number(o.origQty) - Number(o.executedQty),
      pnlUsd: 0, pnlPct: 0, filled: false, openedAt: o.time, holdSeconds: Math.max(0, Math.floor((now - o.time) / 1000)),
      managed: !!managed && (o.clientOrderId === managed.clientId || o.clientOrderId === managed.tpClientId || !!managed.adoptedClientIds?.includes(o.clientOrderId)),
      state: o.reduceOnly ? 'EXIT_ORDER' : 'ARMED', lastError: managed?.lastError,
      targetTp: managed?.targetTp ?? null, tpOrderId: null,
    });
  }
  return rows;
}

export class ExecutionCoordinator {
  journal: Record<string, ManagedTrade> = {};
  snapshot: ExchangeSnapshot | null = null;
  lastError: string | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private exchange: Exchange, private config: ConfigStore, private file: string, private now = Date.now) {
    if (fs.existsSync(file)) {
      this.journal = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [symbol, trade] of Object.entries(this.journal)) {
        if (trade.symbol !== symbol || !trade.clientId || !Number.isFinite(trade.entryDeadline) || !Number.isFinite(trade.holdMs)) throw new Error('Invalid execution journal; recovery required');
      }
    }
  }
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
  private save() { atomicWrite(this.file, this.journal); }
  private async read() {
    this.snapshot = await this.exchange.readExchangeState();
    return this.snapshot;
  }
  status() {
    const fresh = this.snapshot && this.now() - this.snapshot.fetchedAt < 20000 && !this.lastError;
    return { connected: !!fresh, stale: !fresh, balance: this.snapshot?.balance ?? null,
      fetchedAt: this.snapshot?.fetchedAt ?? null, error: this.lastError,
      positions: this.snapshot ? exchangeSlots(this.snapshot, this.journal, this.now()) : [],
      openOrders: this.snapshot?.orders ?? [], exchangePositions: this.snapshot?.positions ?? [],
      reconciliation: Object.values(this.journal).filter(t => t.lastError).map(t => ({ symbol: t.symbol, error: t.lastError })),
    };
  }
  async reconcile() { return this.serial(() => this.reconcileLocked()); }
  private async reconcileLocked() {
    try {
      let snapshot = await this.read();
      // Recover tagged orders even if the process died between exchange acceptance and journal update.
      for (const o of snapshot.orders) {
        if (o.clientOrderId.startsWith('lsv-entry-') && !this.journal[o.symbol] && !o.reduceOnly && o.positionSide === 'BOTH') {
          const c = this.config.get();
          this.journal[o.symbol] = { symbol: o.symbol, clientId: o.clientOrderId, entryOrderId: o.orderId,
            entryPrice: Number(o.price), quantity: Number(o.origQty), openedAt: o.time,
            entryDeadline: o.time + c.entryTimeoutSeconds * 1000, holdMs: c.holdSeconds * 1000,
            targetTp: Number(o.price) * (1 + c.takeProfitPct), state: 'ARMED' };
          this.save();
        }
      }
      for (const trade of Object.values(this.journal)) {
        try {
          await this.manage(trade, snapshot);
          snapshot = await this.read();
        } catch (error) {
          trade.lastError = error instanceof Error ? error.message : String(error);
          this.save();
        }
      }
      this.lastError = null;
      return this.status();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return this.status();
    }
  }
  private ownedOrders(trade: ManagedTrade, snapshot: ExchangeSnapshot) {
    return snapshot.orders.filter(o => o.symbol === trade.symbol && (trade.adoptedClientIds?.includes(o.clientOrderId) || [trade.clientId, trade.tpClientId, trade.closeClientId].includes(o.clientOrderId)));
  }
  private async manage(t: ManagedTrade, initial: ExchangeSnapshot) {
    let snapshot = initial;
    if (snapshot.positions.some(p => p.symbol === t.symbol && p.positionSide !== 'BOTH')) throw new Error('Hedge-mode position requires manual reconciliation');
    const foreign = snapshot.orders.filter(o => o.symbol === t.symbol && !t.adoptedClientIds?.includes(o.clientOrderId) && ![t.clientId, t.tpClientId, t.closeClientId].includes(o.clientOrderId));
    if (foreign.length) throw new Error('Unrecognized orders share this symbol; reconcile them before automatic management');
    const entry = await this.exchange.queryOrder(t.symbol, t.clientId);
    if (t.state === 'SUBMITTING' && !entry) throw new Error('Entry acknowledgement uncertain; review exchange before retrying');
    if (entry) { t.entryOrderId = entry.orderId; if (t.state === 'SUBMITTING') t.state = 'ARMED'; }
    let position = snapshot.positions.find(p => p.symbol === t.symbol && p.positionSide === 'BOTH');
    if (position) {
      if (Number(position.positionAmt) < 0) throw new Error('Unexpected short exposure; manual reconciliation required');
      if (!t.fillTime) {
        t.fillTime = Math.min(this.now(), Number(position.updateTime) || entry?.updateTime || t.openedAt);
        if (t.state !== 'CLOSING') t.state = 'FILLED';
        const profitPct = t.takeProfitPct ?? (t.targetTp / t.entryPrice - 1);
        t.entryPrice = Number(position.entryPrice);
        t.targetTp = t.entryPrice * (1 + profitPct);
        this.save();
      }
      // Partial entry fills are real exposure: cancel the remaining entry before protecting it.
      const remaining = snapshot.orders.find(o => o.clientOrderId === t.clientId);
      if (remaining) {
        const canceled = await this.exchange.cancelOrder(t.symbol, remaining.orderId);
        if (!canceled.ok) throw new Error(canceled.error || 'Entry remainder cancellation failed');
        snapshot = await this.read();
        if (snapshot.orders.some(o => o.clientOrderId === t.clientId)) throw new Error('Entry remainder still open');
        position = snapshot.positions.find(p => p.symbol === t.symbol && p.positionSide === 'BOTH');
      }
    }
    const expired = t.fillTime ? this.now() >= t.fillTime + t.holdMs : this.now() >= t.entryDeadline;
    if (expired || t.state === 'CLOSING' || this.config.get().halted) {
      t.state = 'CLOSING'; this.save();
      await this.close(t, snapshot);
      return;
    }
    if (!position && !this.ownedOrders(t, snapshot).length && entry && ['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED', 'EXPIRED_IN_MATCH'].includes(entry.status)) {
      delete this.journal[t.symbol]; this.save(); return;
    }
    if (position) {
      t.quantity = Math.abs(Number(position.positionAmt));
      const tpOpen = snapshot.orders.find(o => o.clientOrderId === t.tpClientId);
      if (!tpOpen) {
        if (t.tpClientId) {
          const old = await this.exchange.queryOrder(t.symbol, t.tpClientId);
          if (!old) throw new Error('Take-profit acknowledgement uncertain; retaining watchdog');
          if (['NEW', 'PARTIALLY_FILLED'].includes(old.status)) return;
        }
        t.tpClientId = id('tp'); this.save();
        const result = await this.exchange.placePostOnlyLimit(t.symbol, 'SELL', t.targetTp, t.quantity, true, t.tpClientId);
        if (!result.ok) {
          if (definitiveRejection(result)) t.tpClientId = undefined;
          throw new Error(result.error || 'Take-profit failed');
        }
      }
    }
    t.lastError = undefined; this.save();
  }
  private async close(t: ManagedTrade, snapshot: ExchangeSnapshot) {
    for (const order of this.ownedOrders(t, snapshot)) {
      const result = await this.exchange.cancelOrder(t.symbol, order.orderId);
      if (!result.ok) throw new Error(result.error || 'Cancellation failed; tracking retained');
    }
    snapshot = await this.read();
    if (this.ownedOrders(t, snapshot).length) throw new Error('Cancellation not yet confirmed');
    const position = snapshot.positions.find(p => p.symbol === t.symbol && p.positionSide === 'BOTH');
    if (position) {
      if (t.closeClientId) {
        const previous = await this.exchange.queryOrder(t.symbol, t.closeClientId);
        if (!previous) throw new Error('Close acknowledgement uncertain; tracking retained for review');
        if (['NEW', 'PARTIALLY_FILLED'].includes(previous.status)) throw new Error('Close still pending');
      }
      t.closeClientId = id('close'); this.save();
      const result = await this.exchange.placeMarketOrder(t.symbol, Number(position.positionAmt) > 0 ? 'SELL' : 'BUY', Math.abs(Number(position.positionAmt)), true, t.closeClientId);
      if (!result.ok) {
        if (definitiveRejection(result)) t.closeClientId = undefined;
        throw new Error(result.error || 'Close failed; tracking retained');
      }
    }
    snapshot = await this.read();
    if (snapshot.positions.some(p => p.symbol === t.symbol) || this.ownedOrders(t, snapshot).length) throw new Error('Exchange has not confirmed flat; will reconcile again');
    delete this.journal[t.symbol]; this.save();
  }
  async submit(symbol: string, entryPrice: number, automatic = false) {
    return this.serial(async () => {
      const c = this.config.get();
      if (c.mode !== 'LIVE' || c.halted || (automatic && !c.autoExecute)) throw new Error('Demo entries are disabled by backend config');
      if (c.allowedSymbols.length && !c.allowedSymbols.includes(symbol)) throw new Error('Symbol excluded by backend filter');
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) throw new Error('Invalid entry price');
      const snapshot = await this.read();
      const slots = exchangeSlots(snapshot, this.journal, this.now());
      if (slots.some(s => !s.managed && s.symbol === symbol)) throw new Error('Unmanaged exchange exposure on this symbol requires reconciliation before new entries');
      if (Object.values(this.journal).some(t => t.lastError || t.state === 'SUBMITTING')) throw new Error('Unresolved execution state blocks new entries');
      const symbols = new Set([...slots.map(s => s.symbol), ...Object.keys(this.journal)]);
      if (symbols.has(symbol)) throw new Error(`${symbol} already has exchange exposure or an entry intent`);
      if (symbols.size >= c.maxActiveSlots) throw new Error('Max concurrent slots reached');
      const reservedMargin = Object.values(this.journal).reduce((sum, t) => sum + (t.marginUsd ?? t.entryPrice * t.quantity / c.leverage), 0);
      if (reservedMargin + c.marginPerSlotUsd > c.totalRiskPoolUsd) throw new Error('Existing managed exposure exhausts the configured risk pool');
      if (snapshot.balance < c.marginPerSlotUsd) throw new Error('Insufficient available demo balance for configured margin');
      const margin = await this.exchange.ensureIsolatedMargin(symbol);
      if (!margin.ok) throw new Error(margin.error || 'Could not confirm isolated margin');
      await this.exchange.setLeverage(symbol, c.leverage);
      const t: ManagedTrade = { symbol, clientId: id('entry'), entryPrice,
        quantity: c.marginPerSlotUsd * c.leverage / entryPrice, marginUsd: c.marginPerSlotUsd, openedAt: this.now(),
        entryDeadline: this.now() + c.entryTimeoutSeconds * 1000, holdMs: c.holdSeconds * 1000,
        targetTp: entryPrice * (1 + c.takeProfitPct), takeProfitPct: c.takeProfitPct, state: 'SUBMITTING' };
      this.journal[symbol] = t; this.save();
      const result = await this.exchange.placePostOnlyLimit(symbol, 'BUY', entryPrice, t.quantity, false, t.clientId);
      if (!result.ok) {
        // Definitive exchange rejections can release the reservation; network ambiguity cannot.
        if (definitiveRejection(result)) delete this.journal[symbol];
        else t.lastError = result.error || 'Submission uncertain';
        this.save(); throw new Error(result.error || 'Order not acknowledged');
      }
      t.entryOrderId = result.orderId; t.state = 'ARMED';
      t.quantity = Number(result.raw?.origQty ?? t.quantity);
      t.entryPrice = Number(result.raw?.price ?? entryPrice);
      t.targetTp = t.entryPrice * (1 + c.takeProfitPct);
      this.save();
      await this.read();
      return { ok: true, orderId: result.orderId };
    });
  }
  async adopt(symbol: string) {
    return this.serial(async () => {
      if (this.journal[symbol]) throw new Error('Symbol is already managed');
      const snapshot = await this.read();
      const orders = snapshot.orders.filter(o => o.symbol === symbol);
      const position = snapshot.positions.find(p => p.symbol === symbol);
      if (!orders.length && !position) throw new Error('No exchange exposure to adopt');
      if (orders.some(o => o.positionSide !== 'BOTH' || (!o.reduceOnly && o.side !== 'BUY')) || (position && (position.positionSide !== 'BOTH' || Number(position.positionAmt) < 0))) throw new Error('Only one-way long exposure can be adopted');
      const c = this.config.get(), entry = orders.find(o => !o.reduceOnly), price = Number(position?.entryPrice ?? entry?.price ?? orders[0]?.price);
      this.journal[symbol] = { symbol, clientId: entry?.clientOrderId ?? id('adopt'), entryOrderId: entry?.orderId,
        entryPrice: price, quantity: Math.abs(Number(position?.positionAmt ?? entry?.origQty ?? 0)),
        openedAt: entry?.time ?? position?.updateTime ?? this.now(), fillTime: position ? (position.updateTime || this.now()) : undefined,
        entryDeadline: (entry?.time ?? this.now()) + c.entryTimeoutSeconds * 1000,
        holdMs: c.holdSeconds * 1000, targetTp: price * (1 + c.takeProfitPct), state: position ? 'FILLED' : 'ARMED', adopted: true, adoptedClientIds: orders.map(o => o.clientOrderId), tpClientId: orders.find(o => o.reduceOnly)?.clientOrderId, takeProfitPct: c.takeProfitPct };
      this.save();
      return this.reconcileLocked();
    });
  }
}
