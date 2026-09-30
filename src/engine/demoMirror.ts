import fs from 'node:fs';
import { atomicWrite } from './runtimeConfig';
import type { RuntimeConfig } from './runtimeConfig';
import type { ShadowOrder } from './shadowExecution';

// The shadow engine decides every trade. The mirror copies each shadow
// order's lifecycle onto the Binance demo account:
//   shadow ARMED     -> post-only BUY limit at the same depth below the demo best bid
//   demo entry fill  -> reduce-only TP at the same take-profit percentage
//   shadow terminal  -> cancel what is still resting, close any remaining demo position
// Demo fills come from the demo book, so demo results can differ from the
// shadow's estimated results; both are shown side by side.

export class DemoRejection extends Error {
  constructor(message: string, public code?: number) { super(message); }
}
export interface DemoOrder { orderId: number; clientOrderId: string; status: string; price: number; avgPrice: number; origQty: number; executedQty: number; }
export interface LimitRequest { symbol: string; side: 'BUY' | 'SELL'; price: number; quantity: number; reduceOnly: boolean; postOnly: boolean; clientOrderId: string; }
export interface DemoExchange {
  bookTicker(symbol: string): Promise<{ bid: number; ask: number }>;
  prepare(symbol: string, leverage: number): Promise<void>;
  placeLimit(order: LimitRequest): Promise<DemoOrder>;
  placeMarketClose(symbol: string, quantity: number, clientOrderId: string): Promise<DemoOrder>;
  cancel(symbol: string, clientOrderId: string): Promise<void>;
  query(symbol: string, clientOrderId: string): Promise<DemoOrder | null>;
  positionAmt(symbol: string): Promise<number>;
  balance(): Promise<number>;
}

export interface MirrorLeg { clientOrderId: string; orderId?: number; status?: string; price?: number; avgPrice: number; executedQty: number; }
export interface MirrorRecord {
  shadowId: string; symbol: string; createdAt: number; shadowState: ShadowOrder['state'];
  depthPct: number; demoBid?: number; takeProfitPct: number;
  entry: MirrorLeg; tp?: MirrorLeg; closes: MirrorLeg[];
  state: 'PLACING' | 'ACTIVE' | 'CLOSING' | 'DONE' | 'FAILED';
  realizedPnlUsd?: number; error?: string;
}

const OPEN = new Set(['NEW', 'PARTIALLY_FILLED']);
const SHADOW_ACTIVE = new Set(['ARMED', 'FILLED']);
const UNCONFIRMED_ENTRY_MS = 60000;

function leg(clientOrderId: string): MirrorLeg { return { clientOrderId, avgPrice: 0, executedQty: 0 }; }
function update(target: MirrorLeg, order: DemoOrder | null) {
  if (!order) return;
  Object.assign(target, { orderId: order.orderId, status: order.status, price: order.price, avgPrice: order.avgPrice || target.avgPrice, executedQty: order.executedQty });
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export class DemoMirror {
  records: MirrorRecord[] = [];
  private balance: number | null = null;
  private lastError: string | null = null;
  private busy: Promise<void> = Promise.resolve();

  constructor(private exchange: DemoExchange | null, private config: () => RuntimeConfig, private file: string, private now: () => number = Date.now) {
    if (fs.existsSync(file)) this.records = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  private save() { atomicWrite(this.file, this.records); }
  // Placement and reconciliation share one queue so they never race on a record.
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.busy.then(work, work);
    this.busy = run.then(() => undefined, () => undefined);
    return run;
  }

  status() {
    return {
      configured: Boolean(this.exchange), enabled: this.config().mirrorToDemo,
      balance: this.balance, error: this.lastError, records: this.records,
    };
  }

  // Called right after the shadow engine arms an order. mainnetBestBid is the
  // bid the shadow floor was measured from, so depthPct is the shadow's own depth.
  onShadowArmed(order: ShadowOrder, mainnetBestBid: number) {
    const config = this.config();
    if (!this.exchange || !config.mirrorToDemo) return Promise.resolve(null);
    return this.serial(async () => {
      const key = `lsv${this.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const record: MirrorRecord = {
        shadowId: order.id, symbol: order.symbol, createdAt: this.now(), shadowState: order.state,
        depthPct: mainnetBestBid > 0 ? Math.max(0, (mainnetBestBid - order.entryPrice) / mainnetBestBid) : 0,
        takeProfitPct: order.targetTp / order.entryPrice - 1,
        entry: leg(`${key}-e`), closes: [], state: 'PLACING',
      };
      if (this.records.some(r => r.symbol === order.symbol && !['DONE', 'FAILED'].includes(r.state))) {
        record.state = 'FAILED'; record.error = 'Previous demo mirror on this symbol is still open';
        this.records.push(record); this.save(); return record;
      }
      this.records.push(record); this.save();
      try {
        await this.exchange!.prepare(order.symbol, config.leverage);
        const book = await this.exchange!.bookTicker(order.symbol);
        record.demoBid = book.bid;
        const placed = await this.exchange!.placeLimit({
          symbol: order.symbol, side: 'BUY', price: book.bid * (1 - record.depthPct), quantity: order.quantity,
          reduceOnly: false, postOnly: true, clientOrderId: record.entry.clientOrderId,
        });
        update(record.entry, placed);
        if (placed.status === 'EXPIRED') { record.state = 'FAILED'; record.error = 'Post-only entry would have crossed the demo book'; }
        else record.state = 'ACTIVE';
      } catch (error) {
        // A definitive rejection means nothing rests on the exchange. Anything
        // else is ambiguous and is resolved by client order ID on the next tick.
        if (error instanceof DemoRejection) record.state = 'FAILED';
        record.error = message(error);
      }
      this.save();
      return record;
    });
  }

  tick(shadowOrders: ShadowOrder[]) {
    if (!this.exchange) return Promise.resolve();
    return this.serial(async () => {
      try { this.balance = await this.exchange!.balance(); this.lastError = null; }
      catch (error) { this.lastError = message(error); }
      for (const record of this.records.filter(r => !['DONE', 'FAILED'].includes(r.state))) {
        record.shadowState = shadowOrders.find(o => o.id === record.shadowId)?.state ?? 'INCOMPLETE';
        try { await this.reconcile(record); if (record.state !== 'FAILED') record.error = undefined; }
        catch (error) { record.error = message(error); }
        this.save();
      }
    });
  }

  private async reconcile(record: MirrorRecord) {
    const ex = this.exchange!;
    const entry = await ex.query(record.symbol, record.entry.clientOrderId);
    if (record.state === 'PLACING') {
      if (!entry) {
        if (this.now() - record.createdAt > UNCONFIRMED_ENTRY_MS) {
          await ex.cancel(record.symbol, record.entry.clientOrderId); // in case it lands late
          record.state = 'FAILED'; record.error = 'Entry not found on the demo exchange';
        }
        return;
      }
      record.state = 'ACTIVE';
    }
    update(record.entry, entry);
    if (record.tp) {
      // A TP whose placement never reached the exchange is retried under the same client ID.
      const tp = await ex.query(record.symbol, record.tp.clientOrderId);
      if (!tp && record.tp.orderId === undefined) record.tp = undefined;
      else update(record.tp, tp);
    }
    for (const close of record.closes) update(close, await ex.query(record.symbol, close.clientOrderId));

    if (SHADOW_ACTIVE.has(record.shadowState)) {
      if (record.entry.status === 'FILLED' && !record.tp) {
        const tp = leg(record.entry.clientOrderId.replace(/-e$/, '-tp'));
        record.tp = tp;
        update(tp, await ex.placeLimit({
          symbol: record.symbol, side: 'SELL', price: record.entry.avgPrice * (1 + record.takeProfitPct),
          quantity: record.entry.executedQty, reduceOnly: true, postOnly: false, clientOrderId: tp.clientOrderId,
        }));
      }
      return;
    }

    // Shadow finished: take the demo side flat too.
    record.state = 'CLOSING';
    for (const open of [record.entry, record.tp]) {
      if (open && OPEN.has(open.status ?? '')) {
        await ex.cancel(record.symbol, open.clientOrderId);
        update(open, await ex.query(record.symbol, open.clientOrderId));
      }
    }
    if ([record.entry, record.tp].some(o => o && OPEN.has(o.status ?? ''))) return;
    const sold = (record.tp?.executedQty ?? 0) + record.closes.reduce((sum, c) => sum + c.executedQty, 0);
    const remaining = Math.min(record.entry.executedQty - sold, await ex.positionAmt(record.symbol));
    if (remaining > 1e-12) {
      const close = leg(`${record.entry.clientOrderId.replace(/-e$/, '')}-c${record.closes.length + 1}`);
      record.closes.push(close);
      update(close, await ex.placeMarketClose(record.symbol, remaining, close.clientOrderId));
      if (close.status !== 'FILLED') return;
    }
    if (record.entry.executedQty > 0) {
      const exits = [record.tp, ...record.closes].filter((o): o is MirrorLeg => Boolean(o));
      record.realizedPnlUsd = exits.reduce((sum, o) => sum + o.executedQty * o.avgPrice, 0) - record.entry.executedQty * record.entry.avgPrice;
    }
    record.state = 'DONE';
  }
}
