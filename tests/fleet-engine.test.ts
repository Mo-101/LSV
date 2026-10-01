import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetEngine, sweepAsksForUsd, sweepBidsForQty } from '../src/engine/fleetEngine';
import type { ShadowTradeLogRecord } from '../src/types';

type Levels = Array<[number, number]>;
// $20k of bids at each 0.1 step below `top`.
const ladder = (top: number, levels: number, usdEach = 20000): Levels =>
  Array.from({ length: levels }, (_, i) => { const price = Math.round((top - i * 0.1) * 10) / 10; return [price, usdEach / price]; });
const deepAsks = (price: number): Levels => [[price, 1_000_000]];

function setup(fetchDepth?: (s: string) => Promise<{ bids: Levels; asks: Levels }>) {
  let now = 1_000_000;
  const trades: ShadowTradeLogRecord[] = [];
  const engine = new FleetEngine({ now: () => now, onTrade: t => trades.push(t), fetchDepth });
  engine.updateGovernor({ marginPerSlotUsd: 1000 }); // $10k notional at 10x
  const pair = (s = 'SOLUSDT') => engine.pairs.find(p => p.symbol === s)!;
  const at = (ms: number) => { now += ms; };
  const quiet = (s: string, price: number) => {
    engine.ingestDepth(s, [[price - 0.05, 1000]], [[price + 0.05, 1000]]);
    engine.ingestTrade(s, price, 1, false);
  };
  return { engine, trades, pair, at, quiet, now: () => now };
}

// Price 100 (sets the reference and the pre-cascade price), then 30s later a
// long cascade: $400k liquidated at 97.5, trades down to 97.5, bids from 97.9.
// CVI = $400k / $100k of bids between 97.95 and 97.5 = 4. Drop 2.05%.
function cascade(t: ReturnType<typeof setup>, opts: { asks?: Levels; clusterUsd?: number; symbol?: string; start?: number } = {}) {
  const s = opts.symbol ?? 'SOLUSDT';
  t.quiet(s, opts.start ?? 100);
  t.engine.step();
  t.at(30_000);
  t.engine.ingestDepth(s, ladder(97.9, 20), opts.asks ?? deepAsks(98));
  t.engine.ingestTrade(s, 97.5, 1, true);
  t.engine.ingestLiquidation(s, 'SELL', 97.5, (opts.clusterUsd ?? 400000) / 97.5);
  t.engine.step();
}

test('sweep helpers price the full size against the real book', () => {
  assert.deepEqual(sweepAsksForUsd([[100, 1], [101, 10]], 302), { vwap: 302 / (1 + 202 / 101), qty: 3, complete: true });
  assert.equal(sweepAsksForUsd([[100, 1]], 500).complete, false);
  assert.equal(sweepBidsForQty([[99, 1], [98, 1]], 2).vwap, 98.5);
  assert.equal(sweepBidsForQty([[99, 1]], 2).complete, false);
});

test('no long liquidations: CVI 0, no signal, whatever the drop', () => {
  const t = setup();
  t.quiet('SOLUSDT', 100); t.engine.step();
  t.at(30_000);
  t.engine.ingestDepth('SOLUSDT', ladder(97.9, 20), deepAsks(98));
  t.engine.ingestLiquidation('SOLUSDT', 'BUY', 97.5, 400000 / 97.5); // short liquidation: ignored
  t.engine.step();
  assert.ok(t.pair().dropPct > 0.02);
  assert.equal(t.pair().cvi, 0);
  assert.equal(t.engine.events.length, 0);
});

test('real cascade with enough edge: taker entry at the ask-sweep VWAP', () => {
  const t = setup();
  cascade(t);
  const p = t.pair();
  assert.equal(p.cvi, 4);
  assert.equal(p.status, 'FILLED');
  assert.equal(p.entryPrice, 98);
  // target = entry + 50% of (pre-cascade 100 - cascade low 97.5)
  assert.equal(p.targetPrice, 99.25);
  const filled = t.engine.events.find(e => e.type === 'FILLED')!;
  assert.equal(filled.data.preCascadePrice, 100);
  assert.equal(filled.data.cascadeLow, 97.5);
  assert.equal(filled.data.exitSlippagePct, 0);
  // (99.25 / 98 - 1) * 100 - 0.10% fees
  assert.ok(Math.abs((filled.data.netEdgePct as number) - ((99.25 / 98 - 1) * 100 - 0.1)) < 1e-9);
});

test('edge below 0.15% after fees and slippage: rejected, no entry', () => {
  const t = setup();
  // Reference 100, then a slow slide to 98.1, then a small cascade to 97.9.
  t.quiet('SOLUSDT', 100); t.engine.step();
  t.at(30_000); t.quiet('SOLUSDT', 98.1); t.engine.step();
  t.at(30_000);
  t.engine.ingestDepth('SOLUSDT', ladder(97.9, 20), deepAsks(98));
  t.engine.ingestTrade('SOLUSDT', 97.9, 1, true);
  t.engine.ingestLiquidation('SOLUSDT', 'SELL', 97.9, 400000 / 97.9);
  t.engine.step();
  assert.equal(t.pair().status, 'IDLE');
  const rejected = t.engine.events.find(e => e.type === 'EDGE_REJECTED')!;
  assert.equal(rejected.data.reason, 'EDGE_TOO_SMALL');
  assert.equal(rejected.data.targetPrice, 98 + 0.5 * (98.1 - 97.9));
});

test('stream asks too thin for the size: decided on a 1000-level snapshot', async () => {
  const deep = setup(async () => ({ bids: ladder(97.9, 200), asks: deepAsks(98) }));
  cascade(deep, { asks: [[98, 1]] }); // $98 of asks in the stream
  assert.equal(deep.pair().status, 'IDLE');
  await new Promise(r => setImmediate(r));
  assert.equal(deep.pair().status, 'FILLED');
  assert.equal(deep.engine.events.find(e => e.type === 'FILLED')!.data.book, 'snapshot1000');

  const thin = setup(async () => ({ bids: ladder(97.9, 200), asks: [[98, 2]] }));
  cascade(thin, { asks: [[98, 1]] });
  await new Promise(r => setImmediate(r));
  assert.equal(thin.pair().status, 'IDLE');
  assert.equal(thin.engine.events.at(-1)!.type, 'NO_DEPTH');
});

test('take-profit when selling into the real bids reaches the target', () => {
  const t = setup();
  cascade(t);
  t.at(1000);
  t.engine.ingestDepth('SOLUSDT', [[99.2, 1000]], deepAsks(99.3));
  t.engine.step();
  assert.equal(t.pair().status, 'FILLED');
  t.at(1000);
  t.engine.ingestDepth('SOLUSDT', [[99.3, 1000]], deepAsks(99.4));
  t.engine.step();
  assert.equal(t.pair().status, 'COOLDOWN');
  assert.equal(t.trades[0].exitPrice, 99.3);
  assert.equal(t.trades[0].entryPrice, 98);
  assert.equal(t.trades[0].feeUsd, 10); // 0.10% of $10k
  assert.ok(t.trades[0].netPnlUsd! > 0);
});

test('90s time stop exits at the bid-sweep VWAP', () => {
  const t = setup();
  cascade(t);
  t.at(90_000);
  t.engine.ingestDepth('SOLUSDT', [[97.6, 50], [97.5, 1000]], deepAsks(97.7));
  t.engine.step();
  const trade = t.trades[0];
  assert.equal(trade.outcome, 'TIME_STOP_EXPIRED (90s, bid sweep)');
  const qty = 10000 / 98;
  assert.ok(Math.abs(trade.exitPrice - Math.round(((50 * 97.6 + (qty - 50) * 97.5) / qty) * 1e6) / 1e6) < 1e-9);
  assert.ok(trade.netPnlUsd! < 0);
});

test('slots full and signal-only mode: signal but no entry', () => {
  const t = setup();
  t.engine.updateGovernor({ maxActiveSlots: 1 });
  cascade(t);
  cascade(t, { symbol: 'ETHUSDT' });
  assert.equal(t.pair('ETHUSDT').status, 'IDLE');
  assert.ok(t.engine.events.some(e => e.type === 'SLOT_BLOCKED' && e.symbol === 'ETHUSDT'));

  const s = setup();
  s.engine.setMode('SIGNAL_ONLY');
  cascade(s);
  assert.equal(s.pair().status, 'IDLE');
  assert.ok(s.engine.events.some(e => e.type === 'SIGNAL'));
});

test('manual entry needs a real cascade and uses the same gate; halt clears positions', () => {
  const t = setup();
  t.quiet('SOLUSDT', 100); t.engine.step();
  assert.throws(() => t.engine.manualArm('SOLUSDT'), /No long liquidations/);
  t.at(30_000);
  t.engine.ingestDepth('SOLUSDT', ladder(97.9, 20), deepAsks(98));
  t.engine.ingestTrade('SOLUSDT', 97.5, 1, true);
  t.engine.step();
  t.engine.ingestLiquidation('SOLUSDT', 'SELL', 97.5, 100);
  assert.deepEqual(t.engine.manualArm('SOLUSDT'), { symbol: 'SOLUSDT', status: 'FILLED' });
  t.engine.halt();
  assert.equal(t.pair().status, 'IDLE');
});
