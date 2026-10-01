import WebSocket from 'ws';
import type { ConcurrencyGovernorConfig, FleetPairTelemetry, ShadowTradeLogRecord } from '../types';
import { TOP_30_UNIVERSE } from './fleetUniverse';

// Server-side fleet worker on real Binance USD-M mainnet data (no exchange orders, no alerts).
//
// Signal: a real long cascade. CVI = long liquidations in the last 30s / resting
//   bids between price and the cluster >= 3, drop >= 0.8%, velocity <= cap, free slot.
// Edge gate: entry = VWAP of sweeping the real asks for the full notional;
//   target = entry + 50% of the fall from the price 30s earlier to the cascade low;
//   predicted exit = target less the real slippage of selling that size into the bids;
//   net edge = predicted exit vs entry, minus 0.05% taker fee each side; must be >= 0.15%.
// Entry: immediately, as a taker, at the ask-sweep VWAP.
// Exit: when selling into the real bids yields at least the target, else after 90s,
//   both at the bid-sweep VWAP.

export const DEFAULT_FLEET_GOVERNOR: ConcurrencyGovernorConfig = {
  maxActiveSlots: 3,
  totalRiskPoolUsd: 250000,
  marginPerSlotUsd: 25000,
  usdQueueHurdle: 150000,
  autoExecute: true,
  minCviThreshold: 3.0,
  decelerationCap: 65,
  baseDropPct: 0.008,
  absorptionBuffer: 1.45,
  feeDragPct: 0.1,
  toxicOiThresholdPct: 15,
  microCapitalTier: 'INSTITUTIONAL_250K',
};

export const STRATEGY = {
  leverage: 10,
  takerFeePct: 0.05,
  minNetEdgePct: 0.15,
  retraceFraction: 0.5,
  preCascadeLookbackMs: 30000,
  holdLimitSeconds: 90,
};

type Levels = Array<[number, number]>;
export interface LiveTick {
  mid: number;
  lastTrade: number;
  bids: Levels;
  asks: Levels;
  tradeTimes: number[];
  quoteVolume24h: number;
  // 1s price samples and per-second trade lows, last 60s
  samples: Array<{ t: number; price: number }>;
  lows: Array<{ t: number; low: number }>;
}

export interface Liquidation { time: number; usd: number; price: number; }
export interface Cluster { usd: number; price: number; count: number; }
export type DepthFetcher = (symbol: string) => Promise<{ bids: Levels; asks: Levels }>;

export interface Quote {
  ok: boolean;
  reason: 'EDGE_OK' | 'EDGE_TOO_SMALL' | 'ASKS_TOO_THIN' | 'NO_CASCADE_DROP';
  notionalUsd: number;
  entry: { vwap: number; qty: number; complete: boolean };
  pre?: number;
  low?: number;
  targetPrice?: number;
  exitSlippagePct?: number;
  predictedExit?: number;
  netEdgePct?: number;
}

export type FleetMode = 'SIGNAL_ONLY' | 'PAPER';
export interface FleetPair extends FleetPairTelemetry {
  cooldownUntil?: number;
  entryPrice?: number;
  quantity?: number;
  targetPrice?: number;
  exitPriceNow?: number;
  preCascadePrice?: number;
  cascadeLow?: number;
  predictedNetEdgePct?: number;
  cviAtEntry?: number;
}
export interface FleetEvent {
  seq: number;
  time: string;
  type: 'SIGNAL' | 'EDGE_REJECTED' | 'NO_DEPTH' | 'FILLED' | 'EXIT_TP' | 'EXIT_TIME_STOP' | 'SLOT_BLOCKED' | 'TOXIC_ABORT' | 'HALT' | 'RESUME';
  symbol: string;
  data: Record<string, number | string | boolean | undefined>;
}

interface Options {
  now?: () => number;
  onTrade?: (record: ShadowTradeLogRecord) => void;
  fetchDepth?: DepthFetcher;
}

const CLUSTER_WINDOW_MS = 30000;
const SIGNAL_REPEAT_MS = 30000;
const COOLDOWN_MS = 6000;
const MAX_EVENTS = 500;
const HISTORY_MS = 60000;

// 1000-level mainnet book, taken when the 20-level stream cannot cover the size.
const fetchMainnetDepth: DepthFetcher = async symbol => {
  const res = await fetch(`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=1000`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Depth unavailable (HTTP ${res.status})`);
  const book: any = await res.json();
  const parse = (rows: Array<[string, string]> = []) => rows.map(r => [Number(r[0]), Number(r[1])] as [number, number]);
  return { bids: parse(book.bids), asks: parse(book.asks) };
};

// Buys `notionalUsd` by walking the asks. complete=false when the book is too thin.
export function sweepAsksForUsd(asks: Levels, notionalUsd: number) {
  let usd = 0, qty = 0;
  for (const [price, size] of asks) {
    const take = Math.min(size, (notionalUsd - usd) / price);
    usd += take * price; qty += take;
    if (usd >= notionalUsd - 1e-9) return { vwap: usd / qty, qty, complete: true };
  }
  return { vwap: qty > 0 ? usd / qty : 0, qty, complete: false };
}

// Sells `quantity` into the bids. Any remainder beyond the book is priced at the
// last level (conservative) and complete=false.
export function sweepBidsForQty(bids: Levels, quantity: number) {
  let qty = 0, usd = 0;
  for (const [price, size] of bids) {
    const take = Math.min(size, quantity - qty);
    qty += take; usd += take * price;
    if (qty >= quantity - 1e-12) return { vwap: usd / quantity, complete: true };
  }
  if (!bids.length) return { vwap: 0, complete: false };
  usd += (quantity - qty) * bids[bids.length - 1][0];
  return { vwap: usd / quantity, complete: false };
}

// Resting bid USD between the current price and the cluster price. When the
// price is already at or below the cluster, only the best bid level stands in the way.
export function restingBidsAbove(bids: Levels, clusterPrice: number) {
  const inSpan = bids.filter(([price]) => price >= clusterPrice);
  const levels = inSpan.length ? inSpan : bids.slice(0, 1);
  return levels.reduce((sum, [price, size]) => sum + price * size, 0);
}

export class FleetEngine {
  pairs: FleetPair[];
  governor: ConcurrencyGovernorConfig = { ...DEFAULT_FLEET_GOVERNOR };
  mode: FleetMode = 'PAPER';
  halted = false;
  events: FleetEvent[] = [];
  feed = { connected: false, messages: 0, lastMessageAt: null as string | null, liquidations: 0, fleetLiquidations: 0, lastLiquidation: null as string | null };
  private ticks = new Map<string, LiveTick>();
  private liquidations = new Map<string, Liquidation[]>();
  private lastSignalAt = new Map<string, number>();
  private depthRequests = new Set<string>();
  private seq = 0;
  private listeners = new Set<(event: FleetEvent) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private sockets = new Set<WebSocket>();
  private openSockets = new Set<WebSocket>();
  private now: () => number;
  private fetchDepth: DepthFetcher;

  constructor(private options: Options = {}) {
    this.now = options.now ?? Date.now;
    this.fetchDepth = options.fetchDepth ?? fetchMainnetDepth;
    this.pairs = TOP_30_UNIVERSE.map(p => ({
      symbol: p.symbol, name: p.name, price: 0, refPrice: 0, dropPct: 0, cvi: 0, cushionPct: 0,
      tickVelocity: 0, volume24hUsd: 0, openInterestStability: p.oiStability, status: 'IDLE',
      requiredQueueUsd: 0, accumulatedFillUsd: 0, minContractStepUsd: p.minLotStepUsd,
      is10DollarApproved: p.is10DollarApproved,
    }));
  }

  // ---------- real tick ingestion ----------
  private tick(symbol: string) {
    let tick = this.ticks.get(symbol);
    if (!tick) {
      tick = { mid: 0, lastTrade: 0, bids: [], asks: [], tradeTimes: [], quoteVolume24h: 0, samples: [], lows: [] };
      this.ticks.set(symbol, tick);
    }
    return tick;
  }
  ingestDepth(symbol: string, bids: Levels, asks: Levels) {
    if (!bids.length || !asks.length) return;
    const tick = this.tick(symbol);
    tick.bids = bids;
    tick.asks = asks;
    tick.mid = (bids[0][0] + asks[0][0]) / 2;
  }
  ingestTrade(symbol: string, price: number, quantity: number, _buyerIsMaker: boolean) {
    if (!(price > 0 && quantity > 0)) return;
    const tick = this.tick(symbol);
    const now = this.now();
    tick.lastTrade = price;
    tick.tradeTimes.push(now);
    const second = Math.floor(now / 1000);
    const last = tick.lows[tick.lows.length - 1];
    if (last && last.t === second) last.low = Math.min(last.low, price);
    else tick.lows.push({ t: second, low: price });
  }
  ingestTicker(symbol: string, quoteVolume: number) {
    if (quoteVolume > 0) this.tick(symbol).quoteVolume24h = quoteVolume;
  }
  // Forced orders. SELL = a long was liquidated; the engine is long-only.
  ingestLiquidation(symbol: string, side: string, price: number, quantity: number) {
    if (side !== 'SELL' || !(price > 0 && quantity > 0)) return;
    const list = this.liquidations.get(symbol) ?? [];
    list.push({ time: this.now(), usd: price * quantity, price });
    this.liquidations.set(symbol, list);
  }
  cluster(symbol: string, now = this.now()): Cluster {
    const list = (this.liquidations.get(symbol) ?? []).filter(l => now - l.time < CLUSTER_WINDOW_MS);
    this.liquidations.set(symbol, list);
    const usd = list.reduce((sum, l) => sum + l.usd, 0);
    const price = usd > 0 ? list.reduce((sum, l) => sum + l.price * l.usd, 0) / usd : 0;
    return { usd, price, count: list.length };
  }

  // ---------- events ----------
  private emit(type: FleetEvent['type'], symbol: string, data: FleetEvent['data'] = {}) {
    const event: FleetEvent = { seq: ++this.seq, time: new Date(this.now()).toISOString(), type, symbol, data };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    for (const listener of this.listeners) listener(event);
  }
  subscribe(listener: (event: FleetEvent) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  eventsSince(seq: number) { return this.events.filter(e => e.seq > seq); }

  private filledCount() { return this.pairs.filter(p => p.status === 'FILLED').length; }

  // ---------- the fleet loop (one pass per second) ----------
  step() {
    if (this.halted) return;
    const now = this.now();
    const g = this.governor;

    this.pairs = this.pairs.map(pair => {
      let p: FleetPair = { ...pair };
      if (p.status === 'COOLDOWN' && now >= (p.cooldownUntil ?? 0)) p = this.cleared(p);
      const live = this.ticks.get(p.symbol);
      if (live) {
        while (live.tradeTimes.length > 0 && live.tradeTimes[0] < now - 1000) live.tradeTimes.shift();
        p.tickVelocity = live.tradeTimes.length;
        if (live.quoteVolume24h > 0) p.volume24hUsd = live.quoteVolume24h;
        const samplePrice = live.lastTrade || live.mid;
        if (samplePrice > 0) live.samples.push({ t: now, price: samplePrice });
        while (live.samples.length && live.samples[0].t < now - HISTORY_MS) live.samples.shift();
        while (live.lows.length && live.lows[0].t * 1000 < now - HISTORY_MS) live.lows.shift();
      }
      if (p.status !== 'FILLED' && live && live.mid > 0) {
        const ref = p.refPrice > 0 ? p.refPrice : live.mid;
        const topBidUsd = live.bids.slice(0, 10).reduce((sum, b) => sum + b[0] * b[1], 0);
        const cluster = this.cluster(p.symbol, now);
        const resting = cluster.usd > 0 ? restingBidsAbove(live.bids, cluster.price) : 0;
        p = {
          ...p,
          price: live.mid,
          refPrice: ref,
          dropPct: Math.max(0, (ref - live.mid) / ref),
          cvi: cluster.usd > 0 && resting > 0 ? Math.round((cluster.usd / resting) * 100) / 100 : 0,
          cushionPct: Math.round(Math.min(220, Math.max(90, (topBidUsd / g.usdQueueHurdle) * 100))),
        };
      }

      if ((p.oiPlungePct || 0) >= g.toxicOiThresholdPct && p.status !== 'TOXIC_ABORT') {
        p.status = 'TOXIC_ABORT';
        p.isToxicAborted = true;
        this.emit('TOXIC_ABORT', p.symbol, { oiPlungePct: p.oiPlungePct });
      }

      if (
        g.autoExecute &&
        p.status === 'IDLE' &&
        !p.isToxicAborted &&
        p.cvi >= g.minCviThreshold &&
        p.dropPct >= g.baseDropPct &&
        p.tickVelocity <= g.decelerationCap &&
        now - (this.lastSignalAt.get(p.symbol) ?? 0) >= SIGNAL_REPEAT_MS
      ) {
        this.lastSignalAt.set(p.symbol, now);
        this.evaluate(p, live!, now);
      }

      if (p.status === 'FILLED' && p.fillTime && live) this.manage(p, live, now);
      return p;
    });
  }

  private cleared(p: FleetPair): FleetPair {
    return { ...p, status: 'IDLE', armedPrice: undefined, targetTp: undefined, activeSlot: undefined, cooldownUntil: undefined,
      entryPrice: undefined, quantity: undefined, targetPrice: undefined, exitPriceNow: undefined, preCascadePrice: undefined,
      cascadeLow: undefined, predictedNetEdgePct: undefined, cviAtEntry: undefined, fillTime: undefined, holdSeconds: 0, pnlPct: undefined, pnlUsd: undefined };
  }

  private preCascadePrice(live: LiveTick, now: number) {
    const target = now - STRATEGY.preCascadeLookbackMs;
    let best: { t: number; price: number } | undefined;
    for (const s of live.samples) if (s.t <= target) best = s;
    return best?.price ?? live.samples[0]?.price;
  }
  private cascadeLow(live: LiveTick, now: number) {
    const from = Math.floor((now - CLUSTER_WINDOW_MS) / 1000);
    const lows = live.lows.filter(l => l.t >= from).map(l => l.low);
    if (live.mid > 0) lows.push(live.mid);
    return lows.length ? Math.min(...lows) : 0;
  }

  // Edge gate on the given books; returns the decision without changing state.
  quote(symbol: string, books: { bids: Levels; asks: Levels }, now = this.now()): Quote {
    const live = this.ticks.get(symbol);
    const notionalUsd = this.governor.marginPerSlotUsd * STRATEGY.leverage;
    const entry = sweepAsksForUsd(books.asks, notionalUsd);
    const pre = live ? this.preCascadePrice(live, now) : undefined;
    const low = live ? this.cascadeLow(live, now) : 0;
    if (!entry.complete) return { ok: false, reason: 'ASKS_TOO_THIN', notionalUsd, entry };
    if (!pre || !(low > 0) || pre <= low) return { ok: false, reason: 'NO_CASCADE_DROP', notionalUsd, entry, pre, low };
    const targetPrice = entry.vwap + STRATEGY.retraceFraction * (pre - low);
    const bestBid = books.bids[0]?.[0] ?? 0;
    const exitSweep = sweepBidsForQty(books.bids, entry.qty);
    const exitSlippagePct = bestBid > 0 ? Math.max(0, (bestBid - exitSweep.vwap) / bestBid) * 100 : 0;
    const predictedExit = targetPrice * (1 - exitSlippagePct / 100);
    const netEdgePct = (predictedExit / entry.vwap - 1) * 100 - 2 * STRATEGY.takerFeePct;
    return {
      ok: netEdgePct >= STRATEGY.minNetEdgePct, reason: netEdgePct >= STRATEGY.minNetEdgePct ? 'EDGE_OK' : 'EDGE_TOO_SMALL',
      notionalUsd, entry, pre, low, targetPrice, exitSlippagePct, predictedExit, netEdgePct,
    };
  }

  private evaluate(p: FleetPair, live: LiveTick, now: number) {
    const cluster = this.cluster(p.symbol, now);
    const q = this.quote(p.symbol, live, now);
    if (!q.ok && q.reason === 'ASKS_TOO_THIN') {
      this.deepEvaluate(p.symbol, cluster);
      return;
    }
    this.decide(p, q, cluster, now, 'stream');
  }

  // The 20-level stream could not cover the size: re-run the gate on a 1000-level snapshot.
  private deepEvaluate(symbol: string, cluster: Cluster) {
    if (this.depthRequests.has(symbol)) return;
    this.depthRequests.add(symbol);
    void this.fetchDepth(symbol).then(books => {
      const current = this.pairs.find(p => p.symbol === symbol);
      if (!current || this.halted || current.status !== 'IDLE') return;
      const q = this.quote(symbol, books);
      if (!q.ok && q.reason === 'ASKS_TOO_THIN') {
        this.emit('NO_DEPTH', symbol, { notionalUsd: q.notionalUsd, fillableQty: q.entry.qty, levels: books.asks.length });
        return;
      }
      this.decide(current, q, cluster, this.now(), 'snapshot1000');
    }).catch(error => {
      this.emit('NO_DEPTH', symbol, { error: error instanceof Error ? error.message : String(error) });
    }).finally(() => this.depthRequests.delete(symbol));
  }

  private decide(p: FleetPair, q: Quote, cluster: Cluster, now: number, book: string) {
    const details = {
      cvi: p.cvi, dropPct: p.dropPct, clusterUsd: Math.round(cluster.usd), clusterPrice: cluster.price, book,
      notionalUsd: q.notionalUsd, entryVwap: q.entry.vwap, quantity: q.entry.qty,
      preCascadePrice: q.pre, cascadeLow: q.low, targetPrice: q.targetPrice,
      exitSlippagePct: q.exitSlippagePct, predictedExit: q.predictedExit, netEdgePct: q.netEdgePct, reason: q.reason,
    };
    this.emit('SIGNAL', p.symbol, details);
    if (!q.ok) { this.emit('EDGE_REJECTED', p.symbol, details); return; }
    if (this.mode !== 'PAPER') return;
    if (this.filledCount() >= this.governor.maxActiveSlots) {
      this.emit('SLOT_BLOCKED', p.symbol, { maxActiveSlots: this.governor.maxActiveSlots });
      return;
    }
    const slot = this.filledCount() + 1;
    Object.assign(p, {
      status: 'FILLED', fillTime: now, activeSlot: slot, holdSeconds: 0,
      entryPrice: q.entry.vwap, quantity: q.entry.qty, targetPrice: q.targetPrice,
      preCascadePrice: q.pre, cascadeLow: q.low, predictedNetEdgePct: q.netEdgePct, cviAtEntry: p.cvi,
      armedPrice: q.entry.vwap, targetTp: q.targetPrice, price: q.entry.vwap,
    });
    // `p` may be a copy inside step(); keep the stored pair in sync.
    this.pairs = this.pairs.map(x => x.symbol === p.symbol ? p : x);
    this.emit('FILLED', p.symbol, { ...details, slot });
  }

  private manage(p: FleetPair, live: LiveTick, now: number) {
    const elapsed = Math.floor((now - p.fillTime!) / 1000);
    p.holdSeconds = elapsed;
    const exit = sweepBidsForQty(live.bids, p.quantity!);
    if (exit.vwap > 0) {
      p.exitPriceNow = exit.vwap;
      p.price = live.lastTrade || live.mid;
      p.pnlPct = Math.round(((exit.vwap / p.entryPrice!) - 1) * 100000) / 1000;
      p.pnlUsd = Math.round((exit.vwap - p.entryPrice!) * p.quantity! * 100) / 100;
    }
    if (exit.vwap > 0 && exit.vwap >= p.targetPrice!) this.close(p, exit.vwap, 'TP_HIT (Bid sweep >= target)', now);
    else if (elapsed >= STRATEGY.holdLimitSeconds) this.close(p, exit.vwap || p.price, 'TIME_STOP_EXPIRED (90s, bid sweep)', now);
  }

  private close(p: FleetPair, exitPrice: number, outcome: string, now: number) {
    const entry = p.entryPrice!, qty = p.quantity!;
    const notionalUsd = entry * qty;
    const grossPnlUsd = (exitPrice - entry) * qty;
    const pnlPct = (exitPrice / entry - 1) * 100;
    const feeUsd = (2 * STRATEGY.takerFeePct / 100) * notionalUsd;
    const record: ShadowTradeLogRecord = {
      id: `fleet-${p.symbol}-${now}`,
      timestamp: new Date(now).toISOString(),
      symbol: p.symbol,
      entryPrice: Math.round(entry * 1e6) / 1e6,
      exitPrice: Math.round(exitPrice * 1e6) / 1e6,
      cviAtEntry: p.cviAtEntry ?? p.cvi,
      queueClearanceSeconds: 0,
      holdSeconds: p.holdSeconds ?? 0,
      outcome,
      pnlPct: Math.round(pnlPct * 1000) / 1000,
      pnlUsd: Math.round(grossPnlUsd * 100) / 100,
      feeUsd: Math.round(feeUsd * 100) / 100,
      netPnlUsd: Math.round((grossPnlUsd - feeUsd) * 100) / 100,
      netPnlPct: Math.round((pnlPct - 2 * STRATEGY.takerFeePct) * 1000) / 1000,
    };
    this.emit(outcome.startsWith('TP_HIT') ? 'EXIT_TP' : 'EXIT_TIME_STOP', p.symbol, {
      entry: record.entryPrice, exit: record.exitPrice, target: p.targetPrice, holdSeconds: record.holdSeconds,
      pnlPct: record.pnlPct, netPnlUsd: record.netPnlUsd, predictedNetEdgePct: p.predictedNetEdgePct,
    });
    p.status = 'COOLDOWN';
    p.cooldownUntil = now + COOLDOWN_MS;
    this.options.onTrade?.(record);
  }

  // ---------- controls ----------
  // Manual entry: same edge gate, needs a real long cascade in the last 30s.
  manualArm(symbol: string) {
    const pair = this.pairs.find(p => p.symbol === symbol);
    if (!pair) throw new Error(`Unknown symbol ${symbol}`);
    const live = this.ticks.get(symbol);
    if (!live || !(pair.price > 0)) throw new Error(`No live price for ${symbol} yet`);
    if (pair.status !== 'IDLE') throw new Error(`${symbol} is ${pair.status}`);
    const cluster = this.cluster(symbol);
    if (!(cluster.usd > 0)) throw new Error(`No long liquidations on ${symbol} in the last 30s`);
    this.lastSignalAt.set(symbol, this.now());
    this.evaluate(pair, live, this.now());
    return { symbol, status: this.pairs.find(p => p.symbol === symbol)!.status };
  }
  halt() {
    this.halted = true;
    this.pairs = this.pairs.map(p => this.cleared(p));
    this.emit('HALT', 'FLEET');
  }
  resume() {
    this.halted = false;
    this.emit('RESUME', 'FLEET');
  }
  setMode(mode: FleetMode) {
    if (mode !== 'SIGNAL_ONLY' && mode !== 'PAPER') throw new Error('Mode must be SIGNAL_ONLY or PAPER');
    this.mode = mode;
  }
  updateGovernor(patch: Partial<ConcurrencyGovernorConfig>) {
    const allowed = ['maxActiveSlots', 'totalRiskPoolUsd', 'marginPerSlotUsd', 'autoExecute', 'microCapitalTier'] as const;
    for (const key of Object.keys(patch)) if (!(allowed as readonly string[]).includes(key)) throw new Error(`Unsupported setting: ${key}`);
    const next = { ...this.governor, ...patch };
    if (!Number.isInteger(next.maxActiveSlots) || next.maxActiveSlots < 1 || next.maxActiveSlots > 5) throw new Error('maxActiveSlots must be 1-5');
    for (const key of ['totalRiskPoolUsd', 'marginPerSlotUsd'] as const) {
      if (typeof next[key] !== 'number' || !(next[key] > 0)) throw new Error(`Invalid ${key}`);
    }
    if (typeof next.autoExecute !== 'boolean') throw new Error('Invalid autoExecute');
    if (!['INSTITUTIONAL_250K', 'MICRO_FLIGHT_250', 'MINI_MICRO_10'].includes(next.microCapitalTier)) throw new Error('Invalid microCapitalTier');
    this.governor = next;
  }

  // ---------- read model ----------
  snapshot() {
    const pairs = this.pairs.map(({ cooldownUntil: _c, ...p }) => p);
    return {
      updatedAt: new Date(this.now()).toISOString(),
      source: 'LSV server fleet worker (real Binance USD-M mainnet data, no exchange orders)',
      mode: this.mode,
      halted: this.halted,
      feed: this.feed,
      governor: this.governor,
      strategy: { ...STRATEGY, notionalUsd: this.governor.marginPerSlotUsd * STRATEGY.leverage },
      counts: {
        filled: pairs.filter(p => p.status === 'FILLED').length,
        withLiveData: pairs.filter(p => p.price > 0).length,
      },
      lastEventSeq: this.seq,
      pairs,
    };
  }

  // ---------- lifecycle ----------
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.step(), 1000);
    const symbols = TOP_30_UNIVERSE.map(p => p.symbol.toLowerCase());
    this.connect(`wss://fstream.binance.com/public/stream?streams=${symbols.map(s => `${s}@depth20@100ms`).join('/')}`);
    this.connect(`wss://fstream.binance.com/market/stream?streams=${symbols.flatMap(s => [`${s}@aggTrade`, `${s}@ticker`]).join('/')}`);
    this.connect('wss://fstream.binance.com/market/ws/!forceOrder@arr');
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const ws of this.sockets) ws.terminate();
    this.sockets.clear();
  }
  private connect(url: string) {
    const ws = new WebSocket(url);
    this.sockets.add(ws);
    ws.on('open', () => { this.openSockets.add(ws); this.feed.connected = this.openSockets.size === 3; });
    ws.on('message', raw => {
      this.feed.messages++;
      this.feed.lastMessageAt = new Date().toISOString();
      try {
        const payload = JSON.parse(raw.toString());
        if (payload.e === 'forceOrder' && payload.o) {
          const symbol = String(payload.o.s);
          this.feed.liquidations++;
          if (this.pairs.some(p => p.symbol === symbol)) {
            this.feed.fleetLiquidations++;
            this.feed.lastLiquidation = `${symbol} ${payload.o.S} $${Math.round(Number(payload.o.p) * Number(payload.o.q)).toLocaleString()} at ${new Date().toISOString()}`;
          }
          this.ingestLiquidation(symbol, String(payload.o.S), Number(payload.o.p), Number(payload.o.q));
          return;
        }
        const stream: string = payload.stream || '';
        const data = payload.data || {};
        const symbol = String(data.s || stream.split('@')[0]).toUpperCase();
        if (stream.includes('@depth20')) {
          const parse = (rows: Array<[string, string]> = []) => rows.map(r => [Number(r[0]), Number(r[1])] as [number, number]);
          this.ingestDepth(symbol, parse(data.b), parse(data.a));
        } else if (stream.includes('@aggTrade')) {
          this.ingestTrade(symbol, Number(data.p), Number(data.q), data.m === true);
        } else if (stream.includes('@ticker')) {
          this.ingestTicker(symbol, Number(data.q));
        }
      } catch { /* ignore corrupted frame */ }
    });
    ws.on('error', () => ws.terminate());
    ws.on('close', () => {
      this.sockets.delete(ws);
      this.openSockets.delete(ws);
      this.feed.connected = false;
      if (this.timer) setTimeout(() => { if (this.timer) this.connect(url); }, 5000);
    });
  }
}
