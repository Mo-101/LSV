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

export interface ActivePosition {
  symbol: string;
  side: 'BUY' | 'SELL';
  entryOrderId: number;
  entryPrice: number;
  quantity: number;
  targetTp: number;
  filled: boolean;
  tpOrderId?: number;
  chronometer: NodeJS.Timeout;
  openedAt: number;
}

interface SymbolPrecision {
  pricePrecision: number;
  quantityPrecision: number;
  tickSize: number;
  stepSize: number;
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
  public activePositions = new Map<string, ActivePosition>();

  constructor(apiKey: string, apiSecret: string) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }

  private async getSymbolPrecision(symbol: string): Promise<SymbolPrecision> {
    const cached = this.precisionCache.get(symbol);
    if (cached) return cached;
    const fallback: SymbolPrecision = { pricePrecision: 2, quantityPrecision: 3, tickSize: 0.01, stepSize: 0.001 };
    try {
      const res = await fetch(`${TESTNET_REST_BASE}/fapi/v1/exchangeInfo`, { signal: AbortSignal.timeout(10000) });
      const json: any = await res.json();
      for (const s of json.symbols || []) {
        const priceFilter = (s.filters || []).find((f: any) => f.filterType === 'PRICE_FILTER');
        const lotFilter = (s.filters || []).find((f: any) => f.filterType === 'LOT_SIZE');
        const precision: SymbolPrecision = {
          pricePrecision: s.pricePrecision,
          quantityPrecision: s.quantityPrecision,
          tickSize: priceFilter ? parseFloat(priceFilter.tickSize) : Math.pow(10, -s.pricePrecision),
          stepSize: lotFilter ? parseFloat(lotFilter.stepSize) : Math.pow(10, -s.quantityPrecision),
        };
        this.precisionCache.set(s.symbol, precision);
      }
      return this.precisionCache.get(symbol) || fallback;
    } catch {
      return fallback;
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

  async placePostOnlyLimit(symbol: string, side: 'BUY' | 'SELL', price: number, quantity: number): Promise<TestnetOrderResult> {
    try {
      const precision = await this.getSymbolPrecision(symbol);
      const roundedPrice = roundToStep(price, precision.tickSize, precision.pricePrecision);
      const roundedQty = roundToStep(quantity, precision.stepSize, precision.quantityPrecision);
      const { httpOk, json } = await this.signedRequest('POST', '/fapi/v1/order', {
        symbol,
        side,
        type: 'LIMIT',
        quantity: roundedQty.toFixed(precision.quantityPrecision),
        price: roundedPrice.toFixed(precision.pricePrecision),
        timeInForce: 'GTX',
      });
      if (!httpOk || !json.orderId) {
        return { ok: false, error: json.msg || 'Order rejected', raw: json };
      }
      return { ok: true, orderId: json.orderId, status: json.status, raw: json };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  async placeMarketOrder(symbol: string, side: 'BUY' | 'SELL', quantity: number): Promise<TestnetOrderResult> {
    try {
      const precision = await this.getSymbolPrecision(symbol);
      const roundedQty = roundToStep(quantity, precision.stepSize, precision.quantityPrecision);
      const { httpOk, json } = await this.signedRequest('POST', '/fapi/v1/order', {
        symbol,
        side,
        type: 'MARKET',
        quantity: roundedQty.toFixed(precision.quantityPrecision),
      });
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
