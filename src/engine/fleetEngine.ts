import WebSocket from 'ws';
import type { ConcurrencyGovernorConfig, FleetPairTelemetry, ShadowTradeLogRecord } from '../types';
import { TOP_30_UNIVERSE } from './fleetUniverse';

// Server-side port of the dashboard's 30-pair fleet loop. Same rules and
// formulas as the browser version; it runs on real Binance ticks without a
// browser tab. It places no exchange orders and sends no alerts.

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
  feeDragPct: 0.07,
  toxicOiThresholdPct: 15,
  microCapitalTier: 'INSTITUTIONAL_250K',
};

export interface LiveTick {
  mid: number;
  lastTrade: number;
  bids: Array<[number, number]>;
  tradeTimes: number[];
  pendingSellUsd: number;
  quoteVolume24h: number;
}

export type FleetMode = 'SIGNAL_ONLY' | 'PAPER';
export interface FleetPair extends FleetPairTelemetry { armedAt?: number; cooldownUntil?: number; }
export interface FleetEvent {
  seq: number;
  time: string;
  type: 'ARMED' | 'FILLED' | 'EXIT_TP' | 'EXIT_TIME_STOP' | 'SLOT_BLOCKED' | 'TOXIC_ABORT' | 'HALT' | 'RESUME';
  symbol: string;
  data: Record<string, number | string | undefined>;
}

interface Options {
  now?: () => number;
  onTrade?: (record: ShadowTradeLogRecord) => void;
}

const COOLDOWN_MS = 6000;
const HOLD_LIMIT_SECONDS = 90;
const MAX_EVENTS = 500;

export class FleetEngine {
  pairs: FleetPair[];
  governor: ConcurrencyGovernorConfig = { ...DEFAULT_FLEET_GOVERNOR };
  mode: FleetMode = 'PAPER';
  halted = false;
  events: FleetEvent[] = [];
  feed = { connected: false, messages: 0, lastMessageAt: null as string | null };
  private ticks = new Map<string, LiveTick>();
  private armedPrices = new Map<string, number>();
  private seq = 0;
  private listeners = new Set<(event: FleetEvent) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private sockets = new Set<WebSocket>();
  private openSockets = new Set<WebSocket>();
  private now: () => number;

  constructor(private options: Options = {}) {
    this.now = options.now ?? Date.now;
    this.pairs = TOP_30_UNIVERSE.map(p => ({
      symbol: p.symbol, name: p.name, price: 0, refPrice: 0, dropPct: 0, cvi: 0, cushionPct: 0,
      tickVelocity: 0, volume24hUsd: 0, openInterestStability: p.oiStability, status: 'IDLE',
      requiredQueueUsd: 150000, accumulatedFillUsd: 0, minContractStepUsd: p.minLotStepUsd,
      is10DollarApproved: p.is10DollarApproved,
    }));
  }

  // ---------- real tick ingestion ----------
  private tick(symbol: string) {
    let tick = this.ticks.get(symbol);
    if (!tick) {
      tick = { mid: 0, lastTrade: 0, bids: [], tradeTimes: [], pendingSellUsd: 0, quoteVolume24h: 0 };
      this.ticks.set(symbol, tick);
    }
    return tick;
  }
  ingestDepth(symbol: string, bids: Array<[number, number]>, asks: Array<[number, number]>) {
    if (!bids.length || !asks.length) return;
    const tick = this.tick(symbol);
    tick.bids = bids;
    tick.mid = (bids[0][0] + asks[0][0]) / 2;
  }
  ingestTrade(symbol: string, price: number, quantity: number, buyerIsMaker: boolean) {
    if (!(price > 0 && quantity > 0)) return;
    const tick = this.tick(symbol);
    tick.lastTrade = price;
    tick.tradeTimes.push(this.now());
    // Buyer is maker: the aggressor is selling into bids.
    const armedPrice = this.armedPrices.get(symbol);
    if (buyerIsMaker && armedPrice !== undefined && price <= armedPrice) tick.pendingSellUsd += price * quantity;
  }
  ingestTicker(symbol: string, quoteVolume: number) {
    if (quoteVolume > 0) this.tick(symbol).quoteVolume24h = quoteVolume;
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

  // ---------- the fleet loop (one pass per second) ----------
  step() {
    if (this.halted) return;
    const now = this.now();
    const g = this.governor;
    let activeFilledCount = this.pairs.filter(p => p.status === 'FILLED').length;

    this.pairs = this.pairs.map(pair => {
      let updatedPair: FleetPair = { ...pair };
      if (updatedPair.status === 'COOLDOWN' && now >= (updatedPair.cooldownUntil ?? 0)) {
        updatedPair = { ...updatedPair, status: 'IDLE', accumulatedFillUsd: 0, armedPrice: undefined, targetTp: undefined, activeSlot: undefined, cooldownUntil: undefined };
      }
      const live = this.ticks.get(pair.symbol);
      if (live) {
        while (live.tradeTimes.length > 0 && live.tradeTimes[0] < now - 1000) live.tradeTimes.shift();
        updatedPair.tickVelocity = live.tradeTimes.length;
        if (live.quoteVolume24h > 0) updatedPair.volume24hUsd = live.quoteVolume24h;
      }
      if (updatedPair.status !== 'FILLED' && live && live.mid > 0) {
        const ref = updatedPair.refPrice > 0 ? updatedPair.refPrice : live.mid;
        const drop = Math.max(0, (ref - live.mid) / ref);
        const topBidUsd = live.bids.slice(0, 10).reduce((sum, b) => sum + (b[0] * b[1]), 0);
        const cviScore = Math.min(6.5, Math.max(1.1, (drop * 2800000) / Math.max(10000, topBidUsd)));
        updatedPair = {
          ...updatedPair,
          price: live.mid,
          refPrice: ref,
          dropPct: drop,
          cvi: Math.round(cviScore * 100) / 100,
          cushionPct: Math.round(Math.min(220, Math.max(90, (topBidUsd / g.usdQueueHurdle) * 100))),
        };
      }

      // Toxic OI invariant (OI drop > threshold)
      if ((updatedPair.oiPlungePct || 0) >= g.toxicOiThresholdPct && updatedPair.status !== 'TOXIC_ABORT') {
        updatedPair.status = 'TOXIC_ABORT';
        updatedPair.isToxicAborted = true;
        this.emit('TOXIC_ABORT', updatedPair.symbol, { oiPlungePct: updatedPair.oiPlungePct });
      }

      // Arming: CVI, drop, deceleration gate, free slot
      if (
        g.autoExecute &&
        updatedPair.status === 'IDLE' &&
        !updatedPair.isToxicAborted &&
        updatedPair.cvi >= g.minCviThreshold &&
        updatedPair.dropPct >= g.baseDropPct &&
        updatedPair.tickVelocity <= g.decelerationCap &&
        activeFilledCount < g.maxActiveSlots
      ) {
        this.arm(updatedPair, now);
      }

      if (updatedPair.status === 'ARMED' && updatedPair.armedPrice) {
        // A new floor starts counting real volume from zero.
        if (this.armedPrices.get(pair.symbol) !== updatedPair.armedPrice && live) live.pendingSellUsd = 0;
        this.armedPrices.set(pair.symbol, updatedPair.armedPrice);
      }
      // Queue absorption: real seller-initiated volume at or below the floor since the last pass
      if (updatedPair.status === 'ARMED' && g.autoExecute && this.mode === 'PAPER') {
        const incomingTakerVol = live ? live.pendingSellUsd : 0;
        if (live) live.pendingSellUsd = 0;
        const nextQueueTotal = (updatedPair.accumulatedFillUsd || 0) + incomingTakerVol;
        updatedPair.accumulatedFillUsd = nextQueueTotal;

        if (nextQueueTotal >= g.usdQueueHurdle) {
          if (activeFilledCount < g.maxActiveSlots) {
            const allocatedSlot = activeFilledCount + 1;
            activeFilledCount++;
            const floorPrice = updatedPair.armedPrice || updatedPair.price;
            updatedPair.status = 'FILLED';
            updatedPair.fillTime = now;
            updatedPair.activeSlot = allocatedSlot;
            updatedPair.holdSeconds = 0;
            updatedPair.armedPrice = floorPrice;
            updatedPair.targetTp = floorPrice * 1.005;
            updatedPair.price = floorPrice; // Post-only fill executes at the floor
            this.emit('FILLED', updatedPair.symbol, {
              entry: floorPrice, targetTp: updatedPair.targetTp, slot: allocatedSlot,
              queueUsd: Math.round(nextQueueTotal), clearanceSeconds: updatedPair.armedAt ? (now - updatedPair.armedAt) / 1000 : undefined,
            });
          } else {
            // Slots full: the net is dropped (concurrency governor block)
            updatedPair.status = 'IDLE';
            updatedPair.accumulatedFillUsd = 0;
            this.emit('SLOT_BLOCKED', updatedPair.symbol, { maxActiveSlots: g.maxActiveSlots });
          }
        }
      }

      // Active slot: real price, TP or 90s time stop
      if (updatedPair.status === 'FILLED' && updatedPair.fillTime) {
        const elapsed = Math.floor((now - updatedPair.fillTime) / 1000);
        updatedPair.holdSeconds = elapsed;
        const entryPrice = updatedPair.armedPrice || updatedPair.price;
        const targetTp = updatedPair.targetTp || entryPrice * 1.005;
        const livePrice = live?.lastTrade || live?.mid;
        if (livePrice && livePrice > 0) updatedPair.price = livePrice;

        const pnlPct = ((updatedPair.price - entryPrice) / entryPrice) * 100;
        updatedPair.pnlPct = Math.round(pnlPct * 1000) / 1000;
        updatedPair.pnlUsd = Math.round(((pnlPct / 100) * g.marginPerSlotUsd * 10) * 100) / 100;

        if (updatedPair.price >= targetTp) {
          this.close(updatedPair, targetTp, 'TP_HIT (Mean Reversion)');
          updatedPair.status = 'COOLDOWN';
          updatedPair.cooldownUntil = now + COOLDOWN_MS;
        } else if (elapsed >= HOLD_LIMIT_SECONDS) {
          this.close(updatedPair, updatedPair.price, 'TIME_STOP_EXPIRED (Floor Broken)');
          updatedPair.status = 'COOLDOWN';
          updatedPair.cooldownUntil = now + COOLDOWN_MS;
        }
      }

      if (updatedPair.status !== 'ARMED') this.armedPrices.delete(pair.symbol);
      return updatedPair;
    });
  }

  private arm(pair: FleetPair, now: number) {
    const floor = pair.price * 0.997;
    pair.status = 'ARMED';
    pair.armedPrice = floor;
    pair.targetTp = floor * 1.005;
    pair.accumulatedFillUsd = 0;
    pair.armedAt = now;
    this.emit('ARMED', pair.symbol, {
      price: pair.price, floor, targetTp: pair.targetTp, cvi: pair.cvi, dropPct: pair.dropPct,
      queueHurdleUsd: this.governor.usdQueueHurdle,
    });
  }

  private close(pair: FleetPair, exitPrice: number, outcome: string) {
    const g = this.governor;
    const entryPrice = pair.armedPrice || pair.price;
    const hold = pair.holdSeconds || 22;
    const pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
    const notionalUsd = g.marginPerSlotUsd * 10;
    const grossPnlUsd = (pnlPct / 100) * notionalUsd;
    const feeUsd = (g.feeDragPct / 100) * notionalUsd;
    const netPnlUsd = grossPnlUsd - feeUsd;
    const netPnlPct = pnlPct - g.feeDragPct;
    const record: ShadowTradeLogRecord = {
      id: `fleet-${pair.symbol}-${this.now()}`,
      timestamp: new Date(this.now()).toISOString(),
      symbol: pair.symbol,
      entryPrice: Math.round(entryPrice * 10000) / 10000,
      exitPrice: Math.round(exitPrice * 10000) / 10000,
      cviAtEntry: pair.cvi || 3.85,
      queueClearanceSeconds: pair.armedAt && pair.fillTime ? Math.round((pair.fillTime - pair.armedAt) / 100) / 10 : 0,
      holdSeconds: hold,
      outcome,
      pnlPct: Math.round(pnlPct * 1000) / 1000,
      pnlUsd: Math.round(grossPnlUsd * 100) / 100,
      feeUsd: Math.round(feeUsd * 100) / 100,
      netPnlUsd: Math.round(netPnlUsd * 100) / 100,
      netPnlPct: Math.round(netPnlPct * 1000) / 1000,
    };
    this.emit(outcome.startsWith('TP_HIT') ? 'EXIT_TP' : 'EXIT_TIME_STOP', pair.symbol, {
      entry: record.entryPrice, exit: record.exitPrice, holdSeconds: hold, pnlPct: record.pnlPct, netPnlUsd: record.netPnlUsd,
    });
    this.options.onTrade?.(record);
  }

  // ---------- controls ----------
  manualArm(symbol: string) {
    const pair = this.pairs.find(p => p.symbol === symbol);
    if (!pair) throw new Error(`Unknown symbol ${symbol}`);
    if (!(pair.price > 0)) throw new Error(`No live price for ${symbol} yet`);
    if (pair.status !== 'IDLE') throw new Error(`${symbol} is ${pair.status}`);
    this.arm(pair, this.now());
    return pair;
  }
  halt() {
    this.halted = true;
    this.pairs = this.pairs.map(p => ({ ...p, status: 'IDLE', armedPrice: undefined, targetTp: undefined, accumulatedFillUsd: 0, activeSlot: undefined, holdSeconds: 0, cooldownUntil: undefined }));
    this.armedPrices.clear();
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
    const allowed = ['maxActiveSlots', 'totalRiskPoolUsd', 'marginPerSlotUsd', 'usdQueueHurdle', 'autoExecute', 'microCapitalTier'] as const;
    for (const key of Object.keys(patch)) if (!(allowed as readonly string[]).includes(key)) throw new Error(`Unsupported setting: ${key}`);
    const next = { ...this.governor, ...patch };
    if (!Number.isInteger(next.maxActiveSlots) || next.maxActiveSlots < 1 || next.maxActiveSlots > 5) throw new Error('maxActiveSlots must be 1-5');
    for (const key of ['totalRiskPoolUsd', 'marginPerSlotUsd', 'usdQueueHurdle'] as const) {
      if (typeof next[key] !== 'number' || !(next[key] > 0)) throw new Error(`Invalid ${key}`);
    }
    if (typeof next.autoExecute !== 'boolean') throw new Error('Invalid autoExecute');
    if (!['INSTITUTIONAL_250K', 'MICRO_FLIGHT_250', 'MINI_MICRO_10'].includes(next.microCapitalTier)) throw new Error('Invalid microCapitalTier');
    this.governor = next;
  }

  // ---------- read model ----------
  snapshot() {
    const pairs = this.pairs.map(({ cooldownUntil: _c, ...p }) => ({
      ...p,
      queueProgressPct: p.status === 'ARMED' ? Math.min(100, Math.round(((p.accumulatedFillUsd || 0) / this.governor.usdQueueHurdle) * 1000) / 10) : undefined,
    }));
    return {
      updatedAt: new Date(this.now()).toISOString(),
      source: 'LSV server fleet worker (real Binance USD-M ticks, no exchange orders)',
      mode: this.mode,
      halted: this.halted,
      feed: this.feed,
      governor: this.governor,
      counts: {
        armed: pairs.filter(p => p.status === 'ARMED').length,
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
    ws.on('open', () => { this.openSockets.add(ws); this.feed.connected = this.openSockets.size === 2; });
    ws.on('message', raw => {
      this.feed.messages++;
      this.feed.lastMessageAt = new Date().toISOString();
      try {
        const payload = JSON.parse(raw.toString());
        const stream: string = payload.stream || '';
        const data = payload.data || {};
        const symbol = String(data.s || stream.split('@')[0]).toUpperCase();
        if (stream.includes('@depth20')) {
          const bids = (data.b || []).map((b: [string, string]) => [Number(b[0]), Number(b[1])] as [number, number]);
          const asks = (data.a || []).map((a: [string, string]) => [Number(a[0]), Number(a[1])] as [number, number]);
          this.ingestDepth(symbol, bids, asks);
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
