import 'dotenv/config';
const base='http://localhost:3001';
async function check(name, fn) {try {console.log(JSON.stringify({name,...await fn()}));}catch(e){console.log(JSON.stringify({name,error:e.name}));}}
await Promise.allSettled([
 check('page',async()=>{const r=await fetch(base); return {http:r.status,correctApp:(await r.text()).includes('Liquidation Vacuum Engine')};}),
 check('trade stats',async()=>{const r=await fetch(base+'/api/shadow-trades');const d=await r.json();const t=d.trades||[];return {http:r.status,count:t.length,gross:t.reduce((s,x)=>s+x.pnlUsd,0),fees:t.reduce((s,x)=>s+x.feeUsd,0),net:t.reduce((s,x)=>s+x.netPnlUsd,0),tpHits:t.filter(x=>x.outcome.startsWith('TP_HIT')).length,latest:t[0]?.timestamp};}),
 check('python export',async()=>{const r=await fetch(base+'/api/shadow-script');return {http:r.status,scriptPresent:typeof (await r.json()).script==='string'};}),
 check('Telegram authentication',async()=>{const r=await fetch('https://api.telegram.org/bot'+process.env.TELEGRAM_BOT_TOKEN+'/getMe',{signal:AbortSignal.timeout(12000)});const d=await r.json();return {http:r.status,authenticated:d.ok,description:d.description};}),
 check('Gemini models',async()=>{const r=await fetch('https://generativelanguage.googleapis.com/v1beta/models',{headers:{'x-goog-api-key':process.env.GEMINI_API_KEY||''},signal:AbortSignal.timeout(12000)});const d=await r.json();return {http:r.status,models:d.models?.filter(x=>x.name.includes('flash')).map(x=>x.name),error:d.error?.status};}),
 check('AI analyze route',async()=>{const r=await fetch(base+'/api/gemini/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({orderbookData:{pair:'BTCUSDT',currentPrice:100,clusterPrice:99,clusterUsd:1000,airPocketDepthUsd:500,cvi:2,exhaustionPrice:98}}),signal:AbortSignal.timeout(25000)});const d=await r.json();return {http:r.status,modelUsed:d.modelUsed,hasAnalysis:!!d.analysis};})
]);
