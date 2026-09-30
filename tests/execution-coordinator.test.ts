import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore, DEFAULT_RUNTIME_CONFIG, validateConfig } from '../src/engine/runtimeConfig';
import { ExecutionCoordinator, exchangeSlots } from '../src/engine/executionCoordinator';
import { consumeTape, ShadowOrder, ShadowExecution } from '../src/engine/shadowExecution';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsv-tests-'));
  const config = new ConfigStore(path.join(dir, 'config.json'));
  config.update({ mode: 'LIVE', autoExecute: true, allowedSymbols: [], marginPerSlotUsd: 5, totalRiskPoolUsd: 10, maxActiveSlots: 2 }, 0);
  let now = 1000000, nextId = 1;
  const orders: any[] = [], positions: any[] = [], history = new Map<string, any>();
  const behavior = { rejectClose: false, rejectCancel: false, ambiguousEntry: false, unavailable: false, leavePosition: false };
  const calls: any[] = [];
  const exchange: any = {
    readExchangeState: async () => {
      if (behavior.unavailable) throw new Error('Exchange unavailable');
      return structuredClone({ orders, positions, balance: 5000, fetchedAt: now });
    },
    queryOrder: async (_symbol: string, clientId: string) => history.get(clientId) ?? null,
    ensureIsolatedMargin: async () => ({ ok: true }),
    setLeverage: async (...args: any[]) => { calls.push(['leverage', ...args]); },
    placePostOnlyLimit: async (symbol: string, side: string, price: number, qty: number, reduceOnly: boolean, clientOrderId: string) => {
      calls.push(['limit', symbol, qty, reduceOnly]);
      if (behavior.ambiguousEntry && !reduceOnly) return { ok: false, error: 'Timed out' };
      const o = { symbol, side, price: String(price), origQty: String(qty), executedQty: '0', reduceOnly, clientOrderId,
        orderId: nextId++, positionSide: 'BOTH', status: 'NEW', time: now, updateTime: now };
      orders.push(o); history.set(clientOrderId, o);
      return { ok: true, orderId: o.orderId, raw: o };
    },
    cancelOrder: async (_symbol: string, orderId: number) => {
      calls.push(['cancel', orderId]);
      if (behavior.rejectCancel) return { ok: false, error: 'Cancellation rejected' };
      const i = orders.findIndex(o => o.orderId === orderId);
      if (i >= 0) { orders[i].status = 'CANCELED'; orders.splice(i, 1); }
      return { ok: true };
    },
    placeMarketOrder: async (symbol: string, side: string, quantity: number, reduceOnly: boolean, clientId: string) => {
      calls.push(['market', symbol, side, quantity, reduceOnly]);
      if (behavior.rejectClose) return { ok: false, error: 'Market close rejected', raw: { code: -2022 } };
      history.set(clientId, { status: 'FILLED', orderId: nextId++ });
      if (!behavior.leavePosition) positions.splice(0);
      return { ok: true, orderId: nextId++ };
    },
  };
  const file = path.join(dir, 'journal.json');
  const engine = new ExecutionCoordinator(exchange, config, file, () => now);
  const fill = (symbol = 'SOLUSDT', partial = false) => {
    const order = orders.find(o => o.symbol === symbol && !o.reduceOnly);
    order.status = partial ? 'PARTIALLY_FILLED' : 'FILLED'; order.executedQty = partial ? '0.1' : order.origQty;
    if (!partial) orders.splice(orders.indexOf(order), 1);
    positions.push({ symbol, positionSide: 'BOTH', positionAmt: order.executedQty, entryPrice: order.price, unRealizedProfit: '0', updateTime: now });
  };
  return { config, engine, orders, positions, behavior, calls, fill, exchange, file, advance: (ms: number) => { now += ms; }, now: () => now, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('config persists, rejects invalid pool allocation and stale revisions', () => {
  const f = fixture();
  try {
    assert.throws(() => validateConfig(DEFAULT_RUNTIME_CONFIG, { maxActiveSlots: 5 }), /risk pool/);
    assert.throws(() => f.config.update({ mode: 'PAPER' }, 0), /another session/);
    assert.throws(() => validateConfig(DEFAULT_RUNTIME_CONFIG, { leverage: NaN }), /leverage/);
    assert.throws(() => validateConfig(DEFAULT_RUNTIME_CONFIG, { mode: 'MAINNET' as any }), /mode/);
    const fresh = new ConfigStore(path.join(path.dirname(f.file), 'config.json'));
    assert.equal(fresh.get().mode, 'LIVE');
  } finally { f.cleanup(); }
});

test('slots derive from exchange including unmanaged orders, never a stale journal', () => {
  const f = fixture();
  try {
    const rows = exchangeSlots({ orders: [{ symbol: 'SOLUSDT', positionSide: 'BOTH', orderId: 77, clientOrderId: 'external', side: 'BUY', price: '100', origQty: '1', executedQty: '0', time: 1 } as any], positions: [], balance: 1, fetchedAt: 1 }, {});
    assert.equal(rows.length, 1); assert.equal(rows[0].filled, false); assert.equal(rows[0].managed, false);
    assert.deepEqual(exchangeSlots({ orders: [], positions: [], balance: 1, fetchedAt: 1 }, { SOLUSDT: {} as any }), []);
  } finally { f.cleanup(); }
});

test('simultaneous entry requests cannot exceed configured slots; sizing uses margin and leverage', async () => {
  const f = fixture();
  try {
    f.config.update({ maxActiveSlots: 1 }, 1);
    const results = await Promise.allSettled([f.engine.submit('SOLUSDT', 100), f.engine.submit('XRPUSDT', 1)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(f.calls.filter(c => c[0] === 'limit').length, 1);
    assert.equal(f.calls.find(c => c[0] === 'limit')[2], 0.5);
    assert.deepEqual(f.calls[0], ['leverage', 'SOLUSDT', 10]);
  } finally { f.cleanup(); }
});

test('mode, halt, auto-entry flag and symbol allowlist are enforced server-side', async () => {
  const f = fixture();
  try {
    f.config.update({ mode: 'PAPER' }, 1);
    await assert.rejects(f.engine.submit('SOLUSDT', 100), /disabled/);
    f.config.update({ mode: 'LIVE', halted: true }, 2);
    await assert.rejects(f.engine.submit('SOLUSDT', 100), /disabled/);
    f.config.update({ halted: false, autoExecute: false, allowedSymbols: ['SOLUSDT'] }, 3);
    await assert.rejects(f.engine.submit('SOLUSDT', 100, true), /disabled/);
    await assert.rejects(f.engine.submit('BTCUSDT', 100), /filter/);
    assert.equal(f.calls.length, 0);
  } finally { f.cleanup(); }
});

test('restart recovers filled exposure and time-stop; failed close retains durable tracking', async () => {
  const f = fixture();
  try {
    await f.engine.submit('SOLUSDT', 100); f.fill(); await f.engine.reconcile();
    const restored = new ExecutionCoordinator(f.exchange, f.config, f.file, f.now);
    f.advance(91000); f.behavior.rejectClose = true;
    await restored.reconcile();
    assert.equal(restored.journal.SOLUSDT.state, 'CLOSING');
    assert.match(restored.journal.SOLUSDT.lastError!, /rejected/);
    assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).SOLUSDT.state, 'CLOSING');
    f.behavior.rejectClose = false;
    await restored.reconcile();
    assert.equal(restored.journal.SOLUSDT, undefined); assert.equal(f.positions.length, 0);
  } finally { f.cleanup(); }
});

test('accepted close is not treated as flat while exchange position remains', async () => {
  const f = fixture();
  try {
    await f.engine.submit('SOLUSDT', 100); f.fill(); await f.engine.reconcile();
    f.advance(91000); f.behavior.leavePosition = true; await f.engine.reconcile();
    assert.ok(f.engine.journal.SOLUSDT);
    assert.match(f.engine.journal.SOLUSDT.lastError!, /not confirmed flat/);
  } finally { f.cleanup(); }
});

test('partial fills cancel entry remainder and protect actual filled quantity', async () => {
  const f = fixture();
  try {
    await f.engine.submit('SOLUSDT', 100); f.fill('SOLUSDT', true); await f.engine.reconcile();
    assert.ok(f.calls.some(c => c[0] === 'cancel'));
    const tp = f.calls.find(c => c[0] === 'limit' && c[3]);
    assert.equal(tp[2], 0.1);
    assert.equal(f.engine.status().positions[0].filled, true);
  } finally { f.cleanup(); }
});

test('cancel failure preserves pending order, restart does not reset entry deadline', async () => {
  const f = fixture();
  try {
    await f.engine.submit('SOLUSDT', 100); const deadline = f.engine.journal.SOLUSDT.entryDeadline;
    f.advance(301000); f.behavior.rejectCancel = true;
    const restored = new ExecutionCoordinator(f.exchange, f.config, f.file, f.now);
    await restored.reconcile(); assert.equal(restored.journal.SOLUSDT.entryDeadline, deadline);
    assert.equal(f.orders.length, 1); assert.ok(restored.journal.SOLUSDT.lastError);
  } finally { f.cleanup(); }
});

test('uncertain submission blocks duplicates across restart', async () => {
  const f = fixture();
  try {
    f.behavior.ambiguousEntry = true;
    await assert.rejects(f.engine.submit('SOLUSDT', 100), /Timed out/);
    const restored = new ExecutionCoordinator(f.exchange, f.config, f.file, f.now);
    await restored.reconcile();
    await assert.rejects(restored.submit('XRPUSDT', 1), /Unresolved/);
    assert.equal(f.calls.filter(c => c[0] === 'limit').length, 1);
  } finally { f.cleanup(); }
});

test('exchange outage retains last-known slots and marks them stale', async () => {
  const f = fixture();
  try {
    await f.engine.submit('SOLUSDT', 100); await f.engine.reconcile();
    f.behavior.unavailable = true; await f.engine.reconcile();
    const status = f.engine.status(); assert.equal(status.connected, false); assert.equal(status.positions.length, 1);
  } finally { f.cleanup(); }
});

test('shadow fill requires qualifying sell volume, deduplicates tape, and never manufactures a rebound', () => {
  const o: ShadowOrder = { id: '1', symbol: 'SOLUSDT', entryPrice: 100, quantity: 1, targetTp: 100.5, createdAt: 1000,
    entryDeadline: 10000, holdMs: 90000, queueAheadUsd: 100, consumedUsd: 0, exitConsumedQty: 0, state: 'ARMED' };
  consumeTape(o, { a: 1, T: 1001, p: '100', q: '100', m: false }); assert.equal(o.state, 'ARMED');
  consumeTape(o, { a: 2, T: 1002, p: '101', q: '100', m: true }); assert.equal(o.consumedUsd, 0);
  consumeTape(o, { a: 3, T: 1003, p: '100', q: '1', m: true });
  consumeTape(o, { a: 3, T: 1003, p: '100', q: '1', m: true }); assert.equal(o.consumedUsd, 100);
  consumeTape(o, { a: 4, T: 1004, p: '100', q: '1', m: true }); assert.equal(o.state, 'FILLED');
  consumeTape(o, { a: 5, T: 1005, p: '98', q: '100', m: true }); assert.equal(o.state, 'FILLED'); assert.equal(o.grossPnlUsd, undefined);
  consumeTape(o, { a: 6, T: 1006, p: '100.5', q: '1', m: false }); assert.equal(o.state, 'TP'); assert.equal(o.grossPnlUsd, 0.5);
});

test('unmanaged exchange order blocks entry; explicit adoption resumes expiry management', async () => {
  const f = fixture();
  try {
    await f.exchange.placePostOnlyLimit('SOLUSDT', 'BUY', 100, 0.5, false, 'legacy-order');
    await assert.rejects(f.engine.submit('SOLUSDT', 100), /Unmanaged/);
    await f.engine.adopt('SOLUSDT');
    assert.equal(f.engine.status().positions[0].managed, true);
    f.advance(301000); await f.engine.reconcile();
    assert.equal(f.orders.length, 0); assert.equal(f.engine.journal.SOLUSDT, undefined);
  } finally { f.cleanup(); }
});

test('tagged orphan order is recovered even without journal acceptance record', async () => {
  const f = fixture();
  try {
    await f.exchange.placePostOnlyLimit('SOLUSDT', 'BUY', 100, 0.5, false, 'lsv-entry-recovered');
    await f.engine.reconcile();
    assert.equal(f.engine.journal.SOLUSDT.clientId, 'lsv-entry-recovered');
    assert.equal(f.engine.journal.SOLUSDT.openedAt, f.now());
  } finally { f.cleanup(); }
});

test('halt closes managed exposure but leaves unrelated exchange orders visible', async () => {
  const f = fixture();
  try {
    await f.engine.submit('SOLUSDT', 100); f.fill(); await f.engine.reconcile();
    await f.exchange.placePostOnlyLimit('XRPUSDT', 'BUY', 1, 1, false, 'external-order');
    f.config.update({ halted: true }, 1); await f.engine.reconcile();
    assert.equal(f.positions.length, 0); assert.equal(f.orders.length, 1);
    assert.equal(f.engine.status().positions[0].managed, false);
  } finally { f.cleanup(); }
});

test('Binance timeout error code is an unknown outcome, not a definitive rejection', async () => {
  const f = fixture();
  try {
    f.exchange.placePostOnlyLimit = async () => ({ ok: false, error: 'Execution status unknown', raw: { code: -1007 } });
    await assert.rejects(f.engine.submit('SOLUSDT', 100), /unknown/);
    assert.equal(f.engine.journal.SOLUSDT.state, 'SUBMITTING');
  } finally { f.cleanup(); }
});

test('shadow sequence gaps invalidate results rather than assuming missing fills', () => {
  const o: ShadowOrder = { id: 'gap', symbol: 'SOLUSDT', entryPrice: 100, quantity: 1, targetTp: 100.5, createdAt: 1000,
    entryDeadline: 10000, holdMs: 90000, queueAheadUsd: 100, consumedUsd: 0, exitConsumedQty: 0, state: 'ARMED' };
  consumeTape(o, { a: 1, T: 1001, p: '100', q: '0.5', m: true });
  consumeTape(o, { a: 3, T: 1002, p: '100', q: '10', m: true });
  assert.equal(o.state, 'INCOMPLETE'); assert.equal(o.grossPnlUsd, undefined);
});

test('shadow restart marks an active run incomplete without fabricated P&L', () => {
  const f = fixture();
  try {
    const file = path.join(path.dirname(f.file), 'shadow.json');
    fs.writeFileSync(file, JSON.stringify([{ id: 'restart', state: 'FILLED', symbol: 'SOLUSDT' }]));
    const shadow = new ShadowExecution(f.config, file);
    assert.equal(shadow.orders[0].state, 'INCOMPLETE');
    assert.equal(shadow.orders[0].grossPnlUsd, undefined);
  } finally { f.cleanup(); }
});

test('reduced risk pool blocks new entries while existing larger reservation remains', async () => {
  const f = fixture();
  try {
    f.config.update({ totalRiskPoolUsd: 100, marginPerSlotUsd: 25 }, 1);
    await f.engine.submit('SOLUSDT', 100);
    f.config.update({ totalRiskPoolUsd: 10, marginPerSlotUsd: 5 }, 2);
    await assert.rejects(f.engine.submit('XRPUSDT', 1), /risk pool/);
  } finally { f.cleanup(); }
});

test('fill racing an expired cancellation does not erase the persisted close intent', async () => {
  const f = fixture();
  try {
    await f.engine.submit('SOLUSDT', 100);
    f.advance(301000); f.behavior.rejectCancel = true; await f.engine.reconcile();
    assert.equal(f.engine.journal.SOLUSDT.state, 'CLOSING');
    f.fill(); f.behavior.rejectCancel = false;
    await f.engine.reconcile();
    assert.equal(f.positions.length, 0); assert.equal(f.engine.journal.SOLUSDT, undefined);
    assert.ok(f.calls.some(c => c[0] === 'market'));
  } finally { f.cleanup(); }
});
