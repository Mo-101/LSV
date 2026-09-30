import test from 'node:test';
import assert from 'node:assert/strict';
import { AutomaticBatches } from '../src/engine/automaticBatches';
import { DEFAULT_RUNTIME_CONFIG } from '../src/engine/runtimeConfig';

test('ranked five-entry batch fills free slots without waiting for the account to go flat', async () => {
  let now = 10000;
  let positions: Array<{ symbol: string; managed: boolean }> = [];
  const submitted: string[] = [];
  const config = { ...DEFAULT_RUNTIME_CONFIG, mode: 'LIVE' as const, autoExecute: true, maxActiveSlots: 5, allowedSymbols: [] };
  const scheduler = new AutomaticBatches({ config: () => config, now: () => now,
    status: () => ({ connected: true, positions }),
    submit: async c => { submitted.push(c.symbol); positions.push({ symbol: c.symbol, managed: true }); },
  });
  for (let i = 1; i <= 6; i++) scheduler.offer({ symbol: `COIN${i}USDT`, liquidationUsd: i * 50000, detectedAt: now, floor: 100 });
  await Promise.all([scheduler.tick(), scheduler.tick()]);
  assert.deepEqual(submitted, ['COIN6USDT','COIN5USDT','COIN4USDT','COIN3USDT','COIN2USDT']);
  positions.pop(); await scheduler.tick(); assert.equal(submitted.length, 6);
  positions = []; await scheduler.tick(); assert.equal(submitted.length, 6);
  assert.equal(scheduler.status().batch, 2);
});

test('stale, excluded, unmanaged and disabled states never submit entries', async () => {
  const config = { ...DEFAULT_RUNTIME_CONFIG, mode: 'LIVE' as const, autoExecute: true, allowedSymbols: ['SOLUSDT'] };
  let unmanaged = true, calls = 0;
  const scheduler = new AutomaticBatches({ config: () => config, now: () => 100000,
    status: () => ({ connected: true, positions: unmanaged ? [{ symbol: 'SOLUSDT', managed: false }] : [] }),
    submit: async () => { calls++; },
  });
  scheduler.offer({ symbol: 'SOLUSDT', liquidationUsd: 100000, detectedAt: 99999, floor: 100 });
  await scheduler.tick(); assert.equal(calls, 0);
  unmanaged = false; config.autoExecute = false; await scheduler.tick(); assert.equal(calls, 0);
  config.autoExecute = true;
  scheduler.offer({ symbol: 'SOLUSDT', liquidationUsd: 100000, detectedAt: 1, floor: 100 });
  scheduler.offer({ symbol: 'BTCUSDT', liquidationUsd: 1000000, detectedAt: 99999, floor: 100 });
  await scheduler.tick(); assert.equal(calls, 0);
});
