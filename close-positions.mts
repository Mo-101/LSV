import 'dotenv/config';
import { getTestnetExecutor } from './src/engine/binanceTestnetExecutor';

const ex = getTestnetExecutor();
if (!ex) throw new Error('BINANCE_KEY/BINANCE_SECRET not set');
const snap = await ex.getAccountSnapshot();
if (!snap.ok) throw new Error(snap.error || 'account snapshot failed');
console.log('open positions:', JSON.stringify(snap.positions));
for (const p of snap.positions ?? []) {
  const side = p.positionAmt > 0 ? 'SELL' : 'BUY';
  const qty = Math.abs(p.positionAmt);
  const r = await ex.placeMarketOrder(p.symbol, side, qty, true);
  console.log(p.symbol, side, qty, r.ok ? `closed orderId=${r.orderId}` : `FAILED: ${r.error}`);
}
const after = await ex.getAccountSnapshot();
console.log('remaining positions:', JSON.stringify(after.positions ?? []));
