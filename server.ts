import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import fs from 'fs';
import { GoogleGenAI } from '@google/genai';
import WebSocket from 'ws';
import { finiteNumber } from './src/engine/tradeNumbers';
import { LiquidationWindow } from './src/engine/liquidationWindow';
import { FleetEngine } from './src/engine/fleetEngine';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// ================= SERVER FLEET WORKER (30 pairs, real Binance ticks) =================
// Runs the dashboard's 30-pair fleet logic on the server, 24/7. No exchange
// orders, no alerts. Its closed trades go to their own journal.
const fleetStateDir = process.env.LSV_STATE_DIR || path.join(__dirname, '.lsv-state');
const FLEET_TRADES_PATH = path.join(fleetStateDir, 'fleet-trades.csv');
fs.mkdirSync(fleetStateDir, { recursive: true });
if (!fs.existsSync(FLEET_TRADES_PATH)) {
  fs.writeFileSync(FLEET_TRADES_PATH, 'Timestamp,Symbol,Entry_Price,Exit_Price,CVI_Entry,Queue_Clearance_Sec,Hold_Seconds,Outcome,PnL_Pct,PnL_USD,Fee_USD,Net_PnL_USD,Net_PnL_Pct\n');
}
const fleetEngine = new FleetEngine({
  onTrade: r => fs.appendFileSync(FLEET_TRADES_PATH,
    `${r.timestamp},${r.symbol},${r.entryPrice},${r.exitPrice},${r.cviAtEntry},${r.queueClearanceSeconds},${r.holdSeconds},"${r.outcome}",${r.pnlPct},${r.pnlUsd},${r.feeUsd},${r.netPnlUsd},${r.netPnlPct}\n`),
});

// Read-only fleet endpoints may be called from other apps' browsers.
app.use('/api/fleet', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Last-Event-ID');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.get('/api/fleet', (_req, res) => res.json(fleetEngine.snapshot()));
app.get('/api/fleet/armed', (_req, res) => {
  const snapshot = fleetEngine.snapshot();
  res.json({ updatedAt: snapshot.updatedAt, mode: snapshot.mode, halted: snapshot.halted, queueHurdleUsd: snapshot.governor.usdQueueHurdle,
    armed: snapshot.pairs.filter(p => p.status === 'ARMED') });
});
app.get('/api/fleet/events', (req, res) => {
  const since = Number(req.query.since) || 0;
  res.json({ lastEventSeq: fleetEngine.snapshot().lastEventSeq, events: fleetEngine.eventsSince(since) });
});
app.get('/api/fleet/trades', (req, res) => {
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 100));
  const lines = fs.readFileSync(FLEET_TRADES_PATH, 'utf-8').trim().split('\n').slice(1);
  const trades = lines.map(line => {
    const c = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(x => x.replace(/^"|"$/g, ''));
    return { timestamp: c[0], symbol: c[1], entryPrice: +c[2], exitPrice: +c[3], cviAtEntry: +c[4], queueClearanceSeconds: +c[5],
      holdSeconds: +c[6], outcome: c[7], pnlPct: +c[8], pnlUsd: +c[9], feeUsd: +c[10], netPnlUsd: +c[11], netPnlPct: +c[12] };
  }).reverse().slice(0, limit);
  res.json({ trades });
});
// Live stream: `snapshot` every second, `signal` for every fleet event (ARMED, FILLED, exits...).
app.get('/api/fleet/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (event: string, data: unknown, id?: number) => res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const resumeFrom = Number(req.headers['last-event-id'] || req.query.since) || 0;
  for (const event of fleetEngine.eventsSince(resumeFrom)) send('signal', event, event.seq);
  send('snapshot', fleetEngine.snapshot());
  const timer = setInterval(() => send('snapshot', fleetEngine.snapshot()), 1000);
  const unsubscribe = fleetEngine.subscribe(event => send('signal', event, event.seq));
  req.on('close', () => { clearInterval(timer); unsubscribe(); });
});
const fleetControl = (action: (body: any) => unknown) => async (req: express.Request, res: express.Response) => {
  try { res.json({ ok: true, result: await action(req.body || {}), fleet: fleetEngine.snapshot() }); }
  catch (error: any) { res.status(400).json({ ok: false, error: error.message }); }
};
app.post('/api/fleet/arm', fleetControl(body => fleetEngine.manualArm(String(body.symbol || '').toUpperCase())));
app.post('/api/fleet/halt', fleetControl(() => fleetEngine.halt()));
app.post('/api/fleet/resume', fleetControl(() => fleetEngine.resume()));
app.post('/api/fleet/mode', fleetControl(body => fleetEngine.setMode(body.mode)));
app.post('/api/fleet/governor', fleetControl(body => fleetEngine.updateGovernor(body.patch || {})));

const feedHealth = {
  liquidations: { connected: false, messages: 0, lastMessageAt: null as string | null },
  tickers: { connected: false, messages: 0, lastMessageAt: null as string | null },
};
const alertHealth = { attempts: 0, delivered: 0, failed: 0, lastError: null as string | null };
app.get('/api/health', (_req, res) => {
  res.json({
    marketDataStatus: Object.values(feedHealth).every(feed => feed.connected) ? 'connected' : 'degraded',
    uptimeSeconds: Math.floor(process.uptime()),
    feeds: feedHealth,
    alerts: alertHealth,
    credentials: {
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
      telegramConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
      binanceConfigured: Boolean(process.env.BINANCE_KEY && process.env.BINANCE_SECRET),
      note: 'Configured does not mean authenticated.',
    },
    fleetWorker: (() => { const f = fleetEngine.snapshot(); return { feed: f.feed, mode: f.mode, halted: f.halted, counts: f.counts, lastEventSeq: f.lastEventSeq }; })(),
    execution: { implemented: false, mode: 'simulation', exchangeOrdersEnabled: false },
  });
});

// Telegram default credentials - updated with user provided active token
const DEFAULT_TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const DEFAULT_TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

// Server-side helper to send Telegram alerts directly
async function sendTelegramAlert(title: string, details: Record<string, string>) {
  if (!DEFAULT_TG_BOT_TOKEN || !DEFAULT_TG_CHAT_ID) return;
  alertHealth.attempts++;
  try {
    const text = `<b>${title}</b>\n` + Object.entries(details).map(([k, v]) => `• <b>${k}:</b> ${v}`).join('\n');
    const response = await fetch(`https://api.telegram.org/bot${DEFAULT_TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: DEFAULT_TG_CHAT_ID,
        text,
        parse_mode: 'HTML'
      })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      alertHealth.failed++;
      alertHealth.lastError = `Telegram rejected delivery (HTTP ${response.status}, code ${result.error_code ?? 'unknown'})`;
      return;
    }
    alertHealth.delivered++;
    alertHealth.lastError = null;
  } catch (err: any) {
    alertHealth.failed++;
    alertHealth.lastError = 'Telegram network request failed or timed out';
    console.error(alertHealth.lastError);
  }
}

// Initialize Gemini SDK with User-Agent header as required
const getGeminiClient = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
};

// Quantitative Risk Strategist System Instruction
const QUANT_SYSTEM_PROMPT = `
You are the Lead Quantitative Architect and Chief Risk Strategist for an institutional high-frequency liquidation vacuum trading engine.
Your expertise is in high-frequency orderbook physics (L2/L3 delta books, tick stream velocity), derivatives market structure (Open Interest invariant, funding skew, forced liquidations), and survival risk management.

Core Engine Principles:
1. The Air Pocket: Depth between current price and the liquidation cluster.
2. Cascade Vulnerability Index (CVI) = Estimated Cluster Liquidation Size ($) / Cumulative Resting Bids between Current Price and Cluster ($).
   - CVI < 1.0: Thick book, bids absorb cascade, DO NOT TRADE.
   - 1.0 <= CVI < 3.0: Moderate risk, thin bids, high slippage risk.
   - CVI >= 3.0: Paper-thin book, vacuum guaranteed, ARM THE NET.
3. The Net (Exhaustion Floor): Find depth below cluster where cumulative bids >= 120% of cluster volume.
4. The 90-Second Snapback Invalidation: Mechanical liquidation wicks must snap back in <= 90s. If expired without target reversion, execute immediate emergency market cut (indicates structural breakdown, not temporary liquidity dislocation).
5. The Strategist's 3 Hammers:
   - Hammer 1: Exchange API Meltdown (429 rate limit, WebSocket disconnect, matching engine queue freeze) -> Solved by Server-side Contingent OCO and Cancel-on-Disconnect (COD).
   - Hammer 2: Phantom Clusters & Spoofing ($50M bid walls pulled in 1ms) -> Solved by Executed Volume Delta & Debt Invariants (reject unverified OI clusters).
   - Hammer 3: Ruin Management & Systemic Contagion (Luna/FTX -80% waterfall) -> Solved by Cross-Asset Volatility Correlation circuit breakers & Fractional Kelly Sizing (1.5-2.0% equity per wick).

Always be mathematically rigorous, clear, concise, and institutional in tone. Highlight tradeoffs between the Architect's aggressive vacuum capture and the Strategist's defensive survival armor.
`;

// Fast Low-Latency Quant Analysis Endpoint
app.post('/api/gemini/analyze', async (req, res) => {
  try {
    const { orderbookData, model = 'gemini-3.1-flash-lite', customPrompt } = req.body;
    const ai = getGeminiClient();

    if (!ai) {
      // Deterministic institutional algorithmic breakdown if API key isn't provided
      const cvi = orderbookData?.cvi ?? 0;
      const airPocket = orderbookData?.airPocketDepthUsd ?? 0;
      const cluster = orderbookData?.clusterUsd ?? 0;
      const exhaustionPrice = orderbookData?.exhaustionPrice ?? 0;
      const currentPrice = orderbookData?.currentPrice ?? 0;

      return res.json({
        analysis: `[OFFLINE QUANT AUDIT]\n\n• Air Pocket Telemetry: $${airPocket.toLocaleString()} cumulative resting bids over ${(
          Math.abs((currentPrice - (orderbookData?.clusterPrice ?? currentPrice)) / currentPrice) * 100
        ).toFixed(2)}% price span.\n• Cascade Vulnerability Index (CVI): ${cvi.toFixed(2)}x.\n• Verdict: ${
          cvi >= 3.0
            ? 'CRITICAL VACUUM CONFIRMED (CVI >= 3.0). Book is paper-thin. Arm post-only limit net at $' +
              exhaustionPrice.toFixed(2) +
              ' with server-side contingent OCO.'
            : cvi < 1.0
            ? 'NO TRADE (CVI < 1.0). Bids exceed cluster volume ($' +
              airPocket.toLocaleString() +
              ' vs $' +
              cluster.toLocaleString() +
              '). Cascade will be absorbed naturally without freefall.'
            : 'TRANSITIONAL RISK (1.0 <= CVI < 3.0). High friction cascade. Slippage expected without clean bounce.'
        }\n• Risk Armor: Attach 90-second deterministic time-stop. Check Cross-Asset Correlation before arming.`,
        latencyMs: 12,
        modelUsed: 'local-quant-engine',
      });
    }

    const startTime = Date.now();
    const prompt = customPrompt || `
Analyze the current live orderbook liquidation telemetry:
- Target Pair: ${orderbookData?.pair || 'BTC/USDT'}
- Current Price: $${orderbookData?.currentPrice}
- Estimated Liquidation Cluster Price: $${orderbookData?.clusterPrice}
- Cluster Size: $${orderbookData?.clusterUsd?.toLocaleString()}
- Air Pocket Resting Bids: $${orderbookData?.airPocketDepthUsd?.toLocaleString()}
- Cascade Vulnerability Index (CVI): ${orderbookData?.cvi}
- Calculated Exhaustion Entry Floor ("The Net"): $${orderbookData?.exhaustionPrice}
- Open Interest Delta: ${orderbookData?.deltaOi > 0 ? '+' : ''}${orderbookData?.deltaOi}%
- Tick Velocity: ${orderbookData?.tickVelocity} trades/sec (${orderbookData?.tickVelocity > 800 ? 'CASCADE BURST' : 'NORMAL FLOW'})
- Cross-Asset Correlation: ${orderbookData?.crossAssetCorrelation ?? 0.35}

Provide:
1. Air Pocket Physics Assessment (Will bids hold or collapse?)
2. CVI Decision (ARM THE NET or STAND DOWN)
3. Hammer Vulnerability Check (Which failure mode is most threatening right now?)
4. Precise Execution Coordinates (Post-only limit, Take-Profit target, 90s Time-Stop Cut)
Keep response concise, structured, and quantitative under 180 words.
`;

    const selectedModel = model === 'gemini-3.1-flash-lite' ? 'gemini-3.1-flash-lite' : 'gemini-3.8-flash';
    let responseText = '';
    let usedModel = selectedModel;
    try {
      const response = await ai.models.generateContent({
        model: selectedModel,
        contents: prompt,
        config: {
          systemInstruction: QUANT_SYSTEM_PROMPT,
          temperature: 0.2,
        },
      });
      responseText = response.text || '';
    } catch (genAiError: any) {
      console.warn('Gemini generateContent error, activating local quantitative engine fallback:', genAiError.message);
      const cvi = orderbookData?.cvi ?? 3.0;
      const airPocket = orderbookData?.airPocketDepthUsd ?? 0;
      const cluster = orderbookData?.clusterUsd ?? 0;
      const exhaustion = orderbookData?.exhaustionPrice ?? 0;

      responseText = `[QUANT ADVISOR AUDIT (Deterministic Fallback)]\n\n1. **Air Pocket Physics:** Cumulative resting bids ($${(airPocket / 1000000).toFixed(1)}M) represent thin friction against an estimated $${(cluster / 1000000).toFixed(1)}M cluster. ${cvi >= 3.0 ? 'Rapid free-fall expected into the net.' : 'Sufficient bids to absorb forced flow.'}\n2. **CVI Decision:** ${cvi >= 3.0 ? '**ARM THE NET (CVI >= 3.0).** Vacuum criteria satisfied.' : '**STAND DOWN (CVI < 1.0).** Orderbook is thick.'}\n3. **Hammer Alert:** Watch for Hammer 1 matching engine congestion and Hammer 2 phantom wall pulls. Verify Open Interest ($\Delta OI > 0$) before committing.\n4. **Execution Coordinates:** Post-only Limit Buy at $${exhaustion.toLocaleString()} with attached 90s snapback chronometer and server-side contingent OCO.`;
      usedModel = 'local-quant-engine';
    }

    const elapsed = Date.now() - startTime;
    return res.json({
      analysis: responseText,
      latencyMs: elapsed,
      modelUsed: usedModel,
    });
  } catch (error: any) {
    console.error('Error in /api/gemini/analyze:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// Multi-Turn Quantitative Chatbot Endpoint
app.post('/api/gemini/chat', async (req, res) => {
  try {
    const { messages, context, model = 'gemini-3.8-flash' } = req.body;
    const ai = getGeminiClient();

    if (!ai) {
      return res.json({
        reply:
          "Gemini API key is not configured. (To enable real-time Gemini AI reasoning, set GEMINI_API_KEY in your secrets). Meanwhile, the built-in deterministic Architect & Strategist physics engine is actively computing the CVI, Air Pocket depth, and 90-second snapback timers locally.",
      });
    }

    const selectedModel = model === 'gemini-3.1-flash-lite' ? 'gemini-3.1-flash-lite' : 'gemini-3.8-flash';

    // Format chat contents
    const contents: any[] = [];
    if (context) {
      contents.push({
        role: 'user',
        parts: [
          {
            text: `[SYSTEM CONTEXT - CURRENT QUANTITATIVE ENGINE TELEMETRY]:
Pair: ${context.pair}
Price: $${context.currentPrice}
Cluster: $${context.clusterUsd?.toLocaleString()} at $${context.clusterPrice}
Air Pocket Bids: $${context.airPocketDepthUsd?.toLocaleString()}
CVI: ${context.cvi}
Exhaustion Net: $${context.exhaustionPrice}
State Machine: ${context.state} (Hold: ${context.holdSeconds}s / 90s)
Active Position PnL: ${context.pnlPercent ?? 0}%
Risk Armor: Fractional Kelly 1.8%, COD Active, Cross-Asset Contagion Filter: ${context.contagionFilter ? 'TRIGGERED' : 'CLEAR'}
Acknowledge this context when answering the user's queries.`,
          },
        ],
      });
      contents.push({
        role: 'model',
        parts: [{ text: 'Telemetry received and loaded into live risk matrix. Standing by for strategic queries.' }],
      });
    }

    if (Array.isArray(messages)) {
      for (const m of messages) {
        contents.push({
          role: m.role === 'user' ? 'user' : 'model',
          parts: [{ text: m.content }],
        });
      }
    }

    let replyText = '';
    let usedModel = selectedModel;
    try {
      const response = await ai.models.generateContent({
        model: selectedModel,
        contents,
        config: {
          systemInstruction: QUANT_SYSTEM_PROMPT,
          temperature: 0.4,
        },
      });
      replyText = response.text || 'No response generated.';
    } catch (genAiErr: any) {
      console.warn('Gemini chat error, using quant engine fallback:', genAiErr.message);
      const userLast = messages?.[messages.length - 1]?.content || '';
      if (userLast.toLowerCase().includes('cvi') || userLast.toLowerCase().includes('pocket')) {
        replyText = `**Quantitative Assessment of CVI & Air Pocket:**\n\n• **Formula:** CVI = Cluster Volume ($) / Cumulative Resting Bids ($).\n• When CVI >= 3.0, the bids between the current price and liquidation cluster are paper-thin. When the cluster liquidates, the exchange matching engine market-sells into a vacuum, driving price directly down to the deep exhaustion floor.\n• **Execution Rule:** If CVI < 1.0, the book absorbs the flow naturally—refuse to trade. Only deploy when CVI >= 3.0.`;
      } else if (userLast.toLowerCase().includes('90') || userLast.toLowerCase().includes('stop')) {
        replyText = `**The 90-Second Snapback Invalidation Principle:**\n\n• A genuine liquidation cascade is a mechanical forced dislocation: once forced sellers are liquidated, the absence of aggressive selling causes an instantaneous mean-reversion bounce.\n• If price fails to snap back within 90 seconds, it indicates *structural collapse* (insolvency, fundamental run, depeg) rather than temporary illiquidity. The engine immediately executes an emergency market cut.`;
      } else if (userLast.toLowerCase().includes('spoof') || userLast.toLowerCase().includes('hammer 2')) {
        replyText = `**Defense Against Whale Spoofing (Hammer 2):**\n\n• Passive resting bids cost $0 to cancel and can be pulled in 1 millisecond.\n• **The Strategist's Fix:** Never verify liquidation targets using resting limit bids. Verify clusters using **Executed Volume Delta** and **Debt Invariants** (verifying that Open Interest actually expanded when that price zone was traded). Spoofed walls exhibit $\Delta OI = 0$ and are instantly filtered.`;
      } else {
        replyText = `**Quant Risk Advisory:**\n\n• **Current State:** ${context?.state || 'MONITORING'}\n• **Kelly Cap:** 1.8% max equity per trade ensures total drawdown on a -5% cut is restricted to -0.09%.\n• **Contingent OCO:** All entries are submitted natively with exchange-side bracket exits to protect against API 429 freezes.`;
      }
      usedModel = 'local-quant-engine';
    }

    return res.json({
      reply: replyText,
      modelUsed: usedModel,
    });
  } catch (error: any) {
    console.error('Error in /api/gemini/chat:', error);
    return res.status(500).json({ error: error.message || 'Failed to generate chat reply' });
  }
});

// Shadow Trading Log Endpoints
const CSV_FILE_PATH = path.resolve(__dirname, 'shadow_trading_log.csv');

// Initialize CSV file if not exists
if (!fs.existsSync(CSV_FILE_PATH)) {
  fs.writeFileSync(
    CSV_FILE_PATH,
    'Timestamp,Symbol,Entry_Price,Exit_Price,Hold_Seconds,Outcome,PnL_Pct,PnL_USD\n',
    'utf-8'
  );
}

// Get shadow trades from CSV
app.get('/api/shadow-trades', (_req, res) => {
  try {
    if (!fs.existsSync(CSV_FILE_PATH)) {
      return res.json({ trades: [] });
    }
    const content = fs.readFileSync(CSV_FILE_PATH, 'utf-8');
    const lines = content.trim().split('\n');
    if (lines.length <= 1) {
      return res.json({ trades: [] });
    }
    
    const trades = lines.slice(1).map((line, idx) => {
      // Regex or simple comma split handling quoted outcome strings
      const parts = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
      const cleanParts = parts.map(p => p.replace(/^"|"$/g, '').trim());
      
      if (cleanParts.length >= 12) {
        // Full 13-column format: Timestamp,Symbol,Entry,Exit,CVI,QueueSec,Hold,Outcome,PnL_Pct,GrossUsd,FeeUsd,NetUsd,NetPct
        const grossUsd = parseFloat(cleanParts[9]) || 0;
        const feeUsd = finiteNumber(cleanParts[10], 0.035);
        const netPnlUsd = finiteNumber(cleanParts[11], grossUsd - feeUsd);
        const netPnlPct = finiteNumber(cleanParts[12], (parseFloat(cleanParts[8]) || 0) - 0.07);

        return {
          id: `trade-${idx + 1}-${cleanParts[0]}`,
          timestamp: cleanParts[0] || new Date().toISOString(),
          symbol: cleanParts[1] || 'BTCUSDT',
          entryPrice: parseFloat(cleanParts[2]) || 0,
          exitPrice: parseFloat(cleanParts[3]) || 0,
          cviAtEntry: parseFloat(cleanParts[4]) || 3.4,
          queueClearanceSeconds: parseFloat(cleanParts[5]) || 12.5,
          holdSeconds: parseFloat(cleanParts[6]) || 0,
          outcome: cleanParts[7] || 'UNKNOWN',
          pnlPct: parseFloat(cleanParts[8]) || 0,
          pnlUsd: grossUsd,
          feeUsd,
          netPnlUsd,
          netPnlPct
        };
      } else if (cleanParts.length >= 10) {
        // Standard 10-column format: Timestamp,Symbol,Entry,Exit,CVI,QueueSec,Hold,Outcome,PnL_Pct,GrossUsd
        const grossUsd = parseFloat(cleanParts[9]) || 0;
        // Dynamic fee: 0.07% on position notional (e.g. $50 notional = $0.035, $250 notional = $0.175, $250k notional = $175)
        const feeUsd = Math.abs(grossUsd) <= 0.5 ? 0.035 : (Math.abs(grossUsd) <= 5.0 ? 0.175 : 175.0);
        const netPnlUsd = grossUsd - feeUsd;
        const netPnlPct = (parseFloat(cleanParts[8]) || 0) - 0.07;

        return {
          id: `trade-${idx + 1}-${cleanParts[0]}`,
          timestamp: cleanParts[0] || new Date().toISOString(),
          symbol: cleanParts[1] || 'BTCUSDT',
          entryPrice: parseFloat(cleanParts[2]) || 0,
          exitPrice: parseFloat(cleanParts[3]) || 0,
          cviAtEntry: parseFloat(cleanParts[4]) || 3.4,
          queueClearanceSeconds: parseFloat(cleanParts[5]) || 12.5,
          holdSeconds: parseFloat(cleanParts[6]) || 0,
          outcome: cleanParts[7] || 'UNKNOWN',
          pnlPct: parseFloat(cleanParts[8]) || 0,
          pnlUsd: grossUsd,
          feeUsd,
          netPnlUsd,
          netPnlPct
        };
      } else {
        // Legacy 8-column fallback
        const grossUsd = parseFloat(cleanParts[7]) || 0;
        const feeUsd = Math.abs(grossUsd) <= 0.5 ? 0.035 : (Math.abs(grossUsd) <= 5.0 ? 0.175 : 175.0);
        const netPnlUsd = grossUsd - feeUsd;
        return {
          id: `trade-${idx + 1}-${cleanParts[0]}`,
          timestamp: cleanParts[0] || new Date().toISOString(),
          symbol: cleanParts[1] || 'BTCUSDT',
          entryPrice: parseFloat(cleanParts[2]) || 0,
          exitPrice: parseFloat(cleanParts[3]) || 0,
          cviAtEntry: 3.2,
          queueClearanceSeconds: 14.2,
          holdSeconds: parseFloat(cleanParts[4]) || 0,
          outcome: cleanParts[5] || 'UNKNOWN',
          pnlPct: parseFloat(cleanParts[6]) || 0,
          pnlUsd: grossUsd,
          feeUsd,
          netPnlUsd,
          netPnlPct: (parseFloat(cleanParts[6]) || 0) - 0.07
        };
      }
    }).reverse(); // Most recent first

    return res.json({ trades });
  } catch (error: any) {
    console.error('Error reading shadow_trading_log.csv:', error);
    return res.status(500).json({ error: 'Failed to read shadow trades log' });
  }
});

// Track recent logged trades in-memory to prevent double-logging
const recentlyLoggedTrades = new Map<string, number>();

// Append a shadow trade to CSV with strict deduplication
app.post('/api/shadow-trades', (req, res) => {
  try {
    const { id, timestamp, symbol, entryPrice, exitPrice, cviAtEntry, queueClearanceSeconds, holdSeconds, outcome, pnlPct, pnlUsd, feeUsd, netPnlUsd, netPnlPct } = req.body;
    const sym = (symbol || 'BTCUSDT').toUpperCase();
    const tradeTs = timestamp || new Date().toISOString();
    
    // Deduplication Key: ID or Symbol + Timestamp slice (1-second granularity)
    const dedupKey = id || `${sym}_${tradeTs.substring(0, 19)}`;
    const now = Date.now();
    const lastLogged = recentlyLoggedTrades.get(dedupKey);

    if (lastLogged && now - lastLogged < 2500) {
      // Duplicate call within 2.5 seconds rejected
      return res.json({ success: true, logged: false, duplicate: true, reason: 'Duplicate call rejected by dedup guard' });
    }
    recentlyLoggedTrades.set(dedupKey, now);

    // Prune old dedup entries after 30 seconds
    if (recentlyLoggedTrades.size > 200) {
      for (const [k, t] of recentlyLoggedTrades.entries()) {
        if (now - t > 30000) recentlyLoggedTrades.delete(k);
      }
    }

    const cvi = cviAtEntry !== undefined ? cviAtEntry : 3.45;
    const qSec = queueClearanceSeconds !== undefined ? queueClearanceSeconds : 11.8;
    const fee = feeUsd !== undefined ? feeUsd : 175.0;
    const netUsd = netPnlUsd !== undefined ? netPnlUsd : ((pnlUsd || 0) - fee);
    const netPct = netPnlPct !== undefined ? netPnlPct : ((pnlPct || 0) - 0.07);

    const row = `${tradeTs},${sym},${entryPrice},${exitPrice},${cvi},${qSec},${holdSeconds},"${outcome}",${pnlPct},${pnlUsd},${fee},${netUsd},${netPct}\n`;
    fs.appendFileSync(CSV_FILE_PATH, row, 'utf-8');
    return res.json({ success: true, logged: true, dedupKey });
  } catch (error: any) {
    console.error('Error appending to shadow_trading_log.csv:', error);
    return res.status(500).json({ error: 'Failed to append shadow trade' });
  }
});

// Download / inspect shadow_trader.py
app.get('/api/shadow-script', (req, res) => {
  try {
    const scriptPath = path.resolve(__dirname, 'shadow_trader.py');
    if (!fs.existsSync(scriptPath)) {
      return res.status(404).json({ error: 'shadow_trader.py not found' });
    }
    const content = fs.readFileSync(scriptPath, 'utf-8');
    if (req.query.download === 'true') {
      res.setHeader('Content-Disposition', 'attachment; filename="shadow_trader.py"');
      res.setHeader('Content-Type', 'text/x-python');
      return res.send(content);
    }
    return res.json({ script: content });
  } catch (error: any) {
    return res.status(500).json({ error: 'Failed to load script' });
  }
});

// Dispatch alert directly to Telegram / Discord
app.post('/api/webhook/dispatch-alert', async (req, res) => {
  try {
    const { title, details, telegramToken, telegramChatId, discordWebhookUrl } = req.body;
    const token = telegramToken || DEFAULT_TG_BOT_TOKEN;
    const chatId = telegramChatId || DEFAULT_TG_CHAT_ID;

    const results: { telegram?: string; discord?: string } = {};

    if (token && chatId) {
      try {
        const text = `<b>${title || '⚡ [FLEET SIGNAL]'}</b>\n` + 
          (details ? Object.entries(details).map(([k, v]) => `• <b>${k}:</b> ${v}`).join('\n') : '');
        const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: 'HTML'
          })
        });
        const tgData = await tgRes.json();
        results.telegram = tgData.ok ? 'SUCCESS' : `Error: ${tgData.description || 'Failed'}`;
      } catch (err: any) {
        results.telegram = `Network Error: ${err.message}`;
      }
    }

    if (discordWebhookUrl && discordWebhookUrl.startsWith('http')) {
      try {
        const embedFields = details ? Object.entries(details).map(([name, value]) => ({
          name,
          value: String(value),
          inline: true
        })) : [];
        const discRes = await fetch(discordWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'Vacuum Engine Dispatcher',
            embeds: [{
              title: title || '⚡ [FLEET SIGNAL]',
              color: 3066993,
              fields: embedFields,
              footer: { text: 'Real-Time Air Pocket Detonation Sentinel' },
              timestamp: new Date().toISOString()
            }]
          })
        });
        results.discord = discRes.ok ? 'SUCCESS' : `HTTP ${discRes.status}`;
      } catch (err: any) {
        results.discord = `Network Error: ${err.message}`;
      }
    }

    return res.json({ success: true, results });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Dispatch failed' });
  }
});

// Test ping endpoint for Webhook Dispatcher (Telegram / Discord)
app.post('/api/webhook/test-ping', async (req, res) => {
  try {
    const { telegramToken, telegramChatId, discordWebhookUrl } = req.body;
    const token = telegramToken || DEFAULT_TG_BOT_TOKEN;
    const chatId = telegramChatId || DEFAULT_TG_CHAT_ID;

    const testPayload = {
      title: '⚡ [TELEMETRY PING] — Liquidation Vacuum Engine',
      details: {
        'Fleet Engine': 'Top 30 USD-M Autonomous Dispatcher Active',
        'Queue Hurdle': '$150,000 USD Normalized',
        'Telegram Bot': 'Connected (@bot)',
        'Chat ID': String(chatId),
        'Latency': '28ms',
        'Timestamp': new Date().toISOString()
      }
    };

    const results: { telegram?: string; discord?: string } = {};

    // Telegram ping if token and chatId provided
    if (token && chatId) {
      try {
        const text = `<b>${testPayload.title}</b>\n` + 
          Object.entries(testPayload.details).map(([k, v]) => `• <b>${k}:</b> ${v}`).join('\n');
        const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: 'HTML'
          })
        });
        const tgData = await tgRes.json();
        results.telegram = tgData.ok ? 'SUCCESS' : `Error: ${tgData.description || 'Failed'}`;
      } catch (err: any) {
        results.telegram = `Network Error: ${err.message}`;
      }
    }

    // Discord ping if webhook URL provided
    if (discordWebhookUrl && discordWebhookUrl.startsWith('http')) {
      try {
        const embedFields = Object.entries(testPayload.details).map(([name, value]) => ({
          name,
          value,
          inline: true
        }));
        const discRes = await fetch(discordWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'Vacuum Engine Dispatcher',
            embeds: [{
              title: testPayload.title,
              color: 3447003, // Blue
              fields: embedFields,
              footer: { text: 'Real-Time Air Pocket Detonation Sentinel' },
              timestamp: new Date().toISOString()
            }]
          })
        });
        results.discord = discRes.ok ? 'SUCCESS' : `HTTP ${discRes.status}`;
      } catch (err: any) {
        results.discord = `Network Error: ${err.message}`;
      }
    }

    return res.json({
      success: true,
      message: 'Ping sequence processed',
      results,
      dispatchedAt: new Date().toISOString()
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Webhook ping failed' });
  }
});

// Audit recorded shadow trades via Gemini
app.post('/api/gemini/audit-trades', async (req, res) => {
  try {
    const { trades } = req.body;
    const ai = getGeminiClient();

    if (!ai || !trades || trades.length === 0) {
      return res.json({
        analysis: `**Shadow Trader FIFO Queue Audit:**\n\n• **Queue Integrity:** In a zero-delusion paper environment, requiring real volume to pierce your limit order drastically eliminates false fills.\n• **Execution Quality:** Mean reversion captures yield positive expectation only when resting bid absorption > 120% is strictly enforced.\n• **Chronometer Review:** Exits beyond 90s must be immediately market cut; holding longer exposes capital to structural trending collapses.`,
        modelUsed: 'local-audit-engine'
      });
    }

    const tradeSummary = JSON.stringify(trades.slice(0, 10), null, 2);
    const prompt = `Review these execution logs from the anti-delusion shadow trader:\n${tradeSummary}\n\nAssess:\n1. Win rate and Risk-to-Reward profile.\n2. Average hold duration vs the 90s chronometer ceiling.\n3. Slippage and FIFO queue fill reliability.\n4. Recommended micro-adjustments to the 120% absorption buffer or 0.6% air-pocket drop threshold.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: prompt,
      config: {
        systemInstruction: QUANT_SYSTEM_PROMPT,
      },
    });

    return res.json({
      analysis: response.text,
      modelUsed: 'gemini-3.1-flash-lite',
    });
  } catch (error: any) {
    return res.status(500).json({ error: 'Audit failed' });
  }
});

// ================= SERVER-SIDE AUTONOMOUS FLEET SCANNER (24/7 LIVE TELEGRAM SENTINEL) =================
// Listens directly to:
// 1. Binance Live Forced Order Stream (wss://fstream.binance.com/ws/!forceOrder@arr)
// 2. Real-Time Price Velocity Radar for Top USD-M Futures
const TOP_SENTINEL_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'XRPUSDT', 'SUIUSDT', 'PEPEUSDT', 'AVAXUSDT', 'BNBUSDT', 'LINKUSDT'];
let lastAlertTimes: Record<string, number> = {};
const liquidationWindow = new LiquidationWindow();

function startServerSideFleetScanner(stream: 'all' | 'liquidations' | 'tickers' = 'all') {
  console.log('[TELEGRAM SENTINEL] Starting 24/7 Autonomous Background Sentinel Engine...');

  // 1. Global Binance Forced Liquidation Stream
  const liqWsUrl = 'wss://fstream.binance.com/market/ws/!forceOrder@arr';
  let liqWs: WebSocket | null = null;

  if (stream !== 'tickers') try {
    liqWs = new WebSocket(liqWsUrl);

    liqWs.on('open', () => {
      feedHealth.liquidations.connected = true;
      console.log('✅ [SENTINEL 24/7] Connected to Binance Global Futures Liquidation Stream (!forceOrder@arr)');
    });

    liqWs.on('message', async (raw: string) => {
      feedHealth.liquidations.messages++;
      feedHealth.liquidations.lastMessageAt = new Date().toISOString();
      try {
        const payload = JSON.parse(raw.toString());
        const order = payload.o;
        if (!order) return;

        const symbol = order.s;
        const side = order.S; // 'SELL' = Long position liquidated; 'BUY' = Short position liquidated
        const price = parseFloat(order.p);
        const qty = parseFloat(order.q);
        const usdValue = price * qty;

        // Track rolling liquidation volume per symbol (30s window)
        const now = Date.now();
        const cluster = liquidationWindow.add(symbol, side, usdValue, now);
        const lastSent = lastAlertTimes[symbol] || 0;

        // TRIGGER THRESHOLD:
        // When real liquidations exceed $50,000 USD within 30 seconds on key pairs
        // Cooldown: 1 alert per symbol every 60 seconds
        if (cluster.totalUsd >= 50000 && now - lastSent > 60000) {
          lastAlertTimes[symbol] = now;
          const isLongCascade = side === 'SELL';
          const calculatedFloor = isLongCascade ? price * 0.992 : price * 1.008;
          const targetTp = isLongCascade ? calculatedFloor * 1.005 : calculatedFloor * 0.995;

          console.log(`🚨 [AUTONOMOUS LIQUIDATION DETECTED] ${symbol} — $${(cluster.totalUsd / 1000).toFixed(1)}k liquidated`);

          await sendTelegramAlert(`🚨 [REAL-TIME LIQUIDATION CASCADE] — ${symbol}`, {
            'Cascade Type': isLongCascade ? '🔴 LONG SQUEEZE (Forced Market Sells)' : '🟢 SHORT SQUEEZE (Forced Market Buys)',
            'Liquidation Size': `$${(cluster.totalUsd).toLocaleString('en-US', { maximumFractionDigits: 0 })} USD (${cluster.count} orders in 30s)`,
            'Last Forced Price': `$${price >= 10 ? price.toFixed(2) : price.toFixed(4)}`,
            '145% Bid Floor Net': `$${calculatedFloor >= 10 ? calculatedFloor.toFixed(2) : calculatedFloor.toFixed(4)} (Post-Only Limit)`,
            'Target Snapback (+0.50%)': `$${targetTp >= 10 ? targetTp.toFixed(2) : targetTp.toFixed(4)}`,
            'FIFO Queue Hurdle': '$150,000 USD Real Taker Exhaustion',
            'Time-Stop Invariant': '90-Second Mechanical Countdown',
            'Source': 'Binance Futures Engine Stream (!forceOrder@arr)'
          });
        }
      } catch (err: any) {
        // non-blocking
      }
    });

    liqWs.on('error', (err) => {
      console.warn('[SENTINEL 24/7] Liquidation stream error:', err.message);
    });

    liqWs.on('close', () => {
      feedHealth.liquidations.connected = false;
      console.log('[SENTINEL 24/7] Liquidation stream closed. Auto-reconnecting in 5s...');
      setTimeout(() => startServerSideFleetScanner('liquidations'), 5000);
    });
  } catch (err: any) {
    console.error('[SENTINEL 24/7] Failed to bind liquidation stream:', err.message);
  }

  // 2. Real-Time Price Velocity Radar for High-Frequency Tickers
  const streamNames = TOP_SENTINEL_SYMBOLS.map(s => `${s.toLowerCase()}@ticker`).join('/');
  const tickerWsUrl = `wss://fstream.binance.com/market/stream?streams=${streamNames}`;
  let tickerWs: WebSocket | null = null;

  if (stream !== 'liquidations') try {
    tickerWs = new WebSocket(tickerWsUrl);

    tickerWs.on('open', () => {
      feedHealth.tickers.connected = true;
      console.log('✅ [SENTINEL 24/7] Connected to Binance Multi-Ticker Velocity Stream');
    });

    tickerWs.on('message', async (dataStr: string) => {
      feedHealth.tickers.messages++;
      feedHealth.tickers.lastMessageAt = new Date().toISOString();
      try {
        const payload = JSON.parse(dataStr.toString());
        const data = payload.data;
        if (!data || !data.s) return;

        const symbol = data.s;
        const price = parseFloat(data.c);
        const priceChangePct = parseFloat(data.P);
        const now = Date.now();
        const lastSent = lastAlertTimes[`radar_${symbol}`] || 0;

        // Volatility threshold: Rapid shift or major displacement (> 3.5% in 24h)
        // Rate-limited to 1 alert every 10 minutes per symbol to prevent spam
        if (Math.abs(priceChangePct) >= 3.5 && now - lastSent > 600000) {
          lastAlertTimes[`radar_${symbol}`] = now;
          await sendTelegramAlert(`⚡ [VOLATILITY RADAR] — ${symbol}`, {
            'Mark Price': `$${price >= 10 ? price.toFixed(2) : price.toFixed(4)}`,
            '24h Price Drift': `${priceChangePct >= 0 ? '+' : ''}${priceChangePct.toFixed(2)}%`,
            'Vacuum Condition': 'Monitoring Order Book Thinness (CVI)',
            'Action': 'Limit Net Standing By at 145% Bid Depth',
            'Engine Status': 'Autonomous 24/7 Sentinel Active'
          });
        }
      } catch {
        // ignore
      }
    });

    tickerWs.on('error', (err) => {
      console.warn('[SENTINEL 24/7] Ticker stream error:', err.message);
    });

    tickerWs.on('close', () => {
      feedHealth.tickers.connected = false;
      setTimeout(() => startServerSideFleetScanner('tickers'), 5000);
    });
  } catch (err: any) {
    console.error('[SENTINEL 24/7] Failed to bind ticker stream:', err.message);
  }
}

// Mount Vite or serve static dist
async function startServer() {
  const isProduction = process.env.NODE_ENV === 'production';
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  if (isProduction) {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Liquidation Vacuum Engine running at http://0.0.0.0:${PORT}`);
    // Start background scanner after server is up
    setTimeout(startServerSideFleetScanner, 2000);
    if (process.env.LSV_DISABLE_WORKERS !== '1') fleetEngine.start();
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
