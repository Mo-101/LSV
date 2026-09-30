import crypto from 'node:crypto';
import type { DemoExchange, DemoOrder, LimitRequest } from './demoMirror';
import { DemoRejection } from './demoMirror';

// Binance USD-M Futures demo/testnet REST. Signed requests only ever go here;
// mainnet keys and mainnet execution are not supported.
const DEFAULT_REST_BASE = 'https://testnet.binancefuture.com';

interface SymbolRules { pricePrecision: number; quantityPrecision: number; tickSize: number; stepSize: number; minQty: number; minNotional: number; }

// Binance codes whose outcome is unknown (the order may still exist).
const AMBIGUOUS_CODES = new Set([-1000, -1001, -1006, -1007]);

function decimals(step: number, fallback: number) {
  const text = String(step);
  return text.includes('e-') ? Number(text.split('e-')[1]) : text.includes('.') ? text.split('.')[1].replace(/0+$/, '').length : fallback;
}
function toStep(value: number, step: number, direction: 'down' | 'up') {
  const units = value / step;
  const rounded = direction === 'down' ? Math.floor(units + 1e-9) : Math.ceil(units - 1e-9);
  return rounded * step;
}

export class BinanceDemoClient implements DemoExchange {
  private rules = new Map<string, SymbolRules>();
  constructor(private apiKey: string, private apiSecret: string, private base = DEFAULT_REST_BASE) {}

  private async request(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, string | number>) {
    const query = Object.entries({ ...params, timestamp: Date.now(), recvWindow: 5000 })
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
    const signature = crypto.createHmac('sha256', this.apiSecret).update(query).digest('hex');
    const response = await fetch(`${this.base}${path}?${query}&signature=${signature}`, {
      method, headers: { 'X-MBX-APIKEY': this.apiKey }, signal: AbortSignal.timeout(10000),
    });
    const json: any = await response.json().catch(() => ({}));
    if (response.ok) return json;
    const message = `${json.msg || `HTTP ${response.status}`}${json.code ? ` (${json.code})` : ''}`;
    // 4xx with a definitive Binance code: the request was refused. Anything else may have been applied.
    if (response.status < 500 && Number.isFinite(json.code) && !AMBIGUOUS_CODES.has(json.code)) throw new DemoRejection(message, json.code);
    throw new Error(message);
  }

  private async symbolRules(symbol: string): Promise<SymbolRules> {
    const cached = this.rules.get(symbol);
    if (cached) return cached;
    const response = await fetch(`${this.base}/fapi/v1/exchangeInfo`, { signal: AbortSignal.timeout(10000) });
    const json: any = await response.json();
    for (const s of json.symbols || []) {
      const filter = (type: string) => (s.filters || []).find((f: any) => f.filterType === type);
      const tickSize = Number(filter('PRICE_FILTER')?.tickSize ?? 10 ** -s.pricePrecision);
      const stepSize = Number(filter('LOT_SIZE')?.stepSize ?? 10 ** -s.quantityPrecision);
      this.rules.set(s.symbol, {
        tickSize, stepSize,
        pricePrecision: decimals(tickSize, s.pricePrecision), quantityPrecision: decimals(stepSize, s.quantityPrecision),
        minQty: Number(filter('LOT_SIZE')?.minQty ?? 0),
        minNotional: Number((filter('MIN_NOTIONAL') ?? filter('NOTIONAL'))?.notional ?? 0),
      });
    }
    const rules = this.rules.get(symbol);
    if (!rules) throw new DemoRejection(`${symbol} is not listed on the Binance demo exchange`);
    return rules;
  }

  private toOrder(json: any): DemoOrder {
    return {
      orderId: Number(json.orderId), clientOrderId: String(json.clientOrderId), status: String(json.status),
      price: Number(json.price), avgPrice: Number(json.avgPrice) || 0,
      origQty: Number(json.origQty), executedQty: Number(json.executedQty) || 0,
    };
  }

  async bookTicker(symbol: string) {
    const response = await fetch(`${this.base}/fapi/v1/ticker/bookTicker?symbol=${symbol}`, { signal: AbortSignal.timeout(5000) });
    const json: any = await response.json();
    const bid = Number(json.bidPrice), ask = Number(json.askPrice);
    if (!response.ok || !(bid > 0) || !(ask > 0)) throw new Error(`Demo order book unavailable for ${symbol}`);
    return { bid, ask };
  }

  async prepare(symbol: string, leverage: number) {
    try { await this.request('POST', '/fapi/v1/marginType', { symbol, marginType: 'ISOLATED' }); }
    catch (error) { if (!(error instanceof DemoRejection && error.code === -4046)) throw error; } // -4046: already isolated
    const result = await this.request('POST', '/fapi/v1/leverage', { symbol, leverage });
    if (Number(result.leverage) !== leverage) throw new DemoRejection(`Demo leverage not confirmed for ${symbol}`);
  }

  async placeLimit(order: LimitRequest) {
    const rules = await this.symbolRules(order.symbol);
    const price = toStep(order.price, rules.tickSize, order.side === 'BUY' ? 'down' : 'up');
    const quantity = toStep(order.quantity, rules.stepSize, 'down');
    if (!(quantity > 0) || quantity < rules.minQty) throw new DemoRejection('Shadow size is below the demo minimum quantity');
    if (!order.reduceOnly && quantity * price < rules.minNotional) throw new DemoRejection(`Shadow notional $${(quantity * price).toFixed(2)} is below the demo minimum $${rules.minNotional}`);
    const params: Record<string, string> = {
      symbol: order.symbol, side: order.side, type: 'LIMIT', timeInForce: order.postOnly ? 'GTX' : 'GTC',
      price: price.toFixed(rules.pricePrecision), quantity: quantity.toFixed(rules.quantityPrecision),
      newClientOrderId: order.clientOrderId,
    };
    if (order.reduceOnly) params.reduceOnly = 'true';
    return this.toOrder(await this.request('POST', '/fapi/v1/order', params));
  }

  async placeMarketClose(symbol: string, quantity: number, clientOrderId: string) {
    const rules = await this.symbolRules(symbol);
    const rounded = toStep(quantity, rules.stepSize, 'down');
    if (!(rounded > 0)) throw new DemoRejection('Close quantity rounds to zero');
    return this.toOrder(await this.request('POST', '/fapi/v1/order', {
      symbol, side: 'SELL', type: 'MARKET', reduceOnly: 'true',
      quantity: rounded.toFixed(rules.quantityPrecision), newClientOrderId: clientOrderId,
    }));
  }

  async cancel(symbol: string, clientOrderId: string) {
    try { await this.request('DELETE', '/fapi/v1/order', { symbol, origClientOrderId: clientOrderId }); }
    catch (error) { if (!(error instanceof DemoRejection && error.code === -2011)) throw error; } // -2011: already filled/canceled
  }

  async query(symbol: string, clientOrderId: string) {
    try { return this.toOrder(await this.request('GET', '/fapi/v1/order', { symbol, origClientOrderId: clientOrderId })); }
    catch (error) { if (error instanceof DemoRejection && error.code === -2013) return null; throw error; } // -2013: no such order
  }

  async positionAmt(symbol: string) {
    const rows: any[] = await this.request('GET', '/fapi/v2/positionRisk', { symbol });
    return rows.filter(r => r.symbol === symbol).reduce((sum, r) => sum + Number(r.positionAmt), 0);
  }

  async balance() {
    const account = await this.request('GET', '/fapi/v2/account', {});
    const balance = Number(account.availableBalance);
    if (!Number.isFinite(balance)) throw new Error('Invalid demo account balance');
    return balance;
  }
}

export function createDemoClient(): BinanceDemoClient | null {
  const key = process.env.BINANCE_KEY, secret = process.env.BINANCE_SECRET;
  if (!key || !secret) return null;
  return new BinanceDemoClient(key, secret, process.env.BINANCE_DEMO_REST_BASE || DEFAULT_REST_BASE);
}
