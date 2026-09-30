import WebSocket from 'ws';
await Promise.all([
 ['ticker','wss://fstream.binance.com/market/stream?streams=btcusdt@ticker'],
 ['depth','wss://fstream.binance.com/public/stream?streams=btcusdt@depth20@100ms'],
 ['trades','wss://fstream.binance.com/market/stream?streams=btcusdt@aggTrade'],
 ['liquidations','wss://fstream.binance.com/market/ws/!forceOrder@arr']
].map(([name,url])=>new Promise(resolve=>{
 const ws=new WebSocket(url); let messages=0;let event; let opened=false;
 ws.on('open',()=>opened=true);ws.on('message',raw=>{messages++;try{const p=JSON.parse(raw.toString());event=(p.data||p).e;}catch{}});
 ws.on('error',()=>{});
 setTimeout(()=>{ws.terminate();console.log(JSON.stringify({name,opened,messages,event}));resolve();},12000);
})));
