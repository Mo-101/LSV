import test from 'node:test';
import assert from 'node:assert/strict';
import { finiteNumber } from '../src/engine/tradeNumbers';
import { LiquidationWindow } from '../src/engine/liquidationWindow';

test('ledger preserves zero fees and break-even P&L', () => {
  assert.equal(finiteNumber('0', 175), 0);
  assert.equal(finiteNumber('0.000', -175), 0);
  assert.equal(finiteNumber('-0.5', 175), -0.5);
  assert.equal(finiteNumber(undefined, 175), 175);
  assert.equal(finiteNumber('bad', 175), 175);
});

test('continuous liquidation traffic cannot extend the thirty-second window', () => {
  const window = new LiquidationWindow();
  window.add('BTCUSDT', 'SELL', 30000, 0);
  window.add('BTCUSDT', 'SELL', 10000, 20000);
  assert.deepEqual(window.add('BTCUSDT', 'SELL', 10000, 31000), { totalUsd: 20000, count: 2 });
});

test('liquidation windows separate symbols and directions', () => {
  const window = new LiquidationWindow();
  window.add('BTCUSDT', 'SELL', 30000, 0);
  window.add('ETHUSDT', 'SELL', 40000, 0);
  assert.deepEqual(window.add('BTCUSDT', 'BUY', 1000, 1), { totalUsd: 1000, count: 1 });
  assert.deepEqual(window.add('BTCUSDT', 'SELL', 1000, 30000), { totalUsd: 1000, count: 1 });
});
