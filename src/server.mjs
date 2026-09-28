import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildKeyterms, calculateCart, checkInventory, createOrder, metrics, requestPayment, searchProducts, simulatePayment, releaseOrder } from './domain.mjs';
import { readStore, resetStore, withStore } from './store.mjs';

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, '..', 'public');
const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.map':'application/json; charset=utf-8','.ico':'image/x-icon'};

function send(res, status, data, contentType='application/json; charset=utf-8') {
  res.writeHead(status, {'Content-Type':contentType,'Cache-Control':'no-store','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type'});
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
}
function jsonError(res, status, message, code='BAD_REQUEST', details=null) { send(res,status,{error:{code,message,details}}); }
async function body(req) {
  const chunks=[]; for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Invalid JSON.'),{code:'INVALID_JSON'}); }
}
async function token() {
  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key) throw Object.assign(new Error('ASSEMBLYAI_API_KEY is not configured on the server.'), {code:'ASSEMBLYAI_NOT_CONFIGURED'});
  const u = new URL('https://agents.assemblyai.com/v1/token');
  u.searchParams.set('expires_in_seconds','300');
  const r = await fetch(u,{headers:{Authorization:`Bearer ${key}`} });
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(`AssemblyAI token request failed: ${r.status}`),{code:'ASSEMBLYAI_TOKEN_FAILED',details:text});
  return JSON.parse(text);
}

async function route(req,res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res,200,{ok:true,service:'dukaflow',time:new Date().toISOString(),assemblyaiConfigured:Boolean(process.env.ASSEMBLYAI_API_KEY)});
    if (req.method === 'GET' && url.pathname === '/api/business') { const s=await readStore(); return send(res,200,s.business); }
    if (req.method === 'GET' && url.pathname === '/api/products') { const s=await readStore(); return send(res,200,s.products.map(p=>({...p,price:`KSh ${(p.priceMinor/100).toLocaleString('en-KE',{minimumFractionDigits:2})}`}))); }
    if (req.method === 'GET' && url.pathname === '/api/orders') { const s=await readStore(); return send(res,200,s.orders.slice().reverse()); }
    if (req.method === 'GET' && url.pathname === '/api/metrics') { const s=await readStore(); return send(res,200,metrics(s)); }
    if (req.method === 'GET' && url.pathname === '/api/events') { const s=await readStore(); return send(res,200,s.events.slice(-60).reverse()); }
    if (req.method === 'GET' && url.pathname === '/api/keyterms') { const s=await readStore(); return send(res,200,{keyterms:buildKeyterms(s)}); }
    if (req.method === 'GET' && url.pathname === '/api/voice-token') { return send(res,200,await token()); }
    if (req.method === 'POST' && url.pathname === '/api/reset') { await resetStore(); return send(res,200,{ok:true}); }
    if (req.method === 'POST' && url.pathname === '/api/voice-events') {
      const b=await body(req); if(!b.sessionId||!b.type) return jsonError(res,400,'sessionId and type are required.');
      await withStore(async s=>{ if(!s.voiceSessions[b.sessionId]) s.voiceSessions[b.sessionId]={user:[],agent:[],createdAt:new Date().toISOString()}; if(['user','agent'].includes(b.type)&&b.text) s.voiceSessions[b.sessionId][b.type].push({text:String(b.text),at:new Date().toISOString()}); s.events.push({type:`VOICE_${b.type.toUpperCase()}`,sessionId:b.sessionId,text:b.text??'',at:new Date().toISOString()}); });
      return send(res,200,{ok:true});
    }
    if (req.method === 'POST' && url.pathname === '/api/tools') {
      const b=await body(req); const tool=b.name; const args=b.arguments??{};
      let out;
      try {
        await withStore(async s=>{
          if(tool==='search_products') out=searchProducts(s,String(args.query||''));
          else if(tool==='check_inventory') out=checkInventory(s,String(args.productId),Number(args.quantity));
          else if(tool==='calculate_cart') out=calculateCart(s,args.items,args.zone);
          else if(tool==='create_order') {
            let session=s.voiceSessions[args.sessionId];
            const latestUser=(session?.user??[]).at(-1)?.text ?? String(args.latestUserText || args.evidence?.latestUserText || '');
            let evidence=args.evidence??{};
            evidence.latestUserText=latestUser;
            evidence.conversationUserText = (session?.user ?? []).map(x => x.text).join(' ');
            const result=createOrder(s,{...args,evidence,sessionId:args.sessionId}); out=result;
            if(result.order) s.voiceSessions[args.sessionId] ||= {user:[],agent:[],createdAt:new Date().toISOString()};
          } else if(tool==='request_payment') out=requestPayment(s,String(args.orderId));
          else if(tool==='simulate_payment') out=simulatePayment(s,String(args.orderId));
          else if(tool==='cancel_order') out=releaseOrder(s,String(args.orderId));
          else if(tool==='get_order_status') { const o=s.orders.find(x=>x.id===String(args.orderId)); if(!o) throw new Error('Order not found.'); out=o; }
          else throw Object.assign(new Error(`Unknown tool: ${tool}`),{code:'UNKNOWN_TOOL'});
          s.events.push({type:'TOOL_EXECUTED',tool,success:true,at:new Date().toISOString()});
        });
      } catch (err) {
        try {
          await withStore(async s=>{
            const event={type:err.code === 'EVIDENCE_GATE_BLOCKED' ? 'EVIDENCE_GATE_BLOCKED' : 'TOOL_FAILED',tool,success:false,message:err.message,sessionId:args.sessionId ?? null,at:new Date().toISOString()};
            if (err.details) event.details=err.details;
            s.events.push(event);
          });
        } catch {}
        throw err;
      }
      return send(res,200,{ok:true,result:out});
    }
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const safe = path.normalize(rel).replace(/^\.{2}[\\/]/,'');
    const file = path.join(PUBLIC,safe);
    if (!file.startsWith(PUBLIC)) return jsonError(res,403,'Forbidden.','FORBIDDEN');
    try { const data=await fs.readFile(file); return send(res,200,data,MIME[path.extname(file)]||'application/octet-stream'); } catch { return jsonError(res,404,'Not found.','NOT_FOUND'); }
  } catch (err) {
    const status = err.code === 'EVIDENCE_GATE_BLOCKED' ? 422 : err.code === 'ASSEMBLYAI_NOT_CONFIGURED' ? 503 : 400;
    return jsonError(res,status,err.message,err.code||'BAD_REQUEST',err.details||null);
  }
}

http.createServer(route).listen(PORT,()=>console.log(`DukaFlow running on http://localhost:${PORT}`));
