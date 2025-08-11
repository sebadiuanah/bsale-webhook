// index.js — Stock Sync Bsale → Supabase (standalone)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors({ origin: true, methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json());

// ---------- ENV ----------
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const BSALE_BASE    = (process.env.BSALE_BASE_URL || 'https://api.bsale.cl').replace(/\/+$/,'');
const BSALE_TOKEN   = process.env.BSALE_TOKEN;               // access_token
const OFFICE_ID     = Number(process.env.BSALE_WAREHOUSE_ID || 1); // ← ya confirmaste 1 (Casa Matriz)
const SYNC_EVERY_MS = Number(process.env.STOCK_SYNC_INTERVAL_MS || 5 * 60 * 1000); // 5 min
const PORT          = process.env.PORT || 10000;

// ---------- Clients ----------
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
const BSALE = axios.create({
  baseURL: `${BSALE_BASE}/v1`,
  headers: { 'access_token': BSALE_TOKEN }
});

// ---------- Helpers ----------
const log = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);
const err  = (...a) => console.error(...a);

// ---------- Sanity at boot ----------
(async () => {
  log('Sanity → SUPABASE_URL:', SUPABASE_URL, '\nSanity → service_role:', !!SUPABASE_KEY);
  try {
    const rest = `${SUPABASE_URL.replace(/\/+$/,'')}/rest/v1/`;
    const r = await fetch(rest, { headers: { apikey: SUPABASE_KEY } });
    log('Ping REST Supabase:', r.status, rest);
  } catch (e) {
    err('× Ping Supabase falló:', e?.cause?.code || e.message);
  }
  try {
    const { data } = await BSALE.get('/offices.json');
    log('Ping Bsale offices:', Array.isArray(data?.items) ? data.items.length : 'n/a');
  } catch (e) {
    err('× Ping Bsale falló:', e?.response?.status, e?.response?.data || e.message);
  }
})();

// ---------- SQL bootstrap (opcional, crea tabla si no existe) ----------
async function ensureInventoryTable() {
  const sql = `
  create table if not exists inventory (
    sku text primary key,
    bsale_product_id int not null,
    warehouse_id int not null,
    stock_qty numeric not null default 0,
    reserved_qty numeric not null default 0,
    updated_at timestamptz not null default now()
  );
  create index if not exists idx_inventory_bsale on inventory(bsale_product_id, warehouse_id);
  `;
  // Ejecuta vía RPC simple
  try {
    await supabase.rpc('exec_sql', { sql }); // si no tienes esta RPC, ignora este bloque
  } catch (_) { /* opcional; no romper si no existe */ }
}

// ---------- Fetching ----------
async function fetchAllProductsWithStock(page = 1, acc = []) {
  const { data } = await BSALE.get('/products.json', {
    params: { page, limit: 200, expand: 'stock' },
    validateStatus: () => true,
  });
  if (data?.items) acc.push(...data.items);
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
  }, 8000);
}

// ---------- HTTP endpoints ----------
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

// ---------- Start ----------
startStockCron();

app.listen(PORT, () => {
  log(`Server up on :${PORT}`);
});
