import crypto from 'crypto';
import WebSocket from 'ws';

const TESTNET_REST_BASE = 'https://testnet.binancefuture.com';
const TESTNET_WS_BASE = 'wss://stream.binancefuture.com/ws';

export interface TestnetOrderResult {
  ok: boolean;
  orderId?: number;
  status?: string;
  raw?: any;
  error?: string;
}

interface SymbolPrecision {
  pricePrecision: number;
  quantityPrecision: number;
  tickSize: number;
  stepSize: number;
  minQty: number;
  minNotional: number;
}

function roundToStep(value: number, step: number, decimals: number): number {
  if (!Number.isFinite(step) || step <= 0) return Number(value.toFixed(decimals));
  const rounded = Math.round(value / step) * step;
  return Number(rounded.toFixed(decimals));
}

/**
 * Minimal Binance USD-M Futures TESTNET executor.
 * Fixed small USD notional per position; price/quantity are rounded to each
 * symbol's real tick/step precision (fetched once from exchangeInfo and
 * cached) so orders aren't rejected for over-precision.
 */
export class BinanceTestnetExecutor {
  private apiKey: string;
  private apiSecret: string;
  private listenKey: string | null = null;
  private ws: WebSocket | null = null;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private precisionCache = new Map<string, SymbolPrecision>();

  constructor(apiKey: string, apiSecret: string) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }

  private async getSymbolPrecision(symbol: string): Promise<SymbolPrecision> {
    const cached = this.precisionCache.get(symbol);
    if (cached) return cached;
    try {
      const res = await fetch(`${TESTNET_REST_BASE}/fapi/v1/exchangeInfo`, { signal: AbortSignal.timeout(10000) });
      const json: any = await res.json();
      for (const s of json.symbols || []) {
        const priceFilter = (s.filters || []).find((f: any) => f.filterType === 'PRICE_FILTER');
        const lotFilter = (s.filters || []).find((f: any) => f.filterType === 'LOT_SIZE');
        const notionalFilter = (s.filters || []).find((f: any) => f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL');
        const precision: SymbolPrecision = {
          pricePrecision: s.pricePrecision,
          quantityPrecision: s.quantityPrecision,
          minQty: Number(lotFilter?.minQty ?? 0),
          minNotional: Number(notionalFilter?.notional ?? 0),
          tickSize: priceFilter ? parseFloat(priceFilter.tickSize) : Math.pow(10, -s.pricePrecision),
          stepSize: lotFilter ? parseFloat(lotFilter.stepSize) : Math.pow(10, -s.quantityPrecision),
        };
        this.precisionCache.set(s.symbol, precision);
      }
      const precision = this.precisionCache.get(symbol);
      if (!precision) throw new Error('Symbol not available on Binance demo');
      return precision;
    } catch {
      throw new Error('Could not verify demo symbol precision and minimum order size');
    }
  }

  private sign(params: Record<string, string | number>): string {
    const query = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&');
    const signature = crypto.createHmac('sha256', this.apiSecret).update(query).digest('hex');
    return `${query}&signature=${signature}`;
  }

  private async signedRequest(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, string | number>) {
    const fullParams = { ...params, timestamp: Date.now(), recvWindow: 5000 };
    const query = this.sign(fullParams);
    const res = await fetch(`${TESTNET_REST_BASE}${path}?${query}`, {
      method,
      headers: { 'X-MBX-APIKEY': this.apiKey },
      signal: AbortSignal.timeout(10000),
    });
    const json = await res.json().catch(() => ({}));
    return { httpOk: res.ok, json };
  }

  // Set on every entry rather than cached: the symbol may have been switched
  // back to cross from the Binance UI since the last trade.
  async ensureIsolatedMargin(symbol: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const { httpOk, json } = await this.signedRequest('POST', '/fapi/v1/marginType', { symbol, marginType: 'ISOLATED' });
      // -4046 "No need to change margin type": already isolated.
      if (httpOk || json.code === -4046) return { ok: true };
      return { ok: false, error: json.msg || 'Could not set isolated margin' };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  async getBookTicker(symbol: string): Promise<{ bid: number; ask: number } | null> {
    try {
      const res = await fetch(`${TESTNET_REST_BASE}/fapi/v1/ticker/bookTicker?symbol=${symbol}`, { signal: AbortSignal.timeout(10000) });
      const json: any = await res.json();
      const bid = parseFloat(json.bidPrice);
      const ask = parseFloat(json.askPrice);
      return Number.isFinite(bid) && Number.isFinite(ask) ? { bid, ask } : null;
    } catch {
      return null;
    }
  }

  async placePostOnlyLimit(symbol: string, side: 'BUY' | 'SELL', price: number, quantity: number, reduceOnly = false, clientOrderId?: string): Promise<TestnetOrderResult> {
    let submitted = false;
    try {
      const precision = await this.getSymbolPrecision(symbol);
      const roundedPrice = roundToStep(price, precision.tickSize, precision.pricePrecision);
      const roundedQty = Number((Math.floor((quantity + 1e-12) / precision.stepSize) * precision.stepSize).toFixed(precision.quantityPrecision));
      if (!(roundedQty > 0) || roundedQty < precision.minQty) return { ok: false, error: 'Configured size is below the symbol minimum quantity', raw: { code: -1013 } };
      if (!reduceOnly && roundedQty * roundedPrice < precision.minNotional) return { ok: false, error: 'Configured size is below the demo minimum notional; choose a larger tier or another symbol', raw: { code: -1013 } };
      const params: Record<string, string> = {
        symbol,
        side,
        type: 'LIMIT',
        quantity: roundedQty.toFixed(precision.quantityPrecision),
        price: roundedPrice.toFixed(precision.pricePrecision),
        timeInForce: 'GTX',
      };
      if (reduceOnly) params.reduceOnly = 'true';
      if (clientOrderId) params.newClientOrderId = clientOrderId;
      submitted = true;
      const { httpOk, json } = await this.signedRequest('POST', '/fapi/v1/order', params);
      if (!httpOk || !json.orderId) {
        return { ok: false, error: json.msg || 'Order rejected', raw: json };
      }
      return { ok: true, orderId: json.orderId, status: json.status, raw: json };
    } catch (err: any) {
      return { ok: false, error: err.message, ...(submitted ? {} : { raw: { code: -1013 } }) };
    }
  }

  async placeMarketOrder(symbol: string, side: 'BUY' | 'SELL', quantity: number, reduceOnly = false, clientOrderId?: string): Promise<TestnetOrderResult> {
    try {
      const precision = await this.getSymbolPrecision(symbol);
      const roundedQty = Number((Math.floor((quantity + 1e-12) / precision.stepSize) * precision.stepSize).toFixed(precision.quantityPrecision));
      if (!(roundedQty > 0) || roundedQty < precision.minQty) return { ok: false, error: 'Configured size is below the symbol minimum quantity', raw: { code: -1013 } };
      const params: Record<string, string> = {
        symbol,
        side,
        type: 'MARKET',
        quantity: roundedQty.toFixed(precision.quantityPrecision),
      };
      if (reduceOnly) params.reduceOnly = 'true';
      if (clientOrderId) params.newClientOrderId = clientOrderId;
      const { httpOk, json } = await this.signedRequest('POST', '/fapi/v1/order', params);
      if (!httpOk || !json.orderId) {
        return { ok: false, error: json.msg || 'Order rejected', raw: json };
      }
      return { ok: true, orderId: json.orderId, status: json.status, raw: json };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  async cancelOrder(symbol: string, orderId: number): Promise<TestnetOrderResult> {
    try {
      const { httpOk, json } = await this.signedRequest('DELETE', '/fapi/v1/order', {
        symbol,
        orderId,
      });
      return { ok: httpOk, orderId, raw: json };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  async getAccountBalance(): Promise<{ ok: boolean; usdtBalance?: number; error?: string }> {
    try {
      const { httpOk, json } = await this.signedRequest('GET', '/fapi/v2/account', {});
      if (!httpOk) return { ok: false, error: json.msg || 'Account query failed' };
      const usdt = (json.assets || []).find((a: any) => a.asset === 'USDT');
      return { ok: true, usdtBalance: usdt ? parseFloat(usdt.availableBalance) : undefined };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  /** Balance plus real per-symbol position risk (live unrealized P&L) from the exchange. */
  async getAccountSnapshot(): Promise<{
    ok: boolean;
    usdtBalance?: number;
    positions?: Array<{ symbol: string; positionAmt: number; entryPrice: number; unrealizedProfit: number }>;
    error?: string;
  }> {
    try {
      const { httpOk, json } = await this.signedRequest('GET', '/fapi/v2/account', {});
      if (!httpOk) return { ok: false, error: json.msg || 'Account query failed' };
      const usdt = (json.assets || []).find((a: any) => a.asset === 'USDT');
      const positions = (json.positions || [])
        .filter((p: any) => parseFloat(p.positionAmt) !== 0)
        .map((p: any) => ({
          symbol: p.symbol,
          positionAmt: parseFloat(p.positionAmt),
          entryPrice: parseFloat(p.entryPrice),
          unrealizedProfit: parseFloat(p.unRealizedProfit ?? p.unrealizedProfit ?? '0'),
        }));
      return { ok: true, usdtBalance: usdt ? parseFloat(usdt.availableBalance) : undefined, positions };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  async readExchangeState() {
    const [orders, positions, account] = await Promise.all([
      this.signedRequest('GET', '/fapi/v1/openOrders', {}),
      this.signedRequest('GET', '/fapi/v2/positionRisk', {}),
      this.signedRequest('GET', '/fapi/v2/account', {}),
    ]);
    for (const result of [orders, positions, account]) {
      if (!result.httpOk) throw new Error(result.json.msg || 'Exchange snapshot failed');
    }
    if (!Array.isArray(orders.json) || !Array.isArray(positions.json)) throw new Error('Invalid exchange snapshot');
    if (!Number.isFinite(Number(account.json.availableBalance))) throw new Error('Invalid account balance');
    for (const order of orders.json) {
      if (!order.symbol || !order.clientOrderId || !Number.isFinite(order.orderId) || !Number.isFinite(Number(order.origQty)) || !Number.isFinite(Number(order.executedQty))) throw new Error('Invalid open-order data');
    }
    for (const position of positions.json) {
      if (!position.symbol || !Number.isFinite(Number(position.positionAmt)) || !Number.isFinite(Number(position.entryPrice))) throw new Error('Invalid position risk data');
    }
    return {
      orders: orders.json as ExchangeOrder[],
      positions: (positions.json as ExchangePosition[]).filter(p => Number(p.positionAmt) !== 0),
      balance: Number(account.json.availableBalance),
      fetchedAt: Date.now(),
    };
  }

  async queryOrder(symbol: string, clientOrderId: string) {
    const result = await this.signedRequest('GET', '/fapi/v1/order', { symbol, origClientOrderId: clientOrderId });
    if (!result.httpOk) {
      if (result.json.code === -2013) return null;
      throw new Error(result.json.msg || 'Order lookup failed');
    }
    return result.json as ExchangeOrder;
  }

  async setLeverage(symbol: string, leverage: number) {
    const result = await this.signedRequest('POST', '/fapi/v1/leverage', { symbol, leverage });
    if (!result.httpOk || Number(result.json.leverage) !== leverage) throw new Error(result.json.msg || 'Leverage not confirmed');
  }

  /** Starts (or restarts) the user data stream and wires fill notifications to onFill. */
  async startUserDataStream(onFill: (symbol: string, orderId: number, status: string) => void) {
    const res = await fetch(`${TESTNET_REST_BASE}/fapi/v1/listenKey`, {
      method: 'POST',
      headers: { 'X-MBX-APIKEY': this.apiKey },
      signal: AbortSignal.timeout(10000),
    }).catch(() => null);
    const json = res ? await res.json().catch(() => ({})) : {};
    if (!json.listenKey) return;
    this.listenKey = json.listenKey;

    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = setInterval(() => {
      fetch(`${TESTNET_REST_BASE}/fapi/v1/listenKey`, {
        method: 'PUT',
        headers: { 'X-MBX-APIKEY': this.apiKey },
        signal: AbortSignal.timeout(10000),
      }).catch(() => {});
    }, 30 * 60 * 1000);

    if (this.ws) this.ws.close();
    this.ws = new WebSocket(`${TESTNET_WS_BASE}/${this.listenKey}`);
    this.ws.on('message', (raw: string) => {
      try {
        const event = JSON.parse(raw.toString());
        if (event.e === 'ORDER_TRADE_UPDATE') {
          const o = event.o;
          onFill(o.s, o.i, o.X);
        }
      } catch {
        // non-blocking
      }
    });
    this.ws.on('close', () => {
      setTimeout(() => this.startUserDataStream(onFill), 5000);
    });
    this.ws.on('error', () => {
      // reconnect handled by 'close'
    });
  }
}

export function getTestnetExecutor(): BinanceTestnetExecutor | null {
  // BINANCE_KEY/BINANCE_SECRET in .env are Binance Futures TESTNET keys
  // (confirmed alongside BYBIT_ENV=testnet) — not mainnet credentials.
  const key = process.env.BINANCE_KEY;
  const secret = process.env.BINANCE_SECRET;
  if (!key || !secret) return null;
  return new BinanceTestnetExecutor(key, secret);
}

export interface ExchangeOrder {
  symbol: string; orderId: number; clientOrderId: string; side: 'BUY' | 'SELL';
  positionSide: string; reduceOnly: boolean; price: string; origQty: string;
  executedQty: string; status: string; time: number; updateTime: number;
}
export interface ExchangePosition {
  symbol: string; positionSide: string; positionAmt: string; entryPrice: string;
  unRealizedProfit: string; updateTime: number;
}
export interface ExchangeSnapshot {
  orders: ExchangeOrder[]; positions: ExchangePosition[]; balance: number; fetchedAt: number;
}
