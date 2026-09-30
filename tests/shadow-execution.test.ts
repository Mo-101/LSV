import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore, DEFAULT_RUNTIME_CONFIG, validateConfig } from '../src/engine/runtimeConfig';
import { consumeTape, ShadowOrder, ShadowExecution } from '../src/engine/shadowExecution';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsv-tests-'));
  const file = path.join(dir, 'config.json');
  const config = new ConfigStore(file);
  config.update({ mode: 'PAPER', autoExecute: true, allowedSymbols: [], marginPerSlotUsd: 5, totalRiskPoolUsd: 10, maxActiveSlots: 2 }, 0);
  return { config, dir, file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('config persists, rejects invalid pool allocation and stale revisions', () => {
  const f = fixture();
  try {
    assert.throws(() => validateConfig(DEFAULT_RUNTIME_CONFIG, { maxActiveSlots: 5 }), /risk pool/);
    assert.throws(() => f.config.update({ mode: 'SIGNAL_ONLY' }, 0), /another session/);
    assert.throws(() => validateConfig(DEFAULT_RUNTIME_CONFIG, { leverage: NaN }), /leverage/);
    assert.throws(() => validateConfig(DEFAULT_RUNTIME_CONFIG, { mode: 'MAINNET' as any }), /mode/);
    assert.throws(() => validateConfig(DEFAULT_RUNTIME_CONFIG, { mode: 'LIVE' as any }), /mode/);
    assert.equal(new ConfigStore(f.file).get().mode, 'PAPER');
  } finally { f.cleanup(); }
});

test('saved config from the removed Binance demo mode loads as signals only', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.file, JSON.stringify({ ...DEFAULT_RUNTIME_CONFIG, mode: 'LIVE', revision: 4 }));
    const config = new ConfigStore(f.file).get();
    assert.equal(config.mode, 'SIGNAL_ONLY');
    assert.equal(config.revision, 4);
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
    const file = path.join(f.dir, 'shadow.json');
    fs.writeFileSync(file, JSON.stringify([{ id: 'restart', state: 'FILLED', symbol: 'SOLUSDT' }]));
    const shadow = new ShadowExecution(f.config, file);
    assert.equal(shadow.orders[0].state, 'INCOMPLETE');
    assert.equal(shadow.orders[0].grossPnlUsd, undefined);
  } finally { f.cleanup(); }
});
