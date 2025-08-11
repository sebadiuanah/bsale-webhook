// index.js — Stock Sync Bsale → Supabase (backoff + endpoints debug)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const dns = require('node:dns').promises;

const app = express();
app.use(cors({ origin: true, methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json());

// ---------- ENV ----------
const SUPABASE_URL  = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const BSALE_BASE    = (process.env.BSALE_BASE_URL || 'https://api.bsale.cl').replace(/\/+$/,'');
const BSALE_TOKEN   = process.env.BSALE_TOKEN;
const OFFICE_ID     = Number(process.env.BSALE_WAREHOUSE_ID || 1);
const SYNC_EVERY_MS = Number(process.env.STOCK_SYNC_INTERVAL_MS || 5 * 60 * 1000);
const PORT          = process.env.PORT || 10000;

// ---------- Clients ----------
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

const BSALE = axios.create({
  baseURL: `${BSALE_BASE}/v1`,
  headers: {
    'access_token': BSALE_TOKEN,
    'Accept': 'application/json',
    'User-Agent': 'LaCosturaStockSync/1.0 (+render)'
  },
  timeout: 20000
});

// ---------- Helpers ----------
const log  = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);
const err  = (...a) => console.error(...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Backoff para GETs a Bsale (maneja 429)
async function bsaleGet(path, params = {}, tries = 4, delay = 1200) {
  for (let i = 0; i < tries; i++) {
    const resp = await BSALE.get(path, { params, validateStatus: () => true }).catch(e => e.response);
    const status = resp?.status ?? 0;
    if (status >= 200 && status < 300) return resp;

    if (status === 429) {
      const wait = delay * Math.pow(2, i);
      warn(`Bsale 429 → reintento ${i + 1}/${tries} en ${wait}ms`);
      await sleep(wait);
      continue;
    }

    warn('Bsale no-2xx:', status, resp?.data || null);
    return resp || { status: 0, data: { error: 'sin respuesta' } };
  }
  return { status: 429, data: { error: 'max retries' } };
}

// ---------- Sanity al iniciar ----------
(async () => {
  log('Sanity → SUPABASE_URL:', SUPABASE_URL, '\nSanity → service_role set:', !!SUPABASE_KEY);
  try {
    const rest = `${SUPABASE_URL.replace(/\/+$/,'')}/rest/v1/`;
    const r = await fetch(rest, { headers: { apikey: SUPABASE_KEY } });
    log('Ping REST Supabase:', r.status, rest);
  } catch (e) {
    err('× Ping Supabase falló:', e?.cause?.code || e.message);
  }
})();

// ---------- Fetching ----------
async function fetchAllProductsWithStock(page = 1, acc = []) {
  const resp = await bsaleGet('/products.json', { page, limit: 200, expand: 'stock' });
  if (!(resp?.status >= 200 && resp?.status < 300)) {
    warn('StockSync → fallo products:', resp?.status, resp?.data || null);
    return acc;
  }
  const data = resp.data;
  if (data?.items?.length) acc.push(...data.items);
  const hasNext = !!(data?.href?.next || data?.next);
  return hasNext ? fetchAllProductsWithStock(page + 1, acc) : acc;
}

function stockInOffice(product, officeId) {
  const rows = product?.stock?.items || [];
  const row  = rows.find(it => Number(it?.office?.id) === Number(officeId));
  return row ? Number(row.quantity) : 0;
}

// ---------- Sync core ----------
async function syncStockOnce() {
  log(`StockSync → iniciando (officeId=${OFFICE_ID})...`);
  try {
    const products = await fetchAllProductsWithStock();
    if (!products?.length) {
      warn('StockSync → 0 productos recibidos de Bsale');
      return { ok: false, count: 0 };
    }

    const upserts = products.map(p => ({
      sku: (p.code || String(p.id)).trim(),
      bsale_product_id: Number(p.id),
      warehouse_id: Number(OFFICE_ID),
      stock_qty: stockInOffice(p, OFFICE_ID),
      updated_at: new Date().toISOString(),
    }));

    const { error } = await supabase
      .from('inventory')
      .upsert(upserts, { onConflict: 'sku' });

    if (error) {
      err('× StockSync → error upsert Supabase:', error);
      return { ok: false, count: 0, error };
    }

    log(`StockSync → OK. SKUs sincronizados: ${upserts.length}`);
    return { ok: true, count: upserts.length };
  } catch (e) {
    err('× StockSync → error:', e?.response?.data || e.message || e);
    return { ok: false, count: 0, error: e?.message || 'error' };
  }
}

// ---------- Cron interno ----------
function startStockCron() {
  log(`StockSync → cron cada ${Math.round(SYNC_EVERY_MS/1000)}s (officeId=${OFFICE_ID})`);
  setTimeout(() => {
    syncStockOnce();
    setInterval(syncStockOnce, SYNC_EVERY_MS);
  }, 15000); // retraso inicial para evitar ráfagas
}

// ---------- Endpoints HTTP ----------
app.post('/api/stock/sync', async (_req, res) => {
  const r = await syncStockOnce();
  res.status(r.ok ? 200 : 500).json(r);
});

app.get('/api/stock/:sku', async (req, res) => {
  const { sku } = req.params;
  const { data, error } = await supabase
    .from('inventory')
    .select('sku, stock_qty, reserved_qty, warehouse_id, updated_at')
    .eq('sku', sku)
    .maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, data, available: (data?.stock_qty ?? 0) - (data?.reserved_qty ?? 0) });
});

// ---------- Endpoints de diagnóstico ----------
app.get('/debug/supa', async (_req, res) => {
  try {
    const url  = (process.env.SUPABASE_URL || '').trim();
    const host = new URL(url).host;
    const a = await dns.lookup(host).catch(e => ({ error: e.code || e.message }));
    const r = await fetch(`${url.replace(/\/+$/,'')}/rest/v1/`, {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY }
    }).then(x => ({ status: x.status })).catch(e => ({ fetch_error: e.cause?.code || e.message }));
    res.json({ url, host, dns: a, rest: r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/debug/dns', async (_req, res) => {
  try {
    const a = await dns.lookup('supabase.co').catch(e => ({ error: e.code || e.message }));
    res.json({ supabase_co: a });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Start ----------
startStockCron();
app.listen(PORT, () => {
  log(`Server up on :${PORT}`);
});

