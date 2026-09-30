import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_RUNTIME_CONFIG } from '../src/engine/runtimeConfig';
import type { ShadowOrder } from '../src/engine/shadowExecution';
import { DemoMirror, DemoRejection, type DemoExchange, type DemoOrder, type LimitRequest } from '../src/engine/demoMirror';

function fakeExchange() {
  const orders = new Map<string, DemoOrder>();
  const calls: any[] = [];
  const state = { bid: 50, position: 0, rejectEntry: false, ambiguousEntry: false, nextId: 1 };
  const exchange: DemoExchange = {
    bookTicker: async () => ({ bid: state.bid, ask: state.bid + 0.01 }),
    prepare: async (symbol, leverage) => { calls.push(['prepare', symbol, leverage]); },
    placeLimit: async (o: LimitRequest) => {
      calls.push(['limit', o]);
      if (!o.reduceOnly && state.rejectEntry) throw new DemoRejection('Below minimum notional');
      if (!o.reduceOnly && state.ambiguousEntry) throw new Error('Timed out');
      const order = { orderId: state.nextId++, clientOrderId: o.clientOrderId, status: 'NEW', price: o.price, avgPrice: 0, origQty: o.quantity, executedQty: 0 };
      orders.set(o.clientOrderId, order);
      return { ...order };
    },
    placeMarketClose: async (symbol, quantity, clientOrderId) => {
      calls.push(['close', symbol, quantity]);
      state.position -= quantity;
      const order = { orderId: state.nextId++, clientOrderId, status: 'FILLED', price: 0, avgPrice: state.bid, origQty: quantity, executedQty: quantity };
      orders.set(clientOrderId, order);
      return { ...order };
    },
    cancel: async (_symbol, clientOrderId) => {
      calls.push(['cancel', clientOrderId]);
      const order = orders.get(clientOrderId);
      if (order && ['NEW', 'PARTIALLY_FILLED'].includes(order.status)) order.status = 'CANCELED';
    },
    query: async (_symbol, clientOrderId) => { const o = orders.get(clientOrderId); return o ? { ...o } : null; },
    positionAmt: async () => state.position,
    balance: async () => 5000,
  };
  const fill = (clientOrderId: string, price: number) => {
    const order = orders.get(clientOrderId)!;
    order.status = 'FILLED'; order.executedQty = order.origQty; order.avgPrice = price;
    state.position += /-e$/.test(clientOrderId) ? order.origQty : -order.origQty;
  };
  return { exchange, orders, calls, state, fill };
}

function setup(mirrorToDemo = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsv-mirror-'));
  const fake = fakeExchange();
  let now = 1_000_000;
  const config = () => ({ ...DEFAULT_RUNTIME_CONFIG, mode: 'PAPER' as const, mirrorToDemo });
  const file = path.join(dir, 'demo-mirror.json');
  const mirror = new DemoMirror(fake.exchange, config, file, () => now);
  // Shadow floor 1% below the mainnet best bid of 100.
  const shadow: ShadowOrder = { id: 'shadow-SOLUSDT-1', symbol: 'SOLUSDT', entryPrice: 99, quantity: 0.5, targetTp: 99 * 1.005,
    createdAt: now, entryDeadline: now + 300000, holdMs: 90000, queueAheadUsd: 150000, consumedUsd: 0, exitConsumedQty: 0, state: 'ARMED' };
  return { ...fake, mirror, shadow, file, config, advance: (ms: number) => { now += ms; }, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('shadow arm places a post-only demo limit at the same depth below the demo bid, same size', async () => {
  const t = setup();
  try {
    const record = (await t.mirror.onShadowArmed(t.shadow, 100))!;
    assert.equal(record.state, 'ACTIVE');
    const [, entry] = t.calls.find(c => c[0] === 'limit');
    assert.equal(entry.side, 'BUY'); assert.equal(entry.postOnly, true); assert.equal(entry.reduceOnly, false);
    assert.ok(Math.abs(entry.price - 50 * 0.99) < 1e-9, `demo price ${entry.price}`);
    assert.equal(entry.quantity, 0.5);
    assert.deepEqual(t.calls[0], ['prepare', 'SOLUSDT', DEFAULT_RUNTIME_CONFIG.leverage]);
  } finally { t.cleanup(); }
});

test('mirror off or no credentials: nothing is sent', async () => {
  const t = setup(false);
  try {
    assert.equal(await t.mirror.onShadowArmed(t.shadow, 100), null);
    assert.equal(t.calls.length, 0);
    const unconfigured = new DemoMirror(null, t.config, path.join(path.dirname(t.file), 'x.json'));
    assert.equal(await unconfigured.onShadowArmed(t.shadow, 100), null);
  } finally { t.cleanup(); }
});

test('demo fill gets a reduce-only TP at the shadow take-profit percentage', async () => {
  const t = setup();
  try {
    const record = (await t.mirror.onShadowArmed(t.shadow, 100))!;
    t.fill(record.entry.clientOrderId, 49.5);
    await t.mirror.tick([t.shadow]);
    const [, tp] = t.calls.filter(c => c[0] === 'limit')[1];
    assert.equal(tp.side, 'SELL'); assert.equal(tp.reduceOnly, true);
    assert.ok(Math.abs(tp.price - 49.5 * 1.005) < 1e-9);
    assert.equal(tp.quantity, 0.5);
    await t.mirror.tick([t.shadow]);
    assert.equal(t.calls.filter(c => c[0] === 'limit').length, 2, 'TP placed once');
  } finally { t.cleanup(); }
});

test('shadow entry canceled: demo entry is canceled and nothing is closed', async () => {
  const t = setup();
  try {
    const record = (await t.mirror.onShadowArmed(t.shadow, 100))!;
    await t.mirror.tick([{ ...t.shadow, state: 'CANCELED' }]);
    assert.equal(record.state, 'DONE');
    assert.equal(record.entry.status, 'CANCELED');
    assert.equal(t.calls.filter(c => c[0] === 'close').length, 0);
    assert.equal(record.realizedPnlUsd, undefined);
  } finally { t.cleanup(); }
});

test('shadow time-stop: demo TP is canceled and the remaining position is closed', async () => {
  const t = setup();
  try {
    const record = (await t.mirror.onShadowArmed(t.shadow, 100))!;
    t.fill(record.entry.clientOrderId, 49.5);
    await t.mirror.tick([{ ...t.shadow, state: 'FILLED' }]);
    t.state.bid = 49.4;
    await t.mirror.tick([{ ...t.shadow, state: 'TIME_STOP' }]);
    assert.equal(record.tp?.status, 'CANCELED');
    assert.deepEqual(t.calls.find(c => c[0] === 'close'), ['close', 'SOLUSDT', 0.5]);
    assert.equal(record.state, 'DONE');
    assert.ok(Math.abs(record.realizedPnlUsd! - (49.4 - 49.5) * 0.5) < 1e-9);
    assert.equal(t.state.position, 0);
  } finally { t.cleanup(); }
});

test('demo TP already filled when the shadow exits: no extra close', async () => {
  const t = setup();
  try {
    const record = (await t.mirror.onShadowArmed(t.shadow, 100))!;
    t.fill(record.entry.clientOrderId, 49.5);
    await t.mirror.tick([t.shadow]);
    t.fill(record.tp!.clientOrderId, 49.7475);
    await t.mirror.tick([{ ...t.shadow, state: 'TP' }]);
    assert.equal(t.calls.filter(c => c[0] === 'close').length, 0);
    assert.equal(record.state, 'DONE');
    assert.ok(record.realizedPnlUsd! > 0);
  } finally { t.cleanup(); }
});

test('definitive rejection fails the mirror; ambiguous placement is resolved by client ID', async () => {
  const t = setup();
  try {
    t.state.rejectEntry = true;
    const rejected = (await t.mirror.onShadowArmed(t.shadow, 100))!;
    assert.equal(rejected.state, 'FAILED'); assert.match(rejected.error!, /minimum notional/);

    t.state.rejectEntry = false; t.state.ambiguousEntry = true;
    const other = { ...t.shadow, id: 'shadow-DOGEUSDT-1', symbol: 'DOGEUSDT' };
    const unknown = (await t.mirror.onShadowArmed(other, 100))!;
    assert.equal(unknown.state, 'PLACING');
    await t.mirror.tick([other]);
    assert.equal(unknown.state, 'PLACING', 'not assumed rejected while unconfirmed');
    t.advance(61000);
    await t.mirror.tick([other]);
    assert.equal(unknown.state, 'FAILED');
    assert.ok(t.calls.some(c => c[0] === 'cancel' && c[1] === unknown.entry.clientOrderId), 'late arrival is canceled');
  } finally { t.cleanup(); }
});

test('mirror journal survives restart and a missing shadow order closes the demo side', async () => {
  const t = setup();
  try {
    const record = (await t.mirror.onShadowArmed(t.shadow, 100))!;
    t.fill(record.entry.clientOrderId, 49.5);
    const restarted = new DemoMirror(t.exchange, t.config, t.file);
    assert.equal(restarted.records[0].state, 'ACTIVE');
    await restarted.tick([]);
    assert.equal(restarted.records[0].state, 'DONE');
    assert.equal(t.state.position, 0);
  } finally { t.cleanup(); }
});

test('a second shadow entry on a symbol whose demo mirror is still open is not mirrored', async () => {
  const t = setup();
  try {
    await t.mirror.onShadowArmed(t.shadow, 100);
    const second = (await t.mirror.onShadowArmed({ ...t.shadow, id: 'shadow-SOLUSDT-2' }, 100))!;
    assert.equal(second.state, 'FAILED');
    assert.equal(t.calls.filter(c => c[0] === 'limit').length, 1);
  } finally { t.cleanup(); }
});
