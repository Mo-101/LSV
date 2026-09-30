import test from 'node:test';
import assert from 'node:assert/strict';
import { submitTestnetOrder } from '../src/engine/testnetSubmission';

test('demo submission sends one POST and returns the exchange order ID', async () => {
  let calls = 0;
  const request = (async (url, options) => {
    calls++;
    assert.equal(url, '/api/testnet/force-test-order?symbol=SOLUSDT');
    assert.equal(options?.method, 'POST');
    return Response.json({ ok: true, orderId: 123 });
  }) as typeof fetch;
  assert.deepEqual(await submitTestnetOrder('SOLUSDT', request), { orderId: 123 });
  assert.equal(calls, 1);
});

test('demo submission surfaces backend rejection even for HTTP 200', async () => {
  const request = (async () => Response.json({ ok: false, reason: 'Max concurrent testnet slots reached' })) as typeof fetch;
  await assert.rejects(submitTestnetOrder('SOLUSDT', request), /Max concurrent testnet slots reached/);
});

test('uncertain network result advises checking orders without retrying', async () => {
  let calls = 0;
  const request = (async () => { calls++; throw new Error('offline'); }) as typeof fetch;
  await assert.rejects(submitTestnetOrder('SOLUSDT', request), /Check Binance open orders before retrying/);
  assert.equal(calls, 1);
});
