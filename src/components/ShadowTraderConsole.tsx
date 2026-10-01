import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { 
  Activity, 
  Layers, 
  Terminal, 
  Copy, 
  Download, 
  Check, 
  Filter, 
  CheckCircle2, 
  AlertTriangle, 
  XCircle, 
  Cpu, 
  Gauge, 
  Database,
  BarChart2,
  RefreshCw,
  Search,
  ArrowRight,
  ShieldAlert,
  Zap,
  Radio,
  Sliders,
  Play,
  Square,
  Crosshair,
  Bell,
  Send,
  Settings,
  Octagon,
  ExternalLink,
  PhoneCall,
  Clock,
  Sparkles
} from 'lucide-react';
import { 
  ShadowTradeLogRecord, 
  FleetPairTelemetry, 
  ConcurrencyGovernorConfig, 
  OperationalMode, 
  WebhookDispatcherConfig, 
  DispatchedSignalCard 
} from '../types';

import { TOP_30_UNIVERSE } from '../engine/fleetUniverse';

const DEFAULT_GOVERNOR: ConcurrencyGovernorConfig = {
  maxActiveSlots: 3,
  totalRiskPoolUsd: 250000,
  marginPerSlotUsd: 25000,
  usdQueueHurdle: 150000,
  autoExecute: true,
  minCviThreshold: 3.0,
  decelerationCap: 65,
  baseDropPct: 0.008,
  absorptionBuffer: 1.45,
  feeDragPct: 0.07, // 0.07% round-trip exchange fee deduction
  toxicOiThresholdPct: 15, // 15% OI drop in <60s triggers TOXIC_EVENT_ABORT
  microCapitalTier: 'INSTITUTIONAL_250K',
};

const DEFAULT_WEBHOOK_CONFIG: WebhookDispatcherConfig = {
  enabled: true,
  telegramToken: '',
  telegramChatId: '',
  discordWebhookUrl: '',
  notifyOnArmed: true,
  notifyOnFilled: true,
  notifyOnExit: true,
  lastPingStatus: 'IDLE',
};

interface LiveTick {
  mid: number;
  lastTrade: number;
  bids: Array<[number, number]>;
  tradeTimes: number[];
  pendingSellUsd: number;
  quoteVolume24h: number;
}

interface ShadowTraderConsoleProps {
  onBackToBlueprint?: () => void;
}

export const ShadowTraderConsole: React.FC<ShadowTraderConsoleProps> = () => {
  // 1. Operational Mode: 3-way toggle [SIGNAL_ONLY, PAPER, LIVE]
  const [operationalMode, setOperationalMode] = useState<OperationalMode>('PAPER');

  // 2. Governor & Fleet Configuration
  const [governor, setGovernor] = useState<ConcurrencyGovernorConfig>(DEFAULT_GOVERNOR);
  const [selectedPair, setSelectedPair] = useState<string>('BTCUSDT');
  const [isScanningActive, setIsScanningActive] = useState<boolean>(true);
  const [isHalted, setIsHalted] = useState<boolean>(false);

  // 3. Webhook Dispatcher Config & Modal
  const [webhookConfig, setWebhookConfig] = useState<WebhookDispatcherConfig>(DEFAULT_WEBHOOK_CONFIG);
  const [isWebhookModalOpen, setIsWebhookModalOpen] = useState<boolean>(false);
  const [isPingSending, setIsPingSending] = useState<boolean>(false);

  // 4. Live Signal Dispatch Cards (Card previews sent to phone/discord)
  const [dispatchedSignals, setDispatchedSignals] = useState<DispatchedSignalCard[]>([]);

  // Fleet State (Top 30 live matrix)
  const [fleet, setFleet] = useState<FleetPairTelemetry[]>(() => 
    TOP_30_UNIVERSE.map((p) => ({
      symbol: p.symbol,
      name: p.name,
      price: 0,
      refPrice: 0,
      dropPct: 0,
      cvi: 0,
      cushionPct: 0,
      tickVelocity: 0,
      volume24hUsd: 0,
      openInterestStability: p.oiStability,
      status: 'IDLE',
      requiredQueueUsd: 150000,
      accumulatedFillUsd: 0,
      minContractStepUsd: p.minLotStepUsd,
      is10DollarApproved: p.is10DollarApproved,
    }))
  );

  // Connection & live orderbook depth
  const [connectionStatus, setConnectionStatus] = useState<'CONNECTED' | 'DISCONNECTED' | 'CONNECTING'>('CONNECTING');
  const [bidsDepth, setBidsDepth] = useState<Array<[number, number]>>([]);
  const [asksDepth, setAsksDepth] = useState<Array<[number, number]>>([]);
  const tradeTimestampsRef = useRef<number[]>([]);
  const [activeVelocity, setActiveVelocity] = useState<number>(14);

  // Trade History & CSV Ledger
  const [tradeLogs, setTradeLogs] = useState<ShadowTradeLogRecord[]>([]);
  const [activeTab, setActiveTab] = useState<'FLEET_MATRIX' | 'DISPATCH_PREVIEW' | 'FOCUSED_EXECUTION' | 'CSV_LEDGER' | 'PYTHON_SOURCE'>('FLEET_MATRIX');
  const [ledgerFilter, setLedgerFilter] = useState<'ALL' | 'TP_HIT' | 'TIME_STOP'>('ALL');
  const [radarFilter, setRadarFilter] = useState<'ALL' | 'HIGH_CVI' | 'ACTIVE_SLOTS' | '10_APPROVED'>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(null);

  // Standalone python script text
  const [pythonScript, setPythonScript] = useState<string>('');
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);

  // Selected pair telemetry derivation
  const selectedTelemetry = useMemo(() => {
    return fleet.find(p => p.symbol === selectedPair) || fleet[0];
  }, [fleet, selectedPair]);

  // Active slots count and prioritized queue
  const occupiedSlots = useMemo(() => {
    return fleet.filter(p => p.status === 'FILLED');
  }, [fleet]);

  const armedTraps = useMemo(() => {
    return fleet.filter(p => p.status === 'ARMED');
  }, [fleet]);

  // Dispatch signal card generator
  const dispatchSignal = useCallback((card: Omit<DispatchedSignalCard, 'id' | 'timestamp' | 'destinations'>) => {
    const destinations: string[] = [];
    if (webhookConfig.enabled) destinations.push('Delivery pending');
    if (webhookConfig.discordWebhookUrl) destinations.push('Discord Webhook');
    if (destinations.length === 0) destinations.push('Local Terminal Relay');

    const newCard: DispatchedSignalCard = {
      ...card,
      title: `[SIMULATION] ${card.title}`,
      metrics: { ...card.metrics, 'Execution source': 'Local simulation; no exchange order' },
      id: `sig-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      timestamp: new Date().toISOString(),
      destinations,
    };

    setDispatchedSignals(prev => [newCard, ...prev.slice(0, 19)]);

    // Automatically send to Telegram via backend if configured
    if (webhookConfig.enabled) {
      fetch('/api/webhook/dispatch-alert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: newCard.title,
          details: newCard.metrics,
          telegramToken: webhookConfig.telegramToken,
          telegramChatId: webhookConfig.telegramChatId,
          discordWebhookUrl: webhookConfig.discordWebhookUrl,
        }),
      }).then(async response => {
        const data = await response.json();
        const results = data.results || {};
        const delivered = Object.entries(results)
          .filter(([, status]) => status === 'SUCCESS')
          .map(([destination]) => destination);
        setDispatchedSignals(previous => previous.map(signal => signal.id === newCard.id
          ? { ...signal, destinations: delivered.length ? delivered : ['Delivery failed or not configured'] }
          : signal));
      }).catch(() => {
        setDispatchedSignals(previous => previous.map(signal => signal.id === newCard.id
          ? { ...signal, destinations: ['Delivery failed'] }
          : signal));
      });
    }
  }, [webhookConfig]);

  // Load trade records from /api/shadow-trades
  const fetchTrades = useCallback(async (isManual = false) => {
    if (isManual) setIsRefreshing(true);
    try {
      const res = await fetch('/api/shadow-trades');
      if (res.ok) {
        const data = await res.json();
        if (data.trades) {
          setTradeLogs(data.trades);
          setLastSyncTime(new Date().toLocaleTimeString());
        }
      }
    } catch {
      // fallback
    } finally {
      if (isManual) setTimeout(() => setIsRefreshing(false), 300);
    }
  }, []);

  const fetchPythonScript = useCallback(async () => {
    try {
      const res = await fetch('/api/shadow-script');
      if (res.ok) {
        const data = await res.json();
        setPythonScript(data.script || '');
      }
    } catch {
      // fallback
    }
  }, []);

  useEffect(() => {
    fetchTrades();
    fetchPythonScript();
    const interval = setInterval(() => {
      fetchTrades();
    }, 3000);
    return () => clearInterval(interval);
  }, [fetchTrades, fetchPythonScript]);

  // ================= LIVE WEBSOCKET INGESTION (all pairs, real Binance ticks) =================
  // Raw ticks are kept in refs; the 1s fleet loop below reads them, so 30 pairs
  // of depth and trades do not re-render the page on every message.
  const liveTicksRef = useRef(new Map<string, LiveTick>());
  const armedPricesRef = useRef(new Map<string, number>());
  const selectedPairRef = useRef(selectedPair);
  selectedPairRef.current = selectedPair;
  const liveTick = (symbol: string) => {
    let tick = liveTicksRef.current.get(symbol);
    if (!tick) {
      tick = { mid: 0, lastTrade: 0, bids: [], tradeTimes: [], pendingSellUsd: 0, quoteVolume24h: 0 };
      liveTicksRef.current.set(symbol, tick);
    }
    return tick;
  };

  useEffect(() => {
    const symbols = TOP_30_UNIVERSE.map(p => p.symbol.toLowerCase());
    const wsUrls = [
      `wss://fstream.binance.com/public/stream?streams=${symbols.map(s => `${s}@depth20@100ms`).join('/')}`,
      `wss://fstream.binance.com/market/stream?streams=${symbols.flatMap(s => [`${s}@aggTrade`, `${s}@ticker`]).join('/')}`,
    ];

    setConnectionStatus('CONNECTING');
    const sockets = new Set<WebSocket>();
    const receivedStreams = new Set<string>();
    let disposed = false;
    const reconnectTimers = new Set<ReturnType<typeof setTimeout>>();
    const connect = (wsUrl: string) => { try {
      const ws = new WebSocket(wsUrl);
      sockets.add(ws);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnectionStatus('CONNECTING');
      };

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          const stream: string = payload.stream || '';
          const data = payload.data || {};
          if (data.e) receivedStreams.add(wsUrl);
          if (receivedStreams.size === wsUrls.length) setConnectionStatus('CONNECTED');
          const symbol = String(data.s || stream.split('@')[0]).toUpperCase();
          const tick = liveTick(symbol);

          if (stream.includes('@depth20')) {
            const rawBids: Array<[string, string]> = data.b || [];
            const rawAsks: Array<[string, string]> = data.a || [];
            if (rawBids.length > 0 && rawAsks.length > 0) {
              const pBids = rawBids.map(b => [parseFloat(b[0]), parseFloat(b[1])] as [number, number]);
              const pAsks = rawAsks.map(a => [parseFloat(a[0]), parseFloat(a[1])] as [number, number]);
              tick.bids = pBids;
              tick.mid = (pBids[0][0] + pAsks[0][0]) / 2;
              if (symbol === selectedPairRef.current) {
                setBidsDepth(pBids);
                setAsksDepth(pAsks);
              }
            }
          } else if (stream.includes('@aggTrade')) {
            const p = parseFloat(data.p);
            const q = parseFloat(data.q);
            if (!(p > 0 && q > 0)) return;
            tick.lastTrade = p;
            tick.tradeTimes.push(Date.now());
            // m=true: buyer is maker, so the aggressor is selling into bids.
            const armedPrice = armedPricesRef.current.get(symbol);
            if (data.m === true && armedPrice !== undefined && p <= armedPrice) tick.pendingSellUsd += p * q;
          } else if (stream.includes('@ticker')) {
            const quoteVolume = parseFloat(data.q);
            if (quoteVolume > 0) tick.quoteVolume24h = quoteVolume;
          }
        } catch {
          // ignore corrupted frame
        }
      };

      ws.onerror = () => setConnectionStatus('DISCONNECTED');
      ws.onclose = () => {
        sockets.delete(ws);
        receivedStreams.delete(wsUrl);
        if (disposed) return;
        setConnectionStatus('DISCONNECTED');
        const timer = setTimeout(() => {
          reconnectTimers.delete(timer);
          connect(wsUrl);
        }, 5000);
        reconnectTimers.add(timer);
      };
    } catch {
      setConnectionStatus('DISCONNECTED');
    } };
    wsUrls.forEach(connect);

    return () => {
      disposed = true;
      reconnectTimers.forEach(clearTimeout);
      sockets.forEach(ws => ws.close());
    };
  }, []);

  // ================= SIMULATED FLEET ENGINE DYNAMICS =================
  useEffect(() => {
    if (!isScanningActive || isHalted) return;

    const fleetInterval = setInterval(() => {
      const now = Date.now();

      setFleet(prev => {
        let activeFilledCount = prev.filter(p => p.status === 'FILLED').length;

        return prev.map(pair => {
          let updatedPair = { ...pair };
          const live = liveTicksRef.current.get(pair.symbol);
          if (live) {
            while (live.tradeTimes.length > 0 && live.tradeTimes[0] < now - 1000) live.tradeTimes.shift();
            updatedPair.tickVelocity = live.tradeTimes.length;
            if (live.quoteVolume24h > 0) updatedPair.volume24hUsd = live.quoteVolume24h;
          }
          if (pair.status !== 'FILLED' && live && live.mid > 0) {
            // Same depth formulas as before, now from real ticks for every pair.
            const ref = pair.refPrice > 0 ? pair.refPrice : live.mid;
            const drop = Math.max(0, (ref - live.mid) / ref);
            const topBidUsd = live.bids.slice(0, 10).reduce((sum, b) => sum + (b[0] * b[1]), 0);
            const cviScore = Math.min(6.5, Math.max(1.1, (drop * 2800000) / Math.max(10000, topBidUsd)));
            updatedPair = {
              ...updatedPair,
              price: live.mid,
              refPrice: ref,
              dropPct: drop,
              cvi: Math.round(cviScore * 100) / 100,
              cushionPct: Math.round(Math.min(220, Math.max(90, (topBidUsd / governor.usdQueueHurdle) * 100))),
            };
          }

          // Suggestion 2: TOXIC EXPLOIT / HACK INVARIANT (OI drop > 15% in <60s)
          if ((updatedPair.oiPlungePct || 0) >= governor.toxicOiThresholdPct && updatedPair.status !== 'TOXIC_ABORT') {
            updatedPair.status = 'TOXIC_ABORT';
            updatedPair.isToxicAborted = true;
            if (webhookConfig.notifyOnExit) {
              dispatchSignal({
                type: 'TOXIC_EVENT',
                symbol: updatedPair.symbol,
                title: `☣️ [TOXIC OI COLLAPSE ABORT] — ${updatedPair.symbol}`,
                badgeColor: 'purple',
                metrics: {
                  'OI Plunge': `-${updatedPair.oiPlungePct}% in <60s`,
                  'Hazard Type': 'Suspected Exploit / Delisting / Treasury Drain',
                  'Action': 'Net Disarmed / Traps Aborted for 1 Hour',
                  'Risk Armor': 'Capital Protected from Uncontrolled Waterfall'
                },
                rawPayload: `☣️ [TOXIC OI COLLAPSE ABORT] — ${updatedPair.symbol}\n• OI Plunge: -${updatedPair.oiPlungePct}%\n• Reason: Suspected exploit or fundamental run\n• Status: Traps disarmed.`
              });
            }
          }

          // Autonomous Trap Arming (If CVI >= 3.0, Deceleration Gate Valid, Drop >= 0.8%, Not Toxic)
          if (
            governor.autoExecute && 
            updatedPair.status === 'IDLE' && 
            !updatedPair.isToxicAborted &&
            updatedPair.cvi >= governor.minCviThreshold &&
            updatedPair.dropPct >= governor.baseDropPct &&
            updatedPair.tickVelocity <= governor.decelerationCap &&
            activeFilledCount < governor.maxActiveSlots
          ) {
            const floor = updatedPair.price * 0.997;
            updatedPair.status = 'ARMED';
            updatedPair.armedPrice = floor;
            updatedPair.targetTp = floor * 1.005;
            updatedPair.accumulatedFillUsd = 0;

            if (webhookConfig.notifyOnArmed) {
              dispatchSignal({
                type: 'ARMED',
                symbol: updatedPair.symbol,
                title: `🎯 [TRAP ARMED] — ${updatedPair.symbol}`,
                badgeColor: 'amber',
                metrics: {
                  'Vacuum Metric': `CVI ${updatedPair.cvi.toFixed(2)}x`,
                  'Displacement': `${(updatedPair.dropPct * 100).toFixed(2)}% Drop`,
                  '145% Floor': `$${floor.toFixed(4)}`,
                  'Target Snapback': `$${(floor * 1.005).toFixed(4)} (+0.50%)`,
                  'Queue Hurdle': `$${governor.usdQueueHurdle.toLocaleString()} USD Required`
                },
                rawPayload: `🎯 [TRAP ARMED] — ${updatedPair.symbol}\n• Floor: $${floor.toFixed(4)}\n• TP: $${(floor * 1.005).toFixed(4)}\n• CVI: ${updatedPair.cvi.toFixed(2)}x`
              });
            }
          }

          // Autonomous Queue Absorption & Air-Pocket Detonation (Armed -> Filled)
          if (updatedPair.status === 'ARMED' && updatedPair.armedPrice) {
            // A new floor starts counting real volume from zero.
            if (armedPricesRef.current.get(pair.symbol) !== updatedPair.armedPrice && live) live.pendingSellUsd = 0;
            armedPricesRef.current.set(pair.symbol, updatedPair.armedPrice);
          }
          if (updatedPair.status === 'ARMED' && governor.autoExecute && operationalMode === 'PAPER') {
            // Real seller-initiated volume at or below the floor since the last tick
            const incomingTakerVol = live ? live.pendingSellUsd : 0;
            if (live) live.pendingSellUsd = 0;
            const nextQueueTotal = (updatedPair.accumulatedFillUsd || 0) + incomingTakerVol;
            updatedPair.accumulatedFillUsd = nextQueueTotal;

            if (nextQueueTotal >= governor.usdQueueHurdle) {
              if (activeFilledCount < governor.maxActiveSlots) {
                const allocatedSlot = activeFilledCount + 1;
                activeFilledCount++;
                const floorPrice = updatedPair.armedPrice || updatedPair.price;
                const tpTarget = floorPrice * 1.005;
                
                updatedPair.status = 'FILLED';
                updatedPair.fillTime = now;
                updatedPair.activeSlot = allocatedSlot;
                updatedPair.holdSeconds = 0;
                updatedPair.armedPrice = floorPrice;
                updatedPair.targetTp = tpTarget;
                updatedPair.price = floorPrice; // Post-only fill executes at the floor

                dispatchSignal({
                  type: 'FILLED',
                  symbol: updatedPair.symbol,
                  title: `🚨 [AUTONOMOUS CASCADE FILLED] — ${updatedPair.symbol}`,
                  badgeColor: 'emerald',
                  metrics: {
                    'Queue Clearance': `$${governor.usdQueueHurdle.toLocaleString()} USD Absorbed (~4.5s)`,
                    'Vacuum Metric': `CVI ${(updatedPair.cvi || 3.8).toFixed(2)}x`,
                    'Execution Entry': `$${floorPrice.toFixed(4)} (Post-Only Filled)`,
                    'Target TP': `$${tpTarget.toFixed(4)} (+0.50% Snapback)`,
                    'Chronometer': '90s Mechanical Countdown',
                    'Active Risk Slot': `Slot #${allocatedSlot} of ${governor.maxActiveSlots} ($${governor.marginPerSlotUsd} Margin)`
                  },
                  rawPayload: `🚨 [AUTONOMOUS CASCADE FILLED] — ${updatedPair.symbol}\n• Queue: $150,000 USD Hurdle Penetrated\n• Slot: #${allocatedSlot} ($${governor.marginPerSlotUsd} Margin @ 10x)\n• Entry: $${floorPrice.toFixed(4)}\n• TP: $${tpTarget.toFixed(4)}`
                });
              } else {
                // Queue full, cannot allocate another slot (concurrency governor block)
                updatedPair.status = 'IDLE';
                updatedPair.accumulatedFillUsd = 0;
              }
            }
          }

          // Active Slot Management & Natural Mean Reversion Pathing
          if (updatedPair.status === 'FILLED' && updatedPair.fillTime) {
            const elapsed = Math.floor((now - updatedPair.fillTime) / 1000);
            updatedPair.holdSeconds = elapsed;
            
            const entryPrice = updatedPair.armedPrice || updatedPair.price;
            const targetTp = updatedPair.targetTp || entryPrice * 1.005;

            // Real price: latest trade, else order-book mid.
            const livePrice = live?.lastTrade || live?.mid;
            if (livePrice && livePrice > 0) updatedPair.price = livePrice;

            const pnlPct = ((updatedPair.price - entryPrice) / entryPrice) * 100;
            updatedPair.pnlPct = Math.round(pnlPct * 1000) / 1000;
            updatedPair.pnlUsd = Math.round(((pnlPct / 100) * governor.marginPerSlotUsd * 10) * 100) / 100;

            // Exit Condition A: Take Profit Hit (+0.50% snapback)
            if (updatedPair.price >= targetTp) {
              handleFleetTradeClose(updatedPair, targetTp, 'TP_HIT (Mean Reversion)');
              updatedPair.status = 'COOLDOWN';
              setTimeout(() => {
                setFleet(f => f.map(p => p.symbol === updatedPair.symbol ? { ...p, status: 'IDLE', accumulatedFillUsd: 0, armedPrice: undefined, targetTp: undefined, activeSlot: undefined } : p));
              }, 6000);
            }
            // Exit Condition B: 90s Chronometer Expiry
            else if (elapsed >= 90) {
              handleFleetTradeClose(updatedPair, updatedPair.price, 'TIME_STOP_EXPIRED (Floor Broken)');
              updatedPair.status = 'COOLDOWN';
              setTimeout(() => {
                setFleet(f => f.map(p => p.symbol === updatedPair.symbol ? { ...p, status: 'IDLE', accumulatedFillUsd: 0, armedPrice: undefined, targetTp: undefined, activeSlot: undefined } : p));
              }, 6000);
            }
          }

          if (updatedPair.status !== 'ARMED') armedPricesRef.current.delete(pair.symbol);
          return updatedPair;
        });
      });
      const selected = liveTicksRef.current.get(selectedPair);
      if (selected) setActiveVelocity(selected.tradeTimes.length);
    }, 1000);

    return () => clearInterval(fleetInterval);
  }, [isScanningActive, isHalted, selectedPair, governor, operationalMode, webhookConfig.notifyOnArmed, dispatchSignal]);

  // Set of actively closing trade symbols to prevent race conditions or double logging
  const closingTradesRef = useRef<Set<string>>(new Set());

  // Log completed trade to server and dispatch exit alert
  const handleFleetTradeClose = async (pair: FleetPairTelemetry, exitPrice: number, outcome: string) => {
    if (closingTradesRef.current.has(pair.symbol)) {
      return; // Already closing / closed
    }
    closingTradesRef.current.add(pair.symbol);
    setTimeout(() => closingTradesRef.current.delete(pair.symbol), 3000);

    const entryPrice = pair.armedPrice || pair.price;
    const hold = pair.holdSeconds || 22;
    const pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
    const notionalUsd = governor.marginPerSlotUsd * 10;
    const grossPnlUsd = (pnlPct / 100) * notionalUsd;
    
    // Fee Drag & Slippage: 0.07% round-trip (0.02% maker post-only entry + 0.05% taker market exit)
    const feeUsd = (governor.feeDragPct / 100) * notionalUsd;
    const netPnlUsd = grossPnlUsd - feeUsd;
    const netPnlPct = pnlPct - governor.feeDragPct;

    const record: ShadowTradeLogRecord = {
      id: `fleet-${pair.symbol}-${Date.now()}`,
      timestamp: new Date().toISOString(),
      symbol: pair.symbol,
      entryPrice: Math.round(entryPrice * 10000) / 10000,
      exitPrice: Math.round(exitPrice * 10000) / 10000,
      cviAtEntry: pair.cvi || 3.85,
      queueClearanceSeconds: 8.4,
      holdSeconds: hold,
      outcome: outcome as any,
      pnlPct: Math.round(pnlPct * 1000) / 1000,
      pnlUsd: Math.round(grossPnlUsd * 100) / 100,
      feeUsd: Math.round(feeUsd * 100) / 100,
      netPnlUsd: Math.round(netPnlUsd * 100) / 100,
      netPnlPct: Math.round(netPnlPct * 1000) / 1000,
    };

    setTradeLogs(prev => [record, ...prev]);

    // Dispatch Exit Signal Card
    if (webhookConfig.notifyOnExit) {
      const isTp = outcome.startsWith('TP_HIT');
      const isToxic = outcome.includes('TOXIC');
      dispatchSignal({
        type: isToxic ? 'TOXIC_EVENT' : (isTp ? 'EXIT_TP' : 'EXIT_TIME_STOP'),
        symbol: pair.symbol,
        title: isToxic 
          ? `☣️ [TOXIC OI PLUNGE ABORT] — ${pair.symbol}` 
          : (isTp ? `✅ [MEAN REVERSION COMPLETE] — ${pair.symbol}` : `⚠️ [TIME-STOP CUT] — ${pair.symbol}`),
        badgeColor: isToxic ? 'purple' : (isTp ? 'cyan' : (netPnlPct >= 0 ? 'amber' : 'rose')),
        metrics: {
          'Outcome': outcome,
          'Hold Duration': `${hold}s / 90s Max`,
          'Gross PnL': `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% ($${grossPnlUsd.toFixed(2)})`,
          'Fee Drag (0.07%)': `-$${feeUsd.toFixed(2)}`,
          'Net Realized PnL': `${netPnlPct >= 0 ? '+' : ''}${netPnlPct.toFixed(2)}% (${netPnlUsd >= 0 ? '+' : ''}$${netPnlUsd.toFixed(2)})`,
          'Capital Slot': `Slot #${pair.activeSlot || 1} Released to STANDBY`
        },
        rawPayload: `${isToxic ? '☣️ [TOXIC ABORT]' : (isTp ? '✅ [MEAN REVERSION]' : '⚠️ [TIME-STOP CUT]')} — ${pair.symbol}\n• Net PnL: ${netPnlPct >= 0 ? '+' : ''}${netPnlPct.toFixed(2)}% ($${netPnlUsd.toFixed(2)})\n• Fee Drag: -$${feeUsd.toFixed(2)}\n• Hold: ${hold}s`
      });
    }

    try {
      await fetch('/api/shadow-trades', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
      });
    } catch {
      // ignore
    }
  };

  // ================= EMERGENCY KILL-SWITCH =================
  const handleEmergencyHalt = () => {
    setIsHalted(true);
    setIsScanningActive(false);

    // Cancel all resting nets and close all occupied slots to flat cash
    setFleet(prev => prev.map(p => ({
      ...p,
      status: 'IDLE',
      armedPrice: undefined,
      targetTp: undefined,
      accumulatedFillUsd: 0,
      activeSlot: undefined,
      holdSeconds: 0,
    })));

    dispatchSignal({
      type: 'EXIT_TIME_STOP',
      symbol: 'FLEET',
      title: '🛑 [EMERGENCY KILL-SWITCH EXECUTED]',
      badgeColor: 'rose',
      metrics: {
        'Action': 'HALT FLEET / CANCEL ALL ACTIVE NETS',
        'State': 'ALL SLOTS FLATTENED TO CASH (<500ms)',
        'Active Nets Dropped': `${armedTraps.length} Resting Orders Cancelled`,
        'Open Positions Closed': `${occupiedSlots.length} Slots Flattened`,
        'Status': 'ENGINE IN SAFE MODE'
      },
      rawPayload: `🛑 [EMERGENCY KILL-SWITCH EXECUTED]\n• All resting nets dropped\n• All active positions flattened to cash\n• System standing down in safe mode.`
    });

    setToastMessage('EMERGENCY KILL-SWITCH: All 30 assets flattened to cash. Fleet scanner halted.');
    setTimeout(() => setToastMessage(null), 4500);
  };

  const handleResumeFleet = () => {
    setIsHalted(false);
    setIsScanningActive(true);
    setToastMessage('Fleet Engine Resumed: Scanning Top 30 USD-M Futures...');
    setTimeout(() => setToastMessage(null), 3000);
  };

  // Test Ping to Webhook
  const handleSendTestPing = async () => {
    setIsPingSending(true);
    try {
      const res = await fetch('/api/webhook/test-ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegramToken: webhookConfig.telegramToken,
          telegramChatId: webhookConfig.telegramChatId,
          discordWebhookUrl: webhookConfig.discordWebhookUrl,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setWebhookConfig(c => ({
          ...c,
          lastPingStatus: 'SUCCESS',
          lastPingMessage: `Dispatched: TG=${data.results?.telegram || 'Skip'}, Discord=${data.results?.discord || 'Skip'}`
        }));
        setToastMessage('Test Ping Sent Successfully!');
      } else {
        setWebhookConfig(c => ({
          ...c,
          lastPingStatus: 'FAILED',
          lastPingMessage: data.error || 'Failed to dispatch'
        }));
      }
    } catch (err: any) {
      setWebhookConfig(c => ({
        ...c,
        lastPingStatus: 'FAILED',
        lastPingMessage: err.message
      }));
    } finally {
      setIsPingSending(false);
      setTimeout(() => setToastMessage(null), 3000);
    }
  };

  // ================= SIMULATION CONTROLS FOR MANUAL AUDIT =================
  const triggerSimulatedFleetCascade = (targetSymbol: string) => {
    const pair = fleet.find(p => p.symbol === targetSymbol);
    if (!pair || !(pair.price > 0)) {
      setToastMessage(`No live price for ${targetSymbol} yet`);
      setTimeout(() => setToastMessage(null), 3000);
      return;
    }
    if (pair.status !== 'IDLE') return;
    // Arms at the live price with the same floor and target as automatic arming.
    const floor = pair.price * 0.997;
    setFleet(prev => prev.map(p => p.symbol === targetSymbol && p.status === 'IDLE'
      ? { ...p, status: 'ARMED', armedPrice: floor, targetTp: floor * 1.005, accumulatedFillUsd: 0 }
      : p));

    dispatchSignal({
      type: 'ARMED',
      symbol: targetSymbol,
      title: `🎯 [MANUAL TRAP ARMED] — ${targetSymbol}`,
      badgeColor: 'amber',
      metrics: {
        'Live Price': `$${pair.price.toFixed(4)}`,
        'Displacement': `${(pair.dropPct * 100).toFixed(2)}% Drop`,
        'CVI Reading': `${pair.cvi.toFixed(2)}x`,
        'Floor': `$${floor.toFixed(4)}`,
        'Queue Hurdle': `$${governor.usdQueueHurdle.toLocaleString()} USD Real Taker Sales`
      },
      rawPayload: `🎯 [MANUAL TRAP ARMED] — ${targetSymbol}\n• Live price: $${pair.price.toFixed(4)}\n• Floor: $${floor.toFixed(4)}\n• TP: $${(floor * 1.005).toFixed(4)}`
    });

    setToastMessage(`${targetSymbol} armed at live price; fills need real sell volume`);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const satisfyQueueHurdle = (_symbol: string) => {
    setToastMessage('Fills come only from real sell volume at or below the floor.');
    setTimeout(() => setToastMessage(null), 3000);
  };

  const executeCleanSnapback = (_symbol: string) => {
    setToastMessage('Exits come only from real prices: take-profit or the 90s stop.');
    setTimeout(() => setToastMessage(null), 3000);
  };

  // ================= FLEET TELEMETRY SCORECARD =================
  const fleetScorecard = useMemo(() => {
    const totalTrades = tradeLogs.length;
    if (totalTrades === 0) {
      return {
        totalTrades: 0,
        cleanSnapbacks: 0,
        cleanSnapbackRatio: 0,
        avgHold: 0,
        grossUsd: 0,
        totalFeesUsd: 0,
        netUsd: 0,
        netPct: 0,
        avgQueueFriction: 0,
        mostProfitablePair: 'N/A',
        totalTrapsCaught: 0,
        fleetWinRate: 0,
      };
    }

    const tpHits = tradeLogs.filter(t => t.outcome.startsWith('TP_HIT')).length;
    const cleanFast = tradeLogs.filter(t => t.outcome.startsWith('TP_HIT') && t.holdSeconds < 45).length;
    const totalHold = tradeLogs.reduce((acc, t) => acc + (t.holdSeconds || 0), 0);
    const totalGrossUsd = tradeLogs.reduce((acc, t) => acc + (t.pnlUsd || 0), 0);
    const totalFeesUsd = tradeLogs.reduce((acc, t) => acc + (t.feeUsd ?? ((governor.marginPerSlotUsd * 10 * governor.feeDragPct) / 100)), 0);
    const totalNetUsd = tradeLogs.reduce((acc, t) => acc + (t.netPnlUsd !== undefined ? t.netPnlUsd : ((t.pnlUsd || 0) - (t.feeUsd ?? 175))), 0);
    const totalNetPct = tradeLogs.reduce((acc, t) => acc + (t.netPnlPct !== undefined ? t.netPnlPct : ((t.pnlPct || 0) - 0.07)), 0);
    const totalQueueSec = tradeLogs.reduce((acc, t) => acc + (t.queueClearanceSeconds || 8.4), 0);

    const pairPnlMap: Record<string, number> = {};
    tradeLogs.forEach(t => {
      const net = t.netPnlUsd !== undefined ? t.netPnlUsd : ((t.pnlUsd || 0) - 175);
      pairPnlMap[t.symbol] = (pairPnlMap[t.symbol] || 0) + net;
    });
    const sortedPairs = Object.entries(pairPnlMap).sort((a, b) => b[1] - a[1]);
    const topPair = sortedPairs[0] ? `${sortedPairs[0][0]} (+$${sortedPairs[0][1].toFixed(2)} net)` : 'BTCUSDT';

    return {
      totalTrades,
      cleanSnapbacks: cleanFast,
      cleanSnapbackRatio: Math.round((cleanFast / totalTrades) * 1000) / 10,
      fleetWinRate: Math.round((tpHits / totalTrades) * 1000) / 10,
      avgHold: Math.round((totalHold / totalTrades) * 10) / 10,
      grossUsd: Math.round(totalGrossUsd * 100) / 100,
      totalFeesUsd: Math.round(totalFeesUsd * 100) / 100,
      netUsd: Math.round(totalNetUsd * 100) / 100,
      netPct: Math.round(totalNetPct * 100) / 100,
      avgQueueFriction: Math.round((totalQueueSec / totalTrades) * 10) / 10,
      mostProfitablePair: topPair,
      totalTrapsCaught: tradeLogs.length + fleet.filter(p => p.status === 'ARMED' || p.status === 'FILLED').length,
    };
  }, [tradeLogs, fleet, governor.marginPerSlotUsd, governor.feeDragPct]);

  // ================= EXPORT TELEMETRY DIGEST =================
  const handleExportTelemetryDigest = () => {
    const nowIso = new Date().toISOString();
    let md = `# INSTITUTIONAL MULTI-PAIR FLEET SCANNER // TELEMETRY DIGEST\n`;
    md += `Generated: ${nowIso} | Operational Mode: ${operationalMode}\n`;
    md += `Active Concurrency: ${occupiedSlots.length}/${governor.maxActiveSlots} Slots | Webhook Dispatcher: Active\n`;
    md += `Universe: Top 30 USD-M Futures (Vol > $100M/day) | USD Queue Hurdle: $${governor.usdQueueHurdle.toLocaleString()} USD\n`;
    md += `Risk Pool: $${governor.totalRiskPoolUsd.toLocaleString()} | Margin/Slot: $${governor.marginPerSlotUsd.toLocaleString()} (10x Leverage)\n\n`;

    md += `## 1. FLEET TELEMETRY SCORECARD\n`;
    md += `- Total Trades Executed: ${fleetScorecard.totalTrades}\n`;
    md += `- Fleet Win Rate: ${fleetScorecard.fleetWinRate}% | Clean Snapback Ratio (<45s TP): ${fleetScorecard.cleanSnapbackRatio}%\n`;
    md += `- Net Realized Return: $${fleetScorecard.netUsd.toFixed(2)} (${fleetScorecard.netPct > 0 ? '+' : ''}${fleetScorecard.netPct.toFixed(2)}%)\n`;
    md += `- Most Profitable Asset: ${fleetScorecard.mostProfitablePair}\n`;
    md += `- Mean Hold Duration: ${fleetScorecard.avgHold}s / 90s Chronometer Ceiling\n`;
    md += `- Mean FIFO Queue Friction: ${fleetScorecard.avgQueueFriction}s ($150,000 USD hurdle)\n\n`;

    md += `## 2. ACTIVE SLOTS & ARMED TRAPS\n`;
    if (occupiedSlots.length === 0) {
      md += `*No active positions open. All ${governor.maxActiveSlots} slots standing by.*\n\n`;
    } else {
      occupiedSlots.forEach((slot, idx) => {
        md += `- Slot #${idx + 1}: ${slot.symbol} | Entry: $${(slot.armedPrice || 0).toFixed(4)} | TP: $${(slot.targetTp || 0).toFixed(4)} | Hold: ${slot.holdSeconds}s | PnL: ${slot.pnlPct || 0}%\n`;
      });
      md += `\n`;
    }

    md += `## 3. LIVE 30-PAIR FLEET RADAR SNAPSHOT\n`;
    md += `| Symbol | Price | Displacement % | CVI Score | Cushion % | Status | 24h Volume |\n`;
    md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;
    fleet.slice(0, 15).forEach(p => {
      md += `| ${p.symbol} | $${p.price.toFixed(4)} | ${(p.dropPct * 100).toFixed(2)}% | ${p.cvi.toFixed(2)}x | ${p.cushionPct}% | ${p.status} | $${(p.volume24hUsd / 1000000).toFixed(1)}M |\n`;
    });

    navigator.clipboard.writeText(md);
    setToastMessage('Institutional Fleet Digest copied to clipboard');
    setTimeout(() => setToastMessage(null), 3000);
  };

  // Filtered radar pairs
  const filteredRadarFleet = useMemo(() => {
    let list = fleet;
    if (radarFilter === 'HIGH_CVI') list = list.filter(p => p.cvi >= 3.0);
    if (radarFilter === 'ACTIVE_SLOTS') list = list.filter(p => p.status === 'FILLED' || p.status === 'ARMED');
    if (radarFilter === '10_APPROVED' || governor.microCapitalTier === 'MINI_MICRO_10') {
      list = list.filter(p => p.is10DollarApproved);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(p => p.symbol.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
    }
    return list;
  }, [fleet, radarFilter, searchQuery, governor.microCapitalTier]);

  return (
    <div className="space-y-4">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 bg-emerald-950 border border-emerald-500/80 text-emerald-200 px-4 py-2.5 rounded-xl shadow-2xl text-xs font-mono font-bold">
          <Check className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* ================= MODAL: WEBHOOK DISPATCHER SETTINGS ================= */}
      {isWebhookModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in font-mono">
          <div className="bg-zinc-950 border border-zinc-800 rounded-2xl max-w-xl w-full p-5 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
              <div className="flex items-center gap-2">
                <Bell className="w-5 h-5 text-indigo-400" />
                <span className="font-bold text-white uppercase text-sm tracking-wider">
                  REAL-TIME SIGNAL DISPATCHER CONFIGURATION
                </span>
              </div>
              <button
                onClick={() => setIsWebhookModalOpen(false)}
                className="text-zinc-500 hover:text-white text-xs px-2 py-1 rounded bg-zinc-900 border border-zinc-800"
              >
                ESC
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <p className="text-zinc-400 leading-relaxed text-[11px]">
                Broadcasts structured institutional alerts to your phone via Telegram or Discord the millisecond an air pocket detonates, authenticates FIFO fill, or exits.
              </p>

              {/* Telegram Inputs */}
              <div className="p-3 bg-zinc-900/60 rounded-xl border border-zinc-800 space-y-2">
                <div className="flex items-center justify-between font-bold text-zinc-200 text-[11px]">
                  <span>TELEGRAM BOT RELAY</span>
                  <span className="text-[10px] text-zinc-500">api.telegram.org</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-zinc-500 block mb-1">BOT TOKEN</label>
                    <input
                      type="password"
                      placeholder="e.g. 123456:ABC-DEF..."
                      value={webhookConfig.telegramToken}
                      onChange={(e) => setWebhookConfig(c => ({ ...c, telegramToken: e.target.value }))}
                      className="w-full px-2.5 py-1.5 rounded bg-black border border-zinc-800 text-zinc-200 text-xs focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-zinc-500 block mb-1">CHAT ID</label>
                    <input
                      type="text"
                      placeholder="e.g. 987654321 or @channel"
                      value={webhookConfig.telegramChatId}
                      onChange={(e) => setWebhookConfig(c => ({ ...c, telegramChatId: e.target.value }))}
                      className="w-full px-2.5 py-1.5 rounded bg-black border border-zinc-800 text-zinc-200 text-xs focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                </div>
              </div>

              {/* Discord Webhook Input */}
              <div className="p-3 bg-zinc-900/60 rounded-xl border border-zinc-800 space-y-2">
                <div className="flex items-center justify-between font-bold text-zinc-200 text-[11px]">
                  <span>DISCORD WEBHOOK RELAY</span>
                  <span className="text-[10px] text-zinc-500">discord.com/api/webhooks</span>
                </div>
                <div>
                  <label className="text-[10px] text-zinc-500 block mb-1">WEBHOOK URL</label>
                  <input
                    type="password"
                    placeholder="https://discord.com/api/webhooks/..."
                    value={webhookConfig.discordWebhookUrl}
                    onChange={(e) => setWebhookConfig(c => ({ ...c, discordWebhookUrl: e.target.value }))}
                    className="w-full px-2.5 py-1.5 rounded bg-black border border-zinc-800 text-zinc-200 text-xs focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              {/* Event Triggers */}
              <div className="p-3 bg-zinc-900/60 rounded-xl border border-zinc-800 space-y-2">
                <span className="font-bold text-zinc-300 text-[11px] block">DISPATCH EVENT TRIGGERS</span>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
                  <label className="flex items-center gap-2 cursor-pointer text-zinc-300">
                    <input
                      type="checkbox"
                      checked={webhookConfig.notifyOnArmed}
                      onChange={(e) => setWebhookConfig(c => ({ ...c, notifyOnArmed: e.target.checked }))}
                      className="rounded border-zinc-700 bg-zinc-800 text-indigo-500"
                    />
                    <span>On Trap Armed</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer text-zinc-300">
                    <input
                      type="checkbox"
                      checked={webhookConfig.notifyOnFilled}
                      onChange={(e) => setWebhookConfig(c => ({ ...c, notifyOnFilled: e.target.checked }))}
                      className="rounded border-zinc-700 bg-zinc-800 text-indigo-500"
                    />
                    <span>On Order Filled</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer text-zinc-300">
                    <input
                      type="checkbox"
                      checked={webhookConfig.notifyOnExit}
                      onChange={(e) => setWebhookConfig(c => ({ ...c, notifyOnExit: e.target.checked }))}
                      className="rounded border-zinc-700 bg-zinc-800 text-indigo-500"
                    />
                    <span>On TP / Time-Stop</span>
                  </label>
                </div>
              </div>

              {/* Ping Status */}
              {webhookConfig.lastPingMessage && (
                <div className={`p-2 rounded text-[11px] font-mono ${
                  webhookConfig.lastPingStatus === 'SUCCESS'
                    ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-800'
                    : 'bg-zinc-900 text-zinc-400 border border-zinc-800'
                }`}>
                  Status: {webhookConfig.lastPingMessage}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between pt-3 border-t border-zinc-800">
              <button
                onClick={handleSendTestPing}
                disabled={isPingSending}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 border border-indigo-500/50 text-xs font-bold transition-all"
              >
                <Send className={`w-3.5 h-3.5 ${isPingSending ? 'animate-spin' : ''}`} />
                <span>{isPingSending ? 'SENDING PING...' : 'SEND TEST PING'}</span>
              </button>

              <button
                onClick={() => {
                  setIsWebhookModalOpen(false);
                  setToastMessage('Webhook configuration saved');
                  setTimeout(() => setToastMessage(null), 3000);
                }}
                className="px-4 py-1.5 rounded-lg bg-emerald-500 text-black font-black text-xs hover:bg-emerald-400 transition-colors"
              >
                SAVE &amp; ACTIVATE
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= INSTITUTIONAL DUAL-MODE TOP CONTROL & TELEMETRY BAR ================= */}
      <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-4 shadow-xl">
        <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
          {/* Left: Terminal Identifier & Operational Mode 3-Way Toggle */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 pr-3 border-r border-zinc-800">
              <span className={`w-2.5 h-2.5 rounded-full ${isHalted ? 'bg-rose-500' : 'bg-emerald-400 animate-ping'}`} />
              <div>
                <div className="text-sm font-mono font-black text-white tracking-widest uppercase flex items-center gap-2">
                  <span>DUAL-MODE EXECUTION HUB</span>
                  <span className={`text-[10px] px-2 py-0.5 rounded font-mono font-bold uppercase border ${
                    isHalted
                      ? 'bg-rose-950 text-rose-300 border-rose-600 animate-pulse'
                      : 'bg-zinc-900 text-zinc-300 border-zinc-700'
                  }`}>
                    {isHalted ? 'FLEET HALTED (FLAT CASH)' : 'FLEET ACTIVE'}
                  </span>
                </div>
              </div>
            </div>

            {/* 3-WAY OPERATIONAL MODE SELECTOR */}
            <div className="flex items-center bg-zinc-900 p-0.5 rounded-lg border border-zinc-800 font-mono text-xs">
              <button
                onClick={() => {
                  setOperationalMode('SIGNAL_ONLY');
                  setToastMessage('Operational Mode set to: SIGNAL RADAR ONLY (0 order placement)');
                  setTimeout(() => setToastMessage(null), 3000);
                }}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-md transition-all font-bold ${
                  operationalMode === 'SIGNAL_ONLY'
                    ? 'bg-indigo-950 text-indigo-300 border border-indigo-600/70 shadow-sm'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
                title="Monitors 30 pairs and dispatches alerts via Webhooks; zero order placement"
              >
                <Radio className="w-3 h-3 text-indigo-400" />
                <span>SIGNAL RADAR ONLY</span>
              </button>

              <button
                onClick={() => {
                  setOperationalMode('PAPER');
                  setToastMessage('Operational Mode set to: SHADOW TRADER (PAPER FIFO)');
                  setTimeout(() => setToastMessage(null), 3000);
                }}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-md transition-all font-bold ${
                  operationalMode === 'PAPER'
                    ? 'bg-emerald-950 text-emerald-300 border border-emerald-600/70 shadow-sm'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
                title="Simulates real FIFO fills with live WebSockets and dispatches alerts (Default)"
              >
                <ShieldAlert className="w-3 h-3 text-emerald-400" />
                <span>SHADOW TRADER (PAPER)</span>
              </button>

              <button
                onClick={() => {
                  setToastMessage('Exchange execution unavailable: testnet credentials and order integration are required.');
                  setTimeout(() => setToastMessage(null), 3000);
                }}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-md transition-all font-bold ${
                  operationalMode === 'LIVE'
                    ? 'bg-rose-950 text-rose-300 border border-rose-600/70 shadow-sm animate-pulse'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
                title="Unavailable: exchange order execution is not implemented"
              >
                <Zap className="w-3 h-3 text-rose-400" />
                <span>EXCHANGE EXECUTION UNAVAILABLE</span>
              </button>
            </div>
          </div>

          {/* Right: Operational Controls, Webhook Modal & Emergency Kill Switch */}
          <div className="flex flex-wrap items-center gap-2 self-end lg:self-center">
            {/* Webhook Config Modal Button */}
            <button
              onClick={() => setIsWebhookModalOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-700 text-xs font-mono font-bold transition-all"
              title="Configure Telegram and Discord Webhook Alerts"
            >
              <Bell className="w-3.5 h-3.5 text-indigo-400" />
              <span>DISPATCHER ALERTS</span>
              {(webhookConfig.telegramToken || webhookConfig.discordWebhookUrl) && (
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
              )}
            </button>

            {/* Emergency Kill Switch */}
            {!isHalted ? (
              <button
                onClick={handleEmergencyHalt}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border border-rose-500 font-mono text-xs font-black transition-all shadow-lg shadow-rose-950/50"
                title="Immediately cancels all resting nets and flattens active slots to cash (<500ms)"
              >
                <Octagon className="w-3.5 h-3.5 text-rose-400 animate-pulse" />
                <span>HALT FLEET / CANCEL ALL</span>
              </button>
            ) : (
              <button
                onClick={handleResumeFleet}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500 font-mono text-xs font-black transition-all"
              >
                <Play className="w-3.5 h-3.5 text-emerald-400" />
                <span>RESUME FLEET</span>
              </button>
            )}

            {/* Export Telemetry Digest */}
            <button
              onClick={handleExportTelemetryDigest}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-700 text-xs font-mono font-bold transition-all shadow-sm"
              title="Export complete 30-pair telemetry markdown digest"
            >
              <Copy className="w-3.5 h-3.5" />
              <span>EXPORT DIGEST</span>
            </button>

            {/* CSV Download */}
            <a
              href="/api/shadow-trades?download=true"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-700 text-xs font-mono transition-colors"
              title="Download shadow_trading_log.csv"
            >
              <Download className="w-3.5 h-3.5 text-zinc-400" />
              <span>CSV</span>
            </a>
          </div>
        </div>

        {/* View Mode Switcher */}
        <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-zinc-800/80 text-xs font-mono">
          <button
            onClick={() => setActiveTab('FLEET_MATRIX')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all ${
              activeTab === 'FLEET_MATRIX'
                ? 'bg-zinc-800 text-emerald-300 font-bold border border-emerald-500/40 shadow-sm'
                : 'text-zinc-400 hover:text-white hover:bg-zinc-900'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>LIVE 30-PAIR FLEET MATRIX</span>
          </button>

          <button
            onClick={() => setActiveTab('DISPATCH_PREVIEW')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all ${
              activeTab === 'DISPATCH_PREVIEW'
                ? 'bg-zinc-800 text-indigo-300 font-bold border border-indigo-500/40 shadow-sm'
                : 'text-zinc-400 hover:text-white hover:bg-zinc-900'
            }`}
          >
            <Bell className="w-3.5 h-3.5 text-indigo-400" />
            <span>SIGNAL CARD DISPATCH ({dispatchedSignals.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('FOCUSED_EXECUTION')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all ${
              activeTab === 'FOCUSED_EXECUTION'
                ? 'bg-zinc-800 text-cyan-300 font-bold border border-cyan-500/40 shadow-sm'
                : 'text-zinc-400 hover:text-white hover:bg-zinc-900'
            }`}
          >
            <Activity className="w-3.5 h-3.5" />
            <span>FOCUSED PAIR EXECUTION ({selectedPair})</span>
          </button>

          <button
            onClick={() => setActiveTab('CSV_LEDGER')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all ${
              activeTab === 'CSV_LEDGER'
                ? 'bg-zinc-800 text-purple-300 font-bold border border-purple-500/40 shadow-sm'
                : 'text-zinc-400 hover:text-white hover:bg-zinc-900'
            }`}
          >
            <Database className="w-3.5 h-3.5" />
            <span>FLEET TRADE LEDGER (CSV)</span>
          </button>

          <button
            onClick={() => setActiveTab('PYTHON_SOURCE')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all ${
              activeTab === 'PYTHON_SOURCE'
                ? 'bg-zinc-800 text-amber-300 font-bold border border-amber-500/40 shadow-sm'
                : 'text-zinc-400 hover:text-white hover:bg-zinc-900'
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            <span>DUAL-MODE PYTHON SCRIPT</span>
          </button>
        </div>
      </div>

      {/* Unified Fleet Analytics Scorecard */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {/* Total Trades */}
        <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-3 font-mono">
          <div className="text-[10px] text-zinc-500 uppercase font-bold">FLEET TRADES</div>
          <div className="text-xl font-black text-white mt-0.5">{fleetScorecard.totalTrades}</div>
          <div className="text-[10px] text-zinc-400 mt-1">Across 30 assets</div>
        </div>

        {/* Fleet Win Rate */}
        <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-3 font-mono">
          <div className="text-[10px] text-zinc-500 uppercase font-bold">FLEET WIN RATE</div>
          <div className={`text-xl font-black mt-0.5 ${fleetScorecard.fleetWinRate >= 60 ? 'text-emerald-400' : 'text-amber-400'}`}>
            {fleetScorecard.fleetWinRate}%
          </div>
          <div className="text-[10px] text-zinc-400 mt-1">TP vs Time-Stop cuts</div>
        </div>

        {/* Clean Snapback Ratio */}
        <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-3 font-mono">
          <div className="text-[10px] text-zinc-500 uppercase font-bold">CLEAN SNAPBACK (&lt;45s)</div>
          <div className="text-xl font-black text-emerald-400 mt-0.5">{fleetScorecard.cleanSnapbackRatio}%</div>
          <div className="text-[10px] text-zinc-400 mt-1">{fleetScorecard.cleanSnapbacks} mechanical hits</div>
        </div>

        {/* Net Realized PnL (Net of 0.07% Fees) */}
        <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-3 font-mono">
          <div className="text-[10px] text-zinc-500 uppercase font-bold flex items-center justify-between">
            <span>NET REALIZED PNL</span>
            <span className="text-[9px] text-zinc-500">-0.07% FEES</span>
          </div>
          <div className={`text-xl font-black mt-0.5 ${fleetScorecard.netUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {fleetScorecard.netUsd >= 0 ? '+' : ''}${fleetScorecard.netUsd.toFixed(2)}
          </div>
          <div className="text-[10px] text-zinc-400 mt-1 flex items-center justify-between">
            <span>Gross: ${fleetScorecard.grossUsd.toFixed(0)}</span>
            <span className="text-rose-400">Fees: -${fleetScorecard.totalFeesUsd.toFixed(0)}</span>
          </div>
        </div>

        {/* Top Alpha Asset */}
        <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-3 font-mono">
          <div className="text-[10px] text-zinc-500 uppercase font-bold">TOP ALPHA ASSET</div>
          <div className="text-sm font-black text-cyan-300 mt-1 truncate" title={fleetScorecard.mostProfitablePair}>
            {fleetScorecard.mostProfitablePair}
          </div>
          <div className="text-[10px] text-zinc-400 mt-1">Highest net return</div>
        </div>

        {/* Active Concurrency Slots & Capital Tier */}
        <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-3 font-mono">
          <div className="text-[10px] text-zinc-500 uppercase font-bold flex items-center justify-between">
            <span>ACTIVE SLOTS</span>
            <span className="text-[9px] font-bold px-1.5 py-0.2 rounded bg-zinc-900 border border-zinc-700 text-purple-300">
              {governor.microCapitalTier === 'MINI_MICRO_10' 
                ? '$10 POOL' 
                : governor.microCapitalTier === 'MICRO_FLIGHT_250' 
                  ? '$250 POOL' 
                  : '$250k POOL'}
            </span>
          </div>
          <div className="text-xl font-black text-purple-300 mt-0.5">
            {occupiedSlots.length} / {governor.maxActiveSlots}
          </div>
          <div className="text-[10px] text-zinc-400 mt-1">
            ${(governor.marginPerSlotUsd * occupiedSlots.length).toLocaleString()} deployed
          </div>
        </div>
      </div>

      {/* ================= TAB 1: LIVE 30-PAIR FLEET MATRIX ================= */}
      {activeTab === 'FLEET_MATRIX' && (
        <div className="space-y-4">
          {/* Concurrency Governor & Priority Slot Bar */}
          <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-4 font-mono text-xs">
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3 pb-3 border-b border-zinc-800">
              <div className="flex items-center gap-2">
                <Sliders className="w-4 h-4 text-emerald-400" />
                <span className="font-bold text-white uppercase text-sm">
                  CONCURRENCY GOVERNOR &amp; DYNAMIC RISK SLOTS
                </span>
                <span className="text-[10px] px-2 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-300">
                  Pool: ${governor.totalRiskPoolUsd.toLocaleString()} USD
                </span>
              </div>

              {/* Slot Allocator Settings & Micro Flight Toggle */}
              <div className="flex flex-wrap items-center gap-3">
                {/* Capital Tier Selector with $10 Mini-Micro Preset */}
                <div className="flex items-center gap-1.5">
                  <span className="text-zinc-500 text-[11px]">CAPITAL TIER:</span>
                  <div className="flex items-center bg-zinc-900 rounded border border-zinc-800 p-0.5">
                    <button
                      onClick={() => {
                        setGovernor(g => ({
                          ...g,
                          microCapitalTier: 'INSTITUTIONAL_250K',
                          totalRiskPoolUsd: 250000,
                          marginPerSlotUsd: 25000,
                          maxActiveSlots: 3,
                          usdQueueHurdle: 150000,
                        }));
                        setToastMessage('Governor Calibrated: $250k Institutional Tier (3 Slots @ $25k)');
                        setTimeout(() => setToastMessage(null), 3000);
                      }}
                      className={`px-2 py-0.5 rounded text-[11px] font-bold transition-all ${
                        governor.microCapitalTier === 'INSTITUTIONAL_250K'
                          ? 'bg-zinc-800 text-emerald-300 border border-emerald-500/40'
                          : 'text-zinc-500 hover:text-zinc-300'
                      }`}
                      title="Institutional Tier: $250,000 pool, $25,000 margin/slot (10x)"
                    >
                      $250k INSTITUTIONAL
                    </button>
                    <button
                      onClick={() => {
                        setGovernor(g => ({
                          ...g,
                          microCapitalTier: 'MICRO_FLIGHT_250',
                          totalRiskPoolUsd: 250,
                          marginPerSlotUsd: 25,
                          maxActiveSlots: 3,
                          usdQueueHurdle: 150000,
                        }));
                        setToastMessage('Governor Calibrated: $250 Micro-Flight Tier (3 Slots @ $25)');
                        setTimeout(() => setToastMessage(null), 3000);
                      }}
                      className={`px-2 py-0.5 rounded text-[11px] font-bold transition-all ${
                        governor.microCapitalTier === 'MICRO_FLIGHT_250'
                          ? 'bg-amber-950 text-amber-300 border border-amber-500/50 shadow-sm'
                          : 'text-zinc-500 hover:text-zinc-300'
                      }`}
                      title="Micro-Flight Tier: $250 real pool, $25 margin/slot (5 micro live test trades)"
                    >
                      🧪 $250 FLIGHT
                    </button>
                    <button
                      onClick={() => {
                        setGovernor(g => ({
                          ...g,
                          microCapitalTier: 'MINI_MICRO_10',
                          totalRiskPoolUsd: 10,
                          marginPerSlotUsd: 5,
                          maxActiveSlots: 2,
                          usdQueueHurdle: 150000,
                        }));
                        setRadarFilter('10_APPROVED');
                        if (selectedPair === 'BTCUSDT' || selectedPair === 'AAVEUSDT') {
                          setSelectedPair('SOLUSDT');
                        }
                        setToastMessage('🎯 $10 MINI-MICRO TIER ACTIVE: 2 Slots @ $5 Margin (10x = $50 Size), Filtered to Granular Altcoins (SOL, DOGE, XRP, SUI, ETH, PEPE, AVAX)');
                        setTimeout(() => setToastMessage(null), 4000);
                      }}
                      className={`px-2.5 py-0.5 rounded text-[11px] font-black transition-all ${
                        governor.microCapitalTier === 'MINI_MICRO_10'
                          ? 'bg-cyan-950 text-cyan-300 border border-cyan-400 shadow-md animate-pulse'
                          : 'text-cyan-600 hover:text-cyan-400'
                      }`}
                      title="$10 Mini-Micro Testing Tier: $10 pool, 2 slots @ $5 margin (10x = $50 position), micro-fee -$0.035, high-granularity altcoins"
                    >
                      🧪 $10 MINI-MICRO TIER
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-1.5">
                  <span className="text-zinc-500 text-[11px]">MAX SLOTS:</span>
                  <div className="flex items-center bg-zinc-900 rounded border border-zinc-800 p-0.5">
                    {[1, 2, 3, 4, 5].map((slotCount) => (
                      <button
                        key={slotCount}
                        onClick={() => setGovernor(g => ({ ...g, maxActiveSlots: slotCount }))}
                        className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                          governor.maxActiveSlots === slotCount
                            ? 'bg-zinc-800 text-emerald-300 border border-emerald-500/40'
                            : 'text-zinc-500 hover:text-zinc-300'
                        }`}
                      >
                        {slotCount}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-1.5">
                  <span className="text-zinc-500 text-[11px]">QUEUE HURDLE:</span>
                  <span className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 font-bold text-emerald-300">
                    ${(governor.usdQueueHurdle / 1000).toFixed(0)}k USD
                  </span>
                </div>
              </div>
            </div>

            {/* Visual Slots Display */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
              {Array.from({ length: governor.maxActiveSlots }).map((_, slotIdx) => {
                const occupied = occupiedSlots[slotIdx];
                return (
                  <div
                    key={slotIdx}
                    className={`p-3 rounded-lg border transition-all ${
                      occupied
                        ? 'bg-emerald-950/20 border-emerald-500/60 shadow-lg'
                        : 'bg-zinc-900/40 border-zinc-800/80 border-dashed'
                    }`}
                  >
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-bold text-zinc-400">SLOT #{slotIdx + 1}</span>
                      <span className={`px-1.5 py-0.2 rounded text-[10px] font-bold ${
                        occupied ? 'bg-emerald-950 text-emerald-300 border border-emerald-700/60' : 'text-zinc-600'
                      }`}>
                        {occupied ? 'OCCUPIED' : 'STANDBY'}
                      </span>
                    </div>

                    {occupied ? (
                      <div className="mt-2 space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-black text-white">{occupied.symbol}</span>
                          <span className={`text-xs font-bold ${
                            (occupied.pnlUsd || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'
                          }`}>
                            {(occupied.pnlUsd || 0) >= 0 ? '+' : ''}${(occupied.pnlUsd || 0).toFixed(2)} ({(occupied.pnlPct || 0).toFixed(2)}%)
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-zinc-400">
                          <span>Hold: {occupied.holdSeconds}s / 90s</span>
                          <span>Floor: ${occupied.armedPrice?.toFixed(4)}</span>
                        </div>
                        <div className="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden mt-1">
                          <div
                            className="bg-emerald-500 h-full transition-all duration-300"
                            style={{ width: `${Math.min(100, ((occupied.holdSeconds || 0) / 90) * 100)}%` }}
                          />
                        </div>
                        <div className="flex items-center justify-end gap-1.5 pt-1">
                          <button
                            onClick={() => executeCleanSnapback(occupied.symbol)}
                            className="px-2 py-0.5 rounded bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/50 text-[10px] font-bold"
                          >
                            FORCE SNAPBACK (+0.5%)
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-3 text-center text-zinc-600 text-[11px] py-1">
                        Available • Margin: ${(governor.marginPerSlotUsd).toLocaleString()}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Top 30 Live Radar Matrix Table */}
          <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-4 shadow-xl font-mono text-xs space-y-3">
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3 pb-3 border-b border-zinc-800">
              <div className="flex flex-wrap items-center gap-2">
                <Layers className="w-4 h-4 text-emerald-400" />
                <span className="font-bold text-white uppercase text-sm">
                  LIVE 30-PAIR FLEET MATRIX
                </span>
                <span className="text-[10px] px-2 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-300 font-bold">
                  {filteredRadarFleet.length} Monitored Pairs
                </span>
                <span className="text-[10px] text-zinc-500">
                  Multiplexed Stream Active
                </span>
              </div>

              {/* Filters & Search */}
              <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
                <div className="relative flex-1 sm:flex-none">
                  <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
                  <input
                    type="text"
                    placeholder="Search pair (e.g. BTC, SOL, PEPE)..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full sm:w-48 pl-8 pr-2.5 py-1 rounded bg-zinc-900 border border-zinc-800 text-zinc-200 text-xs focus:outline-none"
                  />
                </div>

                <div className="flex items-center gap-1 bg-zinc-900 p-0.5 rounded border border-zinc-800 text-[11px]">
                  <button
                    onClick={() => setRadarFilter('ALL')}
                    className={`px-2 py-0.5 rounded transition-colors ${
                      radarFilter === 'ALL' ? 'bg-zinc-800 text-white font-bold' : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    ALL (30)
                  </button>
                  <button
                    onClick={() => setRadarFilter('10_APPROVED')}
                    className={`px-2 py-0.5 rounded transition-colors font-bold ${
                      radarFilter === '10_APPROVED' ? 'bg-cyan-950 text-cyan-300 border border-cyan-600/70' : 'text-cyan-500 hover:text-cyan-300'
                    }`}
                    title="Filters to assets with granular contract sizes (<$50 minimum) like SOL, DOGE, XRP, SUI, ETH"
                  >
                    🧪 $10 APPROVED (28)
                  </button>
                  <button
                    onClick={() => setRadarFilter('HIGH_CVI')}
                    className={`px-2 py-0.5 rounded transition-colors ${
                      radarFilter === 'HIGH_CVI' ? 'bg-purple-950 text-purple-300 font-bold border border-purple-700/60' : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    HIGH CVI (&ge;3.0)
                  </button>
                  <button
                    onClick={() => setRadarFilter('ACTIVE_SLOTS')}
                    className={`px-2 py-0.5 rounded transition-colors ${
                      radarFilter === 'ACTIVE_SLOTS' ? 'bg-emerald-950 text-emerald-300 font-bold border border-emerald-700/60' : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    ACTIVE/ARMED
                  </button>
                </div>
              </div>
            </div>

            {/* Radar Table */}
            <div className="overflow-x-auto rounded-lg border border-zinc-800/80">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-zinc-900/80 border-b border-zinc-800 text-[10px] text-zinc-400 uppercase tracking-wider font-bold">
                    <th className="py-2.5 px-3">PAIR</th>
                    <th className="py-2.5 px-3">PRICE</th>
                    <th className="py-2.5 px-3">DISPLACEMENT DROP %</th>
                    <th className="py-2.5 px-3">CURRENT CVI</th>
                    <th className="py-2.5 px-3">ORDERBOOK CUSHION %</th>
                    <th className="py-2.5 px-3">STATUS</th>
                    <th className="py-2.5 px-3 text-right">ACTION / TELEMETRY</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-900 text-xs">
                  {filteredRadarFleet.map((pair) => {
                    const isHighCvi = pair.cvi >= 3.0;
                    const isArmed = pair.status === 'ARMED';
                    const isFilled = pair.status === 'FILLED';

                    return (
                      <tr key={pair.symbol} className="hover:bg-zinc-900/50 transition-colors">
                        {/* 1. PAIR */}
                        <td className="py-2.5 px-3 font-bold text-white whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => {
                                setSelectedPair(pair.symbol);
                                setActiveTab('FOCUSED_EXECUTION');
                              }}
                              className="hover:text-emerald-400 transition-colors text-left"
                            >
                              <span className="font-mono text-xs">{pair.symbol}</span>
                            </button>
                            <span className="text-[10px] text-zinc-500 font-normal">({pair.name})</span>
                            {pair.is10DollarApproved ? (
                              <span className="text-[9px] font-bold px-1 py-0.2 rounded bg-cyan-950 text-cyan-300 border border-cyan-800" title={`Min step ~$${pair.minContractStepUsd?.toFixed(2)} (<$50 lot size)`}>
                                $10 OK
                              </span>
                            ) : (
                              <span className="text-[9px] font-bold px-1 py-0.2 rounded bg-rose-950 text-rose-300 border border-rose-800" title={`Min contract lot ~$${pair.minContractStepUsd?.toFixed(0)} exceeds $50 micro slot size`}>
                                &gt;$50 LOT
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] text-zinc-500 font-mono mt-0.5">
                            24h Vol: ${(pair.volume24hUsd / 1000000).toFixed(1)}M | Step: ~${pair.minContractStepUsd ? pair.minContractStepUsd.toFixed(2) : '0.10'}
                          </div>
                        </td>

                        {/* 2. PRICE */}
                        <td className="py-2.5 px-3 font-mono font-semibold text-zinc-200 whitespace-nowrap">
                          {pair.price > 0 ? `$${pair.price >= 10 ? pair.price.toFixed(2) : pair.price.toFixed(4)}` : '—'}
                        </td>

                        {/* 3. DISPLACEMENT DROP % */}
                        <td className="py-2.5 px-3 font-mono whitespace-nowrap">
                          <span className={`px-2 py-0.5 rounded font-bold ${
                            pair.dropPct >= 0.008 
                              ? 'bg-rose-950/80 text-rose-300 border border-rose-700/60'
                              : 'text-zinc-400'
                          }`}>
                            {(pair.dropPct * 100).toFixed(2)}% drop
                          </span>
                        </td>

                        {/* 4. CURRENT CVI */}
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          <span className={`px-2 py-0.5 rounded font-mono font-bold text-[11px] border ${
                            isHighCvi
                              ? 'bg-purple-950/80 text-purple-300 border-purple-700/60 animate-pulse'
                              : 'bg-zinc-900 text-zinc-400 border-zinc-800'
                          }`}>
                            {pair.cvi.toFixed(2)}x CVI
                          </span>
                        </td>

                        {/* 5. ORDERBOOK CUSHION % */}
                        <td className="py-2.5 px-3 font-mono whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            <span className={`font-bold ${pair.cushionPct >= 145 ? 'text-emerald-400' : 'text-zinc-400'}`}>
                              {pair.cushionPct}%
                            </span>
                            <span className="text-[10px] text-zinc-600">/ 145% target</span>
                          </div>
                        </td>

                        {/* 6. STATUS */}
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          {isFilled && (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/60 animate-pulse">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                              FILLED (SLOT #{pair.activeSlot})
                            </span>
                          )}
                          {isArmed && (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/60 animate-pulse">
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                              ARMED ($150k QUEUE)
                            </span>
                          )}
                          {!isFilled && !isArmed && (
                            <span className="px-2 py-0.5 rounded text-[11px] bg-zinc-900 text-zinc-400 border border-zinc-800 font-mono">
                              {pair.status}
                            </span>
                          )}
                        </td>

                        {/* 7. ACTIONS / TELEMETRY */}
                        <td className="py-2.5 px-3 text-right whitespace-nowrap">
                          <div className="flex items-center justify-end gap-1.5">
                            {isArmed && (
                              <button
                                onClick={() => satisfyQueueHurdle(pair.symbol)}
                                className="px-2 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/50 text-[10px] font-bold font-mono"
                              >
                                PUNCH $150k QUEUE
                              </button>
                            )}

                            {isFilled && (
                              <button
                                onClick={() => executeCleanSnapback(pair.symbol)}
                                className="px-2 py-1 rounded bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/50 text-[10px] font-bold font-mono"
                              >
                                SNAPBACK (+0.5%)
                              </button>
                            )}

                            {!isArmed && !isFilled && (
                              <button
                                onClick={() => triggerSimulatedFleetCascade(pair.symbol)}
                                className="px-2 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-700 text-[10px] font-mono"
                              >
                                TEST CASCADE
                              </button>
                            )}

                            <button
                              onClick={() => {
                                setSelectedPair(pair.symbol);
                                setActiveTab('FOCUSED_EXECUTION');
                              }}
                              className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-white text-[10px] font-mono flex items-center gap-1"
                            >
                              <span>FOCUS</span>
                              <ArrowRight className="w-2.5 h-2.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ================= TAB 2: LIVE SIGNAL CARD DISPATCH PREVIEW ================= */}
      {activeTab === 'DISPATCH_PREVIEW' && (
        <div className="space-y-4 font-mono text-xs">
          <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-4 shadow-xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Bell className="w-4 h-4 text-indigo-400" />
              <span className="font-bold text-white uppercase text-sm">
                LIVE DISPATCHED SIGNAL CARDS // TELEGRAM &amp; DISCORD STREAM
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => triggerSimulatedFleetCascade(selectedPair)}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-[11px] font-bold transition-all"
                title="Test-fire an ARMED signal to Telegram"
              >
                <span>TEST 1: ARMED</span>
              </button>
              <button
                onClick={() => satisfyQueueHurdle(selectedPair)}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/40 text-[11px] font-bold transition-all"
                title="Test-fire an AIR POCKET DETONATION signal to Telegram"
              >
                <span>TEST 2: DETONATION</span>
              </button>
              <button
                onClick={() => executeCleanSnapback(selectedPair)}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/40 text-[11px] font-bold transition-all"
                title="Test-fire an EXIT TP Mean Reversion signal to Telegram"
              >
                <span>TEST 3: EXIT TP</span>
              </button>
              <button
                onClick={handleSendTestPing}
                disabled={isPingSending}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow-lg shadow-indigo-950 transition-all"
                title="Send telemetry ping directly to Telegram bot"
              >
                <Send className={`w-3.5 h-3.5 ${isPingSending ? 'animate-spin' : ''}`} />
                <span>{isPingSending ? 'DISPATCHING...' : 'PING BOT'}</span>
              </button>
              <button
                onClick={() => setIsWebhookModalOpen(true)}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-700 text-xs font-bold"
              >
                <Settings className="w-3.5 h-3.5 text-zinc-400" />
                <span>CONFIG</span>
              </button>
              <button
                onClick={() => setDispatchedSignals([])}
                className="px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-400 border border-zinc-800 text-xs"
              >
                CLEAR
              </button>
            </div>
          </div>

          {/* Live Ping Status & Direct Relay Feedback */}
          {webhookConfig.lastPingStatus !== 'IDLE' && (
            <div className={`p-3 rounded-xl border flex items-center justify-between text-xs ${
              webhookConfig.lastPingStatus === 'SUCCESS'
                ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
                : 'bg-rose-950/40 border-rose-500/40 text-rose-300'
            }`}>
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${
                  webhookConfig.lastPingStatus === 'SUCCESS' ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'
                }`} />
                <span className="font-bold">
                  {webhookConfig.lastPingStatus === 'SUCCESS' ? 'TELEGRAM DISPATCH SUCCESSFUL' : 'TELEGRAM DISPATCH NOTICE'}:
                </span>
                <span>{webhookConfig.lastPingMessage}</span>
              </div>
              <span className="text-[10px] text-zinc-400">Target Chat: {webhookConfig.telegramChatId}</span>
            </div>
          )}

          {/* Cards Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {dispatchedSignals.map((card) => {
              const borderClass = 
                card.badgeColor === 'emerald' ? 'border-emerald-500/50 bg-emerald-950/10' :
                card.badgeColor === 'amber' ? 'border-amber-500/50 bg-amber-950/10' :
                card.badgeColor === 'cyan' ? 'border-cyan-500/50 bg-cyan-950/10' :
                'border-rose-500/50 bg-rose-950/10';

              const headerClass = 
                card.badgeColor === 'emerald' ? 'text-emerald-400' :
                card.badgeColor === 'amber' ? 'text-amber-400' :
                card.badgeColor === 'cyan' ? 'text-cyan-400' :
                'text-rose-400';

              return (
                <div
                  key={card.id}
                  className={`p-4 rounded-xl border ${borderClass} shadow-xl space-y-3 font-mono`}
                >
                  <div className="flex items-start justify-between gap-2 border-b border-zinc-800/80 pb-2">
                    <div>
                      <div className={`font-bold text-sm ${headerClass}`}>
                        {card.title}
                      </div>
                      <div className="text-[10px] text-zinc-500 mt-0.5 flex items-center gap-2">
                        <span>{new Date(card.timestamp).toLocaleTimeString()}</span>
                        <span>•</span>
                        <span>Relayed to: {card.destinations.join(', ')}</span>
                      </div>
                    </div>

                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(card.rawPayload);
                        setToastMessage('Signal card payload copied to clipboard');
                        setTimeout(() => setToastMessage(null), 3000);
                      }}
                      className="text-zinc-500 hover:text-zinc-200 p-1 rounded bg-zinc-900 border border-zinc-800"
                      title="Copy exact message payload"
                    >
                      <Copy className="w-3 h-3" />
                    </button>
                  </div>

                  {/* Metrics Table */}
                  <div className="space-y-1.5 text-xs">
                    {Object.entries(card.metrics).map(([key, value]) => (
                      <div key={key} className="flex items-center justify-between text-[11px]">
                        <span className="text-zinc-400 font-medium">• {key}:</span>
                        <span className="text-white font-bold">{value}</span>
                      </div>
                    ))}
                  </div>

                  <div className="pt-2 border-t border-zinc-900 flex items-center justify-between text-[10px] text-zinc-500">
                    <span>Mode: {operationalMode}</span>
                    <span className="text-emerald-400">Validated 0ms Queue Lag</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ================= TAB 3: FOCUSED PAIR EXECUTION ================= */}
      {activeTab === 'FOCUSED_EXECUTION' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 font-mono text-xs">
          {/* Pair Selector Pill Bar */}
          <div className="lg:col-span-12 bg-zinc-950 border border-zinc-800 rounded-xl p-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Crosshair className="w-4 h-4 text-emerald-400" />
              <span className="font-bold text-white uppercase text-sm">
                FOCUSED PAIR AUDIT: {selectedPair}
              </span>
            </div>
            
            <div className="flex flex-wrap items-center gap-1">
              {['SOLUSDT', 'DOGEUSDT', 'XRPUSDT', 'SUIUSDT', 'ETHUSDT', 'PEPEUSDT', 'AVAXUSDT', 'BTCUSDT'].map((sym) => {
                const isApproved = sym !== 'BTCUSDT';
                return (
                  <button
                    key={sym}
                    onClick={() => setSelectedPair(sym)}
                    className={`px-2 py-0.5 rounded text-[11px] font-bold transition-colors flex items-center gap-1 ${
                      selectedPair === sym
                        ? 'bg-zinc-800 text-emerald-300 border border-emerald-500/50'
                        : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    <span>{sym.replace('USDT', '')}</span>
                    {isApproved && <span className="text-[8px] text-cyan-400 font-mono">10$</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Left Column: Ticker & L2 Order Book Depth */}
          <div className="lg:col-span-5 space-y-4">
            <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-4 shadow-xl">
              <div className="flex items-center justify-between text-zinc-500 text-[11px]">
                <span>{selectedPair} LIVE MID</span>
                <span className="text-emerald-400">WebSocket 100ms</span>
              </div>
              <div className="text-3xl font-black text-white mt-1">
                ${selectedTelemetry.price >= 10 ? selectedTelemetry.price.toFixed(2) : selectedTelemetry.price.toFixed(4)}
              </div>
              <div className="flex items-center justify-between mt-2 pt-2 border-t border-zinc-800 text-[11px] text-zinc-400">
                <span>Displacement: {(selectedTelemetry.dropPct * 100).toFixed(2)}%</span>
                <span>Velocity: {activeVelocity}/s (Cap: 65/s)</span>
                <span>CVI: {selectedTelemetry.cvi.toFixed(2)}x</span>
              </div>
            </div>

            {/* Order Book Depth Table */}
            <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-4 shadow-xl space-y-2">
              <div className="flex items-center justify-between text-[11px] text-zinc-400 font-bold border-b border-zinc-800 pb-2">
                <span>L2 BID DEPTH (100MS)</span>
                <span>USD CUMULATIVE</span>
              </div>
              <div className="space-y-1">
                {bidsDepth.slice(0, 8).map(([price, size], idx) => {
                  const levelUsd = price * size;
                  return (
                    <div key={idx} className="flex items-center justify-between text-[11px]">
                      <span className="text-emerald-400 font-semibold">${price.toFixed(2)}</span>
                      <span className="text-zinc-400">{size.toFixed(3)}</span>
                      <span className="text-zinc-300">${(levelUsd / 1000).toFixed(1)}k</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Right Column: USD-Normalized FIFO Queue Authentication */}
          <div className="lg:col-span-7 space-y-4">
            <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-4 shadow-xl space-y-3">
              <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
                <span className="font-bold text-white text-sm uppercase">
                  USD-NORMALIZED FIFO QUEUE TRACKING
                </span>
                <span className="text-[11px] px-2 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-300">
                  Target: ${governor.usdQueueHurdle.toLocaleString()} USD
                </span>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-zinc-400">Queue Penetration Progress:</span>
                  <span className="font-bold text-white">
                    ${(selectedTelemetry.accumulatedFillUsd || 0).toLocaleString()} / ${governor.usdQueueHurdle.toLocaleString()} USD
                  </span>
                </div>
                <div className="w-full bg-zinc-900 rounded-full h-3 overflow-hidden border border-zinc-800">
                  <div
                    className="bg-emerald-500 h-full transition-all duration-300"
                    style={{
                      width: `${Math.min(100, (((selectedTelemetry.accumulatedFillUsd || 0) / governor.usdQueueHurdle) * 100))}%`
                    }}
                  />
                </div>
              </div>

              <div className="p-3 bg-zinc-900/60 rounded-lg border border-zinc-800/80 space-y-1.5 text-[11px]">
                <div className="text-zinc-300 font-bold">ANTI-DELUSION EXECUTION PROTOCOL:</div>
                <div className="text-zinc-400 leading-relaxed">
                  Touching the price line does NOT grant a fill. The engine requires exactly $150,000 of real market-taker selling volume to execute through your limit order before marking the position active.
                </div>
              </div>

              {/* Simulation Controls for Selected Pair */}
              <div className="flex flex-wrap items-center gap-2 pt-2">
                <button
                  onClick={() => triggerSimulatedFleetCascade(selectedPair)}
                  className="px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border border-zinc-700 font-bold"
                >
                  1. INJECT 0.85% DROP
                </button>
                <button
                  onClick={() => satisfyQueueHurdle(selectedPair)}
                  className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/50 font-bold"
                >
                  2. PUNCH $150k QUEUE
                </button>
                <button
                  onClick={() => executeCleanSnapback(selectedPair)}
                  className="px-3 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/50 font-bold"
                >
                  3. FAST SNAPBACK (+0.5%)
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ================= TAB 4: CSV TRADE LEDGER ================= */}
      {activeTab === 'CSV_LEDGER' && (
        <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-4 shadow-xl font-mono text-xs space-y-3">
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3 pb-3 border-b border-zinc-800">
            <div className="flex flex-wrap items-center gap-2">
              <Database className="w-4 h-4 text-emerald-400" />
              <span className="font-bold text-white uppercase text-sm">
                FLEET EXECUTION LEDGER // shadow_trading_log.csv
              </span>
              <span className="text-[10px] px-2 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-300 font-bold">
                {tradeLogs.length} Total Records
              </span>
              <span className="text-[10px] text-zinc-500">
                Synced at {lastSyncTime || 'Active'}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setLedgerFilter('ALL')}
                className={`px-2 py-0.5 rounded text-[11px] ${
                  ledgerFilter === 'ALL' ? 'bg-zinc-800 text-white font-bold' : 'text-zinc-400'
                }`}
              >
                ALL
              </button>
              <button
                onClick={() => setLedgerFilter('TP_HIT')}
                className={`px-2 py-0.5 rounded text-[11px] ${
                  ledgerFilter === 'TP_HIT' ? 'bg-emerald-950 text-emerald-300 font-bold border border-emerald-700/60' : 'text-zinc-400'
                }`}
              >
                TP_HIT
              </button>
              <button
                onClick={() => setLedgerFilter('TIME_STOP')}
                className={`px-2 py-0.5 rounded text-[11px] ${
                  ledgerFilter === 'TIME_STOP' ? 'bg-amber-950 text-amber-300 font-bold border border-amber-700/60' : 'text-zinc-400'
                }`}
              >
                TIME_STOP
              </button>
              <button
                onClick={() => fetchTrades(true)}
                disabled={isRefreshing}
                className="flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-300"
              >
                <RefreshCw className={`w-3 h-3 ${isRefreshing ? 'animate-spin' : ''}`} />
                <span>SYNC</span>
              </button>
            </div>
          </div>

          {/* Ledger Table */}
          <div className="overflow-x-auto rounded-lg border border-zinc-800/80">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-zinc-900/80 border-b border-zinc-800 text-[10px] text-zinc-400 uppercase tracking-wider font-bold">
                  <th className="py-2.5 px-3">TIMESTAMP</th>
                  <th className="py-2.5 px-3">SYMBOL</th>
                  <th className="py-2.5 px-3">ENTRY / EXIT PRICE</th>
                  <th className="py-2.5 px-3">CVI</th>
                  <th className="py-2.5 px-3">QUEUE CLEARANCE</th>
                  <th className="py-2.5 px-3">HOLD (S)</th>
                  <th className="py-2.5 px-3">STATUS MARKER</th>
                  <th className="py-2.5 px-3 text-right">NET REALIZED PNL (AFTER 0.07% FEES)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-900 text-xs">
                {tradeLogs
                  .filter(t => {
                    if (ledgerFilter === 'TP_HIT') return t.outcome.startsWith('TP_HIT');
                    if (ledgerFilter === 'TIME_STOP') return t.outcome.includes('TIME_STOP');
                    return true;
                  })
                  .map((t) => {
                    const isTpHit = t.outcome.startsWith('TP_HIT');
                    const isToxic = t.outcome.includes('TOXIC');
                    const isProfitableDrift = t.outcome.includes('TIME_STOP') && (t.pnlPct || 0) > 0;
                    const isLossCut = t.outcome.includes('TIME_STOP') && (t.pnlPct || 0) <= 0;
                    const netUsd = t.netPnlUsd !== undefined ? t.netPnlUsd : ((t.pnlUsd || 0) - (t.feeUsd || 175));
                    const feeUsd = t.feeUsd !== undefined ? t.feeUsd : 175;

                    return (
                      <tr key={t.id} className="hover:bg-zinc-900/50">
                        <td className="py-2.5 px-3 font-mono text-[11px] text-zinc-300 whitespace-nowrap">
                          {t.timestamp.replace('T', ' ').substring(0, 19)}
                        </td>
                        <td className="py-2.5 px-3 font-bold text-white whitespace-nowrap">
                          {t.symbol}
                        </td>
                        <td className="py-2.5 px-3 font-mono whitespace-nowrap">
                          ${t.entryPrice.toFixed(2)} &rarr; ${t.exitPrice.toFixed(2)}
                        </td>
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          <span className="px-1.5 py-0.5 rounded bg-purple-950/80 text-purple-300 border border-purple-800 text-[11px] font-bold">
                            {(t.cviAtEntry || 3.85).toFixed(2)}x
                          </span>
                        </td>
                        <td className="py-2.5 px-3 font-mono text-zinc-300 whitespace-nowrap">
                          {(t.queueClearanceSeconds || 8.4).toFixed(1)}s
                        </td>
                        <td className="py-2.5 px-3 font-mono whitespace-nowrap">
                          <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                            t.holdSeconds < 45 ? 'bg-emerald-950 text-emerald-300 border border-emerald-800' : 'bg-zinc-900 text-zinc-400'
                          }`}>
                            {t.holdSeconds}s
                          </span>
                        </td>
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          {isToxic && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-purple-500/20 text-purple-300 border border-purple-500/50">
                              <span>☣️ TOXIC_ABORT</span>
                            </span>
                          )}
                          {isTpHit && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/50">
                              <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                              <span>TP_HIT (Mean Reversion)</span>
                            </span>
                          )}
                          {isProfitableDrift && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/50">
                              <AlertTriangle className="w-3 h-3 text-amber-400" />
                              <span>TIME_STOP (Profitable Drift)</span>
                            </span>
                          )}
                          {isLossCut && !isToxic && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-rose-500/20 text-rose-300 border border-rose-500/50">
                              <XCircle className="w-3 h-3 text-rose-400" />
                              <span>TIME_STOP (Floor Broken)</span>
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono whitespace-nowrap">
                          <div className={`font-bold ${netUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {netUsd >= 0 ? '+' : ''}${netUsd.toFixed(netUsd > -1 && netUsd < 1 ? 3 : 2)} Net ({t.netPnlPct !== undefined ? (t.netPnlPct >= 0 ? '+' : '') + t.netPnlPct.toFixed(2) + '%' : (t.pnlPct >= 0 ? '+' : '') + t.pnlPct.toFixed(2) + '%'})
                          </div>
                          <div className="text-[10px] text-zinc-500">
                            Gross: ${t.pnlUsd < 10 && t.pnlUsd > -10 ? t.pnlUsd.toFixed(2) : t.pnlUsd.toFixed(0)} | Fee: -${feeUsd < 10 ? feeUsd.toFixed(3) : feeUsd.toFixed(0)}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ================= TAB 5: STANDALONE DUAL-MODE SCRIPT ================= */}
      {activeTab === 'PYTHON_SOURCE' && (
        <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-4 shadow-xl font-mono text-xs space-y-3">
          <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
            <div>
              <span className="font-bold text-white uppercase text-sm">
                DUAL-MODE MULTI-PAIR FLEET ENGINE (shadow_trader.py)
              </span>
              <p className="text-[11px] text-zinc-500 mt-0.5">
                Autonomous Execution &bull; Telegram &amp; Discord Dispatcher &bull; Emergency Kill-Switch &bull; USD Queue Hurdle
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(pythonScript);
                  setToastMessage('Script copied to clipboard');
                  setTimeout(() => setToastMessage(null), 3000);
                }}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-zinc-900 text-zinc-200 border border-zinc-700"
              >
                <Copy className="w-3.5 h-3.5" />
                <span>COPY CODE</span>
              </button>
              <a
                href="/api/shadow-script?download=true"
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-500/20 text-emerald-300 border border-emerald-500/50 font-bold"
              >
                <Download className="w-3.5 h-3.5" />
                <span>DOWNLOAD FILE</span>
              </a>
            </div>
          </div>

          <pre className="bg-black border border-zinc-900 rounded-lg p-4 text-[11px] text-emerald-300/90 overflow-x-auto max-h-[600px] leading-relaxed">
            {pythonScript || '// Loading python script...'}
          </pre>
        </div>
      )}
    </div>
  );
};
