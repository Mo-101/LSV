import { UnifiedExecutionPanel } from './UnifiedExecutionPanel';
import { submitTestnetOrder } from '../engine/testnetSubmission';
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

// ================= TOP 30 USD-M FUTURES UNIVERSE =================
export const TOP_30_UNIVERSE = [
  { symbol: 'BTCUSDT', name: 'Bitcoin', vol24h: 38.4, oiStability: 98, basePrice: 83810.0, minLotStepUsd: 83.81, is10DollarApproved: false },
  { symbol: 'ETHUSDT', name: 'Ethereum', vol24h: 18.2, oiStability: 96, basePrice: 3120.5, minLotStepUsd: 3.12, is10DollarApproved: true },
  { symbol: 'SOLUSDT', name: 'Solana', vol24h: 12.8, oiStability: 94, basePrice: 178.4, minLotStepUsd: 1.78, is10DollarApproved: true },
  { symbol: 'BNBUSDT', name: 'BNB', vol24h: 3.4, oiStability: 97, basePrice: 585.2, minLotStepUsd: 5.85, is10DollarApproved: true },
  { symbol: 'XRPUSDT', name: 'XRP', vol24h: 4.1, oiStability: 91, basePrice: 0.582, minLotStepUsd: 0.058, is10DollarApproved: true },
  { symbol: 'DOGEUSDT', name: 'Dogecoin', vol24h: 5.6, oiStability: 89, basePrice: 0.1425, minLotStepUsd: 0.142, is10DollarApproved: true },
  { symbol: 'SUIUSDT', name: 'Sui', vol24h: 3.8, oiStability: 93, basePrice: 1.845, minLotStepUsd: 0.184, is10DollarApproved: true },
  { symbol: 'PEPEUSDT', name: 'Pepe 1000', vol24h: 4.2, oiStability: 86, basePrice: 0.0094, minLotStepUsd: 0.009, is10DollarApproved: true },
  { symbol: 'AVAXUSDT', name: 'Avalanche', vol24h: 2.1, oiStability: 92, basePrice: 28.35, minLotStepUsd: 0.283, is10DollarApproved: true },
  { symbol: 'LINKUSDT', name: 'Chainlink', vol24h: 1.9, oiStability: 95, basePrice: 11.45, minLotStepUsd: 0.114, is10DollarApproved: true },
  { symbol: 'NEARUSDT', name: 'NEAR Protocol', vol24h: 2.4, oiStability: 90, basePrice: 4.82, minLotStepUsd: 0.482, is10DollarApproved: true },
  { symbol: 'APTUSDT', name: 'Aptos', vol24h: 1.6, oiStability: 91, basePrice: 8.65, minLotStepUsd: 0.865, is10DollarApproved: true },
  { symbol: 'ADAUSDT', name: 'Cardano', vol24h: 1.8, oiStability: 92, basePrice: 0.354, minLotStepUsd: 0.354, is10DollarApproved: true },
  { symbol: 'SHIBUSDT', name: 'Shiba Inu', vol24h: 2.0, oiStability: 88, basePrice: 0.0182, minLotStepUsd: 0.018, is10DollarApproved: true },
  { symbol: 'WIFUSDT', name: 'dogwifhat', vol24h: 2.7, oiStability: 85, basePrice: 2.45, minLotStepUsd: 0.245, is10DollarApproved: true },
  { symbol: 'FETUSDT', name: 'Artificial Superintelligence', vol24h: 1.5, oiStability: 87, basePrice: 1.35, minLotStepUsd: 0.135, is10DollarApproved: true },
  { symbol: 'RENDERUSDT', name: 'Render', vol24h: 1.4, oiStability: 89, basePrice: 5.62, minLotStepUsd: 0.562, is10DollarApproved: true },
  { symbol: 'OPUSDT', name: 'Optimism', vol24h: 1.2, oiStability: 91, basePrice: 1.52, minLotStepUsd: 0.152, is10DollarApproved: true },
  { symbol: 'ARBUSDT', name: 'Arbitrum', vol24h: 1.3, oiStability: 90, basePrice: 0.54, minLotStepUsd: 0.54, is10DollarApproved: true },
  { symbol: 'INJUSDT', name: 'Injective', vol24h: 1.1, oiStability: 88, basePrice: 21.2, minLotStepUsd: 2.12, is10DollarApproved: true },
  { symbol: 'TIAUSDT', name: 'Celestia', vol24h: 1.4, oiStability: 86, basePrice: 5.15, minLotStepUsd: 0.515, is10DollarApproved: true },
  { symbol: 'FTMUSDT', name: 'Fantom', vol24h: 1.0, oiStability: 89, basePrice: 0.68, minLotStepUsd: 0.68, is10DollarApproved: true },
  { symbol: 'SEIUSDT', name: 'Sei', vol24h: 1.2, oiStability: 88, basePrice: 0.42, minLotStepUsd: 0.42, is10DollarApproved: true },
  { symbol: 'RUNEUSDT', name: 'THORChain', vol24h: 1.1, oiStability: 87, basePrice: 4.95, minLotStepUsd: 0.495, is10DollarApproved: true },
  { symbol: 'GALAUSDT', name: 'Gala', vol24h: 0.85, oiStability: 84, basePrice: 0.022, minLotStepUsd: 0.022, is10DollarApproved: true },
  { symbol: 'TONUSDT', name: 'Toncoin', vol24h: 1.7, oiStability: 94, basePrice: 5.8, minLotStepUsd: 0.58, is10DollarApproved: true },
  { symbol: 'FLOKIUSDT', name: 'Floki', vol24h: 1.3, oiStability: 85, basePrice: 0.155, minLotStepUsd: 0.155, is10DollarApproved: true },
  { symbol: 'FILUSDT', name: 'Filecoin', vol24h: 0.95, oiStability: 89, basePrice: 3.75, minLotStepUsd: 0.375, is10DollarApproved: true },
  { symbol: 'KASUSDT', name: 'Kaspa', vol24h: 1.1, oiStability: 91, basePrice: 0.138, minLotStepUsd: 0.138, is10DollarApproved: true },
  { symbol: 'AAVEUSDT', name: 'Aave', vol24h: 1.5, oiStability: 93, basePrice: 154.2, minLotStepUsd: 15.42, is10DollarApproved: false }
];

const DEFAULT_GOVERNOR: ConcurrencyGovernorConfig = {
  maxActiveSlots: 2,
  totalRiskPoolUsd: 10,
  marginPerSlotUsd: 5,
  usdQueueHurdle: 150000,
  autoExecute: false,
  minCviThreshold: 3.0,
  decelerationCap: 65,
  baseDropPct: 0.008,
  absorptionBuffer: 1.45,
  feeDragPct: 0.07, // 0.07% round-trip exchange fee deduction
  toxicOiThresholdPct: 15, // 15% OI drop in <60s triggers TOXIC_EVENT_ABORT
  microCapitalTier: 'MINI_MICRO_10',
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

interface ShadowTraderConsoleProps {
  onBackToBlueprint?: () => void;
}

interface TestnetPosition {
  symbol: string;
  side: 'BUY' | 'SELL';
  entryOrderId: number;
  entryPrice: number;
  quantity: number;
  targetTp: number;
  filled: boolean;
  tpOrderId: number | null;
  openedAt: number;
  pnlUsd: number;
  pnlPct: number;
  holdSeconds: number;
}

interface TestnetStatus {
  connected: boolean;
  balance: number | null;
  error?: string | null;
  positions: TestnetPosition[];
}

export const ShadowTraderConsole: React.FC<ShadowTraderConsoleProps> = () => {
  // 1. Operational Mode: 3-way toggle [SIGNAL_ONLY, PAPER, LIVE]
  const [operationalMode, setOperationalMode] = useState<OperationalMode>('SIGNAL_ONLY');

  // Real Binance Futures Testnet account/position status, polled from the backend.
  // This is the actual exchange state — distinct from the simulated fleet below.
  const [testnetStatus, setTestnetStatus] = useState<TestnetStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/testnet/status');
        const data = await res.json();
        if (!res.ok) throw new Error('Status unavailable');
        if (!cancelled) setTestnetStatus(data);
      } catch {
        if (!cancelled) setTestnetStatus(previous => ({ connected: false, balance: previous?.balance ?? null, positions: previous?.positions ?? [] }));
      }
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

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
      price: p.basePrice,
      refPrice: p.basePrice,
      dropPct: 0.002,
      cvi: 1.45,
      cushionPct: 152,
      tickVelocity: 14,
      volume24hUsd: p.vol24h * 1000000000,
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

  // When TESTNET mode is selected, the slot panel shows real backend
  // positions instead of the client-side paper simulation. The paper
  // simulation (fleet state, WS ticks, etc.) keeps running unaffected either
  // way — this only changes what the Slot panel reads from.
  const isShowingRealTestnet = operationalMode === 'LIVE';
  const realSlots = useMemo(() => {
    return (testnetStatus?.positions || []).map(p => ({
      symbol: p.symbol,
      pnlUsd: p.pnlUsd,
      pnlPct: p.pnlPct,
      holdSeconds: p.holdSeconds,
      armedPrice: p.entryPrice,
      isReal: true as const,
      filled: p.filled,
      entryOrderId: p.entryOrderId,
    }));
  }, [testnetStatus]);
  const displaySlots = realSlots;

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

  // ================= LIVE WEBSOCKET INGESTION =================
  useEffect(() => {
    const symbolLower = selectedPair.toLowerCase();
    const wsUrls = [
      `wss://fstream.binance.com/public/stream?streams=${symbolLower}@depth20@100ms`,
      `wss://fstream.binance.com/market/stream?streams=${symbolLower}@aggTrade`,
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
          const stream = payload.stream || '';
          const data = payload.data || {};
          if (data.e) receivedStreams.add(wsUrl);
          if (receivedStreams.size === wsUrls.length) setConnectionStatus('CONNECTED');

          if (stream.includes('depth20')) {
            const rawBids: Array<[string, string]> = data.b || [];
            const rawAsks: Array<[string, string]> = data.a || [];
            if (rawBids.length > 0 && rawAsks.length > 0) {
              const pBids = rawBids.map(b => [parseFloat(b[0]), parseFloat(b[1])] as [number, number]);
              const pAsks = rawAsks.map(a => [parseFloat(a[0]), parseFloat(a[1])] as [number, number]);
              const mid = (pBids[0][0] + pAsks[0][0]) / 2;
              setBidsDepth(pBids);
              setAsksDepth(pAsks);

              // Update fleet telemetry for selected pair
              setFleet(prev => prev.map(item => {
                if (item.symbol !== selectedPair) return item;
                const ref = item.refPrice > 0 ? item.refPrice : mid;
                const drop = Math.max(0, (ref - mid) / ref);
                const topBidUsd = pBids.slice(0, 10).reduce((sum, b) => sum + (b[0] * b[1]), 0);
                const cviScore = Math.min(6.5, Math.max(1.1, (drop * 2800000) / Math.max(10000, topBidUsd)));
                
                return {
                  ...item,
                  price: mid,
                  refPrice: ref,
                  dropPct: drop,
                  cvi: Math.round(cviScore * 100) / 100,
                  cushionPct: Math.round(Math.min(220, Math.max(90, (topBidUsd / governor.usdQueueHurdle) * 100))),
                };
              }));
            }
          } else if (stream.includes('aggTrade')) {
            const p = parseFloat(data.p);
            const q = parseFloat(data.q);
            const tradeUsd = p * q;

            // Rolling tick velocity (1s window)
            const now = Date.now();
            tradeTimestampsRef.current.push(now);
            const oneSecAgo = now - 1000;
            while (tradeTimestampsRef.current.length > 0 && tradeTimestampsRef.current[0] < oneSecAgo) {
              tradeTimestampsRef.current.shift();
            }
            const currentVel = tradeTimestampsRef.current.length;
            setActiveVelocity(currentVel);

            // Update fleet pair
            setFleet(prev => prev.map(item => {
              if (item.symbol !== selectedPair) return item;
              return { ...item, tickVelocity: currentVel };
            }));


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
  }, [selectedPair, governor.usdQueueHurdle, governor.maxActiveSlots, governor.autoExecute, operationalMode, isScanningActive, isHalted, dispatchSignal]);

  // ================= EMERGENCY KILL-SWITCH =================
  const handleEmergencyHalt = async () => {
    try {
      const response = await fetch('/api/execution/halt', { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setIsHalted(result.config.halted);
      setToastMessage(result.message);
    } catch (e) { setToastMessage(e instanceof Error ? e.message : 'Halt request failed'); }
  };
  const handleResumeFleet = () => setToastMessage('Use Resume entries in the backend execution controls.');

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
  const armShadow = async (symbol: string) => {
    try {
      const response = await fetch('/api/shadow/arm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setToastMessage(`Shadow order armed for ${symbol}. Waiting for mainnet selling volume.`);
    } catch (e) { setToastMessage(e instanceof Error ? e.message : 'Shadow entry failed'); }
  };
  const triggerSimulatedFleetCascade = (symbol: string) => { void armShadow(symbol); };

  // In TESTNET mode, "TEST CASCADE" fires a real signed order on the backend
  // instead of arming the client-side paper simulation.
  const testnetSubmissionPending = useRef(false);
  const [isTestnetSubmitting, setIsTestnetSubmitting] = useState(false);

  const submitDemoOrder = async (targetSymbol: string) => {
    if (testnetSubmissionPending.current) return;
    if (isHalted) {
      setToastMessage('Execution is halted. Resume before submitting a demo order.');
      return;
    }
    testnetSubmissionPending.current = true;
    setIsTestnetSubmitting(true);
    setToastMessage(`Submitting Binance demo limit order for ${targetSymbol}...`);
    try {
      const result = await submitTestnetOrder(targetSymbol);
      setToastMessage(`Binance accepted ${targetSymbol} order #${result.orderId}. Waiting for a fill.`);
      try {
        const response = await fetch('/api/testnet/status');
        if (!response.ok) throw new Error('Status unavailable');
        const status = await response.json();
        setTestnetStatus(status);
        if (!status.connected) throw new Error('Disconnected');
      } catch {
        setToastMessage(`Binance accepted order #${result.orderId}; slot refresh failed. Do not resubmit; check Binance open orders.`);
      }
    } catch (error) {
      setToastMessage(error instanceof Error ? error.message : 'Demo order submission failed.');
    } finally {
      testnetSubmissionPending.current = false;
      setIsTestnetSubmitting(false);
    }
  };

  const handleTestCascadeClick = (targetSymbol: string) => {
    if (operationalMode === 'LIVE') {
      void submitDemoOrder(targetSymbol);
      return;
    }
    triggerSimulatedFleetCascade(targetSymbol);
  };

  const handlePunchQueue = (targetSymbol: string) => {
    if (operationalMode === 'LIVE') {
      void submitDemoOrder(targetSymbol);
      return;
    }
    void armShadow(targetSymbol);
  };

  const satisfyQueueHurdle = (_symbol: string) => setToastMessage('Shadow fills require observed mainnet trades. Queue volume cannot be injected.');
  const executeCleanSnapback = (_symbol: string) => setToastMessage('Synthetic profit generation is disabled. Exits require market evidence.');

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
                    {isHalted ? 'ENTRIES HALTED' : 'FLEET ACTIVE'}
                  </span>
                </div>
              </div>
            </div>

            <p className="text-xs text-zinc-400">Backend mode: {operationalMode === 'LIVE' ? 'Binance demo' : operationalMode === 'PAPER' ? 'Real-tape shadow' : 'Signals only'}. Change execution settings below.</p>
          </div>

          {/* Real Binance Testnet account strip — actual exchange data, polled every 5s */}
          <div className="w-full flex flex-wrap items-center gap-3 px-3 py-2 bg-black/40 border border-zinc-800 rounded-lg">
            <div className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${testnetStatus?.connected ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}`} />
              <span className="text-[10px] font-mono font-bold uppercase text-zinc-400">
                {testnetStatus?.connected ? 'Connected to testnet.binancefuture.com' : testnetStatus ? `Disconnected${testnetStatus.error ? `: ${testnetStatus.error}` : ''}` : 'Checking...'}
              </span>
            </div>
            {testnetStatus?.connected && (
              <>
                <span className="text-zinc-700">|</span>
                <span className="text-[11px] font-mono text-zinc-300">
                  Balance: <span className="text-emerald-300 font-bold">${testnetStatus.balance?.toLocaleString(undefined, { maximumFractionDigits: 2 }) ?? '—'} USDT</span>
                </span>
                <span className="text-zinc-700">|</span>
                <span className="text-[11px] font-mono text-zinc-300">
                  Exchange orders / positions: <span className="text-white font-bold">{testnetStatus.positions.length}</span>
                </span>
                {testnetStatus.positions.map(p => (
                  <span key={p.entryOrderId} className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-300">
                    {p.symbol} {p.side} #{p.entryOrderId} {p.filled ? '(position open)' : '(order awaiting fill)'}
                  </span>
                ))}
              </>
            )}
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
                title="Halt backend entries and request closure of managed exchange exposure"
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
            <span>REFERENCE UNIVERSE / SELECTED-PAIR TAPE</span>
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
            <span>LEGACY SIMULATION LEDGER (CSV)</span>
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

      <p className="text-sm text-amber-300">Legacy simulation archive below: synthetic outcomes, not Binance performance. New real-tape results appear in the execution panel.</p>
      {/* Legacy simulation analytics */}
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
            <span>LEGACY SIMULATION PNL</span>
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
          <div className="text-[10px] text-zinc-400 mt-1">Legacy synthetic ledger; not exchange performance</div>
        </div>

        {/* Active Concurrency Slots & Capital Tier */}
        <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-3 font-mono">
          <div className="text-[10px] text-zinc-500 uppercase font-bold flex items-center justify-between">
            <span>ACTIVE SLOTS</span>
            <span className="text-[9px] font-bold px-1.5 py-0.2 rounded bg-zinc-900 border border-zinc-700 text-purple-300">
              {`$${governor.totalRiskPoolUsd.toLocaleString()} POOL`}
            </span>
          </div>
          <div className="text-xl font-black text-purple-300 mt-0.5">
            {testnetStatus?.connected ? displaySlots.length : 'Unknown'} / {governor.maxActiveSlots}
          </div>
          <div className="text-[10px] text-zinc-400 mt-1">
            Binance orders and positions
          </div>
        </div>
      </div>

          <UnifiedExecutionPanel onConfig={config => {
            setOperationalMode(config.mode);
            setIsHalted(config.halted);
            setIsScanningActive(!config.halted);
            setGovernor(previous => ({ ...previous, maxActiveSlots: config.maxActiveSlots, totalRiskPoolUsd: config.totalRiskPoolUsd,
              marginPerSlotUsd: config.marginPerSlotUsd, microCapitalTier: config.microCapitalTier, autoExecute: config.autoExecute,
              absorptionBuffer: config.absorptionBuffer, usdQueueHurdle: config.usdQueueHurdle }));
          }} />

      {/* ================= TAB 1: REFERENCE UNIVERSE / SELECTED-PAIR TAPE ================= */}
      {activeTab === 'FLEET_MATRIX' && (
        <div className="space-y-4">


          {/* Top 30 Live Radar Matrix Table */}
          <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-4 shadow-xl font-mono text-xs space-y-3">
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3 pb-3 border-b border-zinc-800">
              <div className="flex flex-wrap items-center gap-2">
                <Layers className="w-4 h-4 text-emerald-400" />
                <span className="font-bold text-white uppercase text-sm">
                  REFERENCE UNIVERSE / SELECTED-PAIR TAPE
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
                          ${pair.price >= 10 ? pair.price.toFixed(2) : pair.price.toFixed(4)}
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
                                onClick={() => handlePunchQueue(pair.symbol)}
                                disabled={isTestnetSubmitting || isHalted}
                                className="px-2 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/50 text-[10px] font-bold font-mono"
                              >
                                {isShowingRealTestnet ? (isTestnetSubmitting ? 'SUBMITTING...' : 'PLACE DEMO LIMIT') : 'ARM REAL-TAPE SHADOW'}
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
                                onClick={() => handleTestCascadeClick(pair.symbol)}
                                className="px-2 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-700 text-[10px] font-mono"
                                title={isShowingRealTestnet ? 'Fires a real signed order on Binance Futures Testnet' : 'Simulates a cascade in the paper engine'}
                              >
                                {isShowingRealTestnet ? 'FIRE REAL TEST ORDER' : 'TEST CASCADE'}
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
                  Binance demo positions require exchange-confirmed fills. Real-tape shadow entries require observed seller-initiated volume at or below the limit to clear the configured queue estimate plus the order size. Follow their state in the execution panel.
                </div>
              </div>

              {/* Simulation Controls for Selected Pair */}
              <div className="flex flex-wrap items-center gap-2 pt-2">
                <button
                  onClick={() => triggerSimulatedFleetCascade(selectedPair)}
                  className="px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border border-zinc-700 font-bold"
                >
                  1. ARM REAL-TAPE SHADOW
                </button>
                <button
                  onClick={() => handlePunchQueue(selectedPair)}
                  disabled={isTestnetSubmitting || isHalted}
                  className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/50 font-bold"
                >
                  {isShowingRealTestnet ? (isTestnetSubmitting ? 'SUBMITTING...' : '2. PLACE DEMO LIMIT') : '2. ARM REAL-TAPE SHADOW'}
                </button>
                <button
                  onClick={() => executeCleanSnapback(selectedPair)}
                  className="px-3 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/50 font-bold"
                >
                  3. EXITS FOLLOW MARKET DATA
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
                  <th className="py-2.5 px-3 text-right">LEGACY SIMULATION PNL (AFTER 0.07% FEES)</th>
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
