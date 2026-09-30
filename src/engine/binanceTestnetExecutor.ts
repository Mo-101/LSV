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

/**
 * Minimal Binance USD-M Futures TESTNET executor.
 * Uses fixed small USD notional per position — no exchangeInfo/lot-size
 * lookup, so orders on symbols with unusual step sizes may be rejected by
 * the exchange (caller should treat a rejection as a no-op, not a crash).
 */
export class BinanceTestnetExecutor {
  private apiKey: string;
  private apiSecret: string;
  private listenKey: string | null = null;
  private ws: WebSocket | null = null;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  public activePositions = new Map<string, ActivePosition>();

  constructor(apiKey: string, apiSecret: string) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
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
      const { httpOk, json } = await this.signedRequest('POST', '/fapi/v1/order', {
        symbol,
        side,
        type: 'LIMIT',
        quantity: quantity.toString(),
        price: price.toString(),
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
      const { httpOk, json } = await this.signedRequest('POST', '/fapi/v1/order', {
        symbol,
        side,
        type: 'MARKET',
        quantity: quantity.toString(),
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
