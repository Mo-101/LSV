import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetEngine } from '../src/engine/fleetEngine';
import type { ShadowTradeLogRecord } from '../src/types';

// Thin book: top 10 bids well under $10k, so a 2% drop gives CVI 5.6.
const thinBids: Array<[number, number]> = [[97.9, 1]];
const asks: Array<[number, number]> = [[98.1, 1]];

function setup() {
  let now = 1_000_000;
  const trades: ShadowTradeLogRecord[] = [];
  const engine = new FleetEngine({ now: () => now, onTrade: t => trades.push(t) });
  const sol = () => engine.pairs.find(p => p.symbol === 'SOLUSDT')!;
  // First real tick sets the reference price at 100, then price drops 2%.
  engine.ingestDepth('SOLUSDT', [[99.9, 1]], [[100.1, 1]]);
  engine.step();
  return { engine, trades, sol, advance: (ms: number) => { now += ms; } };
}
function armSol(t: ReturnType<typeof setup>) {
  t.advance(1000);
  t.engine.ingestDepth('SOLUSDT', thinBids, asks);
  t.engine.step();
}

test('pairs without real ticks never arm', () => {
  const engine = new FleetEngine();
  engine.step();
  assert.ok(engine.pairs.every(p => p.status === 'IDLE' && p.price === 0));
});

test('arms on real drop and CVI with the same floor and target formulas', () => {
  const t = setup();
  assert.equal(t.sol().refPrice, 100);
  armSol(t);
  const sol = t.sol();
  assert.equal(sol.status, 'ARMED');
  assert.equal(sol.dropPct, 0.02);
  assert.equal(sol.cvi, 5.6);
  assert.ok(Math.abs(sol.armedPrice! - 98 * 0.997) < 1e-9);
  assert.ok(Math.abs(sol.targetTp! - 98 * 0.997 * 1.005) < 1e-9);
  assert.equal(t.engine.events.at(-1)!.type, 'ARMED');
});

test('only real seller-initiated volume at or below the floor fills the $150k queue', () => {
  const t = setup();
  armSol(t);
  const floor = t.sol().armedPrice!;
  t.engine.ingestTrade('SOLUSDT', floor, 2000, false); // buyer-initiated: ignored
  t.engine.ingestTrade('SOLUSDT', floor + 1, 2000, true); // above the floor: ignored
  t.engine.ingestTrade('SOLUSDT', floor, 1000, true); // $97.7k
  t.advance(1000); t.engine.step();
  assert.equal(t.sol().status, 'ARMED');
  assert.ok(Math.abs(t.sol().accumulatedFillUsd! - floor * 1000) < 1e-6);
  t.engine.ingestTrade('SOLUSDT', floor, 600, true); // total > $150k
  t.advance(1000); t.engine.step();
  const sol = t.sol();
  assert.equal(sol.status, 'FILLED');
  assert.equal(sol.price, floor);
  assert.equal(sol.activeSlot, 1);
});

function fillSol(t: ReturnType<typeof setup>) {
  armSol(t);
  t.engine.ingestTrade('SOLUSDT', t.sol().armedPrice!, 2000, true);
  t.advance(1000); t.engine.step();
  assert.equal(t.sol().status, 'FILLED');
}

test('take-profit only when a real price reaches the target, then 6s cooldown', () => {
  const t = setup();
  fillSol(t);
  const target = t.sol().targetTp!;
  t.engine.ingestTrade('SOLUSDT', target - 0.01, 1, false);
  t.advance(1000); t.engine.step();
  assert.equal(t.sol().status, 'FILLED');
  t.engine.ingestTrade('SOLUSDT', target + 0.01, 1, false);
  t.advance(1000); t.engine.step();
  assert.equal(t.sol().status, 'COOLDOWN');
  assert.equal(t.trades.length, 1);
  assert.equal(t.trades[0].outcome, 'TP_HIT (Mean Reversion)');
  assert.equal(t.trades[0].exitPrice, Math.round(target * 10000) / 10000);
  // Price back at the reference: after the cooldown the pair returns to IDLE.
  t.engine.ingestDepth('SOLUSDT', [[99.9, 1]], [[100.1, 1]]);
  t.advance(6000); t.engine.step();
  assert.equal(t.sol().status, 'IDLE');
});

test('90s time stop exits at the real price', () => {
  const t = setup();
  fillSol(t);
  t.engine.ingestTrade('SOLUSDT', 97.5, 1, true);
  t.advance(90_000); t.engine.step();
  assert.equal(t.trades.length, 1);
  assert.equal(t.trades[0].outcome, 'TIME_STOP_EXPIRED (Floor Broken)');
  assert.equal(t.trades[0].exitPrice, 97.5);
  assert.ok(t.trades[0].pnlUsd < 0);
});

test('halt clears nets and stops the loop; manual arm needs a live price', () => {
  const t = setup();
  armSol(t);
  t.engine.halt();
  assert.equal(t.sol().status, 'IDLE');
  t.engine.ingestDepth('SOLUSDT', thinBids, asks);
  t.advance(1000); t.engine.step();
  assert.equal(t.sol().status, 'IDLE');
  t.engine.resume();
  assert.throws(() => t.engine.manualArm('BTCUSDT'), /No live price/);
  assert.equal(t.engine.manualArm('SOLUSDT').status, 'ARMED');
});

test('full slots block new arming', () => {
  const t = setup();
  t.engine.updateGovernor({ maxActiveSlots: 1 });
  fillSol(t);
  t.engine.ingestDepth('ETHUSDT', [[99.9, 1]], [[100.1, 1]]);
  t.advance(1000); t.engine.step();
  t.engine.ingestDepth('ETHUSDT', thinBids, asks);
  t.advance(1000); t.engine.step();
  assert.equal(t.engine.pairs.find(p => p.symbol === 'ETHUSDT')!.status, 'IDLE');
});
