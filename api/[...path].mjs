import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildKeyterms,
  calculateCart,
  checkInventory,
  createOrder,
  metrics,
  requestPayment,
  searchProducts,
  simulatePayment,
  releaseOrder,
} from '../src/domain.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED_FILE = path.join(HERE, '..', 'data', 'store.json');

function loadSeed() {
  return JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
}

function clone(value) {
  return structuredClone(value);
}

// Vercel may reuse a warm function instance. Keeping the demo store at module/global
// scope makes the multi-step voice demo survive separate HTTP requests in that instance.
// The app remains intentionally demo-oriented; production persistence should use a DB.
function getStore() {
  if (!globalThis.__DUKAFLOW_STORE__) globalThis.__DUKAFLOW_STORE__ = clone(loadSeed());
  return globalThis.__DUKAFLOW_STORE__;
}

function resetStore() {
  globalThis.__DUKAFLOW_STORE__ = clone(loadSeed());
  return globalThis.__DUKAFLOW_STORE__;
}

function send(res, status, data) {
  res.status(status).setHeader('Cache-Control', 'no-store');
  return res.json(data);
}

function errorResponse(res, err) {
  const status = err?.code === 'EVIDENCE_GATE_BLOCKED'
    ? 422
    : err?.code === 'ASSEMBLYAI_NOT_CONFIGURED'
      ? 503
      : 400;
  return send(res, status, {
    error: {
      code: err?.code || 'BAD_REQUEST',
      message: err?.message || 'Request failed.',
      details: err?.details || null,
    },
  });
}

function requestBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return {};
}

async function getVoiceToken() {
  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key) {
    throw Object.assign(
      new Error('ASSEMBLYAI_API_KEY is not configured on the server.'),
      { code: 'ASSEMBLYAI_NOT_CONFIGURED' },
    );
  }

  const url = new URL('https://agents.assemblyai.com/v1/token');
  url.searchParams.set('expires_in_seconds', '300');

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const text = await response.text();

  if (!response.ok) {
    throw Object.assign(
      new Error(`AssemblyAI token request failed: ${response.status}`),
      { code: 'ASSEMBLYAI_TOKEN_FAILED', details: text },
    );
  }

  return JSON.parse(text);
}

export default async function handler(req, res) {
  try {
    const pathname = `/${Array.isArray(req.query?.path) ? req.query.path.join('/') : String(req.query?.path || '')}`;
    const store = getStore();

    if (req.method === 'OPTIONS') return res.status(204).end();

    if (req.method === 'GET' && pathname === '/health') {
      return send(res, 200, {
        ok: true,
        service: 'dukaflow',
        deployment: 'vercel',
        assemblyaiConfigured: Boolean(process.env.ASSEMBLYAI_API_KEY),
        time: new Date().toISOString(),
      });
    }

    if (req.method === 'GET' && pathname === '/business') return send(res, 200, store.business);
    if (req.method === 'GET' && pathname === '/products') {
      return send(res, 200, store.products.map((p) => ({
        ...p,
        price: `KSh ${(p.priceMinor / 100).toLocaleString('en-KE', { minimumFractionDigits: 2 })}`,
      })));
    }
    if (req.method === 'GET' && pathname === '/orders') return send(res, 200, store.orders.slice().reverse());
    if (req.method === 'GET' && pathname === '/metrics') return send(res, 200, metrics(store));
    if (req.method === 'GET' && pathname === '/events') return send(res, 200, store.events.slice(-60).reverse());
    if (req.method === 'GET' && pathname === '/keyterms') return send(res, 200, { keyterms: buildKeyterms(store) });
    if (req.method === 'GET' && pathname === '/voice-token') return send(res, 200, await getVoiceToken());

    if (req.method === 'POST' && pathname === '/reset') {
      resetStore();
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/voice-events') {
      const body = requestBody(req);
      if (!body.sessionId || !body.type) {
        throw Object.assign(new Error('sessionId and type are required.'), { code: 'BAD_REQUEST' });
      }
      const session = store.voiceSessions[body.sessionId] ||= {
        user: [],
        agent: [],
        createdAt: new Date().toISOString(),
      };
      if (['user', 'agent'].includes(body.type) && body.text) {
        session[body.type].push({ text: String(body.text), at: new Date().toISOString() });
      }
      store.events.push({
        type: `VOICE_${String(body.type).toUpperCase()}`,
        sessionId: body.sessionId,
        text: body.text ?? '',
        at: new Date().toISOString(),
      });
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/tools') {
      const body = requestBody(req);
      const tool = body.name;
      const args = body.arguments ?? {};
      let result;

      try {
        if (tool === 'search_products') {
          result = searchProducts(store, String(args.query || ''));
        } else if (tool === 'check_inventory') {
          result = checkInventory(store, String(args.productId), Number(args.quantity));
        } else if (tool === 'calculate_cart') {
          result = calculateCart(store, args.items, args.zone);
        } else if (tool === 'create_order') {
          const session = store.voiceSessions[args.sessionId];
          const latestUser = session?.user?.at(-1)?.text
            ?? String(args.latestUserText || args.evidence?.latestUserText || '');
          const evidence = {
            ...(args.evidence ?? {}),
            latestUserText: latestUser,
            conversationUserText: (session?.user ?? []).map((x) => x.text).join(' '),
          };
          result = createOrder(store, { ...args, evidence, sessionId: args.sessionId });
          store.voiceSessions[args.sessionId] ||= { user: [], agent: [], createdAt: new Date().toISOString() };
        } else if (tool === 'request_payment') {
          result = requestPayment(store, String(args.orderId));
        } else if (tool === 'simulate_payment') {
          result = simulatePayment(store, String(args.orderId));
        } else if (tool === 'cancel_order') {
          result = releaseOrder(store, String(args.orderId));
        } else if (tool === 'get_order_status') {
          const order = store.orders.find((x) => x.id === String(args.orderId));
          if (!order) throw new Error('Order not found.');
          result = order;
        } else {
          throw Object.assign(new Error(`Unknown tool: ${tool}`), { code: 'UNKNOWN_TOOL' });
        }

        store.events.push({ type: 'TOOL_EXECUTED', tool, success: true, at: new Date().toISOString() });
        return send(res, 200, { ok: true, result });
      } catch (err) {
        store.events.push({
          type: err.code === 'EVIDENCE_GATE_BLOCKED' ? 'EVIDENCE_GATE_BLOCKED' : 'TOOL_FAILED',
          tool,
          success: false,
          message: err.message,
          sessionId: args.sessionId ?? null,
          ...(err.details ? { details: err.details } : {}),
          at: new Date().toISOString(),
        });
        throw err;
      }
    }

    return send(res, 404, { error: { code: 'NOT_FOUND', message: 'API route not found.' } });
  } catch (err) {
    return errorResponse(res, err);
  }
}
