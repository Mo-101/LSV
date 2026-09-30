import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Radio, ShieldAlert, Zap, Play, Octagon, Sliders, Crosshair } from 'lucide-react';
import type { RuntimeConfig } from '../engine/runtimeConfig';

const presets = {
  MINI_MICRO_10: { totalRiskPoolUsd: 10, marginPerSlotUsd: 5, maxActiveSlots: 2, allowedSymbols: ['SOLUSDT', 'DOGEUSDT', 'XRPUSDT', 'SUIUSDT', 'ETHUSDT', 'AVAXUSDT'] },
  MICRO_FLIGHT_250: { totalRiskPoolUsd: 250, marginPerSlotUsd: 25, maxActiveSlots: 3, allowedSymbols: [] },
  INSTITUTIONAL_250K: { totalRiskPoolUsd: 250000, marginPerSlotUsd: 25000, maxActiveSlots: 3, allowedSymbols: [] },
};
const ACTIVE = ['ARMED', 'FILLED'];
const price = (n?: number) => n === undefined || !Number.isFinite(n) ? '—' : `$${n >= 10 ? n.toFixed(2) : n.toFixed(4)}`;
const usd = (n: number) => `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(4)}`;

export function UnifiedExecutionPanel({ onConfig }: { onConfig: (config: RuntimeConfig) => void }) {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [shadow, setShadow] = useState<any>(null);
  const [demo, setDemo] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [symbols, setSymbols] = useState('');
  const [now, setNow] = useState(Date.now());
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
      const results = await Promise.all(['/api/config', '/api/shadow/status', '/api/demo/status'].map(async url => {
        const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error(`Could not load ${url}`);
        return response.json();
      }));
      apply(results[0]); setShadow(results[1]); setDemo(results[2]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Status unavailable');
    } finally { loading.current = false; }
  }, []);
  useEffect(() => { void refresh(); const timer = setInterval(refresh, 5000); return () => clearInterval(timer); }, [refresh]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
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
  // The backend requires slots x margin <= risk pool, so more slots than the pool covers grows the pool.
  const slotPatch = (n: number): Partial<RuntimeConfig> => {
    const needed = (config?.marginPerSlotUsd ?? 0) * n;
    return config && needed > config.totalRiskPoolUsd ? { maxActiveSlots: n, totalRiskPoolUsd: needed, microCapitalTier: 'CUSTOM' } : { maxActiveSlots: n };
  };

  const orders: any[] = shadow?.orders ?? [];
  const mirrors: any[] = demo?.records ?? [];
  const mirrorFor = (id: string) => mirrors.filter(m => m.shadowId === id).at(-1);
  const activeOrders = orders.filter(o => ACTIVE.includes(o.state));
  const history = orders.filter(o => !ACTIVE.includes(o.state)).slice(-8).reverse();
  const pill = (active: boolean, tone: string) => `flex items-center gap-1.5 px-3 py-1 rounded-md transition-all font-bold disabled:opacity-40 ${active ? tone : 'text-zinc-500 hover:text-zinc-300'}`;
  const chip = (active: boolean, tone = 'bg-zinc-800 text-emerald-300 border border-emerald-500/40') => `px-2 py-0.5 rounded text-[11px] font-bold transition-all disabled:opacity-40 ${active ? tone : 'text-zinc-500 hover:text-zinc-300'}`;
  const input = 'w-28 rounded bg-zinc-900 border border-zinc-800 px-2 py-0.5 text-[11px] text-zinc-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500';

  const demoLine = (m: any) => {
    if (!m) return demo?.configured && config?.mirrorToDemo ? <span className="text-zinc-600">Demo: not mirrored</span> : null;
    const entry = m.entry;
    const label = m.state === 'FAILED' ? 'NOT PLACED'
      : entry.status === 'FILLED' ? (m.tp?.status === 'FILLED' ? 'TP FILLED' : 'POSITION OPEN')
      : entry.status === 'PARTIALLY_FILLED' ? 'PARTIAL FILL' : m.state === 'DONE' ? (entry.executedQty > 0 ? 'CLOSED' : 'CANCELED (NO FILL)') : 'ORDER RESTING';
    return <div className="space-y-0.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-cyan-300 font-bold">BINANCE DEMO {entry.orderId ? `#${entry.orderId}` : '(unconfirmed)'}</span>
        <span className={`px-1.5 rounded text-[10px] font-bold border ${m.state === 'FAILED' ? 'bg-rose-950 text-rose-300 border-rose-700/60' : 'bg-cyan-950 text-cyan-300 border-cyan-700/60'}`}>{label}</span>
      </div>
      <div className="flex items-center justify-between text-zinc-400">
        <span>Limit {price(entry.price)}{entry.executedQty > 0 ? ` · filled ${entry.executedQty} @ ${price(entry.avgPrice)}` : ''}</span>
        {m.tp && <span>TP {price(m.tp.price)}</span>}
      </div>
      {m.realizedPnlUsd !== undefined && <div className={m.realizedPnlUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'}>Demo realized {usd(m.realizedPnlUsd)} before fees</div>}
      {m.error && <div className="text-amber-300">{m.error}</div>}
    </div>;
  };

  return <section className="bg-zinc-950 border border-zinc-800 rounded-xl p-4 shadow-xl font-mono text-xs space-y-4 text-zinc-200">
    {/* Mode selector, mirror and kill switch */}
    <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center bg-zinc-900 p-0.5 rounded-lg border border-zinc-800">
          <button disabled={busy || !config} onClick={() => void update({ mode: 'SIGNAL_ONLY' })} className={pill(config?.mode === 'SIGNAL_ONLY', 'bg-indigo-950 text-indigo-300 border border-indigo-600/70 shadow-sm')} title="Alerts only; no shadow or demo entries">
            <Radio className="w-3 h-3 text-indigo-400" /><span>SIGNAL RADAR ONLY</span>
          </button>
          <button disabled={busy || !config} onClick={() => void update({ mode: 'PAPER' })} className={pill(config?.mode === 'PAPER', 'bg-emerald-950 text-emerald-300 border border-emerald-600/70 shadow-sm')} title="Real-tape shadow: mainnet trades drive estimated fills">
            <ShieldAlert className="w-3 h-3 text-emerald-400" /><span>SHADOW TRADER (PAPER)</span>
          </button>
          <button disabled={busy || !config || !demo?.configured} onClick={() => void update({ mirrorToDemo: !config?.mirrorToDemo })}
            className={pill(Boolean(config?.mirrorToDemo), 'bg-cyan-950 text-cyan-300 border border-cyan-600/70 shadow-sm')}
            title={demo?.configured ? 'Copy every shadow entry and exit onto the Binance demo account' : 'Set BINANCE_KEY and BINANCE_SECRET on the server'}>
            <Zap className="w-3 h-3 text-cyan-400" /><span>{!demo?.configured ? 'BINANCE DEMO: NO KEYS' : config?.mirrorToDemo ? 'BINANCE DEMO MIRROR: ON' : 'BINANCE DEMO MIRROR: OFF'}</span>
          </button>
        </div>
        <button disabled={busy || !config} onClick={() => void update({ autoExecute: !config?.autoExecute })}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border font-bold disabled:opacity-40 ${config?.autoExecute ? 'bg-emerald-950 text-emerald-300 border-emerald-600/70' : 'bg-zinc-900 text-zinc-400 border-zinc-700'}`}
          title="Arm a shadow order automatically on each qualifying liquidation cascade">
          <Crosshair className="w-3.5 h-3.5" /><span>AUTO ENTRIES: {config?.autoExecute ? 'ON' : 'OFF'}</span>
        </button>
      </div>
      <button disabled={busy || !config} onClick={() => void (config?.halted ? update({ halted: false }) : mutate('/api/execution/halt', {}))}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border font-bold disabled:opacity-40 ${config?.halted ? 'bg-emerald-950 text-emerald-300 border-emerald-600/70' : 'bg-rose-950 text-rose-300 border-rose-600/70 hover:bg-rose-900'}`}>
        {config?.halted ? <><Play className="w-3.5 h-3.5" /><span>RESUME ENTRIES</span></> : <><Octagon className="w-3.5 h-3.5" /><span>HALT &amp; FLATTEN</span></>}
      </button>
    </div>

    {/* Demo account strip */}
    {demo?.configured && <div className="flex flex-wrap items-center gap-3 px-3 py-2 bg-black/40 border border-zinc-800 rounded-lg">
      <span className="flex items-center gap-1.5">
        <span className={`w-2 h-2 rounded-full ${demo.error ? 'bg-rose-500' : 'bg-emerald-400 animate-pulse'}`} />
        <span className="text-[10px] font-bold uppercase text-zinc-400">{demo.error ? `Binance demo unreachable: ${demo.error}` : 'Binance demo account connected'}</span>
      </span>
      <span className="text-zinc-700">|</span>
      <span className="text-[11px]">Balance: <span className="text-emerald-300 font-bold">{demo.balance === null ? 'unknown' : `$${demo.balance.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDT`}</span></span>
      <span className="text-zinc-700">|</span>
      <span className="text-[10px] text-zinc-500">Demo orders rest at the shadow's depth below the demo bid; demo fills come from the demo book.</span>
    </div>}
    {error && <p role="alert" className="text-rose-300">{error}</p>}
    {notice && <p role="status" className="text-cyan-300">{notice}</p>}

    {/* Governor */}
    {config && <div className="flex flex-wrap items-center gap-x-5 gap-y-2 p-3 bg-zinc-900/40 border border-zinc-800 rounded-lg">
      <div className="flex items-center gap-1.5">
        <Sliders className="w-3.5 h-3.5 text-emerald-400" /><span className="text-zinc-500 text-[11px]">CAPITAL TIER:</span>
        <div className="flex items-center bg-zinc-900 rounded border border-zinc-800 p-0.5">
          <button disabled={busy} onClick={() => void update({ microCapitalTier: 'INSTITUTIONAL_250K', ...presets.INSTITUTIONAL_250K })} className={chip(config.microCapitalTier === 'INSTITUTIONAL_250K')}>$250k INSTITUTIONAL</button>
          <button disabled={busy} onClick={() => void update({ microCapitalTier: 'MICRO_FLIGHT_250', ...presets.MICRO_FLIGHT_250 })} className={chip(config.microCapitalTier === 'MICRO_FLIGHT_250', 'bg-amber-950 text-amber-300 border border-amber-500/50')}>🧪 $250 FLIGHT</button>
          <button disabled={busy} onClick={() => void update({ microCapitalTier: 'MINI_MICRO_10', ...presets.MINI_MICRO_10 })} className={chip(config.microCapitalTier === 'MINI_MICRO_10', 'bg-cyan-950 text-cyan-300 border border-cyan-400')}>🧪 $10 MINI-MICRO</button>
          {config.microCapitalTier === 'CUSTOM' && <span className={chip(true)}>CUSTOM ${config.totalRiskPoolUsd}</span>}
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-zinc-500 text-[11px]">MAX SLOTS:</span>
        <div className="flex items-center bg-zinc-900 rounded border border-zinc-800 p-0.5">
          {[1, 2, 3, 4, 5].map(n => <button key={n} disabled={busy} onClick={() => void update(slotPatch(n))} className={chip(config.maxActiveSlots === n)}>{n}</button>)}
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-zinc-500 text-[11px]">SIZE:</span>
        <span className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 font-bold text-emerald-300">${config.marginPerSlotUsd} × {config.leverage}x = ${config.marginPerSlotUsd * config.leverage}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-zinc-500 text-[11px]">QUEUE HURDLE:</span>
        <span className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 font-bold text-emerald-300">${(config.usdQueueHurdle / 1000).toFixed(0)}k USD</span>
      </div>
      <label className="flex items-center gap-1.5 text-zinc-500 text-[11px]">MIN CASCADE $
        <input key={`volume-${config.revision}`} disabled={busy} className={input} type="number" min="1000" defaultValue={config.minLiquidationUsd} onBlur={e => { if (Number(e.target.value) !== config.minLiquidationUsd) void update({ minLiquidationUsd: Number(e.target.value) }); }} />
      </label>
      <label className="flex items-center gap-1.5 text-zinc-500 text-[11px]">ABSORPTION ×
        <input key={`buffer-${config.revision}`} disabled={busy} className={`${input} w-20`} type="number" min="1" max="5" step="0.05" defaultValue={config.absorptionBuffer} onBlur={e => { if (Number(e.target.value) !== config.absorptionBuffer) void update({ absorptionBuffer: Number(e.target.value) }); }} />
      </label>
      <div className="flex w-full flex-wrap items-center gap-1.5">
        <span className="text-zinc-500 text-[11px]">SYMBOLS (empty = all USDT):</span>
        <input disabled={busy} className={`${input} min-w-0 flex-1`} value={symbols} onChange={e => setSymbols(e.target.value)} />
        <button disabled={busy} className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-[11px] font-bold text-zinc-200 disabled:opacity-40" onClick={() => void update({ allowedSymbols: symbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) })}>SAVE</button>
      </div>
    </div>}

    {/* Slot cards */}
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {Array.from({ length: Math.max(config?.maxActiveSlots ?? 2, activeOrders.length) }).map((_, i) => {
        const o = activeOrders[i];
        const m = o && mirrorFor(o.id);
        const hold = o?.fillTime ? Math.max(0, Math.floor((now - o.fillTime) / 1000)) : 0;
        const holdMax = o ? Math.round(o.holdMs / 1000) : 90;
        const hurdle = o ? o.queueAheadUsd + o.entryPrice * o.quantity : 0;
        const entryLeft = o ? Math.max(0, Math.ceil((o.entryDeadline - now) / 1000)) : 0;
        return <div key={i} className={`p-3 rounded-lg border transition-all ${o ? 'bg-emerald-950/20 border-emerald-500/60 shadow-lg' : 'bg-zinc-900/40 border-zinc-800/80 border-dashed'}`}>
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-bold text-zinc-400">SLOT #{i + 1}</span>
            <span className={`px-1.5 rounded text-[10px] font-bold ${o ? (o.state === 'FILLED' ? 'bg-emerald-950 text-emerald-300 border border-emerald-700/60' : 'bg-amber-950 text-amber-300 border border-amber-700/60') : 'text-zinc-600'}`}>
              {o ? (o.state === 'FILLED' ? 'SHADOW FILLED' : 'SHADOW ARMED') : 'STANDBY'}
            </span>
          </div>
          {o ? <div className="mt-2 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-sm font-black text-white">{o.symbol}</span>
              <span className="text-[10px] text-zinc-400">Floor {price(o.entryPrice)} → TP {price(o.targetTp)}</span>
            </div>
            {o.state === 'FILLED' ? <>
              <div className="flex items-center justify-between text-[10px] text-zinc-400"><span>Hold: {hold}s / {holdMax}s</span><span>Qty {o.quantity.toFixed(4)}</span></div>
              <div className="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden"><div className="bg-emerald-500 h-full transition-all duration-300" style={{ width: `${Math.min(100, (hold / holdMax) * 100)}%` }} /></div>
            </> : <>
              <div className="flex items-center justify-between text-[10px] text-zinc-400"><span>Sell volume ${(o.consumedUsd / 1000).toFixed(1)}k / ${(hurdle / 1000).toFixed(1)}k</span><span>{entryLeft}s left</span></div>
              <div className="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden"><div className="bg-amber-500 h-full transition-all duration-300" style={{ width: `${Math.min(100, (o.consumedUsd / hurdle) * 100)}%` }} /></div>
            </>}
            <div className="pt-1.5 border-t border-zinc-800 text-[10px]">{demoLine(m)}</div>
          </div> : <div className="mt-3 text-center text-zinc-600 text-[11px] py-1">Available • Margin: ${(config?.marginPerSlotUsd ?? 0).toLocaleString()}</div>}
        </div>;
      })}
    </div>

    {/* Finished trades */}
    <div className="space-y-2">
      <div className="text-[10px] text-zinc-500 uppercase font-bold">Recent shadow trades · estimated from mainnet tape, before fees</div>
      {!history.length && <div className="text-[11px] text-zinc-600">No finished real-tape shadow trades yet.</div>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {history.map(o => {
          const m = mirrorFor(o.id);
          const tone = o.state === 'TP' ? 'text-emerald-300 border-emerald-700/60' : o.state === 'TIME_STOP' ? 'text-amber-300 border-amber-700/60' : 'text-zinc-400 border-zinc-700';
          return <div key={o.id} className="p-2.5 rounded-lg border border-zinc-800 bg-zinc-900/40 space-y-1">
            <div className="flex items-center justify-between">
              <span className="font-black text-white">{o.symbol}</span>
              <span className={`px-1.5 rounded text-[10px] font-bold border ${tone}`}>{o.state === 'TIME_STOP' ? 'TIME STOP' : o.state}</span>
            </div>
            <div className="flex items-center justify-between text-[10px] text-zinc-400">
              <span>Entry {price(o.entryPrice)}{o.exitPrice !== undefined ? ` → exit ${price(o.exitPrice)}` : ''}</span>
              {o.grossPnlUsd !== undefined && <span className={o.grossPnlUsd >= 0 ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>Shadow {usd(o.grossPnlUsd)}</span>}
            </div>
            {o.reason && <div className="text-[10px] text-amber-300">{o.reason}</div>}
            {m && <div className="pt-1 border-t border-zinc-800 text-[10px]">{demoLine(m)}</div>}
          </div>;
        })}
      </div>
    </div>
  </section>;
}
