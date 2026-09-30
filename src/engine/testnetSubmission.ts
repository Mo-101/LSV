export async function submitTestnetOrder(symbol: string, request: typeof fetch = fetch): Promise<{ orderId: number }> {
  let response: Response;
  try {
    response = await request(`/api/testnet/force-test-order?symbol=${encodeURIComponent(symbol)}`, {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new Error('Demo order response unavailable. Check Binance open orders before retrying.');
  }
  let result: { ok?: boolean; orderId?: number; reason?: string; error?: string };
  try {
    result = await response.json();
  } catch {
    throw new Error('Invalid demo order response. Check Binance open orders before retrying.');
  }
  if (!response.ok || !result.ok || !result.orderId) {
    throw new Error(`Demo order rejected: ${result.reason || result.error || `HTTP ${response.status}`}`);
  }
  return { orderId: result.orderId };
}
