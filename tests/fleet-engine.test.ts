import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetEngine, absorptionFloor } from '../src/engine/fleetEngine';
import type { ShadowTradeLogRecord } from '../src/types';

// Bid ladder below 98: $20k at each of 97.9, 97.8, 97.7... (size ~204).
const ladder = (top: number, levels: number, usdEach = 20000): Array<[number, number]> =>
  Array.from({ length: levels }, (_, i) => { const price = Math.round((top - i * 0.1) * 10) / 10; return [price, usdEach / price]; });
const asks: Array<[number, number]> = [[98.1, 1]];

function setup(fetchDepth = async (_: string): Promise<Array<[number, number]>> => []) {
  let now = 1_000_000;
  const trades: ShadowTradeLogRecord[] = [];
  const engine = new FleetEngine({ now: () => now, onTrade: t => trades.push(t), fetchDepth });
  const sol = () => engine.pairs.find(p => p.symbol === 'SOLUSDT')!;
  // First real tick sets the drop reference at 100.
  engine.ingestDepth('SOLUSDT', [[99.9, 1]], [[100.1, 1]]);
  engine.step();
  return { engine, trades, sol, advance: (ms: number) => { now += ms; } };
}
// 2% below the reference, $100k of long liquidations clustered at 97.5.
// Resting bids between price and cluster: 97.9..97.5 = 5 x $20k = $100k -> CVI 1.0.
// A $400k cluster gives CVI 4.0.
function cascade(t: ReturnType<typeof setup>, clusterUsd: number, levels = 20) {
  t.advance(1000);
  t.engine.ingestDepth('SOLUSDT', ladder(97.9, levels), asks);
  t.engine.ingestLiquidation('SOLUSDT', 'SELL', 97.5, clusterUsd / 97.5);
  t.engine.step();
}

test('no liquidations means CVI 0 and no arm, whatever the drop', () => {
  const t = setup();
  t.advance(1000);
  t.engine.ingestDepth('SOLUSDT', ladder(97.9, 20), asks);
  t.engine.step();
  assert.equal(t.sol().dropPct, 0.02);
  assert.equal(t.sol().cvi, 0);
  assert.equal(t.sol().status, 'IDLE');
});

test('CVI = real liquidation cluster / resting bids between price and cluster', () => {
  const t = setup();
  cascade(t, 100000, 40);
  assert.equal(t.sol().cvi, 1);
  assert.equal(t.sol().status, 'IDLE');
  t.engine.ingestLiquidation('SOLUSDT', 'SELL', 97.5, 300000 / 97.5);
  t.advance(1000); t.engine.step();
  assert.equal(t.sol().cvi, 4);
  assert.equal(t.sol().status, 'ARMED');
});

test('short liquidations (BUY) do not count for the long-only engine', () => {
  const t = setup();
  t.advance(1000);
  t.engine.ingestDepth('SOLUSDT', ladder(97.9, 20), asks);
  t.engine.ingestLiquidation('SOLUSDT', 'BUY', 97.5, 400000 / 97.5);
  t.engine.step();
  assert.equal(t.sol().cvi, 0);
});

test('floor is the bid where real resting bids reach 145% of the cluster', () => {
  const t = setup();
  cascade(t, 400000);
  // 145% x $400k = $580k = 29 levels of $20k -> beyond the 20-level stream.
  // With 40 levels streamed, the 29th level (97.9 - 2.8 = 95.1) is the floor.
  const u = setup();
  cascade(u, 400000, 40);
  const sol = u.sol();
  assert.equal(sol.status, 'ARMED');
  assert.equal(sol.armedPrice, 95.1);
  assert.ok(Math.abs(sol.targetTp! - 95.1 * 1.005) < 1e-9);
  const event = u.engine.events.at(-1)!;
  assert.equal(event.type, 'ARMED');
  assert.equal(event.data.absorptionTargetUsd, 580000);
  assert.equal(event.data.floorLevels, 29);
  assert.equal(absorptionFloor(ladder(97.9, 10), 580000), null);
});

test('20-level book too thin: 1000-level snapshot sets the floor; no floor there means no trade', async () => {
  const deep = setup(async () => ladder(97.9, 60));
  cascade(deep, 400000);
  assert.equal(deep.sol().status, 'IDLE'); // waiting for the deep book
  await new Promise(r => setImmediate(r));
  assert.equal(deep.sol().status, 'ARMED');
  assert.equal(deep.sol().armedPrice, 95.1);

  const thin = setup(async () => ladder(97.9, 25));
  cascade(thin, 400000);
  await new Promise(r => setImmediate(r));
  assert.equal(thin.sol().status, 'IDLE');
  assert.equal(thin.engine.events.at(-1)!.type, 'NO_FLOOR');
});

function armSol() {
  const t = setup();
  cascade(t, 400000, 40);
  assert.equal(t.sol().status, 'ARMED');
  return t;
}

test('only real seller-initiated volume at or below the floor fills the $150k queue', () => {
  const t = armSol();
  const floor = t.sol().armedPrice!;
  t.engine.ingestTrade('SOLUSDT', floor, 2000, false); // buyer-initiated: ignored
  t.engine.ingestTrade('SOLUSDT', floor + 1, 2000, true); // above the floor: ignored
  t.engine.ingestTrade('SOLUSDT', floor, 1000, true); // $95.1k
  t.advance(1000); t.engine.step();
  assert.equal(t.sol().status, 'ARMED');
  t.engine.ingestTrade('SOLUSDT', floor, 600, true); // total > $150k
  t.advance(1000); t.engine.step();
  assert.equal(t.sol().status, 'FILLED');
  assert.equal(t.sol().price, floor);
});

test('unfilled nets expire after 300s', () => {
  const t = armSol();
  t.advance(299_000); t.engine.step();
  assert.equal(t.sol().status, 'ARMED');
  t.advance(1000); t.engine.step();
  assert.notEqual(t.sol().status, 'ARMED');
  assert.ok(t.engine.events.some(e => e.type === 'ARMED_EXPIRED'));
});

function fillSol() {
  const t = armSol();
  t.engine.ingestTrade('SOLUSDT', t.sol().armedPrice!, 2000, true);
  t.advance(1000); t.engine.step();
  assert.equal(t.sol().status, 'FILLED');
  return t;
}

test('take-profit only when a real price reaches the target', () => {
  const t = fillSol();
  const target = t.sol().targetTp!;
  t.engine.ingestTrade('SOLUSDT', target - 0.01, 1, false);
  t.advance(1000); t.engine.step();
  assert.equal(t.sol().status, 'FILLED');
  t.engine.ingestTrade('SOLUSDT', target + 0.01, 1, false);
  t.advance(1000); t.engine.step();
  assert.equal(t.sol().status, 'COOLDOWN');
  assert.equal(t.trades[0].outcome, 'TP_HIT (Mean Reversion)');
  assert.equal(t.trades[0].exitPrice, Math.round(target * 10000) / 10000);
});

test('90s time stop exits at the real price', () => {
  const t = fillSol();
  t.engine.ingestTrade('SOLUSDT', 94.9, 1, true);
  t.advance(90_000); t.engine.step();
  assert.equal(t.trades[0].outcome, 'TIME_STOP_EXPIRED (Floor Broken)');
  assert.equal(t.trades[0].exitPrice, 94.9);
});

test('manual arm needs a real cascade and uses the same floor', () => {
  const t = setup();
  t.advance(1000);
  t.engine.ingestDepth('SOLUSDT', ladder(97.9, 40), asks);
  t.engine.step();
  assert.throws(() => t.engine.manualArm('SOLUSDT'), /No long liquidations/);
  t.engine.ingestLiquidation('SOLUSDT', 'SELL', 97.5, 400000 / 97.5);
  assert.deepEqual(t.engine.manualArm('SOLUSDT'), { symbol: 'SOLUSDT', result: 'ARMED' });
  assert.equal(t.sol().armedPrice, 95.1);
});

test('halt clears nets and stops the loop', () => {
  const t = armSol();
  t.engine.halt();
  assert.equal(t.sol().status, 'IDLE');
  t.engine.ingestLiquidation('SOLUSDT', 'SELL', 97.5, 400000 / 97.5);
  t.advance(1000); t.engine.step();
  assert.equal(t.sol().status, 'IDLE');
});
