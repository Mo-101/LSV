import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { RuntimeConfig } from '../engine/runtimeConfig';

const presets = {
  MINI_MICRO_10: { totalRiskPoolUsd: 10, marginPerSlotUsd: 5, maxActiveSlots: 2, allowedSymbols: ['SOLUSDT', 'DOGEUSDT', 'XRPUSDT', 'SUIUSDT', 'ETHUSDT', 'AVAXUSDT'] },
  MICRO_FLIGHT_250: { totalRiskPoolUsd: 250, marginPerSlotUsd: 25, maxActiveSlots: 3, allowedSymbols: [] },
  INSTITUTIONAL_250K: { totalRiskPoolUsd: 250000, marginPerSlotUsd: 25000, maxActiveSlots: 3, allowedSymbols: [] },
};
export function UnifiedExecutionPanel({ onConfig }: { onConfig: (config: RuntimeConfig) => void }) {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [exchange, setExchange] = useState<any>(null);
  const [shadow, setShadow] = useState<any>(null);
  const [automation, setAutomation] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [symbols, setSymbols] = useState('');
  const callback = useRef(onConfig); callback.current = onConfig;
  const configRef = useRef<RuntimeConfig | null>(null);
  const loading = useRef(false);
  const apply = (c: RuntimeConfig) => {
    if (!configRef.current || c.revision >= configRef.current.revision) {
      if (c.revision !== configRef.current?.revision) setSymbols(c.allowedSymbols.join(', '));
      configRef.current = c; setConfig(c); callback.current(c);
    }
  };
  const refresh = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const results = await Promise.all(['/api/config', '/api/testnet/status', '/api/shadow/status', '/api/automation/status'].map(async url => {
        const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error(`Could not load ${url}`);
        return response.json();
      }));
      apply(results[0]); setExchange(results[1]); setShadow(results[2]); setAutomation(results[3]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Status unavailable');
      setExchange((previous: any) => previous ? { ...previous, connected: false, stale: true } : null);
    } finally { loading.current = false; }
  }, []);
  useEffect(() => { void refresh(); const timer = setInterval(refresh, 5000); return () => clearInterval(timer); }, [refresh]);
  const mutate = async (url: string, body: unknown) => {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Request failed');
      if (url === '/api/config') { apply(result); setNotice('Backend configuration saved.'); }
      if (result.config) apply(result.config);
      if (result.message) setNotice(result.message);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Request failed; refresh before retrying.'); }
    finally { setBusy(false); }
  };
  const update = (patch: Partial<RuntimeConfig>) => config && mutate('/api/config', { patch, revision: config.revision });
  const control = 'rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400';
  const slots = exchange?.positions || [];
  return <section className="space-y-4 rounded-xl border border-zinc-700 bg-zinc-950 p-4 text-zinc-200">
    <div className="flex flex-wrap justify-between gap-2">
      <h2 className="font-semibold">Execution controls and exchange slots</h2>
      <span className="text-sm text-zinc-400">{config ? `Backend revision ${config.revision}` : 'Loading backend settings...'}</span>
    </div>
    {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
    {notice && <p role="status" className="text-sm text-cyan-300">{notice}</p>}
    {config && <fieldset disabled={busy} className="space-y-3 disabled:opacity-70">
      <div className="flex flex-wrap gap-3">
        <label className="text-sm">Execution mode <select className={control} value={config.mode} onChange={e => void update({ mode: e.target.value as RuntimeConfig['mode'] })}>
          <option value="SIGNAL_ONLY">Signals only</option><option value="PAPER">Real-tape shadow</option><option value="LIVE">Binance demo</option>
        </select></label>
        <label className="text-sm">Capital tier <select className={control} value={config.microCapitalTier} onChange={e => {
          const tier = e.target.value as RuntimeConfig['microCapitalTier']; if (tier !== 'CUSTOM') void update({ microCapitalTier: tier, ...presets[tier] });
        }}>{config.microCapitalTier === 'CUSTOM' && <option value="CUSTOM" disabled>Custom (${config.totalRiskPoolUsd} pool)</option>}<option value="MINI_MICRO_10">$10 mini-micro</option><option value="MICRO_FLIGHT_250">$250 flight</option><option value="INSTITUTIONAL_250K">$250k institutional</option></select></label>
        <label className="text-sm">Maximum slots <select className={control} value={config.maxActiveSlots} onChange={e => void update({ maxActiveSlots: Number(e.target.value) })}>{[1,2,3,4,5].map(n => <option key={n}>{n}</option>)}</select></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={config.autoExecute} onChange={e => void update({ autoExecute: e.target.checked })} />Automatic entries</label>
        <button className={control} onClick={() => void (config.halted ? update({ halted: false }) : mutate('/api/execution/halt', {}))}>{config.halted ? 'Resume entries' : 'Halt and close managed exposure'}</button>
      </div>
      <p className="text-sm text-zinc-400">${config.marginPerSlotUsd} margin per slot x {config.leverage} leverage = ${config.marginPerSlotUsd * config.leverage} target exposure. Mode changes affect new entries; existing managed trades keep their exit watchdogs.</p>
      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <label className="text-sm">Minimum liquidation volume <input key={`volume-${config.revision}`} className={control} type="number" min="1000" defaultValue={config.minLiquidationUsd} onBlur={e => { if (Number(e.target.value) !== config.minLiquidationUsd) void update({ minLiquidationUsd: Number(e.target.value) }); }} /></label>
        <label className="text-sm">Absorption multiplier <input key={`buffer-${config.revision}`} className={control} type="number" min="1" max="5" step="0.05" defaultValue={config.absorptionBuffer} onBlur={e => { if (Number(e.target.value) !== config.absorptionBuffer) void update({ absorptionBuffer: Number(e.target.value) }); }} /></label>
        <label className="w-full text-sm sm:min-w-64 sm:flex-1">Allowed symbols (empty = all USDT pairs)<input className={`${control} w-full`} value={symbols} onChange={e => setSymbols(e.target.value)} /></label>
        <button className={control} onClick={() => void update({ allowedSymbols: symbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) })}>Save symbol filter</button>
      </div>
    </fieldset>}
    {automation && <div className="space-y-1 text-sm" aria-live="polite">
      <p>Automatic entries: up to {config?.maxActiveSlots ?? 5} concurrent slots. Each symbol fills a free slot independently.</p>
      <p className="text-cyan-300">{automation.message}</p>
      <p className="text-zinc-400">{automation.candidates.length} fresh candidates. Ranked by qualifying liquidation volume, not guaranteed profit.</p>
      {automation.lastErrors?.map((message: string) => <p key={message} className="text-amber-300">{message}</p>)}
    </div>}
    <div className="space-y-2 border-t border-zinc-800 pt-3">
      <h3 className="font-semibold">Binance demo slots - {exchange?.connected ? slots.length : 'unknown'}{config ? ` / ${config.maxActiveSlots}` : ''}</h3>
      <p className="text-sm text-zinc-400">Source: Binance open orders and position risk. Pending entries and filled positions are shown separately from shadow results.</p>
      {!exchange?.connected && <p role="alert" className="text-amber-300">Exchange data unavailable or stale. Last-known rows are retained; an empty response is not proof of a flat account.</p>}
      {exchange?.fetchedAt && <p className="text-xs text-zinc-500">Last exchange read: {new Date(exchange.fetchedAt).toLocaleString()}</p>}
      {exchange?.error && <p className="text-sm text-rose-300">{exchange.error}</p>}
      {exchange?.connected && !slots.length && <p className="text-sm text-zinc-400">Binance reports no open orders or positions.</p>}
      <div className="grid gap-3 md:grid-cols-3">{slots.map((slot: any) => <article key={slot.key} className="space-y-2 rounded-lg border border-zinc-700 p-3">
        <div className="flex justify-between"><strong>{slot.symbol}</strong><span>{slot.filled ? 'Position open' : 'Order pending'}</span></div>
        <p className="text-sm">{slot.side} {slot.quantity} at ${slot.entryPrice}</p>
        {slot.filled && <p className="text-sm">Unrealized P&L: ${slot.pnlUsd.toFixed(4)}</p>}
        <p className="text-xs text-zinc-400">{slot.managed ? `Managed / ${slot.state} / ${slot.holdSeconds}s` : 'Unmanaged - reconciliation required'}</p>
        {slot.lastError && <p role="alert" className="text-xs text-rose-300">{slot.lastError}</p>}
        {!slot.managed && <button disabled={busy || !exchange?.connected} className={control} title="Adopt all one-way long orders and position for this symbol. Expired exposure will be closed." onClick={() => void mutate('/api/testnet/reconcile', { symbol: slot.symbol })}>Adopt and enforce time-stop</button>}
      </article>)}</div>
      {exchange?.reconciliation?.map((r: any) => <p key={r.symbol} role="alert" className="text-sm text-amber-300">{r.symbol}: {r.error}</p>)}
    </div>
    <div className="space-y-2 border-t border-zinc-800 pt-3">
      <h3 className="font-semibold">Real-tape shadow execution</h3>
      <p className="text-sm text-zinc-400">Mainnet aggregate trades drive estimated fills. No random fills or generated rebounds. Queue priority, fees and slippage remain estimates. Deep demo limits may remain unfilled because mainnet and demo use separate order books.</p>
      {!shadow?.orders?.length && <p className="text-sm text-zinc-500">No real-tape shadow orders recorded.</p>}
      <div className="max-h-72 overflow-auto">{shadow?.orders?.slice().reverse().map((o: any) => <div key={o.id} className="border-b border-zinc-800 py-2 text-sm">
        <strong>{o.symbol}</strong> / {o.state} / limit ${o.entryPrice} / observed sell volume ${o.consumedUsd.toFixed(2)} / ${(o.queueAheadUsd + o.entryPrice * o.quantity).toFixed(2)}
        {o.grossPnlUsd !== undefined && <span> / estimated gross P&L ${o.grossPnlUsd.toFixed(4)} before fees/slippage</span>}
        {o.reason && <p className="text-amber-300">{o.reason}</p>}
      </div>)}</div>
    </div>
  </section>;
}
